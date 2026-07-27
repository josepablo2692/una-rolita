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
import { QueueRequest } from './queue-request.entity';

// Traduce `queue_jumps` — registra cada salto de cola pagado, por usuario.
// songsPlayedSnapshot guarda cuántas canciones habían sonado en el venue
// al momento del salto: el cooldown se valida comparando ese número contra
// el conteo actual (cooldown por actividad, no por reloj).

@Entity('queue_jumps')
export class QueueJump {
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

  @Column({ name: 'queue_request_id', type: 'uuid' })
  queueRequestId!: string;

  @ManyToOne(() => QueueRequest)
  @JoinColumn({ name: 'queue_request_id' })
  queueRequest!: QueueRequest;

  @Column({ name: 'songs_played_snapshot', type: 'int' })
  songsPlayedSnapshot!: number;

  @CreateDateColumn({ name: 'jumped_at' })
  jumpedAt!: Date;
}
