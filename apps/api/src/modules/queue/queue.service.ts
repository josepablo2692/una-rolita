import {
  Inject,
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
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
import { User } from '../auth/entities/user.entity';
import { VenuesService } from '../venues/venues.service';
import { CreditsService, LedgerLine } from '../credits/credits.service';
import { CreditTransaction } from '../credits/entities/credit-transaction.entity';
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

@Injectable()
export class QueueService {
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
        // ---- CANDADO 1: el crédito -------------------------------
        // Primero el crédito y después la cola, SIEMPRE en ese orden.
        // Si dos operaciones tomaran los recursos al revés, se
        // esperarían para siempre (interbloqueo).
        const cuenta = await this.creditsService.ensureAndLockAccount(
          manager,
          userId,
          venueId,
        );

        // ---- CANDADO 2: el usuario -------------------------------
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

        // ---- Ahora sí, la cola ------------------------------------
        const position = esSalto
          ? await this.calculateJumpPosition(manager, venueId)
          : await this.calculateNextPosition(manager, venueId);

        const queueRequest = manager.create(QueueRequest, {
          venueId,
          tableId,
          userId,
          songId: song.id,
          position,
          isPaidJump: esSalto,
          paidAmount: esGratis ? 0 : precio,
        });
        const guardado = await manager.save(queueRequest);

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

    request.status = 'played';
    request.playedAt = new Date();
    await this.queueRequestRepository.save(request);

    const history = this.historyRepository.create({
      venueId: request.venueId,
      songId: request.songId,
    });
    await this.historyRepository.save(history);
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

      const { neto, fueGratis } = await this.netoCobrado(manager, id);

      // Si se cobró algo, se devuelve completo. `neto` es negativo, así
      // que el reembolso es su valor absoluto.
      if (neto < 0) {
        await this.creditsService.applyLines({
          userId: request.userId,
          venueId,
          manager, // dentro de NUESTRA transacción
          lines: [
            {
              type: 'refund',
              amount: Math.abs(neto),
              queueRequestId: id,
            },
          ],
        });
      }

      // Canción gratis saltada por el artista: no hay crédito que
      // devolver (el neto fue cero), pero el cliente perdió su promoción
      // sin recibir nada. Como el local incumplió, se le restituye.
      if (fueGratis) {
        const usuario = await manager.findOne(User, {
          where: { id: request.userId },
          lock: { mode: 'pessimistic_write' },
        });
        if (usuario) {
          usuario.freeSongUsed = false;
          await manager.save(usuario);
        }
      }

      request.status = 'skipped';
      return manager.save(request);
    });

    // El aviso, después del commit.
    const updatedQueue = await this.findQueueByVenue(venueId);
    this.queueGateway.notifyQueueUpdated(venueId, updatedQueue);

    return actualizado;
  }

  // ==============================================================
  // Métodos privados: cada uno resuelve UNA sola regla de negocio
  // (Single Responsibility a nivel de método, no solo de clase).
  // ==============================================================

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
