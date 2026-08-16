// apps/api/src/modules/auth/guards/venue-roles.guard.ts
//
// Resuelve el rol del usuario EN EL VENUE DE LA RUTA, consultando
// user_venue_roles. No usa el `role` del JWT para decidir permisos de
// venue: ese campo solo dice "algún rol en algún lado", y confiar en él
// permite que un venue_admin del Bar A actúe como admin del Bar B.
//
// Va SIEMPRE después de JwtAuthGuard: necesita que req.user exista.
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { UserVenueRole } from '../entities/user-venue-role.entity';
import { Role } from '../entities/role.entity';

interface RequestWithUser {
  params: Record<string, string>;
  method: string;
  url: string;
  user?: { userId: string; role: string; venueId?: string };
  venueRoles?: string[];
}

@Injectable()
export class VenueRolesGuard implements CanActivate {
  private readonly logger = new Logger(VenueRolesGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @InjectRepository(UserVenueRole)
    private readonly userVenueRoleRepository: Repository<UserVenueRole>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();

    // Guard Clause: si no hay user, este guard se puso sin JwtAuthGuard
    // delante. Es un error de programación, no del cliente.
    if (!request.user) {
      throw new InternalServerErrorException(
        'VenueRolesGuard requiere JwtAuthGuard antes en la cadena',
      );
    }

    // El venue puede venir como :venueId (rutas anidadas) o :id
    // (rutas directas de venue).
    const venueId = request.params.venueId ?? request.params.id;
    if (!venueId) {
      throw new InternalServerErrorException(
        'VenueRolesGuard usado en una ruta sin :venueId ni :id',
      );
    }

    // super_admin es el dueño de la plataforma: pasa por encima de la
    // pertenencia para poder dar soporte a cualquier negocio.
    // TODO Épica 3: persistir esto en audit_logs con el patrón de
    // auditoría que montemos para los créditos.
    if (request.user.role === 'super_admin') {
      this.logger.warn(
        `super_admin ${request.user.userId} accedió a venue ${venueId} — ${request.method} ${request.url}`,
      );
      request.venueRoles = ['super_admin'];
      return true;
    }

    // Una sola consulta: trae los NOMBRES de los roles que este usuario
    // tiene en ESTE venue. Va contra la llave primaria compuesta
    // (user_id, venue_id, role_id), así que es una búsqueda por índice.
    const rows = await this.userVenueRoleRepository
      .createQueryBuilder('uvr')
      .innerJoin(Role, 'role', 'role.id = uvr.roleId')
      .select('role.name', 'name')
      .where('uvr.userId = :userId', { userId: request.user.userId })
      .andWhere('uvr.venueId = :venueId', { venueId })
      .getRawMany<{ name: string }>();

    const venueRoles = rows.map((r) => r.name);

    if (venueRoles.length === 0) {
      throw new ForbiddenException('No tienes acceso a este negocio');
    }

    // Se lo dejamos al request por si el Service lo necesita después,
    // para no repetir la consulta.
    request.venueRoles = venueRoles;

    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Sin @Roles(), basta con pertenecer al venue.
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const hasPermission = venueRoles.some((r) => requiredRoles.includes(r));
    if (!hasPermission) {
      throw new ForbiddenException(
        `Este endpoint requiere uno de estos roles en este negocio: ${requiredRoles.join(', ')}`,
      );
    }

    return true;
  }
}
