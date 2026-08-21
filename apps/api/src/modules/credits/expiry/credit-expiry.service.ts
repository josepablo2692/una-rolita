// apps/api/src/modules/credits/expiry/credit-expiry.service.ts
//
// Expiración de saldos por inactividad (ADR 0006 + su enmienda).
//
// Son DOS jobs, no uno, y el orden entre ellos es la regla de seguridad
// más importante del módulo:
//
//   UNA CUENTA NO EXPIRA SI NO SE LE AVISÓ ANTES.
//
// El aviso no es una cortesía: es una PRECONDICIÓN. Si el correo está
// caído un mes entero, no expira nada. Es el modo de falla correcto —
// ante la duda, el dinero se queda con el cliente.

import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CreditsService } from '../credits.service';
import { NotificationsService } from '../../notifications/notifications.service';

// Formatea la fecha como la lee alguien en Guatemala: 15/03/2027.
const FORMATO_GT = new Intl.DateTimeFormat('es-GT', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

// Cuántos días antes del vencimiento se avisa.
//
// Treinta y no siete: con una ventana de doce meses, alguien que no ha
// entrado en un año necesita margen real para acordarse, encontrar el
// local y volver. Siete días es un aviso que solo sirve para poder decir
// que avisamos.
const DIAS_DE_AVISO_PREVIO = 30;

interface FilaPorAvisar {
  id: string;
  user_id: string;
  venue_id: string;
  balance: number;
  email: string;
  display_name: string | null;
  venue_name: string;
  expira_el: Date;
}

interface FilaPorExpirar {
  id: string;
  user_id: string;
  venue_id: string;
  credit_expiry_months: number;
}

@Injectable()
export class CreditExpiryService {
  private readonly logger = new Logger(CreditExpiryService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly creditsService: CreditsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ==============================================================
  // JOB 1 — avisar. Corre ANTES que el de expiración, a propósito.
  // ==============================================================
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async avisarSaldosPorExpirar(): Promise<number> {
    // Los locales con credit_expiry_months = 0 quedan fuera EN EL WHERE,
    // no con un `if` después de traerlos. Mismo criterio que el venueId
    // en las consultas de pedidos: filtrar en la base es más barato y no
    // se olvida.
    const porAvisar = await this.dataSource.query<FilaPorAvisar[]>(
      `SELECT ca.id,
              ca.user_id,
              ca.venue_id,
              ca.balance,
              u.email,
              u.display_name,
              v.name AS venue_name,
              ca.last_activity_at
                + (v.credit_expiry_months * INTERVAL '1 month') AS expira_el
         FROM credit_accounts ca
         JOIN venues v ON v.id = ca.venue_id
         JOIN users  u ON u.id = ca.user_id
        WHERE ca.balance > 0
          AND ca.expiry_warning_sent_at IS NULL
          AND v.credit_expiry_months > 0
          AND ca.last_activity_at
              < now() - (v.credit_expiry_months * INTERVAL '1 month')
                      + ($1::int * INTERVAL '1 day')`,
      [DIAS_DE_AVISO_PREVIO],
    );

    let avisadas = 0;

    for (const fila of porAvisar) {
      const expiraEl = new Date(fila.expira_el);
      const fecha = FORMATO_GT.format(expiraEl);
      const nombre = fila.display_name ?? 'Hola';

      // El aviso sale por los DOS canales: queda como mensaje en la app
      // (la fila de notifications) y se manda el correo en el momento.
      //
      // crearYEnviarAhora y no crear(): este es el único aviso cuyo
      // correo hay que CONFIRMAR antes de actuar, porque lo que sigue es
      // quitarle el saldo a alguien. Los demás pueden esperar al job de
      // la mañana.
      const { correoEnviado } = await this.notifications.crearYEnviarAhora({
        userId: fila.user_id,
        venueId: fila.venue_id,
        type: 'credits_expiring',
        title: `Tenés Q${fila.balance} sin usar en ${fila.venue_name}`,
        body:
          `Tus créditos en ${fila.venue_name} vencen el ${fecha}. ` +
          `Para conservarlos solo tenés que usarlos: pedí una canción ` +
          `antes de esa fecha y el plazo vuelve a empezar.`,
        data: {
          creditos: fila.balance,
          expiraEl: expiraEl.toISOString(),
          venueName: fila.venue_name,
        },
        email: fila.email,
        asunto: `Tus créditos en ${fila.venue_name} vencen el ${fecha}`,
        cuerpoCorreo: [
          `${nombre},`,
          ``,
          `Tenés Q${fila.balance} en créditos en ${fila.venue_name} que no has usado.`,
          ``,
          `Vencen el ${fecha}.`,
          ``,
          `Para conservarlos solo tenés que usarlos: pedí una canción en`,
          `${fila.venue_name} antes de esa fecha y el plazo vuelve a empezar.`,
          ``,
          `Una Rolita`,
        ].join('\n'),
      });

      // LA LÍNEA QUE PROTEGE AL CLIENTE.
      //
      // La marca se pone SOLO si el correo salió. Si se pusiera siempre,
      // un servidor de correo caído dejaría la cuenta marcada como
      // avisada sin que nadie la haya avisado — y el job de expiración
      // la tomaría como lista para perder el saldo.
      //
      // El mensaje en la app no alcanza como prueba de aviso: quien no
      // entra en doce meses tampoco lo va a ver, y ése es exactamente el
      // cliente al que estamos por expirarle el dinero.
      //
      // El costo es que un fallo a mitad de camino puede mandar el correo
      // dos veces. Molestar a alguien con un correo repetido es
      // infinitamente preferible a quitarle el dinero en silencio.
      if (correoEnviado) {
        await this.dataSource.query(
          `UPDATE credit_accounts SET expiry_warning_sent_at = now() WHERE id = $1`,
          [fila.id],
        );
        avisadas += 1;
      }
      // Si no salió, la cuenta queda sin marcar y mañana se reintenta
      // sola. crearYEnviarAhora ya registró el fallo en la bitácora.
    }

    if (avisadas > 0) {
      this.logger.log(`Avisos de expiración enviados: ${avisadas}`);
    }

    return avisadas;
  }

  // ==============================================================
  // JOB 2 — expirar. Solo toca cuentas que YA fueron avisadas.
  // ==============================================================
  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async expirarSaldosInactivos(): Promise<number> {
    const porExpirar = await this.dataSource.query<FilaPorExpirar[]>(
      `SELECT ca.id,
              ca.user_id,
              ca.venue_id,
              v.credit_expiry_months
         FROM credit_accounts ca
         JOIN venues v ON v.id = ca.venue_id
        WHERE ca.balance > 0
          AND v.credit_expiry_months > 0
          AND ca.last_activity_at
              < now() - (v.credit_expiry_months * INTERVAL '1 month')
          -- LAS DOS CONDICIONES QUE PROTEGEN AL CLIENTE:
          -- que se le haya avisado, y que el aviso tenga ya sus días de
          -- gracia cumplidos. Si el aviso salió ayer (porque el job
          -- estuvo caído y se puso al día), el plazo corre desde ayer.
          AND ca.expiry_warning_sent_at IS NOT NULL
          AND ca.expiry_warning_sent_at
              < now() - ($1::int * INTERVAL '1 day')`,
      [DIAS_DE_AVISO_PREVIO],
    );

    let expiradas = 0;
    let creditosExpirados = 0;

    for (const fila of porExpirar) {
      try {
        const monto = await this.expirarCuenta(fila);
        if (monto > 0) {
          expiradas += 1;
          creditosExpirados += monto;
        }
      } catch (error) {
        // Una cuenta que falla no puede detener al resto.
        this.logger.error(
          `No se pudo expirar el saldo de la cuenta ${fila.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    if (expiradas > 0) {
      this.logger.warn(
        `Expiración: ${expiradas} cuenta(s), ${creditosExpirados} créditos`,
      );
    }

    return expiradas;
  }

  // Expira UNA cuenta. Devuelve cuántos créditos se expiraron (0 si no
  // aplicaba). Cada cuenta va en su propia transacción: expirar es
  // independiente por cliente, y una que falle no debe arrastrar al resto.
  private async expirarCuenta(fila: FilaPorExpirar): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const cuenta = await this.creditsService.ensureAndLockAccount(
        manager,
        fila.user_id,
        fila.venue_id,
      );

      // ---- RE-VERIFICACIÓN BAJO CANDADO ------------------------
      // La consulta de arriba es una PISTA, no un hecho. Entre esa
      // consulta y este candado pudieron pasar minutos, y en ese rato el
      // cliente pudo recargar o gastar. Expirar con el saldo viejo le
      // quitaría dinero que acababa de meter.
      if (cuenta.balance <= 0) {
        return 0;
      }

      // Y esta condición sola cubre "la cuenta volvió a moverse": cada
      // movimiento pasa por applyLines, que pone expiry_warning_sent_at
      // en NULL. Si está en NULL, es porque hubo actividad después de
      // que la seleccionamos, y ya no le toca expirar.
      if (cuenta.expiryWarningSentAt === null) {
        return 0;
      }

      const saldo = cuenta.balance;

      // Expirar es un movimiento más del libro mayor, con su razón
      // escrita. NUNCA un `UPDATE balance = 0`: sin el renglón, el
      // cliente ve que su dinero desapareció y no hay nada que mostrarle.
      await this.creditsService.applyLines({
        userId: fila.user_id,
        venueId: fila.venue_id,
        manager,
        lines: [
          {
            type: 'expiration',
            amount: -saldo,
            reason: `Saldo expirado tras ${fila.credit_expiry_months} meses sin actividad`,
          },
        ],
      });

      return saldo;
    });
  }
}
