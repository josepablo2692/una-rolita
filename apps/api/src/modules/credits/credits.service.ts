import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';
import { CreditAccount } from './entities/credit-account.entity';
import {
  CreditTransaction,
  CreditTransactionType,
  CreditPaymentMethod,
} from './entities/credit-transaction.entity';

export interface ApplyTransactionParams {
  userId: string;
  venueId: string;
  type: CreditTransactionType;
  /** CON SIGNO: positivo entra, negativo sale. Siempre entero. */
  amount: number;
  paymentMethod?: CreditPaymentMethod | null;
  /** Quetzales reales recibidos en caja. Solo en recargas. */
  cashAmount?: number | null;
  createdByStaffId?: string | null;
  queueRequestId?: string | null;
  reversesTransactionId?: string | null;
  /** Si viene, el mismo valor nunca produce dos movimientos. */
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
  // La ÚNICA puerta por la que se mueve un crédito en todo el sistema.
  //
  // Recargas, cobros, reembolsos, reversas y expiraciones pasan todos por
  // aquí. Es a propósito: la invariante SUM(amount) = balance solo se
  // puede garantizar si hay un único lugar que la mantiene. El día que
  // alguien escriba un UPDATE de saldo por fuera, la invariante se rompe
  // y nadie se entera hasta que la caja no cuadre.
  // ==============================================================
  async applyTransaction(
    params: ApplyTransactionParams,
  ): Promise<CreditTransaction> {
    // Guard Clause: los créditos son enteros y un movimiento de 0 no es
    // un movimiento. La base también lo rechaza, pero preferimos fallar
    // aquí con un mensaje claro que con un error de restricción.
    if (!Number.isInteger(params.amount) || params.amount === 0) {
      throw new BadRequestException(
        'El monto debe ser un número entero distinto de cero',
      );
    }

    try {
      // dataSource.transaction abre BEGIN, y hace COMMIT si la función
      // termina bien o ROLLBACK si lanza. Todo o nada.
      return await this.dataSource.transaction(async (manager) => {
        // ---- 1. Idempotencia ----------------------------------------
        // Si esta llave ya se procesó, devolvemos el movimiento original
        // en vez de crear uno nuevo. Es lo que hace que un doble clic del
        // mesero no cobre dos veces.
        if (params.idempotencyKey) {
          const existente = await manager.findOne(CreditTransaction, {
            where: { idempotencyKey: params.idempotencyKey },
          });
          if (existente) {
            return existente;
          }
        }

        // ---- 2. Asegurar que la cuenta exista ------------------------
        // ON CONFLICT DO NOTHING resuelve la carrera de dos primeras
        // cargas simultáneas para el mismo par (usuario, venue): una
        // inserta, la otra no hace nada, ninguna falla.
        await manager.query(
          `INSERT INTO credit_accounts (user_id, venue_id)
           VALUES ($1, $2)
           ON CONFLICT (user_id, venue_id) DO NOTHING`,
          [params.userId, params.venueId],
        );

        // ---- 3. EL BLOQUEO ------------------------------------------
        // pessimistic_write genera SELECT ... FOR UPDATE. Desde esta
        // línea hasta el COMMIT, cualquier otra transacción que pida
        // esta misma fila se queda esperando. Aquí es donde se cierra el
        // hueco entre leer y escribir.
        const cuenta = await manager.findOne(CreditAccount, {
          where: { userId: params.userId, venueId: params.venueId },
          lock: { mode: 'pessimistic_write' },
        });

        if (!cuenta) {
          throw new BadRequestException(
            'No se pudo abrir la cuenta de créditos de este cliente en este negocio',
          );
        }

        // ---- 4. Decidir, ya en exclusiva ----------------------------
        const saldoNuevo = cuenta.balance + params.amount;

        if (saldoNuevo < 0) {
          throw new BadRequestException(
            `Saldo insuficiente: la cuenta tiene ${cuenta.balance} crédito(s) y se intentan descontar ${Math.abs(params.amount)}`,
          );
        }

        // ---- 5. El asiento en el libro mayor ------------------------
        const movimiento = manager.create(CreditTransaction, {
          creditAccountId: cuenta.id,
          type: params.type,
          amount: params.amount,
          balanceAfter: saldoNuevo,
          paymentMethod: params.paymentMethod ?? null,
          cashAmount: params.cashAmount ?? null,
          createdByStaffId: params.createdByStaffId ?? null,
          queueRequestId: params.queueRequestId ?? null,
          reversesTransactionId: params.reversesTransactionId ?? null,
          idempotencyKey: params.idempotencyKey ?? null,
        });
        const guardado = await manager.save(movimiento);

        // ---- 6. Y el saldo materializado ----------------------------
        // Estas dos escrituras (5 y 6) son las que DEBEN cuadrar. Están
        // en la misma transacción justamente para que sea imposible que
        // una ocurra sin la otra.
        cuenta.balance = saldoNuevo;
        cuenta.lastActivityAt = new Date();
        await manager.save(cuenta);

        return guardado;
      });
    } catch (error) {
      // Carrera de idempotencia: dos peticiones con la misma llave
      // entraron a la vez y ambas pasaron el paso 1 antes de que
      // ninguna hubiera insertado. La base rechaza a la segunda con
      // violación de UNIQUE; devolvemos el movimiento que sí quedó.
      //
      // Es la defensa en profundidad de siempre: el chequeo del paso 1
      // cubre el caso normal, la restricción de la base cubre la carrera.
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

  // ==============================================================
  // El pago de haber elegido montos CON SIGNO: la integridad de todo el
  // módulo de dinero se verifica con una sola suma.
  //
  // El saldo es caché; el ledger es la verdad. Si estos dos números no
  // coinciden, hay corrupción — y esto la detecta sin adivinar.
  // Es la base de la prueba de integridad de Épica 7.
  // ==============================================================
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

    // SUM() en Postgres devuelve NUMERIC/bigint, que pg entrega como
    // string — el mismo motivo por el que existe NumericColumnTransformer.
    const sumaLedger = Number(filas[0]?.suma ?? 0);

    return {
      balance: cuenta.balance,
      sumaLedger,
      ok: cuenta.balance === sumaLedger,
    };
  }
}
