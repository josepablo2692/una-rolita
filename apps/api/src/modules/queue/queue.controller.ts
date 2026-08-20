import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
  Query,
} from '@nestjs/common';
import { QueueService, ResumenNoche } from './queue.service';
import { CreateQueueRequestDto } from './dto/create-queue-request.dto';
import { QueueRequest } from './entities/queue-request.entity';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { VenueRolesGuard } from '../auth/guards/venue-roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

// Rutas anidadas bajo /venues/:venueId/queue — la cola siempre pertenece
// a un venue específico, nunca existe "suelta".
//
// CRITERIO DE GUARDS EN ESTE CONTROLLER:
// - Acciones de CLIENTE (pedir, ver, cancelar lo propio): solo
//   JwtAuthGuard. Los clientes NO tienen fila en user_venue_roles —
//   ponerles VenueRolesGuard los dejaría a todos afuera.
// - Acciones de OPERACIÓN (marcar reproducida, saltar): además
//   VenueRolesGuard + @Roles, porque solo quien trabaja en ESE local
//   puede tocar la cola de ESE local.
@Controller('venues/:venueId/queue')
export class QueueController {
  constructor(private readonly queueService: QueueService) {}

  // Pedir una canción — acción de cliente.
  @UseGuards(JwtAuthGuard)
  @Post()
  create(
    @Param('venueId') venueId: string,
    @Body() dto: CreateQueueRequestDto,
    @Req() req: Request & { user: { userId: string } },
  ): Promise<QueueRequest> {
    return this.queueService.createRequest(
      venueId,
      dto.tableId,
      req.user.userId,
      dto,
    );
  }

  // Ver la cola — cualquier cliente autenticado del local.
  @UseGuards(JwtAuthGuard)
  @Get()
  findQueue(
    @Param('venueId') venueId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<QueueRequest[]> {
    return this.queueService.findQueueByVenue(
      venueId,
      limit ? parseInt(limit, 10) : 20,
      offset ? parseInt(offset, 10) : 0,
    );
  }

  // Marcar como reproducida — escribe en venue_song_history, que es lo
  // que alimenta el cooldown y el contador de saltos. Estaba SIN GUARD:
  // cualquiera podía envenenar el historial del local.
  @UseGuards(JwtAuthGuard, VenueRolesGuard)
  @Roles('dj', 'venue_admin')
  @Patch(':requestId/played')
  markAsPlayed(
    @Param('venueId') venueId: string,
    @Param('requestId') requestId: string,
  ): Promise<QueueRequest> {
    return this.queueService.markAsPlayed(venueId, requestId);
  }

  // Cancelar el pedido propio — acción de cliente. La pertenencia del
  // pedido la verifica el Service contra req.user.userId.
  @UseGuards(JwtAuthGuard)
  @Patch(':requestId/cancel')
  cancel(
    @Param('venueId') venueId: string,
    @Param('requestId') requestId: string,
    @Req() req: Request & { user: { userId: string } },
  ): Promise<QueueRequest> {
    return this.queueService.cancelRequest(venueId, requestId, req.user.userId);
  }

  // Saltar un pedido — decisión del artista/DJ. En Épica 3 esta acción
  // dispara un REEMBOLSO automático (ADR 0006), así que el rol no es
  // opcional: sin él, cualquier cliente podría forzar devoluciones.
  @UseGuards(JwtAuthGuard, VenueRolesGuard)
  @Roles('dj', 'venue_admin')
  @Patch(':requestId/skip')
  skip(
    @Param('venueId') venueId: string,
    @Param('requestId') requestId: string,
  ): Promise<QueueRequest> {
    return this.queueService.skipRequest(venueId, requestId);
  }

  // Cerrar la noche — acción de operación, y de las caras: reembolsa
  // TODA la cola pendiente. Por eso exige rol en ESTE local.
  //
  // Es POST y no PATCH porque no está modificando un recurso que el
  // cliente identificó: le está pidiendo al sistema que ejecute un
  // proceso (saltar, reembolsar, cerrar, medir) y le devuelva el
  // resultado.
  @UseGuards(JwtAuthGuard, VenueRolesGuard)
  @Roles('dj', 'venue_admin')
  @Post('close-night')
  closeNight(
    @Param('venueId') venueId: string,
    @Req() req: Request & { user: { userId: string } },
  ): Promise<ResumenNoche> {
    return this.queueService.closeSession({
      venueId,
      closedByUserId: req.user.userId,
    });
  }

  // La noche en curso, con sus números en vivo. Se declara ANTES que la
  // ruta con :sessionId: Nest resuelve por orden de declaración, y si
  // fuera al revés intentaría leer "current" como un UUID.
  @UseGuards(JwtAuthGuard, VenueRolesGuard)
  @Roles('dj', 'venue_admin')
  @Get('sessions/current')
  currentSession(@Param('venueId') venueId: string): Promise<ResumenNoche> {
    return this.queueService.getCurrentSession(venueId);
  }

  // El resumen de una noche cualquiera. ParseUUIDPipe rechaza basura
  // antes de que llegue a la base: sin él, un id inválido se convierte
  // en un 500 de Postgres en vez de un 400 honesto.
  @UseGuards(JwtAuthGuard, VenueRolesGuard)
  @Roles('dj', 'venue_admin')
  @Get('sessions/:sessionId')
  sessionSummary(
    @Param('venueId') venueId: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ): Promise<ResumenNoche> {
    return this.queueService.getSessionSummary(venueId, sessionId);
  }
}
