import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { QueueService } from './queue.service';
import { CreateQueueRequestDto } from './dto/create-queue-request.dto';
import { QueueRequest } from './entities/queue-request.entity';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

// Rutas anidadas bajo /venues/:venueId/queue — la cola siempre pertenece
// a un venue específico, nunca existe "suelta".
@Controller('venues/:venueId/queue')
export class QueueController {
  constructor(private readonly queueService: QueueService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  create(
    @Param('venueId') venueId: string,
    @Body() dto: CreateQueueRequestDto & { tableId: string },
    @Req() req: Request & { user: { userId: string } },
  ): Promise<QueueRequest> {
    return this.queueService.createRequest(
      venueId,
      dto.tableId,
      req.user.userId, // ← viene del JWT verificado, ya no del body
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
