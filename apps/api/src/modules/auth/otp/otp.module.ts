// apps/api/src/modules/auth/otp/otp.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisModule } from '../../../redis/redis.module';
import { OTP_SENDER } from './otp-sender.interface';
import { EmailOtpSender } from './senders/email-otp.sender';
import { OtpService } from './otp.service';
import { OtpController } from './otp.controller'; // ← nuevo

@Module({
  // RedisModule no es @Global(), así que hay que importarlo aquí para
  // que OtpService pueda inyectar REDIS_CLIENT (mismo patrón que QueueModule).
  imports: [ConfigModule, RedisModule],
  controllers: [OtpController], // ← nuevo
  providers: [
    EmailOtpSender,
    {
      provide: OTP_SENDER,
      useClass: EmailOtpSender,
    },
    OtpService,
  ],
  exports: [OtpService],
})
export class OtpModule {}
