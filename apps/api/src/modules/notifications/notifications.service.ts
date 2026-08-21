// apps/api/src/modules/notifications/notifications.service.ts
//
// El único lugar por donde salen los avisos al cliente.
//
// DOS RESPONSABILIDADES SEPARADAS, y la separación es el diseño:
//
//   crear()  → SOLO escribe filas. Nunca manda un correo. Por eso puede
//              participar en la transacción de quien la llama sin riesgo.
//   despacharCorreosPendientes() → manda. Corre aparte, agrupando por
//              persona.
//
// POR QUÉ NO SE MANDA EL CORREO AL CREAR: si el aviso se crea dentro de
// la transacción del cierre de noche y esa transacción falla, la fila
// desaparece — pero el correo ya salió y no se puede "des-enviar". Al
// separar, lo único que puede quedar a medias es una fila, y para eso
// está la base de datos.

import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Notification, NotificationType } from './entities/notification.entity';
import { NotificationDelivery } from './entities/notification-delivery.entity';
import { MAILER } from './mailer.interface';
// `import type` y no un import normal: con isolatedModules +
// emitDecoratorMetadata, un TIPO usado en una firma decorada (aquí el
// constructor con @Inject) tiene que importarse así. Si no, tsc intenta
// emitir metadata de algo que no existe en tiempo de ejecución y falla
// con TS1272. Mismo patrón que `import type { OtpSender }` en otp.service.
import type { Mailer } from './mailer.interface';

export interface CrearAvisoParams {
  userId: string;
  venueId?: string | null;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown> | null;
  /**
   * Si además del mensaje en la app debe salir por correo. El envío NO
   * ocurre aquí: la fila queda en 'pending' y la manda el job matutino,
   * agrupada con todo lo demás de esa persona.
   */
  porCorreo?: boolean;
  /**
   * Si viene, se escribe DENTRO de esa transacción. Es lo que permite
   * que cerrar la noche y avisarle al cliente sean una sola operación.
   */
  manager?: EntityManager;
}

