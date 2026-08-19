import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Song } from './entities/song.entity';
import { VenueSongHistory } from './entities/venue-song-history.entity';
import { QueueRequest } from './entities/queue-request.entity';
import { QueueJump } from './entities/queue-jump.entity';
import { VenuesModule } from '../venues/venues.module';
import { AuthModule } from '../auth/auth.module';
import { AuthorizationModule } from '../auth/authorization.module';
import { RedisModule } from '../../redis/redis.module';
import { QueueController } from './queue.controller';
import { QueueService } from './queue.service';
import { QueueGateway } from './queue.gateway';
import { CreditsModule } from '../credits/credits.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Song, VenueSongHistory, QueueRequest, QueueJump]),
    // QueueRequest/QueueJump tienen relaciones hacia Venue/VenueTable (venues)
    // y hacia User (auth) — por eso ambos módulos deben estar aquí.
    VenuesModule,
    AuthModule,
    // Provee VenueRolesGuard y los repositorios que necesita. Nest
    // construye el guard dentro de ESTE módulo (porque aquí vive el
    // controller que lo usa en @UseGuards), no donde se declaró.
    AuthorizationModule,
    // El lock distribuido (Redlock) que evita que dos personas paguen
    // por la misma posición de cola al mismo tiempo.
    CreditsModule,
    RedisModule,
  ],
  controllers: [QueueController],
  providers: [QueueService, QueueGateway],
})
export class QueueModule {}
