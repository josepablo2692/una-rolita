import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

// Traduce la tabla `songs` — catálogo de canciones (provenientes de Spotify
// u otro proveedor a futuro), independiente de qué local las pidió.

@Entity('songs')
export class Song {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 20, default: 'spotify' })
  provider!: string;

  @Column({ name: 'provider_track_id', type: 'varchar', length: 100 })
  providerTrackId!: string;

  @Column({ length: 200 })
  title!: string;

  @Column({ length: 200 })
  artist!: string;

  @Column({ name: 'duration_ms', type: 'int', nullable: true })
  durationMs!: number | null;
}
