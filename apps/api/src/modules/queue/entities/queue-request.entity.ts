import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { Venue } from '../../venues/entities/venue.entity';
import { VenueTable } from '../../venues/entities/venue-table.entity';
import { VenueSession } from '../../venues/entities/venue-session.entity';
import { User } from '../../auth/entities/user.entity';
import { Song } from './song.entity';
import { NumericColumnTransformer } from '../../../common/transformers/numeric.transformer';

export type QueueRequestStatus =
  'queued' | 'playing' | 'played' | 'skipped' | 'cancelled';

// Traduce `queue_requests` — un pedido de canción concreto, con su
// posición en la cola y si fue un salto de cola pagado.

@Entity('queue_requests')
export class QueueRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'venue_id', type: 'uuid' })
  venueId!: string;

  @ManyToOne(() => Venue)
  @JoinColumn({ name: 'venue_id' })
  venue!: Venue;

  // A qué noche pertenece el pedido. La cola no es perpetua: cuando la
  // sesión se cierra, los pedidos que quedaron se saltan y se reembolsan.
  @Column({ name: 'session_id', type: 'uuid' })
  sessionId!: string;

  @ManyToOne(() => VenueSession)
  @JoinColumn({ name: 'session_id' })
  session!: VenueSession;

  @Column({ name: 'table_id', type: 'uuid' })
  tableId!: string;

  @ManyToOne(() => VenueTable)
  @JoinColumn({ name: 'table_id' })
  table!: VenueTable;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'song_id', type: 'uuid' })
  songId!: string;

  @ManyToOne(() => Song)
  @JoinColumn({ name: 'song_id' })
  song!: Song;

  @Column({ type: 'int' })
  position!: number;

  @Column({ type: 'varchar', length: 20, default: 'queued' })
  status!: QueueRequestStatus;

  @Column({ name: 'is_paid_jump', default: false })
  isPaidJump!: boolean;

  @Column({
    name: 'paid_amount',
    type: 'numeric',
    precision: 10,
    scale: 2,
    default: 0,
    transformer: new NumericColumnTransformer(),
  })
  paidAmount!: number;

  @CreateDateColumn({ name: 'requested_at' })
  requestedAt!: Date;

  @Column({ name: 'played_at', type: 'timestamptz', nullable: true })
  playedAt!: Date | null;
}
