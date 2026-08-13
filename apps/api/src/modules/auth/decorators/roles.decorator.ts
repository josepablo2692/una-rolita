// apps/api/src/modules/auth/decorators/roles.decorator.ts
//
// ROADMAP — Épica 1, RolesGuard. SetMetadata es la forma en que Nest
// te deja "pegar una etiqueta invisible" sobre una clase o método —
// el decorador @Roles('dj', 'staff') no hace nada por sí solo, solo
// GUARDA esa lista en un lugar que RolesGuard va a poder leer después.
import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
