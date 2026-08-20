import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../auth/entities/user.entity';
import { Venue } from '../../venues/entities/venue.entity';

// Traduce `credit_accounts` — el saldo de un cliente EN UN VENUE
// específico. Un cliente que visita tres locales tiene TRES cuentas
// separadas: el crédito pertenece al dueño del venue donde se compró
// (ADR 0004) y no viaja entre negocios.
//
// OJO con `balance`: es CACHÉ, no la verdad. La verdad es SUM(amount)
// del ledger en credit_transactions. Se puede recomputar en cualquier
// momento para verificar que no hay corrupción (ADR 0006).

@Entity('credit_accounts')
export class CreditAccount {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'venue_id', type: 'uuid' })
  venueId!: string;

  @ManyToOne(() => Venue)
  @JoinColumn({ name: 'venue_id' })
  venue!: Venue;

  // Créditos ENTEROS (1 crédito = Q1).
  // Fijate que NO lleva NumericColumnTransformer: eso solo hace falta en
  // columnas NUMERIC, que Postgres devuelve como string para no perder
  // precisión. Un INTEGER llega como number de JavaScript sin traducción.
  // Elegir enteros nos ahorró esa clase entera de bugs (ADR 0006).
  @Column({ type: 'int', default: 0 })
  balance!: number;

  // Para la expiración por INACTIVIDAD: se actualiza en cada movimiento.
  @Column({
    name: 'last_activity_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  lastActivityAt!: Date;

  // Cuándo se le avisó al cliente que su saldo está por expirar.
  // NULL = no se le ha avisado en este ciclo de inactividad.
  //
  // Guarda el HECHO, no el canal: el mismo aviso sale por correo Y dentro
  // de la app, y ninguno de los dos debe repetirse cada día que corra el
  // job. Vuelve a NULL en cuanto la cuenta se mueve (ver applyLines).
  @Column({
    name: 'expiry_warning_sent_at',
    type: 'timestamptz',
    nullable: true,
  })
  expiryWarningSentAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
