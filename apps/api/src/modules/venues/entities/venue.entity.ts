import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
//Aplicamos de nuevo DRY para proximos transformar datos numericos
import { NumericColumnTransformer } from '../../../common/transformers/numeric.transformer';

// Traduce la tabla `venues` de schema.sql a una clase de TypeScript.
// TypeORM usa esta clase para leer/escribir filas de esa tabla sin que
// tengamos que escribir SQL a mano en cada consulta.

export type VenueType = 'bar' | 'gym' | 'strip_club' | 'live_music';
export type PlaylistMode = 'free' | 'curated';
export type PlaybackMode = 'spotify_managed' | 'dj_manual';

@Entity('venues') // nombre exacto de la tabla en Postgres
export class Venue {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 150 })
  name!: string;

  @Column({ type: 'varchar', length: 30 })
  type!: VenueType;

  @Column({
    name: 'playlist_mode',
    type: 'varchar',
    length: 20,
    default: 'free',
  })
  playlistMode!: PlaylistMode;

  @Column({
    name: 'playback_mode',
    type: 'varchar',
    length: 20,
    default: 'spotify_managed',
  })
  playbackMode!: PlaybackMode;

  @Column({ name: 'cooldown_hours', type: 'int', default: 3 })
  cooldownHours!: number;

  @Column({
    name: 'queue_jump_price',
    type: 'numeric',
    precision: 10,
    scale: 2,
    default: 5.0,
    transformer: new NumericColumnTransformer(),
  })
  queueJumpPrice!: number;

  @Column({
    name: 'dedication_price',
    type: 'numeric',
    precision: 10,
    scale: 2,
    default: 3.0,
    transformer: new NumericColumnTransformer(),
  })
  dedicationPrice!: number;

  @Column({
    name: 'combo_jump_dedication_price',
    type: 'numeric',
    precision: 10,
    scale: 2,
    default: 7.0,
    transformer: new NumericColumnTransformer(),
  })
  comboJumpDedicationPrice!: number;

  @Column({ name: 'bank_account_info', type: 'jsonb', nullable: true })
  bankAccountInfo!: Record<string, unknown> | null;

  @Column({ name: 'spotify_account_id', type: 'uuid', nullable: true })
  spotifyAccountId!: string | null;

  @Column({ name: 'is_active', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
