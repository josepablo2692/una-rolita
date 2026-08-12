// apps/api/src/modules/auth/jwt/refresh-token.service.ts
//
// ROADMAP — Épica 1. Maneja el ciclo de vida completo del refresh
// token: firma, verificación, y revocación (individual o total).
// Usa su PROPIA instancia de JwtService (no la de AppJwtModule) porque
// necesita secret y expiración distintos al access token.

import { Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { JwtModuleOptions } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../redis/redis.module';

// Mismo tipo que ya resolviste en jwt.module.ts — necesario aquí también
// porque esta clase firma un JWT con su propia expiración configurable.
type ExpiresIn = NonNullable<JwtModuleOptions['signOptions']>['expiresIn'];

interface RefreshPayload {
  sub: string;
  jti: string;
}

@Injectable()
export class RefreshTokenService {
  private readonly refreshJwt: JwtService;

  constructor(
    configService: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    this.refreshJwt = new JwtService({
      secret: configService.get<string>('JWT_REFRESH_SECRET'),
      signOptions: {
        expiresIn: (configService.get<string>('JWT_REFRESH_EXPIRES_IN') ??
          '7d') as ExpiresIn,
      },
    });
  }

  // Firma un refresh token nuevo Y lo registra en Redis en dos lugares:
  // uno para validarlo rápido por jti, otro para poder revocar TODOS
  // los de un usuario de un jalón (caso "perdí mi celular").
  async generate(userId: string): Promise<string> {
    const jti = randomUUID();
    const token = this.refreshJwt.sign({ sub: userId, jti });

    const ttlSeconds = 7 * 24 * 60 * 60; // 7 días, mismo valor que JWT_REFRESH_EXPIRES_IN
    await this.redis.set(`refresh:${jti}`, userId, 'EX', ttlSeconds);
    await this.redis.sadd(`refresh:user:${userId}`, jti);
    await this.redis.expire(`refresh:user:${userId}`, ttlSeconds);

    return token;
  }

  // Verifica firma + que el jti siga "vivo" en Redis (no revocado).
  // Devuelve el userId si es válido, o lanza si no.
  async verify(token: string): Promise<{ userId: string; jti: string }> {
    let payload: RefreshPayload;
    try {
      payload = this.refreshJwt.verify<RefreshPayload>(token);
    } catch {
      throw new UnauthorizedException('Refresh token inválido o expirado');
    }

    const storedUserId = await this.redis.get(`refresh:${payload.jti}`);
    if (!storedUserId || storedUserId !== payload.sub) {
      throw new UnauthorizedException('Refresh token revocado o inválido');
    }

    return { userId: payload.sub, jti: payload.jti };
  }

  // Rotación: cada vez que se usa un refresh token para pedir uno nuevo,
  // el viejo muere. Si alguien roba un refresh token usado, el legítimo
  // dueño lo nota porque el SUYO deja de funcionar primero.
  async revoke(jti: string, userId: string): Promise<void> {
    await this.redis.del(`refresh:${jti}`);
    await this.redis.srem(`refresh:user:${userId}`, jti);
  }

  // El botón de emergencia: "perdí mi celular, ciérrame todo".
  async revokeAllForUser(userId: string): Promise<void> {
    const jtis = await this.redis.smembers(`refresh:user:${userId}`);
    if (jtis.length > 0) {
      const keys = jtis.map((jti) => `refresh:${jti}`);
      await this.redis.del(...keys);
    }
    await this.redis.del(`refresh:user:${userId}`);
  }
}
