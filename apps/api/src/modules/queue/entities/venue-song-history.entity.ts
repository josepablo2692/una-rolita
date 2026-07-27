import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { Venue } from '../../venues/entities/venue.entity';
import { Song } from './song.entity';

// Traduce `venue_song_history` — registra CADA vez que una canción sonó
// en un local específico. Es la base del cooldown: "no repetir una canción
// hasta que pasen X canciones" se valida consultando esta tabla.

@Entity('venue_song_history')
export class VenueSongHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'venue_id', type: 'uuid' })
  venueId!: string;

  @ManyToOne(() => Venue)
  @JoinColumn({ name: 'venue_id' })
  venue!: Venue;

  @Column({ name: 'song_id', type: 'uuid' })
  songId!: string;

  @ManyToOne(() => Song)
  @JoinColumn({ name: 'song_id' })
  song!: Song;

  @CreateDateColumn({ name: 'played_at' })
  playedAt!: Date;
}
