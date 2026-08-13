// apps/api/src/modules/auth/entities/role.entity.ts
//
// ROADMAP — Épica 1, login de staff. Traduce la tabla `roles` —
// el catálogo fijo de roles posibles: super_admin, venue_admin, dj,
// staff, customer. Nota el id numérico (SERIAL en SQL), no UUID,
// a diferencia de casi todas tus otras tablas.
import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('roles')
export class Role {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 30, unique: true })
  name!: string;
}
