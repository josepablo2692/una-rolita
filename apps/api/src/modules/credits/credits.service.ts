import {
  Injectable,
  BadRequestException,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { User } from '../auth/entities/user.entity';
import { CreditAccount } from './entities/credit-account.entity';
import {
  CreditTransaction,
  CreditTransactionType,
  CreditPaymentMethod,
} from './entities/credit-transaction.entity';

// Un renglón del libro mayor. Varios renglones pueden formar UNA sola
// operación — por ejemplo la canción gratis, que es un regalo (+1) y un
// cobro (−1) que deben ocurrir juntos o no ocurrir.
export interface LedgerLine {
  type: CreditTransactionType;
  /** CON SIGNO: positivo entra, negativo sale. Siempre entero. */
  amount: number;
  queueRequestId?: string | null;
  paymentMethod?: CreditPaymentMethod | null;
  cashAmount?: number | null;
  idempotencyKey?: string | null;
  /** Por qué se hizo. Obligatorio en reversas. */
  reason?: string | null;
  /**
   * A qué asiento corrige este renglón. Va AQUÍ y no después de guardar:
   * el trigger de inmutabilidad rechaza cualquier UPDATE sobre
   * credit_transactions, así que el dato tiene que estar completo en el
   * INSERT o no entra nunca.
   */
  reversesTransactionId?: string | null;
}

// Cómo llegan las filas crudas desde pg: los NUMERIC vienen como string.
interface RawTransactionRow {
  id: string;
  type: CreditTransactionType;
  amount: number;
  balance_after: number;
  payment_method: CreditPaymentMethod | null;
  cash_amount: string | null;
  reason: string | null;
  created_at: Date;
  reverses_transaction_id: string | null;
  customer_id: string;
  customer_name: string | null;
  created_by_staff_id: string | null;
  staff_name: string | null;
}

export interface VenueTransactionRow {
  id: string;
  type: CreditTransactionType;
  amount: number;
  balanceAfter: number;
  paymentMethod: CreditPaymentMethod | null;
  cashAmount: number | null;
  reason: string | null;
  createdAt: Date;
  reversesTransactionId: string | null;
  customer: { id: string; displayName: string | null };
  staff: { id: string; displayName: string | null } | null;
}

export interface ApplyLinesParams {
  userId: string;
  venueId: string;
  /**
   * IMPORTANTE: el orden importa. Los renglones se aplican uno por uno y
   * el saldo nunca puede quedar negativo en el camino (hay un CHECK en la
   * base). Los renglones POSITIVOS van primero: en la canción gratis, el
   * regalo antes del cobro.
   */
  lines: LedgerLine[];
  createdByStaffId?: string | null;
  /**
   * Si viene, se trabaja DENTRO de esa transacción en vez de abrir una
   * propia. Es lo que permite que QueueService cobre y meta la canción en
   * la cola como una sola operación indivisible: quien abre la
   * transacción es quien manda.
   */
  manager?: EntityManager;
}

export interface ApplyTransactionParams {
  userId: string;
  venueId: string;
  type: CreditTransactionType;
  amount: number;
  paymentMethod?: CreditPaymentMethod | null;
  cashAmount?: number | null;
  createdByStaffId?: string | null;
  queueRequestId?: string | null;
  reversesTransactionId?: string | null;
  reason?: string | null;
  idempotencyKey?: string | null;
}

// Código de error de Postgres para violación de restricción UNIQUE.
const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class CreditsService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  // ==============================================================
  // Aplica una lista de renglones como UNA sola operación.
  //
  // Es el núcleo del módulo: todos los movimientos de crédito del sistema
  // terminan pasando por aquí. Toma el candado de la cuenta UNA vez y no
  // lo suelta hasta escribir el último renglón y actualizar el saldo.
  //
  // Este servicio NO sabe qué es una canción ni cuándo alguien merece una
  // gratis. Solo sabe mover créditos con integridad. Las reglas de negocio
  // viven en quien arma la lista.
  // ==============================================================
  async applyLines(params: ApplyLinesParams): Promise<CreditTransaction[]> {
    if (params.lines.length === 0) {
      throw new BadRequestException('No hay movimientos que aplicar');
    }

    for (const renglon of params.lines) {
      if (!Number.isInteger(renglon.amount) || renglon.amount === 0) {
        throw new BadRequestException(
          'Cada movimiento debe ser un número entero distinto de cero',
        );
      }
    }

    // Si nos pasaron un manager, trabajamos dentro de la transacción de
    // quien llama. Si no, abrimos la nuestra.
    if (params.manager) {
      return this.aplicarRenglones(params.manager, params);
    }

    return this.dataSource.transaction((manager) =>
      this.aplicarRenglones(manager, params),
    );
  }

  // Asegura que la cuenta exista y la deja BLOQUEADA dentro de la
  // transacción de quien llama, sin escribir nada todavía.
  //
  // Existe para que QueueService pueda respetar el orden de bloqueo
  // (primero el crédito, después la cola) y verificar el saldo ANTES de
  // mover posiciones. Volver a bloquear la misma fila más adelante en la
  // misma transacción no cuesta nada: Postgres ya la tiene tomada.
  async ensureAndLockAccount(
    manager: EntityManager,
    userId: string,
    venueId: string,
  ): Promise<CreditAccount> {
    // No se puede bloquear una fila que no existe.
    await manager.query(
      `INSERT INTO credit_accounts (user_id, venue_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, venue_id) DO NOTHING`,
      [userId, venueId],
    );

    const cuenta = await manager.findOne(CreditAccount, {
      where: { userId, venueId },
      lock: { mode: 'pessimistic_write' },
    });

    if (!cuenta) {
      throw new BadRequestException(
        'No se pudo abrir la cuenta de créditos de este cliente en este negocio',
      );
    }

    return cuenta;
  }

  // La lógica real. Siempre corre dentro de una transacción, propia o ajena.
  private async aplicarRenglones(
    manager: EntityManager,
    params: ApplyLinesParams,
  ): Promise<CreditTransaction[]> {
    // 1. Asegurar que exista la cuenta. ON CONFLICT DO NOTHING resuelve la
    //    carrera de dos primeras operaciones simultáneas para el mismo par.
    //    No se puede bloquear una fila que todavía no existe.
    await manager.query(
      `INSERT INTO credit_accounts (user_id, venue_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, venue_id) DO NOTHING`,
      [params.userId, params.venueId],
    );

    // 2. EL CANDADO. Desde aquí hasta el COMMIT, nadie más toca esta fila.
    const cuenta = await manager.findOne(CreditAccount, {
      where: { userId: params.userId, venueId: params.venueId },
      lock: { mode: 'pessimistic_write' },
    });

    if (!cuenta) {
      throw new BadRequestException(
        'No se pudo abrir la cuenta de créditos de este cliente en este negocio',
      );
    }

    // 3. ¿Alcanza para el total? Se comprueba el NETO antes de escribir
    //    nada, para poder dar un mensaje útil en vez de fallar a la mitad.
    const neto = params.lines.reduce((suma, r) => suma + r.amount, 0);
    if (cuenta.balance + neto < 0) {
      throw new BadRequestException(
        `Saldo insuficiente: la cuenta tiene ${cuenta.balance} crédito(s) y esta operación requiere ${Math.abs(neto)}`,
      );
    }

    // 4. Los renglones, en orden, sin soltar el candado.
    let saldo = cuenta.balance;
    const guardados: CreditTransaction[] = [];

    for (const renglon of params.lines) {
      saldo += renglon.amount;

      // El neto ya dio positivo, así que si un renglón intermedio deja el
      // saldo negativo es porque vinieron en mal orden (un cobro antes de
      // su regalo). Es un error de programación, no del usuario.
      if (saldo < 0) {
        throw new InternalServerErrorException(
          'Los movimientos vienen en un orden que deja el saldo negativo a mitad de camino. Los renglones positivos deben ir primero.',
        );
      }

      const movimiento = manager.create(CreditTransaction, {
        creditAccountId: cuenta.id,
        type: renglon.type,
        amount: renglon.amount,
        balanceAfter: saldo,
        paymentMethod: renglon.paymentMethod ?? null,
        cashAmount: renglon.cashAmount ?? null,
        createdByStaffId: params.createdByStaffId ?? null,
        queueRequestId: renglon.queueRequestId ?? null,
        // Completos en el INSERT: el trigger de inmutabilidad no permite
        // corregirlos después.
        reversesTransactionId: renglon.reversesTransactionId ?? null,
        reason: renglon.reason ?? null,
        idempotencyKey: renglon.idempotencyKey ?? null,
      });

      guardados.push(await manager.save(movimiento));
    }

    // 5. El saldo materializado, una sola vez al final.
    cuenta.balance = saldo;
    cuenta.lastActivityAt = new Date();
    await manager.save(cuenta);

    return guardados;
  }

  // ==============================================================
  // Movimiento único con idempotencia. Es la puerta que usa la carga en
  // recepción: un doble clic del mesero devuelve el movimiento original
  // en vez de cobrar dos veces.
  // ==============================================================
  async applyTransaction(
    params: ApplyTransactionParams,
  ): Promise<CreditTransaction> {
    if (!Number.isInteger(params.amount) || params.amount === 0) {
      throw new BadRequestException(
        'El monto debe ser un número entero distinto de cero',
      );
    }

    try {
      return await this.dataSource.transaction(async (manager) => {
        // Idempotencia: si esta llave ya se procesó, devolvemos el
        // movimiento original sin crear uno nuevo.
        if (params.idempotencyKey) {
          const existente = await manager.findOne(CreditTransaction, {
            where: { idempotencyKey: params.idempotencyKey },
          });
          if (existente) {
            return existente;
          }
        }

        const [movimiento] = await this.aplicarRenglones(manager, {
          userId: params.userId,
          venueId: params.venueId,
          createdByStaffId: params.createdByStaffId,
          lines: [
            {
              type: params.type,
              amount: params.amount,
              paymentMethod: params.paymentMethod,
              cashAmount: params.cashAmount,
              queueRequestId: params.queueRequestId,
              idempotencyKey: params.idempotencyKey,
              // Ahora viajan en el renglón. Antes se intentaba escribir
              // con un UPDATE posterior, que el trigger de inmutabilidad
              // habría rechazado — nunca falló solo porque ninguna prueba
              // ejercitaba ese camino.
              reversesTransactionId: params.reversesTransactionId,
              reason: params.reason,
            },
          ],
        });

        return movimiento;
      });
    } catch (error) {
      // Carrera de idempotencia: dos peticiones con la misma llave
      // entraron a la vez y ambas pasaron el chequeo antes de que ninguna
      // insertara. La base rechaza a la segunda; devolvemos la que quedó.
      if (
        params.idempotencyKey &&
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string })?.code === PG_UNIQUE_VIOLATION
      ) {
        const existente = await this.dataSource
          .getRepository(CreditTransaction)
          .findOne({ where: { idempotencyKey: params.idempotencyKey } });
        if (existente) {
          return existente;
        }
      }
      throw error;
    }
  }

  // Saldo de un cliente en un venue. Devuelve 0 si nunca tuvo cuenta:
  // para el usuario, no tener cuenta y tener saldo cero son lo mismo.
  async getBalance(userId: string, venueId: string): Promise<number> {
    const cuenta = await this.dataSource
      .getRepository(CreditAccount)
      .findOne({ where: { userId, venueId } });

    return cuenta?.balance ?? 0;
  }

  // Lo que necesita el mesero en un solo paso: encontrar al cliente y ver
  // su saldo EN ESTE local. Coincidencia EXACTA, nunca parcial: con LIKE
  // cualquier empleado podría pescar los datos de todos los clientes.
  async findCustomerForTopup(
    venueId: string,
    criterio: { phone?: string; email?: string },
  ): Promise<{
    userId: string;
    displayName: string | null;
    tienePhone: boolean;
    balance: number;
  }> {
    const criteriosDados = [criterio.phone, criterio.email].filter(Boolean);
    if (criteriosDados.length !== 1) {
      throw new BadRequestException(
        'Indica el teléfono O el correo del cliente, uno de los dos',
      );
    }

    const cliente = await this.dataSource.getRepository(User).findOne({
      where: criterio.phone
        ? { phoneNumber: criterio.phone }
        : { email: criterio.email },
      select: { id: true, displayName: true, phoneNumber: true },
    });

    if (!cliente) {
      throw new NotFoundException(
        'No hay ningún cliente registrado con ese dato. Pídele que escanee el QR de su mesa y se registre.',
      );
    }

    return {
      userId: cliente.id,
      displayName: cliente.displayName,
      tienePhone: cliente.phoneNumber !== null,
      balance: await this.getBalance(cliente.id, venueId),
    };
  }

  // ==============================================================
  // Historial de movimientos del local.
  //
  // Es SQL directo a propósito: es una consulta de reporte con tres
  // joins, y escribirla como SQL es más claro que armarla con el ORM.
  // La proyección es explícita — nunca sale el correo de nadie.
  // ==============================================================
  async listVenueTransactions(
    venueId: string,
    opciones: { userId?: string; limit?: number; offset?: number } = {},
  ): Promise<VenueTransactionRow[]> {
    const limit = Math.min(opciones.limit ?? 50, 200);
    const offset = opciones.offset ?? 0;

    const filas = await this.dataSource.query<RawTransactionRow[]>(
      `SELECT ct.id,
              ct.type,
              ct.amount,
              ct.balance_after,
              ct.payment_method,
              ct.cash_amount,
              ct.reason,
              ct.created_at,
              ct.reverses_transaction_id,
              ca.user_id                AS customer_id,
              cliente.display_name      AS customer_name,
              ct.created_by_staff_id,
              empleado.display_name     AS staff_name
         FROM credit_transactions ct
         JOIN credit_accounts ca      ON ca.id = ct.credit_account_id
         JOIN users cliente           ON cliente.id = ca.user_id
         LEFT JOIN users empleado     ON empleado.id = ct.created_by_staff_id
        WHERE ca.venue_id = $1
          AND ($2::uuid IS NULL OR ca.user_id = $2::uuid)
        ORDER BY ct.seq DESC
        LIMIT $3 OFFSET $4`,
      [venueId, opciones.userId ?? null, limit, offset],
    );

    return filas.map((f) => ({
      id: f.id,
      type: f.type,
      amount: Number(f.amount),
      balanceAfter: Number(f.balance_after),
      paymentMethod: f.payment_method,
      // NUMERIC llega como string desde pg — el mismo motivo de siempre.
      cashAmount: f.cash_amount === null ? null : Number(f.cash_amount),
      reason: f.reason,
      createdAt: f.created_at,
      reversesTransactionId: f.reverses_transaction_id,
      customer: { id: f.customer_id, displayName: f.customer_name },
      staff: f.created_by_staff_id
        ? { id: f.created_by_staff_id, displayName: f.staff_name }
        : null,
    }));
  }

  // ==============================================================
  // Nota de crédito: corrige un movimiento SIN borrarlo.
  //
  // El libro mayor es inmutable, así que corregir significa insertar un
  // asiento contrario que apunta al original. El error queda visible, y
  // también queda visible quién lo corrigió y por qué.
  //
  // Admite reversa PARCIAL: si el cliente ya gastó parte, se devuelve lo
  // que todavía se puede. El resto es una conversación de negocio.
  // ==============================================================
  async reverseTransaction(params: {
    venueId: string;
    transactionId: string;
    adminUserId: string;
    reason: string;
    /** Cuántos créditos revertir. Por defecto, el movimiento completo. */
    amount?: number;
  }): Promise<CreditTransaction> {
    return this.dataSource.transaction(async (manager) => {
      const original = await manager.findOne(CreditTransaction, {
        where: { id: params.transactionId },
      });
      if (!original) {
        throw new NotFoundException('No existe ese movimiento');
      }

      // IDOR: el movimiento tiene que ser de una cuenta DE ESTE local.
      const cuenta = await manager.findOne(CreditAccount, {
        where: { id: original.creditAccountId, venueId: params.venueId },
      });
      if (!cuenta) {
        throw new NotFoundException(
          'Ese movimiento no pertenece a este negocio',
        );
      }

      // Guard Clause: una reversa no se revierte. Si la corrección estuvo
      // mal, se hace una nueva sobre el movimiento original.
      if (original.type === 'reversal') {
        throw new BadRequestException(
          'No se puede revertir una reversa. Corrige sobre el movimiento original.',
        );
      }

      // Cuánto de este movimiento ya se revirtió antes.
      const reversasPrevias = await manager.find(CreditTransaction, {
        where: { reversesTransactionId: original.id },
      });
      const yaRevertido = reversasPrevias.reduce(
        (suma, r) => suma + Math.abs(r.amount),
        0,
      );

      const montoOriginal = Math.abs(original.amount);
      const pendiente = montoOriginal - yaRevertido;

      if (pendiente <= 0) {
        throw new BadRequestException(
          'Ese movimiento ya fue revertido por completo',
        );
      }

      const aRevertir = params.amount ?? pendiente;

      if (!Number.isInteger(aRevertir) || aRevertir < 1) {
        throw new BadRequestException(
          'El monto a revertir debe ser un entero mayor que cero',
        );
      }
      if (aRevertir > pendiente) {
        throw new BadRequestException(
          `Solo quedan ${pendiente} crédito(s) por revertir de ese movimiento (original ${montoOriginal}, ya revertido ${yaRevertido})`,
        );
      }

      // El signo es el opuesto del original: revertir una carga descuenta,
      // revertir un cobro devuelve.
      const montoConSigno = original.amount > 0 ? -aRevertir : aRevertir;

      // Si el cliente ya gastó, no se puede devolver todo. Se avisa con el
      // máximo posible en vez de dejar que reviente el CHECK de la base.
      if (cuenta.balance + montoConSigno < 0) {
        throw new BadRequestException(
          `No se puede revertir ${aRevertir}: el cliente ya gastó parte y el saldo quedaría negativo. Máximo reversible ahora: ${cuenta.balance}`,
        );
      }

      const [reversa] = await this.aplicarRenglones(manager, {
        userId: cuenta.userId,
        venueId: params.venueId,
        // Queda registrado QUIÉN corrigió, que es distinto de quién causó
        // el error. Esa firma es lo que hace que la auditoría signifique
        // algo.
        createdByStaffId: params.adminUserId,
        lines: [
          {
            type: 'reversal',
            amount: montoConSigno,
            reversesTransactionId: original.id,
            reason: params.reason,
          },
        ],
      });

      return reversa;
    });
  }

  // El pago de haber elegido montos CON SIGNO: la integridad de todo el
  // módulo se verifica con una sola suma. El saldo es caché; el ledger es
  // la verdad. Si no coinciden, hay corrupción.
  async verifyIntegrity(creditAccountId: string): Promise<{
    balance: number;
    sumaLedger: number;
    ok: boolean;
  }> {
    const cuenta = await this.dataSource
      .getRepository(CreditAccount)
      .findOne({ where: { id: creditAccountId } });

    if (!cuenta) {
      throw new BadRequestException('No existe esa cuenta de créditos');
    }

    const filas = await this.dataSource.query<{ suma: string }[]>(
      `SELECT COALESCE(SUM(amount), 0) AS suma
         FROM credit_transactions
        WHERE credit_account_id = $1`,
      [creditAccountId],
    );

    // SUM() devuelve NUMERIC/bigint, que pg entrega como string — el mismo
    // motivo por el que existe NumericColumnTransformer.
    const sumaLedger = Number(filas[0]?.suma ?? 0);

    return {
      balance: cuenta.balance,
      sumaLedger,
      ok: cuenta.balance === sumaLedger,
    };
  }
}
