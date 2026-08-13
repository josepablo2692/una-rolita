// apps/api/src/modules/auth/guards/roles.guard.ts
//
// ROADMAP — Épica 1, RolesGuard. Se ejecuta DESPUÉS de JwtAuthGuard
// (por eso siempre van juntos en @UseGuards(JwtAuthGuard, RolesGuard),
// en ese orden) — necesita que req.user YA exista, y eso solo pasa
// si el JWT ya fue validado antes.
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  // Reflector es una pieza que Nest te da gratis (no la registras en
  // ningún módulo) — su trabajo es "leer etiquetas" que dejaron los
  // decoradores, como la que pusiste con @Roles(...).
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Busca la lista de roles permitidos, revisando primero el
    // método específico y si no encuentra nada, la clase completa.
    // Si un endpoint no tiene @Roles() en absoluto, requiredRoles
    // queda undefined — y lo dejamos pasar (JwtAuthGuard ya validó
    // que el token es válido; sin @Roles(), cualquier rol autenticado
    // entra).
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<{ user: { role: string } }>();

    const hasPermission = requiredRoles.includes(request.user.role);

    if (!hasPermission) {
      // Guard Clause con mensaje explícito — mejor que un 403 mudo,
      // le dice a quien depure esto exactamente qué faltó.
      throw new ForbiddenException(
        `Este endpoint requiere uno de estos roles: ${requiredRoles.join(', ')}`,
      );
    }

    return true;
  }
}
