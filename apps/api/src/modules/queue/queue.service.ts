import {
  Inject,
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { Song } from './entities/song.entity';
import { VenueSongHistory } from './entities/venue-song-history.entity';
import { QueueRequest } from './entities/queue-request.entity';
import { QueueJump } from './entities/queue-jump.entity';
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

  async findQueueByVenue(venueId: string): Promise<QueueRequest[]> {
    return this.queueRequestRepository.find({
      where: { venueId, status: 'queued' as const },
      order: { position: 'ASC' },
    });
  }

  // Marca una canción como reproducida y la registra en el historial
  // (VenueSongHistory), que es lo que alimenta el cooldown a futuro.
  async markAsPlayed(id: string): Promise<QueueRequest> {
    const request = await this.queueRequestRepository.findOne({
      where: { id },
    });
    if (!request) {
      throw new NotFoundException(
        `No se encontró el pedido de cola con id ${id}`,
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

  // Posición de salto pagado: justo después de lo que ya está sonando
  // (posición 1) — al frente de todos los pedidos normales en espera.
  private async calculateJumpPosition(venueId: string): Promise<number> {
    const playing = await this.queueRequestRepository.findOne({
      where: { venueId, status: 'playing' as const },
    });
    return (playing?.position ?? 0) + 1;
  }

  // Libera el lock SOLO si sigue siendo el que este proceso creó —
  // evita borrar por accidente el candado de otro proceso si el
  // nuestro ya expiró y alguien más lo tomó mientras tanto.
  private async releaseLockIfOwned(
    lockKey: string,
    lockValue: string,
  ): Promise<void> {
    const currentValue = await this.redis.get(lockKey);
    if (currentValue === lockValue) {
      await this.redis.del(lockKey);
    }
  }
}
