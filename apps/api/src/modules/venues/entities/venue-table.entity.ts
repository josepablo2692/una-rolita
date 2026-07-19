import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { Venue } from './venue.entity';

// Traduce la tabla `tables` de schema.sql a una clase de TypeScript.
// Se llama "VenueTable" (no "Table") para no chocar con la clase interna
// `Table` que TypeORM ya usa en sus propias migraciones.

@Entity('tables') // el nombre real de la tabla en Postgres sigue siendo "tables"
export class VenueTable {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Esta columna guarda el UUID real (venue_id) — la necesitamos explícita
  // para poder filtrar/consultar sin tener que cargar el objeto Venue completo.
  @Column({ name: 'venue_id', type: 'uuid' })
  venueId!: string;

  // Esta es la relación en sí: "muchas mesas pertenecen a un mismo local".
  // @JoinColumn le dice a TypeORM que use la columna `venue_id` de arriba
  // para saber a qué Venue conectarse.
  @ManyToOne(() => Venue)
  @JoinColumn({ name: 'venue_id' })
  venue!: Venue;

  @Column({ length: 20 })
  label!: string; // ej. "Mesa 7"

  @Column({ name: 'qr_code_token', length: 100, unique: true })
  qrCodeToken!: string;

  @Column({ name: 'is_active', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
