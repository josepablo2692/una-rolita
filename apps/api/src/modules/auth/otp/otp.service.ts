// apps/api/src/modules/auth/otp/otp.service.ts
//
// ROADMAP — Paso 4 (registro con OTP).
// Responsabilidad única: generar, guardar y verificar códigos OTP.
// NO crea usuarios ni firma JWT — eso lo orquesta AuthService,
// que va a inyectar este servicio como una pieza más (Paso 5:
// endpoint de "upgrade" de invitado a usuario autenticado).

import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import Redis from 'ioredis';
import { randomInt } from 'crypto';
import { REDIS_CLIENT } from '../../../redis/redis.module';
import { OTP_SENDER } from './otp-sender.interface';
import type { OtpSender } from './otp-sender.interface';
import {
  OTP_CODE_LENGTH,
  OTP_TTL_SECONDS,
  OTP_RESEND_COOLDOWN_SECONDS,
} from './otp.constants';

@Injectable()
export class OtpService {
  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
    @Inject(OTP_SENDER)
    private readonly otpSender: OtpSender,
  ) {}

  // Punto de entrada de POST /auth/otp/request (lo construimos en el
  // siguiente paso). Genera el código, lo guarda con expiración corta,
  // y lo envía por el canal que sea (hoy: email; mañana: SMS/WhatsApp
  // sin tocar esta línea, gracias al token OTP_SENDER).
  async requestOtp(email: string): Promise<void> {
    const cooldownKey = this.cooldownKey(email);
    const stillOnCooldown = await this.redis.get(cooldownKey);
    if (stillOnCooldown) {
      throw new BadRequestException(
        'Ya se envió un código recientemente, espera antes de pedir otro',
      );
    }

    const code = this.generateCode();

    // 'EX' = expira en segundos. Sin flag 'NX': si ya había un código
    // viejo sin usar, este lo reemplaza — el usuario solo necesita
    // el último código que pidió.
    await this.redis.set(this.codeKey(email), code, 'EX', OTP_TTL_SECONDS);
    await this.redis.set(cooldownKey, '1', 'EX', OTP_RESEND_COOLDOWN_SECONDS);

    await this.otpSender.send(email, code);
  }

  // Punto de entrada de POST /auth/otp/verify. Devuelve true/false;
  // qué hacer con ese resultado (crear User, firmar JWT) es decisión
  // de AuthService, no de este servicio.
  async verifyOtp(email: string, code: string): Promise<boolean> {
    const codeKey = this.codeKey(email);
    const storedCode = await this.redis.get(codeKey);

    if (!storedCode || storedCode !== code) {
      return false;
    }

    // Un OTP es de un solo uso: se borra apenas se valida, aunque su
    // TTL todavía no haya vencido — evita que el mismo código sirva
    // dos veces si alguien lo intercepta.
    await this.redis.del(codeKey);
    return true;
  }

  private generateCode(): string {
    // randomInt (de 'crypto') es criptográficamente seguro, a
    // diferencia de Math.random() — importa porque este código es,
    // ni más ni menos, una contraseña temporal.
    const max = 10 ** OTP_CODE_LENGTH;
    return randomInt(0, max).toString().padStart(OTP_CODE_LENGTH, '0');
  }

  private codeKey(email: string): string {
    return `otp:code:${email}`;
  }

  private cooldownKey(email: string): string {
    return `otp:cooldown:${email}`;
  }
}
