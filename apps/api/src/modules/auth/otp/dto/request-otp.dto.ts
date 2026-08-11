// apps/api/src/modules/auth/otp/dto/request-otp.dto.ts
import { IsEmail } from 'class-validator';

export class RequestOtpDto {
  @IsEmail()
  email!: string; // ← el ! le dice a TS: "esto se llena después, confía"
}
