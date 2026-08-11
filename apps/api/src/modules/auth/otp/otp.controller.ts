// apps/api/src/modules/auth/otp/otp.controller.ts
//
// ROADMAP — Paso 4. Este archivo es la ÚNICA parte de todo lo que
// hemos construido que el celular del cliente puede "tocar"
// directamente, vía una URL. Todo lo demás (OtpService, EmailOtpSender)
// es invisible para afuera — trabaja detrás de este controller.

import { Body, Controller, Post } from '@nestjs/common';
import { OtpService } from './otp.service';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';

@Controller('auth/otp') // todo lo de esta clase vive bajo /auth/otp/...
export class OtpController {
  // Nest ve este constructor y automáticamente te entrega el
  // OtpService ya construido — es la inyección de dependencias
  // que vimos en el diagrama, aplicada aquí mismo.
  constructor(private readonly otpService: OtpService) {}

  // Se activa cuando algo hace: POST /auth/otp/request
  // con body: { "email": "cliente@correo.com" }
  @Post('request')
  async requestOtp(@Body() dto: RequestOtpDto): Promise<{ message: string }> {
    await this.otpService.requestOtp(dto.email);
    return { message: 'Código enviado, revisa tu correo' };
  }

  // Se activa cuando algo hace: POST /auth/otp/verify
  // con body: { "email": "cliente@correo.com", "code": "123456" }
  @Post('verify')
  async verifyOtp(@Body() dto: VerifyOtpDto): Promise<{ verified: boolean }> {
    const isValid = await this.otpService.verifyOtp(dto.email, dto.code);
    return { verified: isValid };
  }
}
