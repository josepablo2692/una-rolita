import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { Notification } from './notification.entity';

export type DeliveryChannel = 'email' | 'in_app';
export type DeliveryStatus = 'sent' | 'failed';

// Traduce `notification_deliveries` — la bitácora de intentos.
//
// APPEND-ONLY, con trigger en la base igual que el libro mayor. Una
// bitácora que se puede editar no demuestra nada, y con la expiración de
// créditos esto dejó de ser un detalle técnico: es lo que respalda haber
// avisado antes de tocarle el dinero a alguien.

@Entity('notification_deliveries')
export class NotificationDelivery {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'notification_id', type: 'uuid' })
  notificationId!: string;

  @ManyToOne(() => Notification)
  @JoinColumn({ name: 'notification_id' })
  notification!: Notification;

  @Column({ type: 'varchar', length: 20 })
  channel!: DeliveryChannel;

  @Column({ type: 'varchar', length: 20 })
  status!: DeliveryStatus;

  // A dónde se mandó, COPIADO tal como estaba en ese momento. Si mañana
  // el cliente cambia de correo, la bitácora debe seguir diciendo a dónde
  // se mandó realmente.
  @Column({ type: 'varchar', length: 255, nullable: true })
  destination!: string | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
