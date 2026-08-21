import {
  Inject,
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  IsNull,
  MoreThan,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { Song } from './entities/song.entity';
import { VenueSongHistory } from './entities/venue-song-history.entity';
import { QueueRequest } from './entities/queue-request.entity';
import { QueueJump } from './entities/queue-jump.entity';
import { VenueTable } from '../venues/entities/venue-table.entity';
import { VenueSession } from '../venues/entities/venue-session.entity';
import { User } from '../auth/entities/user.entity';
import { VenuesService } from '../venues/venues.service';
import { CreditsService, LedgerLine } from '../credits/credits.service';
import { CreditTransaction } from '../credits/entities/credit-transaction.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateQueueRequestDto } from './dto/create-queue-request.dto';
import { QueueGateway } from './queue.gateway';

// Cuántas canciones deben sonar antes de que el MISMO usuario pueda
// volver a pagar por otro salto de cola (cooldown por actividad,
// no por reloj — ver ADR/backlog sobre esta decisión de negocio).
const JUMP_COOLDOWN_IN_SONGS = 2;

// Duración del lock de Redis: suficiente para completar la operación
// de asignar posición, corta para no bloquear a otros por error.
const LOCK_TTL_MS = 5000;

// Script Lua para liberar el lock de forma ATÓMICA.
//
// Antes hacíamos GET y luego DEL como dos operaciones separadas. Entre
// una y otra hay una ventana: si el lock expiraba justo ahí y otro
// proceso lo tomaba, borrábamos el candado ajeno — exactamente lo que
// el lockValue con UUID intentaba evitar.
//
// Redis ejecuta un script Lua completo sin interrumpirlo: es una sola
// operación indivisible. Es la forma canónica de hacer un
// "compare-and-delete" y viene documentada en la propia guía de Redis.
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

// Postgres devuelve COUNT y SUM como texto (son bigint/numeric, que no
// caben garantizados en un number de JS). Se tipan como string y se
// convierten explícitamente: si los declaráramos number, TypeScript nos
// dejaría sumarlos y obtendríamos "12" en vez de 3.
interface FilaConteoPedidos {
  total: string;
  sonadas: string;
  saltadas: string;
  canceladas: string;
  en_cola: string;
}

interface FilaConteoCreditos {
  gastado: string;
  reembolsado: string;
}

interface FilaSesionVencida {
  id: string;
  venue_id: string;
}

// Lo que devuelve el cierre y las consultas de noche. Vive aquí, junto a
// quien lo produce, para que el Controller no invente su propia forma.
export interface ResumenNoche {
  sessionId: string;
  venueId: string;
  openedAt: Date;
  closedAt: Date | null;
  closedByUserId: string | null;
  closedAutomatically: boolean;
  abierta: boolean;
  duracionMinutos: number;
  cancionesPedidas: number;
  cancionesSonadas: number;
  cancionesSaltadas: number;
  cancionesCanceladas: number;
  cancionesEnCola: number;
  creditosGastados: number;
  creditosReembolsados: number;
  pedidosReembolsadosAlCerrar: number | null;
  creditosDevueltosAlCerrar: number | null;
}

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
    @InjectRepository(Song)
    private readonly songRepository: Repository<Song>,
    @InjectRepository(VenueSongHistory)
    private readonly historyRepository: Repository<VenueSongHistory>,
    @InjectRepository(QueueRequest)
    private readonly queueRequestRepository: Repository<QueueRequest>,
    @InjectRepository(QueueJump)
    private readonly queueJumpRepository: Repository<QueueJump>,
    @InjectRepository(VenueTable)
    private readonly venueTableRepository: Repository<VenueTable>,
    private readonly venuesService: VenuesService,
    private readonly queueGateway: QueueGateway, // <- nuevo
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly creditsService: CreditsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ==============================================================
  // Punto de entrada público: pedir una canción (con o sin salto pagado)
  // ==============================================================
  async createRequest(
    venueId: string,
    tableId: string,
    userId: string,
    dto: CreateQueueRequestDto,
  ): Promise<QueueRequest> {
    const venue = await this.venuesService.findOne(venueId);

    // Guard Clause (IDOR): la mesa debe ser de ESTE venue y estar activa.
    const table = await this.venueTableRepository.findOne({
      where: { id: tableId, venueId, isActive: true },
    });
    if (!table) {
      throw new BadRequestException(
        'La mesa indicada no pertenece a este negocio o está inactiva',
      );
    }

    const song = await this.findOrCreateSong(dto);
    await this.assertCooldownNotActive(venueId, song.id, venue.cooldownHours);

    const esSalto = dto.isPaidJump ?? false;

    // El precio es TOTAL por producto: queue_jump_price ya incluye la
    // canción, no se suma a song_price (ver ADR 0006 y el modelo de
    // precios en el backlog).
    const precio = this.aCreditosEnteros(
      esSalto ? venue.queueJumpPrice : venue.songPrice,
      esSalto ? 'salto de cola' : 'canción',
    );

    const lockKey = `lock:queue:${venueId}`;
    const lockValue = randomUUID();

    const acquired = await this.redis.set(
      lockKey,
      lockValue,
      'PX',
      LOCK_TTL_MS,
      'NX',
    );
    if (!acquired) {
      throw new BadRequestException(
        'La cola está ocupada procesando otro pedido, intenta de nuevo',
      );
    }

    let saved: QueueRequest;

    try {
      // Todo lo que sigue ocurre o no ocurre: cobrar, escribir el libro
      // mayor y meter la canción en la cola son una sola operación.
      saved = await this.dataSource.transaction(async (manager) => {
        // ---- ORDEN DE CANDADOS: sesión → crédito → usuario → cola ---
        //
        // TODA operación que toque estos recursos los toma en ESTE orden.
        // Si una los tomara al revés (por ejemplo crédito y después
        // sesión), dos transacciones podrían quedarse esperándose para
        // siempre: cada una con lo que la otra necesita. Eso es un
        // interbloqueo, y la base lo resuelve matando una transacción.
        //
        // ---- CANDADO 1: la sesión --------------------------------
        // La noche a la que pertenece este pedido. Si no hay ninguna
        // abierta, se abre sola.
        //
        // Bloquear la fila aquí es lo que impide que un pedido se cuele
        // en una noche que el DJ está cerrando en este mismo instante.
        const sesion = await this.resolverSesionAbierta(manager, venueId);

        // ---- CANDADO 2: el crédito -------------------------------
        const cuenta = await this.creditsService.ensureAndLockAccount(
          manager,
          userId,
          venueId,
        );

        // ---- CANDADO 3: el usuario -------------------------------
        // La canción gratis vive en users.free_song_used y es UNA por
        // persona en toda la plataforma, no una por local. Se bloquea la
        // fila para que dos pedidos simultáneos no la usen dos veces.
        const usuario = await manager.findOne(User, {
          where: { id: userId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!usuario) {
          throw new NotFoundException('El usuario del pedido no existe');
        }

        // La gratis cubre el producto "canción sola". Si querés saltar la
        // cola en tu primer pedido, pagás el salto completo y conservás
        // tu canción gratis para después.
        // Antifraude: solo con correo verificado (backlog línea 184).
        const esGratis =
          !esSalto && !usuario.freeSongUsed && usuario.isEmailVerified;

        // Un pedido = UN renglón por producto. La gratis son dos: el
        // regalo y el cobro. Suman cero, pero queda escrito que hubo
        // promoción — si solo omitiéramos el cobro, sería invisible.
        // El renglón POSITIVO va primero: el saldo no puede quedar
        // negativo en el camino.
        const renglones: LedgerLine[] = esGratis
          ? [
              { type: 'grant_free_song', amount: +precio },
              { type: 'charge_song', amount: -precio },
            ]
          : [
              {
                type: esSalto ? 'charge_jump' : 'charge_song',
                amount: -precio,
              },
            ];

        // Fallar rápido: si no alcanza, ni tocamos las posiciones de la
        // cola. El mensaje se lo damos aquí, no a mitad del cobro.
        const neto = renglones.reduce((suma, r) => suma + r.amount, 0);
        if (cuenta.balance + neto < 0) {
          throw new BadRequestException(
            `No te alcanzan los créditos: tenés ${cuenta.balance} y este pedido cuesta ${Math.abs(neto)}`,
          );
        }

        if (esSalto) {
          await this.assertUserCanPayForJump(userId, venueId);
        }

        // ---- CANDADO 4: la cola -----------------------------------
        const position = esSalto
          ? await this.calculateJumpPosition(manager, venueId)
          : await this.calculateNextPosition(manager, venueId);

        const queueRequest = manager.create(QueueRequest, {
          venueId,
          sessionId: sesion.id,
          tableId,
          userId,
          songId: song.id,
          position,
          isPaidJump: esSalto,
          paidAmount: esGratis ? 0 : precio,
        });
        const guardado = await manager.save(queueRequest);

        // Marca actividad en la sesión. Es lo que usa el job de cierre
        // automático para saber si la noche sigue viva Y con qué hora
        // cerrarla si nadie lo hizo.
        sesion.lastActivityAt = new Date();
        await manager.save(sesion);

        // El cobro apunta al pedido, por eso va después de crearlo: no se
        // puede referenciar algo que todavía no existe.
        await this.creditsService.applyLines({
          userId,
          venueId,
          manager, // ← dentro de NUESTRA transacción, no una aparte
          lines: renglones.map((r) => ({
            ...r,
            queueRequestId: guardado.id,
          })),
        });

        if (esGratis) {
          usuario.freeSongUsed = true;
          await manager.save(usuario);
        }

        if (esSalto) {
          await this.registerJump(manager, userId, venueId, guardado.id);
        }

        return guardado;
      });
    } finally {
      await this.releaseLockIfOwned(lockKey, lockValue);
    }

    // El aviso va DESPUÉS del commit. Si notificáramos dentro de la
    // transacción y algo fallara, la pantalla del DJ mostraría una
    // canción que nunca existió.
    const updatedQueue = await this.findQueueByVenue(venueId);
    this.queueGateway.notifyQueueUpdated(venueId, updatedQueue);

    return saved;
  }

  // Los precios se guardan en NUMERIC porque son dinero, pero los
  // créditos son enteros. Un CHECK en la base ya obliga a que los precios
  // sean enteros; esto es la red por si alguien lo desactiva.
  private aCreditosEnteros(precio: number, etiqueta: string): number {
    if (!Number.isInteger(precio) || precio < 0) {
      throw new BadRequestException(
        `El precio de ${etiqueta} está mal configurado (${precio}): debe ser un número entero de quetzales`,
      );
    }
    return precio;
  }

  async findQueueByVenue(
    venueId: string,
    limit = 20,
    offset = 0,
  ): Promise<QueueRequest[]> {
    return this.queueRequestRepository.find({
      where: { venueId, status: 'queued' as const },
      order: { position: 'ASC' },
      take: limit,
      skip: offset,
    });
  }

  // Marca una canción como reproducida y la registra en el historial
  // (VenueSongHistory), que es lo que alimenta el cooldown a futuro.
  async markAsPlayed(venueId: string, id: string): Promise<QueueRequest> {
    // El venueId va en el WHERE, no en un if posterior. Buscar
    // "el pedido X que además es de este local" hace que un pedido de
    // otro venue simplemente no exista para esta consulta: mismo 404,
    // sin revelar si el id es real. Filtrar en la consulta es más
    // seguro que traer el dato y después comprobarlo.
    const request = await this.queueRequestRepository.findOne({
      where: { id, venueId },
    });
    if (!request) {
      throw new NotFoundException(
        `No se encontró el pedido ${id} en este negocio`,
      );
    }

    // Guard Clause: solo suena lo que está en cola.
    //
    // Sin esto, un pedido de una noche ya cerrada —que quedó en
    // 'skipped' y YA fue reembolsado— podría marcarse como sonado. El
    // cliente se habría quedado con el crédito devuelto Y con la
    // canción, y el historial del local contaría una reproducción que
    // pertenecía a otra noche. Es la misma defensa que ya tenían
    // cancelRequest y skipRequest.
    if (request.status !== 'queued') {
      throw new BadRequestException(
        `No se puede marcar como reproducido un pedido en estado "${request.status}"`,
      );
    }

    request.status = 'played';
    request.playedAt = new Date();
    await this.queueRequestRepository.save(request);

    const history = this.historyRepository.create({
      venueId: request.venueId,
      songId: request.songId,
    });
    await this.historyRepository.save(history);

    // Una canción sonando también es señal de vida. Sin esto, una noche
    // en la que el DJ solo reproduce lo que ya estaba en cola —sin
    // pedidos nuevos— se cerraría sola con la sala llena.
    await this.dataSource.query(
      `UPDATE venue_sessions
          SET last_activity_at = now()
        WHERE id = $1 AND closed_at IS NULL`,
      [request.sessionId],
    );

    const updatedQueue = await this.findQueueByVenue(request.venueId);
    this.queueGateway.notifyQueueUpdated(request.venueId, updatedQueue); // <- notifica que ya sono
    return request;
  }

  // Cancelar el pedido propio — decisión del cliente.
  //
  // Si pagó salto de cola, YA recibió la posición que compró: no se
  // reembolsa. Y con precios totales, todo el precio del salto ES el
  // producto salto — no hay una "parte canción" separable que devolver.
  //
  // Si fue un pedido normal, se le devuelve lo que pagó.
  // No se borra la fila, solo cambia su estado: el historial se conserva.
  async cancelRequest(
    venueId: string,
    id: string,
    userId: string,
  ): Promise<QueueRequest> {
    const actualizado = await this.dataSource.transaction(async (manager) => {
      const request = await manager.findOne(QueueRequest, {
        where: { id, venueId },
      });
      if (!request) {
        throw new NotFoundException(
          `No se encontró el pedido ${id} en este negocio`,
        );
      }

      if (request.userId !== userId) {
        throw new ForbiddenException(
          'No puedes cancelar el pedido de otra persona',
        );
      }

      if (request.status !== 'queued') {
        throw new BadRequestException(
          `No se puede cancelar un pedido en estado "${request.status}"`,
        );
      }

      // La diferencia con skipRequest está en esta línea: aquí el cliente
      // decidió retirarse, así que el salto pagado no se devuelve.
      if (!request.isPaidJump) {
        const { neto } = await this.netoCobrado(manager, id);

        if (neto < 0) {
          await this.creditsService.applyLines({
            userId: request.userId,
            venueId,
            manager,
            lines: [
              {
                type: 'refund',
                amount: Math.abs(neto),
                queueRequestId: id,
              },
            ],
          });
        }
      }

      // La canción gratis NO se restituye al cancelar: fue decisión del
      // cliente, no un incumplimiento del local.

      request.status = 'cancelled';
      return manager.save(request);
    });

    const updatedQueue = await this.findQueueByVenue(venueId);
    this.queueGateway.notifyQueueUpdated(venueId, updatedQueue);

    return actualizado;
  }

  // Saltar un pedido — decisión unilateral del artista o el DJ.
  //
  // El cliente no hizo nada mal: el servicio nunca se entregó porque el
  // local decidió no entregarlo. Reembolso TOTAL (ADR 0007). Por eso el
  // endpoint exige rol dj/venue_admin.
  async skipRequest(venueId: string, id: string): Promise<QueueRequest> {
    const actualizado = await this.dataSource.transaction(async (manager) => {
      // El venueId va dentro del WHERE: un pedido de otro local
      // simplemente no existe para esta consulta.
      const request = await manager.findOne(QueueRequest, {
        where: { id, venueId },
      });
      if (!request) {
        throw new NotFoundException(
          `No se encontró el pedido ${id} en este negocio`,
        );
      }

      // Guard Clause: solo se puede saltar lo que está en cola. También
      // es lo que impide reembolsar dos veces el mismo pedido.
      if (request.status !== 'queued') {
        throw new BadRequestException(
          `No se puede saltar un pedido en estado "${request.status}"`,
        );
      }

      await this.saltarYReembolsar(manager, request);
      return request;
    });

    // El aviso, después del commit.
    const updatedQueue = await this.findQueueByVenue(venueId);
    this.queueGateway.notifyQueueUpdated(venueId, updatedQueue);

    return actualizado;
  }

  // ==============================================================
  // Cierre de la noche
  // ==============================================================

  // Cerrar la noche — decisión del DJ o del administrador del local.
  //
  // Cerrar NO es solo poner una fecha: la cola que quedó pendiente nunca
  // va a sonar, y esos créditos ya están cobrados. Por eso el cierre
  // salta cada pedido pendiente y lo reembolsa (ADR 0007): el local no
  // entregó el servicio, igual que en un skip.
  //
  // Todo ocurre en UNA transacción. Si el reembolso número 7 falla, no
  // queremos una noche cerrada con seis clientes devueltos y el resto no.
  async closeSession(params: {
    venueId: string;
    closedByUserId: string | null;
    automatic?: boolean;
    // Solo lo usa el cierre automático. Ver el comentario de abajo.
    closedAt?: Date;
  }): Promise<ResumenNoche> {
    const { venueId, closedByUserId, automatic = false } = params;

    const resumen = await this.dataSource.transaction(async (manager) => {
      // ---- CANDADO 1: la sesión --------------------------------
      // Mismo orden que createRequest: sesión → crédito → usuario.
      // Además serializa los cierres entre sí: dos personas apretando
      // el botón a la vez no reembolsan dos veces.
      const sesion = await manager.findOne(VenueSession, {
        where: { venueId, closedAt: IsNull() },
        lock: { mode: 'pessimistic_write' },
      });

      if (!sesion) {
        throw new BadRequestException(
          'No hay una noche abierta en este negocio',
        );
      }

      // Los pedidos que quedaron colgados. Solo los de ESTA sesión: si
      // por algún motivo quedaron filas viejas de otra noche, no son
      // asunto de este cierre.
      const pendientes = await manager.find(QueueRequest, {
        where: { sessionId: sesion.id, status: 'queued' as const },
        order: { position: 'ASC' },
      });

      // Se acumula POR PERSONA, no por pedido. Alguien con tres canciones
      // en cola recibe UN aviso que dice "se te devolvieron Q3", no tres
      // avisos de Q1. Tres notificaciones por la misma noche se sienten
      // como un error del sistema, no como una devolución.
      const devolucionesPorCliente = new Map<
        string,
        { creditos: number; gratis: number }
      >();

      let creditosDevueltos = 0;
      for (const pedido of pendientes) {
        const resultado = await this.saltarYReembolsar(manager, pedido);
        creditosDevueltos += resultado.devuelto;

        if (resultado.devuelto > 0 || resultado.gratisRestituida) {
          const acumulado = devolucionesPorCliente.get(pedido.userId) ?? {
            creditos: 0,
            gratis: 0,
          };
          acumulado.creditos += resultado.devuelto;
          if (resultado.gratisRestituida) {
            acumulado.gratis += 1;
          }
          devolucionesPorCliente.set(pedido.userId, acumulado);
        }
      }

      // POR QUÉ el cierre automático usa last_activity_at y no "ahora":
      // el job corre cada media hora. Si cerrara con su propio reloj,
      // una noche que terminó de verdad a las 2:00 a.m. y que el job
      // detecta a las 8:00 a.m. mediría seis horas de más. La métrica de
      // duración quedaría inservible justo en los locales peor operados,
      // que son los que más nos interesa medir.
      //
      // POR QUÉ la hora la pone Postgres y no JavaScript:
      // `opened_at` lo escribe la base con now(). Si `closed_at` lo
      // pusiera Node con new Date(), estaríamos comparando dos relojes
      // distintos — el del contenedor de la base y el del servidor. Con
      // unos cientos de milisegundos de desfase (Docker en Windows los
      // tiene), una noche que abre y cierra casi seguido queda con
      // closed_at ANTERIOR a opened_at, y el CHECK de la base la rechaza.
      //
      // Regla: dos instantes que se van a comparar entre sí tienen que
      // salir del mismo reloj. Aquí manda el de la base.
      await manager.query(
        `UPDATE venue_sessions
            SET closed_at            = COALESCE($2::timestamptz, now()),
                closed_by_user_id    = $3,
                closed_automatically = $4
          WHERE id = $1`,
        [sesion.id, params.closedAt ?? null, closedByUserId, automatic],
      );

      // La entidad en memoria quedó desactualizada tras el UPDATE crudo;
      // se relee para que el resumen mida la duración correcta.
      //
      // ANTES esto usaba `UPDATE ... RETURNING closed_at` y leía
      // `resultado[0].closed_at`. No funcionaba: para un UPDATE, el
      // driver de TypeORM devuelve `[filas, cantidadAfectada]`, así que
      // `resultado[0]` era el ARREGLO de filas y `.closed_at` salía
      // undefined. La duración que devolvía este endpoint estaba mal, y
      // ninguna prueba lo agarró porque `undefined === null` también da
      // false y el campo `abierta` salía correcto por casualidad.
      //
      // Una relectura explícita cuesta una consulta y no depende de
      // adivinar la forma del resultado.
      const cerrada = await manager.findOneOrFail(VenueSession, {
        where: { id: sesion.id },
      });
      sesion.closedAt = cerrada.closedAt;
      sesion.closedByUserId = closedByUserId;
      sesion.closedAutomatically = automatic;

      // Los avisos van DENTRO de la transacción, con el mismo manager.
      // Si el cierre falla, no queda un aviso diciéndole a alguien que le
      // devolvimos dinero que en realidad nunca se movió.
      //
      // Esto es seguro porque crear() solo ESCRIBE: el correo lo manda el
      // job de la mañana. Si aquí se enviara el correo y la transacción
      // se deshiciera, el correo ya habría salido y no hay forma de
      // des-enviarlo.
      if (devolucionesPorCliente.size > 0) {
        const [local] = await manager.query<Array<{ name: string }>>(
          `SELECT name FROM venues WHERE id = $1`,
          [venueId],
        );
        const nombreLocal = local?.name ?? 'el negocio';

        for (const [userId, devuelto] of devolucionesPorCliente) {
          await this.notifications.crear({
            userId,
            venueId,
            type: 'refund_night_close',
            title: this.tituloDeDevolucion(devuelto),
            body: this.cuerpoDeDevolucion(devuelto, nombreLocal),
            data: {
              creditos: devuelto.creditos,
              cancionesGratisRestituidas: devuelto.gratis,
              sessionId: sesion.id,
            },
            porCorreo: true,
            manager,
          });
        }
      }

      return this.construirResumen(manager, sesion, {
        pedidosReembolsados: pendientes.length,
        creditosDevueltos,
      });
    });

    // Los avisos, después del commit.
    const colaVacia = await this.findQueueByVenue(venueId);
    this.queueGateway.notifyQueueUpdated(venueId, colaVacia);
    this.queueGateway.notifyNightClosed(venueId, {
      sessionId: resumen.sessionId,
      closedAt: resumen.closedAt as Date,
      automatico: automatic,
    });

    return resumen;
  }

  // Red de seguridad: cierra las noches que nadie cerró.
  //
  // El botón de cerrar existe, pero un local con clientes encima no
  // siempre lo aprieta. Si nadie cerrara nunca, la cola de anoche
  // aparecería mañana y los reembolsos jamás saldrían.
  //
  // Corre cada media hora, no cada minuto: el umbral se mide en horas,
  // así que revisar más seguido solo gasta consultas. Y como cierra con
  // last_activity_at, media hora de retraso no distorsiona la métrica.
  @Cron(CronExpression.EVERY_30_MINUTES)
  async cerrarSesionesInactivas(): Promise<number> {
    // El umbral es POR LOCAL (venues.session_timeout_hours): un bar y un
    // gimnasio no tienen el mismo ritmo. Por eso el JOIN — no se puede
    // resolver con una constante.
    const vencidas = await this.dataSource.query<FilaSesionVencida[]>(
      `SELECT s.id, s.venue_id
         FROM venue_sessions s
         JOIN venues v ON v.id = s.venue_id
        WHERE s.closed_at IS NULL
          AND s.last_activity_at < now() - (v.session_timeout_hours * INTERVAL '1 hour')`,
    );

    let cerradas = 0;

    for (const fila of vencidas) {
      try {
        // Se relee la sesión dentro de closeSession con su candado; aquí
        // solo necesitamos last_activity_at para la hora de cierre.
        const sesion = await this.dataSource
          .getRepository(VenueSession)
          .findOne({ where: { id: fila.id } });

        if (!sesion || sesion.closedAt) {
          continue; // alguien la cerró entre la consulta y este momento
        }

        await this.closeSession({
          venueId: fila.venue_id,
          closedByUserId: null, // nadie la cerró: la cerró el sistema
          automatic: true,
          closedAt: sesion.lastActivityAt,
        });
        cerradas += 1;
      } catch (error) {
        // Un local que falla no puede dejar sin cerrar a los demás. Se
        // registra y se sigue: el job vuelve a intentarlo en 30 minutos.
        this.logger.error(
          `No se pudo cerrar automáticamente la noche del negocio ${fila.venue_id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    if (cerradas > 0) {
      this.logger.warn(
        `Cierre automático: ${cerradas} noche(s) cerradas por inactividad`,
      );
    }

    return cerradas;
  }

  // La noche en curso, con sus números en vivo. Es lo que mira el DJ
  // antes de apretar el botón: cuánto lleva abierta y qué va a pasar si
  // cierra (cuántos pedidos pendientes se van a reembolsar).
  async getCurrentSession(venueId: string): Promise<ResumenNoche> {
    const sesion = await this.dataSource.getRepository(VenueSession).findOne({
      where: { venueId, closedAt: IsNull() },
    });

    if (!sesion) {
      throw new NotFoundException('No hay una noche abierta en este negocio');
    }

    return this.construirResumen(this.dataSource.manager, sesion);
  }

  // El resumen de una noche ya cerrada. El venueId va en el WHERE: una
  // sesión de otro local simplemente no existe para esta consulta.
  async getSessionSummary(
    venueId: string,
    sessionId: string,
  ): Promise<ResumenNoche> {
    const sesion = await this.dataSource.getRepository(VenueSession).findOne({
      where: { id: sessionId, venueId },
    });

    if (!sesion) {
      throw new NotFoundException(
        `No se encontró la noche ${sessionId} en este negocio`,
      );
    }

    return this.construirResumen(this.dataSource.manager, sesion);
  }

  // ==============================================================
  // Métodos privados: cada uno resuelve UNA sola regla de negocio
  // (Single Responsibility a nivel de método, no solo de clase).
  // ==============================================================

  // Textos del aviso de devolución.
  //
  // Están separados del resto porque son lo ÚNICO de este archivo que lee
  // un cliente. El tono importa: la persona pagó y no escuchó su canción,
  // así que el aviso tiene que decir qué pasó, cuánto volvió y que no
  // tiene que hacer nada. Un mensaje frío aquí confirma la sospecha de
  // que la app se quedó con su dinero.
  private tituloDeDevolucion(devuelto: {
    creditos: number;
    gratis: number;
  }): string {
    if (devuelto.creditos > 0 && devuelto.gratis > 0) {
      return `Te devolvimos Q${devuelto.creditos} y tu canción gratis`;
    }
    if (devuelto.creditos > 0) {
      return `Te devolvimos Q${devuelto.creditos}`;
    }
    return 'Recuperaste tu canción gratis';
  }

  private cuerpoDeDevolucion(
    devuelto: { creditos: number; gratis: number },
    nombreLocal: string,
  ): string {
    const partes: string[] = [];

    if (devuelto.creditos > 0) {
      partes.push(`Q${devuelto.creditos} a tu saldo de ${nombreLocal}`);
    }
    if (devuelto.gratis > 0) {
      partes.push(
        devuelto.gratis === 1
          ? 'tu canción gratis'
          : `tus ${devuelto.gratis} canciones gratis`,
      );
    }

    return (
      `La noche en ${nombreLocal} se cerró antes de que sonara tu música. ` +
      `Te devolvimos ${partes.join(' y ')}. ` +
      `No tenés que hacer nada: ya está disponible para tu próxima visita.`
    );
  }

  // Saltar un pedido y devolver lo que se le cobró.
  //
  // Vive aparte porque tiene DOS usuarios con la misma regla: el skip
  // individual del DJ y el cierre de la noche. Si estuviera duplicado,
  // el día que cambie la política de reembolsos habría que acordarse de
  // los dos lugares — y ese es exactamente el bug que no se nota hasta
  // que un cliente reclama.
  //
  // Devuelve las DOS formas de devolución, no solo los créditos: una
  // canción gratis saltada no mueve saldo (su neto era cero) pero sí es
  // algo que el cliente recuperó, y tiene derecho a que se lo digan.
  //
  // Asume que el pedido ya fue validado (existe, es del local, está en
  // estado 'queued'). No abre transacción: participa en la del que llama.
  private async saltarYReembolsar(
    manager: EntityManager,
    request: QueueRequest,
  ): Promise<{ devuelto: number; gratisRestituida: boolean }> {
    const { neto, fueGratis } = await this.netoCobrado(manager, request.id);

    // Si se cobró algo, se devuelve completo. `neto` es negativo, así
    // que el reembolso es su valor absoluto.
    let devuelto = 0;
    if (neto < 0) {
      devuelto = Math.abs(neto);
      await this.creditsService.applyLines({
        userId: request.userId,
        venueId: request.venueId,
        manager, // dentro de la transacción del que llama
        lines: [
          {
            type: 'refund',
            amount: devuelto,
            queueRequestId: request.id,
          },
        ],
      });
    }

    // Canción gratis saltada por el local: no hay crédito que devolver
    // (el neto fue cero), pero el cliente perdió su promoción sin recibir
    // nada. Como el local incumplió, se le restituye.
    let gratisRestituida = false;
    if (fueGratis) {
      const usuario = await manager.findOne(User, {
        where: { id: request.userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (usuario) {
        usuario.freeSongUsed = false;
        await manager.save(usuario);
        gratisRestituida = true;
      }
    }

    request.status = 'skipped';
    await manager.save(request);

    return { devuelto, gratisRestituida };
  }

  // Arma las métricas de una noche, abierta o cerrada.
  //
  // Son dos consultas y no una porque miden cosas distintas: los pedidos
  // cuelgan de la sesión, pero los movimientos de crédito cuelgan del
  // pedido. Unirlas en un solo SELECT multiplicaría filas y los conteos
  // saldrían inflados — el error clásico de contar sobre un JOIN.
  private async construirResumen(
    manager: EntityManager,
    sesion: VenueSession,
    extra?: { pedidosReembolsados: number; creditosDevueltos: number },
  ): Promise<ResumenNoche> {
    const [pedidos] = await manager.query<FilaConteoPedidos[]>(
      `SELECT COUNT(*)                                        AS total,
              COUNT(*) FILTER (WHERE status = 'played')        AS sonadas,
              COUNT(*) FILTER (WHERE status = 'skipped')       AS saltadas,
              COUNT(*) FILTER (WHERE status = 'cancelled')     AS canceladas,
              COUNT(*) FILTER (WHERE status = 'queued')        AS en_cola
         FROM queue_requests
        WHERE session_id = $1`,
      [sesion.id],
    );

    // Los cobros son negativos y los reembolsos positivos: por eso el
    // gastado lleva ABS y se filtra por signo, no por tipo. Si mañana
    // aparece un tipo de cobro nuevo, esta consulta ya lo cuenta.
    const [creditos] = await manager.query<FilaConteoCreditos[]>(
      `SELECT COALESCE(ABS(SUM(t.amount) FILTER (WHERE t.amount < 0)), 0) AS gastado,
              COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'refund'), 0) AS reembolsado
         FROM credit_transactions t
         JOIN queue_requests q ON q.id = t.queue_request_id
        WHERE q.session_id = $1`,
      [sesion.id],
    );

    const hasta = sesion.closedAt ?? new Date();
    const duracionMinutos = Math.round(
      (hasta.getTime() - new Date(sesion.openedAt).getTime()) / 60000,
    );

    return {
      sessionId: sesion.id,
      venueId: sesion.venueId,
      openedAt: sesion.openedAt,
      closedAt: sesion.closedAt,
      closedByUserId: sesion.closedByUserId,
      closedAutomatically: sesion.closedAutomatically,
      abierta: sesion.closedAt === null,
      duracionMinutos,
      cancionesPedidas: Number(pedidos.total),
      cancionesSonadas: Number(pedidos.sonadas),
      cancionesSaltadas: Number(pedidos.saltadas),
      cancionesCanceladas: Number(pedidos.canceladas),
      cancionesEnCola: Number(pedidos.en_cola),
      creditosGastados: Number(creditos.gastado),
      creditosReembolsados: Number(creditos.reembolsado),
      // Solo el cierre sabe cuántos reembolsó ÉL. En un resumen
      // consultado después, esos números ya están dentro de los totales.
      pedidosReembolsadosAlCerrar: extra?.pedidosReembolsados ?? null,
      creditosDevueltosAlCerrar: extra?.creditosDevueltos ?? null,
    };
  }

  // Devuelve la sesión abierta del local, abriéndola si no existe.
  //
  // APERTURA PEREZOSA: la noche empieza cuando alguien pide música, no
  // cuando alguien aprieta un botón. Eso le quita un paso al DJ y evita
  // que un olvido deje al local sin poder recibir pedidos.
  //
  // El ON CONFLICT DO NOTHING se apoya en el índice único parcial de la
  // base (una sola sesión sin closed_at por venue): si dos peticiones
  // intentan abrir la noche a la vez, una gana y la otra no rompe nada.
  //
  // El bloqueo de la fila NO es decorativo. Sin él, cerrar la noche y
  // pedir una canción pueden pisarse: el cierre marca closed_at mientras
  // el pedido ya leyó esa misma sesión como abierta, y el pedido queda
  // colgado de una noche cerrada — sin reembolso y sin salir nunca.
  //
  // Con el bloqueo, el pedido espera al cierre; cuando entra, ya no ve
  // sesión abierta y abre una nueva. Eso es lo correcto: una canción
  // pedida después del cierre pertenece a la noche siguiente.
  private async resolverSesionAbierta(
    manager: EntityManager,
    venueId: string,
  ): Promise<VenueSession> {
    // Dos vueltas, no una. La primera puede quedarse vacía por una razón
    // legítima: había una noche abierta, esperamos su candado, y quien lo
    // tenía la estaba cerrando. Al soltarlo ya no hay sesión abierta.
    // En la segunda vuelta el INSERT sí crea la noche nueva.
    for (let intento = 1; intento <= 2; intento++) {
      await manager.query(
        `INSERT INTO venue_sessions (venue_id)
         VALUES ($1)
         ON CONFLICT DO NOTHING`,
        [venueId],
      );

      const sesion = await manager.findOne(VenueSession, {
        where: { venueId, closedAt: IsNull() },
        lock: { mode: 'pessimistic_write' },
      });

      if (sesion) {
        return sesion;
      }
    }

    throw new InternalServerErrorException(
      'No se pudo abrir la sesión de la noche para este negocio',
    );
  }

  // Qué se le cobró realmente a este pedido.
  //
  // Se excluyen los reembolsos previos para no devolver dos veces. El
  // neto puede ser CERO: es el caso de la canción gratis, donde el regalo
  // (+1) y el cobro (−1) se anulan.
  private async netoCobrado(
    manager: EntityManager,
    queueRequestId: string,
  ): Promise<{ neto: number; fueGratis: boolean }> {
    const renglones = await manager.find(CreditTransaction, {
      where: { queueRequestId },
    });

    const movimientos = renglones.filter((r) => r.type !== 'refund');

    return {
      // Los cobros son negativos, así que el neto sale negativo o cero.
      neto: movimientos.reduce((suma, r) => suma + r.amount, 0),
      fueGratis: movimientos.some((r) => r.type === 'grant_free_song'),
    };
  }

  // Busca la canción en el catálogo por su ID de proveedor; si no
  // existe todavía, la crea (evita duplicados de la misma canción
  // pedida por primera vez en cualquier local).
  private async findOrCreateSong(dto: CreateQueueRequestDto): Promise<Song> {
    const existing = await this.songRepository.findOne({
      where: { provider: 'spotify', providerTrackId: dto.songProviderTrackId },
    });
    if (existing) {
      return existing;
    }

    const song = this.songRepository.create({
      provider: 'spotify',
      providerTrackId: dto.songProviderTrackId,
      title: dto.songTitle,
      artist: dto.songArtist,
      durationMs: dto.songDurationMs ?? null,
    });
    return this.songRepository.save(song);
  }

  // Regla: una canción no puede repetirse en el mismo venue hasta que
  // pasen `cooldownHours` desde la última vez que sonó ahí.
  private async assertCooldownNotActive(
    venueId: string,
    songId: string,
    cooldownHours: number,
  ): Promise<void> {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - cooldownHours);

    const recentPlay = await this.historyRepository.findOne({
      where: { venueId, songId, playedAt: MoreThan(cutoff) },
    });

    if (recentPlay) {
      throw new BadRequestException(
        `Esta canción ya sonó hace menos de ${cooldownHours} horas en este local`,
      );
    }
  }

  // Regla: límite de salto de cola pagado POR USUARIO (no por mesa),
  // con cooldown basado en canciones reproducidas desde el último salto.
  private async assertUserCanPayForJump(
    userId: string,
    venueId: string,
  ): Promise<void> {
    const lastJump = await this.queueJumpRepository.findOne({
      where: { userId, venueId },
      order: { jumpedAt: 'DESC' },
    });

    if (!lastJump) {
      return; // nunca ha saltado en este venue — puede hacerlo libremente
    }

    const currentSongsPlayed = await this.historyRepository.count({
      where: { venueId },
    });
    const songsSinceLastJump =
      currentSongsPlayed - lastJump.songsPlayedSnapshot;

    if (songsSinceLastJump < JUMP_COOLDOWN_IN_SONGS) {
      throw new BadRequestException(
        `Debes esperar a que suenen ${JUMP_COOLDOWN_IN_SONGS - songsSinceLastJump} canción(es) más antes de volver a saltar la cola`,
      );
    }
  }

  // Deja constancia del salto pagado, con la "foto" de cuántas canciones
  // habían sonado — necesaria para el cooldown de saltos.
  private async registerJump(
    manager: EntityManager,
    userId: string,
    venueId: string,
    queueRequestId: string,
  ): Promise<void> {
    const songsPlayedSnapshot = await manager.count(VenueSongHistory, {
      where: { venueId },
    });

    const jump = manager.create(QueueJump, {
      userId,
      venueId,
      queueRequestId,
      songsPlayedSnapshot,
    });
    await manager.save(jump);
  }

  // Posición normal: al final de la cola actual.
  // Recibe `manager` para correr DENTRO de la transacción del cobro. Con
  // this.queueRequestRepository correría fuera, y ese es el error más
  // difícil de detectar en este tipo de código.
  private async calculateNextPosition(
    manager: EntityManager,
    venueId: string,
  ): Promise<number> {
    const last = await manager.findOne(QueueRequest, {
      where: { venueId, status: 'queued' as const },
      order: { position: 'DESC' },
    });
    return (last?.position ?? 0) + 1;
  }

  // Posición de salto pagado: justo después de lo que está sonando, y
  // EMPUJANDO a todos los que estaban ahí o más atrás. Sin el empuje, dos
  // saltos pagados quedan en la misma posición y se cobra dos veces el
  // mismo lugar.
  // Posición de un salto pagado.
  //
  // FIFO ENTRE SALTOS (ADR 0007): el salto nuevo va DESPUÉS de los saltos
  // que ya están esperando, no adelante de ellos.
  //
  // Antes iba siempre a `playing.position + 1`, así que cada salto nuevo
  // se metía adelante de todos los anteriores: quien pagaba primero
  // terminaba último entre los que pagaron. Con 10 saltos vendidos en una
  // noche, el primero pasaba de la posición 2 a la 11 — pagó por una
  // posición que nunca tuvo.
  //
  // Corre dentro del lock de Redis y de la transacción, así que nadie más
  // puede calcular posiciones para este venue mientras esto sucede.
  private async calculateJumpPosition(
    manager: EntityManager,
    venueId: string,
  ): Promise<number> {
    // El último salto pagado que sigue en cola marca el final del bloque
    // de saltos. El nuevo se pone justo después.
    const ultimoSalto = await manager.findOne(QueueRequest, {
      where: {
        venueId,
        status: 'queued' as const,
        isPaidJump: true,
      },
      order: { position: 'DESC' },
    });

    let targetPosition: number;

    if (ultimoSalto) {
      targetPosition = ultimoSalto.position + 1;
    } else {
      // Nadie ha pagado salto todavía: va justo después de lo que suena.
      const playing = await manager.findOne(QueueRequest, {
        where: { venueId, status: 'playing' as const },
      });
      targetPosition = (playing?.position ?? 0) + 1;
    }

    // Empuja una posición a todos los que estaban ahí o más atrás. Sin
    // esto, dos pedidos quedarían con el mismo número y el ORDER BY
    // desempataría al azar.
    await manager.increment(
      QueueRequest,
      {
        venueId,
        status: 'queued' as const,
        position: MoreThanOrEqual(targetPosition),
      },
      'position',
      1,
    );

    return targetPosition;
  }
  // Libera el lock SOLO si sigue siendo el que este proceso creó.
  // La comparación y el borrado van en un script Lua (ver
  // RELEASE_LOCK_SCRIPT arriba) para que sean una sola operación
  // atómica: con GET + DEL separados existía una ventana en la que
  // podíamos borrar el candado de otro proceso.
  private async releaseLockIfOwned(
    lockKey: string,
    lockValue: string,
  ): Promise<void> {
    // eval(script, cantidadDeKeys, ...keys, ...argumentos)
    // KEYS[1] = lockKey, ARGV[1] = lockValue
    await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, lockValue);
  }
}
