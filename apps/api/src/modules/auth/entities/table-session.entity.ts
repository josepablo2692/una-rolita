import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { VenueTable } from '../../venues/entities/venue-table.entity';
import { User } from './user.entity';

// Traduce la tabla `table_sessions` de schema.sql.
// user_id es NULLABLE a propósito: representa el estado "invitado" antes
// de que el cliente complete el registro progresivo (OTP por teléfono).
// Esto es el patrón de progressive registration que definimos en el
// glosario del proyecto.

@Entity('table_sessions')
export class TableSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'table_id', type: 'uuid' })
  tableId!: string;

  @ManyToOne(() => VenueTable)
  @JoinColumn({ name: 'table_id' })
  table!: VenueTable;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId!: string | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'user_id' })
  user!: User | null;

  @Column({
    name: 'device_fingerprint',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  deviceFingerprint!: string | null;

  @CreateDateColumn({ name: 'started_at' })
  startedAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;
}
