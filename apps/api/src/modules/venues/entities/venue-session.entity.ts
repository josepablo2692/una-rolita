import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { Venue } from './venue.entity';
import { User } from '../../auth/entities/user.entity';

// Traduce `venue_sessions` — una "noche" del local.
//
// La cola NO es perpetua: pertenece a una sesión. Al día siguiente hay
// otra playlist, otro cantante, otras canciones, y los pedidos que
// quedaron colgados de anoche no deben aparecer en la nueva.
//
// La sesión se abre SOLA con el primer pedido (apertura perezosa): la
// noche empieza cuando alguien pide música, no cuando alguien aprieta un
// botón. El cierre sí es explícito, porque mueve dinero: cerrar salta los
// pedidos pendientes y dispara sus reembolsos (ADR 0007).
//
// La base garantiza con un índice único parcial que un local no puede
// tener dos sesiones abiertas a la vez.

@Entity('venue_sessions')
export class VenueSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'venue_id', type: 'uuid' })
  venueId!: string;

  @ManyToOne(() => Venue)
  @JoinColumn({ name: 'venue_id' })
  venue!: Venue;

  @Column({ name: 'opened_at', type: 'timestamptz', default: () => 'now()' })
  openedAt!: Date;

  // Se actualiza en cada pedido. El job de cierre automático lo usa para
  // dos cosas: decidir SI cerrar, y con qué hora cerrar. Si cerrara con
  // la hora del job, una noche de 4h30m que nadie cerró mediría 8h30m.
  @Column({
    name: 'last_activity_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  lastActivityAt!: Date;

  // Null mientras la sesión está abierta. Es lo que consulta el índice
  // único parcial de la base.
  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @Column({ name: 'closed_by_user_id', type: 'uuid', nullable: true })
  closedByUserId!: string | null;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'closed_by_user_id' })
  closedByUser!: User | null;

  // Distingue "el DJ cerró" de "el sistema cerró porque se olvidaron".
  // Es un dato de calidad de operación, no solo un detalle técnico: dice
  // qué tan bien opera cada local.
  @Column({ name: 'closed_automatically', default: false })
  closedAutomatically!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
