import {
  Inject,
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, MoreThanOrEqual, Repository } from 'typeorm';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { Song } from './entities/song.entity';
import { VenueSongHistory } from './entities/venue-song-history.entity';
import { QueueRequest } from './entities/queue-request.entity';
import { QueueJump } from './entities/queue-jump.entity';
import { VenueTable } from '../venues/entities/venue-table.entity';
import { VenuesService } from '../venues/venues.service';
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
    const venue = await this.venuesService.findOne(venueId); // Guard Clause: el venue debe existir

    // Guard Clause (IDOR): la mesa debe pertenecer a ESTE venue y estar
    // activa. Antes se aceptaba cualquier tableId: se podía pedir desde
    // la "mesa 3 del Bar A" estando sentado en el Bar B.
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

    // --------------------------------------------------------------
    // LOCK DISTRIBUIDO (Redlock simplificado con SET NX):
    // solo UN pedido a la vez puede calcular/asignar posición para
    // este venue específico. Evita que dos personas terminen con la
    // misma posición si piden casi al mismo tiempo.
    // --------------------------------------------------------------
    const lockKey = `lock:queue:${venueId}`;
    const lockValue = randomUUID(); // identifica ESTE candado, para no borrar el de otro proceso por error

    const acquired = await this.redis.set(
      lockKey,
      lockValue,
      'PX',
      LOCK_TTL_MS,
      'NX',
    );
    if (!acquired) {
      // Alguien más está procesando un pedido para este venue AHORA MISMO.
      throw new BadRequestException(
        'La cola está ocupada procesando otro pedido, intenta de nuevo',
      );
    }

    try {
      let position: number;

      if (dto.isPaidJump) {
        // Valida la regla de negocio ANTES de cobrar/insertar nada (Guard Clause).
        await this.assertUserCanPayForJump(userId, venueId);
        position = await this.calculateJumpPosition(venueId);
      } else {
        position = await this.calculateNextPosition(venueId);
      }

      const queueRequest = this.queueRequestRepository.create({
        venueId,
        tableId,
        userId,
        songId: song.id,
        position,
        isPaidJump: dto.isPaidJump ?? false,
        paidAmount: dto.isPaidJump ? venue.queueJumpPrice : 0,
      });
      const saved = await this.queueRequestRepository.save(queueRequest);

      if (dto.isPaidJump) {
        await this.registerJump(userId, venueId, saved.id);
      }
      const updatedQueue = await this.findQueueByVenue(venueId);
      this.queueGateway.notifyQueueUpdated(venueId, updatedQueue); // <- Notifica el nuevo pedido
      return saved;
    } finally {
      // Libera el lock SIEMPRE, incluso si algo falló arriba — para
      // no dejar el venue bloqueado indefinidamente por un error.
      await this.releaseLockIfOwned(lockKey, lockValue);
    }
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

  // Cancela un pedido — solo el usuario dueño puede hacerlo. No borra
  // la fila (igual que markAsPlayed), solo cambia su estado, para
  // conservar el historial completo.
  async cancelRequest(
    venueId: string,
    id: string,
    userId: string,
  ): Promise<QueueRequest> {
    const request = await this.queueRequestRepository.findOne({
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

    request.status = 'cancelled';
    await this.queueRequestRepository.save(request);

    const updatedQueue = await this.findQueueByVenue(request.venueId);
    this.queueGateway.notifyQueueUpdated(request.venueId, updatedQueue);

    return request;
  }
  // Saltar un pedido — decisión unilateral del artista/DJ. El cliente no
  // incumplió nada, así que en Épica 3 esto dispara reembolso TOTAL
  // (ADR 0006). Por eso el endpoint exige rol dj/venue_admin.
  async skipRequest(venueId: string, id: string): Promise<QueueRequest> {
    const request = await this.queueRequestRepository.findOne({
      where: { id, venueId },
    });
    if (!request) {
      throw new NotFoundException(
        `No se encontró el pedido ${id} en este negocio`,
      );
    }
    if (request.status !== 'queued') {
      throw new BadRequestException(
        `No se puede saltar un pedido en estado "${request.status}"`,
      );
    }

    request.status = 'skipped';
    await this.queueRequestRepository.save(request);

    // TODO Épica 3: si request.isPaidJump, el monto del salto NO se
    // reembolsa (ya se recibió el beneficio de posición). Si no era
    // salto pagado, reembolsar el Q1 de la canción cuando exista
    // el sistema de créditos.

    const updatedQueue = await this.findQueueByVenue(request.venueId);
    this.queueGateway.notifyQueueUpdated(request.venueId, updatedQueue);

    return request;
  }

  // ==============================================================
  // Métodos privados: cada uno resuelve UNA sola regla de negocio
  // (Single Responsibility a nivel de método, no solo de clase).
  // ==============================================================

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

  // Deja constancia del salto pagado, con la "foto" de cuántas
  // canciones habían sonado — necesaria para el cooldown futuro.
  private async registerJump(
    userId: string,
    venueId: string,
    queueRequestId: string,
  ): Promise<void> {
    const songsPlayedSnapshot = await this.historyRepository.count({
      where: { venueId },
    });

    const jump = this.queueJumpRepository.create({
      userId,
      venueId,
      queueRequestId,
      songsPlayedSnapshot,
    });
    await this.queueJumpRepository.save(jump);
  }

  // Posición normal: al final de la cola actual.
  private async calculateNextPosition(venueId: string): Promise<number> {
    const last = await this.queueRequestRepository.findOne({
      where: { venueId, status: 'queued' as const },
      order: { position: 'DESC' },
    });
    return (last?.position ?? 0) + 1;
  }

  // Posición de salto pagado: justo después de lo que ya está sonando.
  //
  // El paso clave es EMPUJAR a los demás. Antes solo se devolvía
  // `playing.position + 1` sin mover a nadie: si la canción sonando
  // estaba en la 5, el salto iba a la 6 — donde ya había alguien. Dos
  // saltos pagados seguidos quedaban ambos en la 6, y el ORDER BY
  // position desempataba al azar. Le cobrábamos a dos personas por el
  // mismo lugar, y no garantizábamos la posición que vendimos.
  //
  // Corre dentro del lock de Redis, así que ningún otro pedido de este
  // venue puede calcular posiciones mientras esto sucede.
  private async calculateJumpPosition(venueId: string): Promise<number> {
    const playing = await this.queueRequestRepository.findOne({
      where: { venueId, status: 'playing' as const },
    });
    const targetPosition = (playing?.position ?? 0) + 1;

    // Un solo UPDATE, atómico en Postgres: corre a todos los que están
    // en la posición destino o más atrás.
    await this.queueRequestRepository.increment(
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
