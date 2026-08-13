// apps/api/src/modules/auth/entities/user-venue-role.entity.ts
//
// ROADMAP — Épica 1, login de staff. Traduce `user_venue_roles` —
// la tabla que responde "¿qué rol tiene ESTE usuario en ESTE venue
// específico?". Es una tabla puente (many-to-many con un dato extra,
// el rol) — por eso su llave primaria son TRES columnas juntas, no
// una sola. En TypeORM, eso se logra con varios @PrimaryColumn().
import { Entity, PrimaryColumn } from 'typeorm';

@Entity('user_venue_roles')
export class UserVenueRole {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @PrimaryColumn({ name: 'venue_id', type: 'uuid' })
  venueId!: string;

  @PrimaryColumn({ name: 'role_id', type: 'int' })
  roleId!: number;
}
