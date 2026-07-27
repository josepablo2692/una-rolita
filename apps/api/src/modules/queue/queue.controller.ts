import { Controller, Post, Get, Patch, Body, Param } from '@nestjs/common';
import { QueueService } from './queue.service';
import { CreateQueueRequestDto } from './dto/create-queue-request.dto';
import { QueueRequest } from './entities/queue-request.entity';

// Rutas anidadas bajo /venues/:venueId/queue — la cola siempre pertenece
// a un venue específico, nunca existe "suelta".
@Controller('venues/:venueId/queue')
export class QueueController {
  constructor(private readonly queueService: QueueService) {}

  @Post()
  create(
    @Param('venueId') venueId: string,
    @Body() dto: CreateQueueRequestDto & { tableId: string; userId: string },
  ): Promise<QueueRequest> {
    // tableId y userId vienen en el body por ahora (en un paso futuro,
    // userId saldrá del JWT vía Guard, no del body — anotado en backlog).
    return this.queueService.createRequest(
      venueId,
      dto.tableId,
      dto.userId,
      dto,
    );
  }

  @Get()
  findQueue(@Param('venueId') venueId: string): Promise<QueueRequest[]> {
    return this.queueService.findQueueByVenue(venueId);
  }

  @Patch(':requestId/played')
  markAsPlayed(@Param('requestId') requestId: string): Promise<QueueRequest> {
    return this.queueService.markAsPlayed(requestId);
  }
}
