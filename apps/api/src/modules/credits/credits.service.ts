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
        reversesTransactionId: null,
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
            },
          ],
        });

        // reversesTransactionId no viaja en LedgerLine porque solo aplica
        // a movimientos únicos (una nota de crédito corrige UN asiento).
        if (params.reversesTransactionId) {
          movimiento.reversesTransactionId = params.reversesTransactionId;
          await manager.save(movimiento);
        }

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
