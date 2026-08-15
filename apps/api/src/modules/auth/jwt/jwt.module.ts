// apps/api/src/modules/auth/jwt/jwt.module.ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import type { JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';
import { RefreshTokenService } from './refresh-token.service';
import { RedisModule } from '../../../redis/redis.module';
import { GoogleStrategy } from '../google/google.strategy';

// El tipo real que espera jsonwebtoken ('15m', '7d', o segundos como number).
// Lo derivamos de @nestjs/jwt en vez de importar 'ms', que no es una
// dependencia de este paquete y resolvía a `any`.
type ExpiresIn = NonNullable<JwtModuleOptions['signOptions']>['expiresIn'];

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    RedisModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService): JwtModuleOptions => ({
        secret: config.get<string>('JWT_ACCESS_SECRET'),
        signOptions: {
          expiresIn: (config.get<string>('JWT_ACCESS_EXPIRES_IN') ??
            '15m') as ExpiresIn,
        },
      }),
    }),
  ],
  providers: [JwtStrategy, RefreshTokenService, GoogleStrategy],
  exports: [JwtModule, PassportModule, RefreshTokenService],
})
export class AppJwtModule {}
