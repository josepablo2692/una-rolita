import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        return new Redis(config.get<string>('REDIS_URL')!, {
          // Por defecto ioredis reintenta conectarse INDEFINIDAMENTE sin
          // límite, lo que cuelga la app para siempre si Redis no está
          // disponible (nos pasó en el CI). Limitamos los reintentos para
          // que falle rápido y con un error claro, tanto en CI como en
          // producción si Redis real llegara a caerse.
          maxRetriesPerRequest: 3,
          retryStrategy: (times: number) => {
            if (times > 3) {
              return null; // deja de reintentar, lanza el error
            }
            return Math.min(times * 200, 1000); // espera progresiva corta
          },
        });
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
