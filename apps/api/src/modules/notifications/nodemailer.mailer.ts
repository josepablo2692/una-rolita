// apps/api/src/modules/notifications/nodemailer.mailer.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { Mailer, CorreoSalida } from './mailer.interface';

@Injectable()
export class NodemailerMailer implements Mailer {
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

  async enviar(correo: CorreoSalida): Promise<void> {
    // Si falla, la excepción SUBE. La bitácora la necesita para registrar
    // el intento fallido con su error.
    await this.transporter.sendMail({
      from: this.configService.get<string>('SMTP_FROM'),
      to: correo.to,
      subject: correo.subject,
      text: correo.text,
    });
  }
}
