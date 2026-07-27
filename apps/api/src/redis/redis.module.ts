import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

// Token de inyección: NestJS necesita un identificador para poder
// "inyectar" este cliente de Redis en cualquier Service que lo pida,
// igual que @InjectRepository hace con TypeORM.
export const REDIS_CLIENT = 'REDIS_CLIENT';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        return new Redis(config.get<string>('REDIS_URL')!);
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