interface FilaPendiente {
  notification_id: string;
  user_id: string;
  email: string;
  display_name: string | null;
  title: string;
  body: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject(MAILER)
    private readonly mailer: Mailer,
  ) {}

  // ==============================================================
  // Crear un aviso. Solo escribe; no manda nada.
  // ==============================================================
  async crear(params: CrearAvisoParams): Promise<Notification> {
    const escribir = async (manager: EntityManager): Promise<Notification> => {
      const aviso = await manager.save(
        manager.create(Notification, {
          userId: params.userId,
          venueId: params.venueId ?? null,
          type: params.type,
          title: params.title,
          body: params.body,
          data: params.data ?? null,
          emailStatus: params.porCorreo ? 'pending' : 'not_applicable',
        }),
      );

      // La entrega in-app se registra en el mismo momento porque ya está
      // hecha: la fila existe, el cliente la va a ver al abrir la app.
      // Puede parecer redundante, pero hace que una sola consulta a la
      // bitácora responda "¿por qué canales le avisamos de esto?".
      await manager.save(
        manager.create(NotificationDelivery, {
          notificationId: aviso.id,
          channel: 'in_app',
          status: 'sent',
        }),
      );

      return aviso;
    };

    return params.manager
      ? escribir(params.manager)
      : this.dataSource.transaction(escribir);
  }

  // ==============================================================
  // Crear un aviso Y mandarlo AHORA. Devuelve si el correo salió.
  // ==============================================================
  //
  // Existe para UN caso: el aviso previo de expiración de saldo. Es el
  // único aviso cuyo correo hay que CONFIRMAR antes de actuar, porque lo
  // que viene después es quitarle el dinero a alguien. Si el correo no
  // salió, quien llama no debe marcar la cuenta como avisada.
  //
  // Los demás avisos usan crear(): pueden esperar al job de la mañana,
  // y nada malo pasa si el correo se atrasa un día.
  //
  // NUNCA dentro de la transacción de otro: manda un correo, y un correo
  // enviado no se puede deshacer con un rollback.
  async crearYEnviarAhora(
    params: Omit<CrearAvisoParams, 'porCorreo' | 'manager'> & {
      email: string;
      asunto: string;
      cuerpoCorreo: string;
    },
  ): Promise<{ aviso: Notification; correoEnviado: boolean }> {
    const aviso = await this.crear({
      userId: params.userId,
      venueId: params.venueId,
      type: params.type,
      title: params.title,
      body: params.body,
      data: params.data,
      // 'pending' sería mentira: no lo va a mandar el job, lo mandamos
      // aquí mismo en la línea siguiente.
      porCorreo: false,
    });

    try {
      await this.mailer.enviar({
        to: params.email,
        subject: params.asunto,
        text: params.cuerpoCorreo,
      });

      await this.registrarEnvio(aviso.id, params.email, 'sent', null);
      return { aviso, correoEnviado: true };
    } catch (error) {
      const detalle = error instanceof Error ? error.message : String(error);

      await this.registrarEnvio(aviso.id, params.email, 'failed', detalle);

      this.logger.error(
        `No se pudo mandar el aviso ${aviso.id} a ${params.email}`,
        error instanceof Error ? error.stack : detalle,
      );

      // El aviso EXISTE (el cliente lo verá en la app) pero el correo no
      // salió. Quien llama decide qué hacer con eso.
      return { aviso, correoEnviado: false };
    }
  }

  // Registra un envío individual en las dos tablas.
  private async registrarEnvio(
    notificationId: string,
    destino: string,
    estado: 'sent' | 'failed',
    error: string | null,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.update(Notification, notificationId, {
        emailStatus: estado,
      });
      await manager.save(
        manager.create(NotificationDelivery, {
          notificationId,
          channel: 'email',
          status: estado,
          destination: destino,
          error,
        }),
      );
    });
  }

  // ==============================================================
  // Job matutino: manda los correos pendientes, AGRUPADOS por persona.
  // ==============================================================
  //
  // Agrupar no es una optimización, es la decisión de producto: una noche
  // con tres canciones sin sonar genera tres avisos, y tres correos a las
  // 2 de la mañana es acoso. Uno solo a las 9, con la lista adentro, es
  // información.
  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async despacharCorreosPendientes(): Promise<number> {
    const pendientes = await this.dataSource.query<FilaPendiente[]>(
      `SELECT n.id AS notification_id,
              n.user_id,
              u.email,
              u.display_name,
              n.title,
              n.body
         FROM notifications n
         JOIN users u ON u.id = n.user_id
        WHERE n.email_status = 'pending'
        ORDER BY n.user_id, n.created_at`,
    );

    if (pendientes.length === 0) {
      return 0;
    }

    // Agrupación en memoria y no con GROUP BY: necesitamos los textos
    // completos de cada aviso para armar el cuerpo, y un GROUP BY con
    // string_agg haría el SQL más difícil de leer sin ganar nada — son
    // pocas filas por definición (solo lo pendiente de un día).
    const porPersona = new Map<string, FilaPendiente[]>();
    for (const fila of pendientes) {
      const lista = porPersona.get(fila.user_id) ?? [];
      lista.push(fila);
      porPersona.set(fila.user_id, lista);
    }

    let enviados = 0;

    for (const [, avisos] of porPersona) {
      const destino = avisos[0].email;
      const nombre = avisos[0].display_name ?? 'Hola';

      try {
        await this.mailer.enviar({
          to: destino,
          subject: this.asuntoDe(avisos),
          text: this.cuerpoDe(nombre, avisos),
        });

        await this.registrarResultado(avisos, destino, 'sent', null);
        enviados += 1;
      } catch (error) {
        const detalle = error instanceof Error ? error.message : String(error);

        // Se marcan como 'failed', NO se dejan en 'pending'. Si volvieran
        // a quedar pendientes, mañana se reintentaría y el cliente podría
        // recibir el mismo correo por semanas si su buzón está lleno.
        // Queda el registro del fallo, que es lo que permite revisarlo.
        await this.registrarResultado(avisos, destino, 'failed', detalle);

        this.logger.error(
          `No se pudieron mandar ${avisos.length} aviso(s) a ${destino}`,
          error instanceof Error ? error.stack : detalle,
        );
      }
    }

    if (enviados > 0) {
      this.logger.log(`Correos de avisos enviados: ${enviados}`);
    }

    return enviados;
  }

  // Escribe el resultado en las DOS tablas: el estado en notifications y
  // la historia en deliveries. Una fila de bitácora por aviso, aunque el
  // correo haya sido uno solo — así "¿le avisamos a Ana de X?" tiene
  // respuesta directa, sin tener que interpretar un correo agrupado.
  private async registrarResultado(
    avisos: FilaPendiente[],
    destino: string,
    estado: 'sent' | 'failed',
    error: string | null,
  ): Promise<void> {
    const ids = avisos.map((a) => a.notification_id);

    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `UPDATE notifications SET email_status = $2 WHERE id = ANY($1::uuid[])`,
        [ids, estado],
      );

      for (const id of ids) {
        await manager.save(
          manager.create(NotificationDelivery, {
            notificationId: id,
            channel: 'email',
            status: estado,
            destination: destino,
            error,
          }),
        );
      }
    });
  }

  private asuntoDe(avisos: FilaPendiente[]): string {
    return avisos.length === 1
      ? avisos[0].title
      : `Tenés ${avisos.length} avisos de Una Rolita`;
  }

  private cuerpoDe(nombre: string, avisos: FilaPendiente[]): string {
    const lineas = [`${nombre},`, ''];

    for (const aviso of avisos) {
      lineas.push(`• ${aviso.title}`);
      lineas.push(`  ${aviso.body}`);
      lineas.push('');
    }

    lineas.push('Una Rolita');
    return lineas.join('\n');
  }

  // ==============================================================
  // Consultas del cliente
  // ==============================================================

  // La bandeja. El userId va en el WHERE, no en un `if` posterior: los
  // avisos de otra persona simplemente no existen para esta consulta.
  async listarDe(
    userId: string,
    limite = 30,
    desplazamiento = 0,
  ): Promise<Notification[]> {
    return this.dataSource.getRepository(Notification).find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: Math.min(limite, 100),
      skip: desplazamiento,
    });
  }

  // `IsNull()` y NO `readAt: undefined`. En TypeORM, undefined significa
  // "ignorá esta condición", así que habría contado TODOS los avisos y el
  // contador de la app siempre habría mostrado un número inflado.
  async contarSinLeer(userId: string): Promise<number> {
    return this.dataSource
      .getRepository(Notification)
      .count({ where: { userId, readAt: IsNull() } });
  }

  // Marcar como leído. Devuelve si el aviso existe y es de esta persona:
  // el userId va en el WHERE, así que un aviso ajeno simplemente no calza
  // y no se toca nada — sin revelar si el id existe.
  //
  // `COALESCE(read_at, now())` en vez de `now()` a secas, y sin
  // `AND read_at IS NULL` en el WHERE. Dos razones:
  //   - conserva la hora de la PRIMERA lectura, que es el dato real
  //   - marcar dos veces devuelve la fila igual, así que la operación es
  //     idempotente. Con la versión anterior, un doble clic en la app
  //     daba 404 la segunda vez y parecía que el aviso se había borrado.
  //
  // OJO CON `query()` PARA UPDATE: el driver de TypeORM no devuelve solo
  // las filas, devuelve `[filas, cantidadAfectada]`. Contar `.length`
  // sobre eso da 2 SIEMPRE, aunque no haya coincidido ninguna fila — y
  // esta función habría devuelto true para el aviso de cualquiera.
  // Por eso va con `.affected`, que es un número y no una forma que hay
  // que adivinar.
  async marcarLeido(userId: string, notificationId: string): Promise<boolean> {
    const resultado = await this.dataSource
      .createQueryBuilder()
      .update(Notification)
      .set({ readAt: () => 'COALESCE(read_at, now())' })
      .where('id = :notificationId AND user_id = :userId', {
        notificationId,
        userId,
      })
      .execute();

    return (resultado.affected ?? 0) > 0;
  }
}
