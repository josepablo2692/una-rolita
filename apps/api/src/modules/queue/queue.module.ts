import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Song } from './entities/song.entity';
import { VenueSongHistory } from './entities/venue-song-history.entity';
import { QueueRequest } from './entities/queue-request.entity';
import { QueueJump } from './entities/queue-jump.entity';
import { VenuesModule } from '../venues/venues.module';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../../redis/redis.module';
import { QueueController } from './queue.controller';
import { QueueService } from './queue.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Song, VenueSongHistory, QueueRequest, QueueJump]),
    // QueueRequest/QueueJump tienen relaciones hacia Venue/VenueTable (venues)
    // y hacia User (auth) — por eso ambos módulos deben estar aquí.
    VenuesModule,
    AuthModule,
    // El lock distribuido (Redlock) que evita que dos personas paguen
    // por la misma posición de cola al mismo tiempo.
    RedisModule,
  ],
  controllers: [QueueController],
  providers: [QueueService],
})
export class QueueModule {}
