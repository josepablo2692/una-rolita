// apps/api/src/modules/auth/guards/jwt-auth.guard.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  // Passport lanza un 401 con el texto "Unauthorized" en inglés y sin
  // contexto. Lo interceptamos para responder en español.
  // Ojo: el mensaje NO debe distinguir entre "no mandaste token",
  // "token vencido" y "firma inválida" — eso le daría pistas a quien
  // esté probando tokens. Mismo criterio que usamos en loginStaff.
  handleRequest<TUser = unknown>(err: unknown, user: TUser): TUser {
    if (err || !user) {
      throw new UnauthorizedException(
        'Tu sesión no es válida o ya venció. Inicia sesión de nuevo.',
      );
    }
    return user;
  }
}
