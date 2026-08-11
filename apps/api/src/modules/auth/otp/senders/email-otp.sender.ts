// apps/api/src/modules/auth/otp/senders/email-otp.sender.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { OtpSender } from '../otp-sender.interface';

@Injectable()
export class EmailOtpSender implements OtpSender {
  private readonly transporter: nodemailer.Transporter;

  constructor(private readonly configService: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.configService.get<string>('SMTP_HOST'),
      port: this.configService.get<number>('SMTP_PORT'),
      secure: false,
      auth: {
        user: this.configService.get<string>('SMTP_USER'),
        pass: this.configService.get<string>('SMTP_PASS'),
      },
    });
  }

  async send(destination: string, code: string): Promise<void> {
    await this.transporter.sendMail({
      from: this.configService.get<string>('SMTP_FROM'),
      to: destination,
      subject: 'Tu código de Una Rolita',
      text: `Tu código de verificación es: ${code}`,
    });
  }
}
