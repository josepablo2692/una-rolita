import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { VenuesModule } from './modules/venues/venues.module';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './modules/auth/auth.module';
import { RedisModule } from './redis/redis.module';
import { QueueModule } from './modules/queue/queue.module';
import { CreditsModule } from './modules/credits/credits.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }), // lee el .env y lo deja disponible en toda la app
    // Habilita los @Cron de toda la app. Hoy solo lo usa el cierre
    // automático de la noche (la red de seguridad para cuando al DJ se
    // le olvida cerrar). Sin este forRoot(), los @Cron no corren.
    ScheduleModule.forRoot(),
    DatabaseModule,
    VenuesModule,
    RedisModule,
    AuthModule,
    QueueModule,
    CreditsModule,
    NotificationsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
