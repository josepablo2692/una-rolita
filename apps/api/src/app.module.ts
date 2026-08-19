import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { VenuesModule } from './modules/venues/venues.module';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './modules/auth/auth.module';
import { RedisModule } from './redis/redis.module';
import { QueueModule } from './modules/queue/queue.module';
import { CreditsModule } from './modules/credits/credits.module';
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }), // lee el .env y lo deja disponible en toda la app
    DatabaseModule,
    VenuesModule,
    RedisModule,
    AuthModule,
    QueueModule,
    CreditsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
