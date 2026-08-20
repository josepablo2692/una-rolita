import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
//Aplicamos DRY para poder tranformar los datos de PG a TypeORM
import { NumericColumnTransformer } from '../../../common/transformers/numeric.transformer';

export type VenueType = 'bar' | 'gym' | 'strip_club' | 'live_music';
export type PlaylistMode = 'free' | 'curated';
export type PlaybackMode = 'spotify_managed' | 'dj_manual';

@Entity('venues')
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
  // Costo base de pedir una canción (Q1). Es el cobro más frecuente del
  // sistema y hasta ahora no tenía columna: vivía como número mágico.
  @Column({
    name: 'song_price',
    type: 'numeric',
    precision: 10,
    scale: 2,
    default: 1.0,
    transformer: new NumericColumnTransformer(),
  })
  songPrice!: number;

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
  // Meses de INACTIVIDAD antes de que expire el saldo de una cuenta.
  // Configurable por local: un gimnasio y una discoteca tienen ritmos
  // distintos (ADR 0006).
  @Column({ name: 'credit_expiry_months', type: 'int', default: 3 })
  creditExpiryMonths!: number;

  // Horas sin actividad tras las cuales el sistema cierra la noche solo.
  // Configurable por local: un bar cierra a las 2 a.m., un gimnasio a las
  // 9 p.m., y sus ritmos de inactividad no se parecen.
  @Column({ name: 'session_timeout_hours', type: 'int', default: 6 })
  sessionTimeoutHours!: number;

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
