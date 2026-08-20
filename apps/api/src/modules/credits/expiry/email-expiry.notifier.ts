// apps/api/src/modules/credits/expiry/email-expiry.notifier.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { ExpiryNotifier, AvisoDeExpiracion } from './expiry-notifier.interface';

// Formatea la fecha como la lee alguien en Guatemala: 15/03/2027.
const FORMATO_GT = new Intl.DateTimeFormat('es-GT', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

@Injectable()
export class EmailExpiryNotifier implements ExpiryNotifier {
  private readonly transporter: nodemailer.Transporter;

  constructor(private readonly configService: ConfigService) {
    // DEUDA CONOCIDA: esta configuración está duplicada con
    // EmailOtpSender. Se unifica en PR 6, cuando el módulo de avisos
    // tenga su propio transporte compartido. Duplicarla hoy es preferible
    // a acoplar el módulo de créditos con el de autenticación.
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

  async avisar(aviso: AvisoDeExpiracion): Promise<void> {
    const nombre = aviso.displayName ?? 'Hola';
    const fecha = FORMATO_GT.format(aviso.expiraEl);

    // El texto dice el monto, el local y la fecha exacta, y termina
    // diciendo cómo evitarlo. Un aviso que solo anuncia la pérdida sin
    // decir qué hacer es peor que no avisar: molesta y no sirve.
    const texto = [
      `${nombre},`,
      ``,
      `Tenés Q${aviso.balance} en créditos en ${aviso.venueName} que no has usado.`,
      ``,
      `Vencen el ${fecha}.`,
      ``,
      `Para conservarlos solo tenés que usarlos: pedí una canción en`,
      `${aviso.venueName} antes de esa fecha y el plazo vuelve a empezar.`,
      ``,
      `Una Rolita`,
    ].join('\n');

    // Si esto falla, la excepción SUBE. El job la necesita para no marcar
    // la cuenta como avisada y reintentar mañana.
    await this.transporter.sendMail({
      from: this.configService.get<string>('SMTP_FROM'),
      to: aviso.email,
      subject: `Tus créditos en ${aviso.venueName} vencen el ${fecha}`,
      text: texto,
    });
  }
}
