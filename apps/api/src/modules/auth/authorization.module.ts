// apps/api/src/modules/auth/authorization.module.ts
//
// Módulo mínimo cuyo único trabajo es proveer VenueRolesGuard.
// Existe para evitar una dependencia circular: AuthModule ya importa
// VenuesModule, así que VenuesModule NO puede importar AuthModule.
// Este módulo solo depende de dos Entities (clases sueltas), no de
// AuthModule — por eso no cierra el círculo.
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserVenueRole } from './entities/user-venue-role.entity';
import { Role } from './entities/role.entity';
import { VenueRolesGuard } from './guards/venue-roles.guard';

@Module({
  imports: [TypeOrmModule.forFeature([UserVenueRole, Role])],
  providers: [VenueRolesGuard],
  exports: [VenueRolesGuard, TypeOrmModule],
})
export class AuthorizationModule {}
