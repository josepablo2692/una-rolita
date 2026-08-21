import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { User } from '../../auth/entities/user.entity';
import { Venue } from '../../venues/entities/venue.entity';

export type NotificationType =
  | 'refund_night_close'
  | 'credits_expiring'
  | 'credits_expired'
  | 'rules_changed';

export type EmailStatus = 'not_applicable' | 'pending' | 'sent' | 'failed';

// Traduce `notifications` — un aviso que el cliente ve dentro de la app.
//
// Esta fila ES el canal in-app: no hay que "enviarla", existir alcanza.
// `email_status` gobierna únicamente el canal externo.

@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user!: User;

  // Nullable: un cambio de reglas de la plataforma no pertenece a ningún
  // local.
  @Column({ name: 'venue_id', type: 'uuid', nullable: true })
  venueId!: string | null;

  @ManyToOne(() => Venue)
  @JoinColumn({ name: 'venue_id' })
  venue!: Venue | null;

  @Column({ type: 'varchar', length: 40 })
  type!: NotificationType;

  @Column({ type: 'varchar', length: 150 })
  title!: string;

  @Column({ type: 'text' })
  body!: string;

  // Los datos crudos del aviso: monto, id del pedido, fecha de
  // vencimiento. Permite que la app arme su propia presentación sin
  // volver a consultar, y que el texto cambie sin perder el dato.
  @Column({ type: 'jsonb', nullable: true })
  data!: Record<string, unknown> | null;

  @Column({ name: 'read_at', type: 'timestamptz', nullable: true })
  readAt!: Date | null;

  @Column({
    name: 'email_status',
    type: 'varchar',
    length: 20,
    default: 'not_applicable',
  })
  emailStatus!: EmailStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
