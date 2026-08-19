import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { User } from '../../auth/entities/user.entity';
import { QueueRequest } from '../../queue/entities/queue-request.entity';
import { CreditAccount } from './credit-account.entity';
import { NumericColumnTransformer } from '../../../common/transformers/numeric.transformer';

// Tipos de movimiento. Granular a propósito: el backlog pide separar en
// renglones un mismo checkout (salto + dedicatoria), y Épica 8 va a
// querer saber cuánto se vendió de cada cosa.
export type CreditTransactionType =
  | 'topup_manual' //     carga en recepción (efectivo/tarjeta)
  | 'topup_gateway' //    carga por pasarela (Recurrente)
  | 'grant_free_song' //  canción gratis por registro
  | 'charge_song' //      cobro base por pedir una canción
  | 'charge_jump' //      cobro por saltar la cola
  | 'charge_dedication' //cobro por dedicatoria
  | 'refund' //           devolución (el LOCAL incumplió: artista saltó el pedido)
  | 'reversal' //         nota de crédito (corrección de un error de caja)
  | 'expiration'; //      caducidad por inactividad de la cuenta

// Se conservan los valores en español que ya existían en el esquema.
export type CreditPaymentMethod =
  | 'efectivo_recepcion'
  | 'tarjeta_recepcion'
  | 'transferencia_directa'
  | 'recurrente';

// Traduce `credit_transactions` — el libro mayor. APPEND-ONLY: nunca se
// hace UPDATE ni DELETE. Corregir un error significa INSERTAR una
// transacción reversa que apunta a la original (ADR 0006).
//
// La base lo hace cumplir con un trigger, no es solo convención: si algo
// intenta editar una fila, Postgres la rechaza. Por eso esta entidad NO
// lleva @UpdateDateColumn — la tabla ni siquiera tiene updated_at.
//
// INVARIANTE DEL SISTEMA: SUM(amount) = credit_accounts.balance

@Entity('credit_transactions')
export class CreditTransaction {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'credit_account_id', type: 'uuid' })
  creditAccountId!: string;

  @ManyToOne(() => CreditAccount)
  @JoinColumn({ name: 'credit_account_id' })
  creditAccount!: CreditAccount;

  @Column({ type: 'varchar', length: 20 })
  type!: CreditTransactionType;

  // CON SIGNO: positivo entra, negativo sale. El signo es lo que hace que
  // SUM(amount) sea el saldo, y convierte la integridad de todo el módulo
  // en una sola consulta SQL.
  @Column({ type: 'int' })
  amount!: number;

  // Foto del saldo justo después de este movimiento. Redundante a
  // propósito: permite auditar sin recorrer todo el historial.
  @Column({ name: 'balance_after', type: 'int' })
  balanceAfter!: number;

  // Solo tiene sentido en recargas; en cobros va null.
  @Column({
    name: 'payment_method',
    type: 'varchar',
    length: 25,
    nullable: true,
  })
  paymentMethod!: CreditPaymentMethod | null;

  // Quetzales REALES recibidos en caja. Aquí sí va NUMERIC con transformer:
  // es dinero de verdad y puede llevar centavos. El crédito no.
  @Column({
    name: 'cash_amount',
    type: 'numeric',
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: new NumericColumnTransformer(),
  })
  cashAmount!: number | null;

  // Auditoría: qué empleado registró la carga en recepción.
  @Column({ name: 'created_by_staff_id', type: 'uuid', nullable: true })
  createdByStaffId!: string | null;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'created_by_staff_id' })
  createdByStaff!: User | null;

  // Nota de crédito: apunta a la transacción que esta corrige.
  @Column({ name: 'reverses_transaction_id', type: 'uuid', nullable: true })
  reversesTransactionId!: string | null;

  @ManyToOne(() => CreditTransaction)
  @JoinColumn({ name: 'reverses_transaction_id' })
  reversesTransaction!: CreditTransaction | null;

  // Traza el cobro al pedido que lo originó — necesario para reembolsar.
  @Column({ name: 'queue_request_id', type: 'uuid', nullable: true })
  queueRequestId!: string | null;

  @ManyToOne(() => QueueRequest)
  @JoinColumn({ name: 'queue_request_id' })
  queueRequest!: QueueRequest | null;

  // Hoy sin uso. Se conserva porque preserva el camino a lotes FIFO sin
  // rehacer el modelo: el historial es completo e inmutable, así que
  // siempre se puede reconstruir un modelo más rico (ADR 0006).
  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  // Antifraude de doble clic: la misma llave nunca se cobra dos veces.
  // En Postgres los NULL no chocan entre sí en un UNIQUE, así que solo
  // restringe a las filas que sí traen llave.
  @Column({
    name: 'idempotency_key',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  idempotencyKey!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
