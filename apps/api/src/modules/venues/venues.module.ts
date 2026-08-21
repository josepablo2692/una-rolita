import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Venue } from './entities/venue.entity';
import { VenueTable } from './entities/venue-table.entity';
import { VenueSession } from './entities/venue-session.entity';
import { VenuesController } from './venues.controller';
import { VenuesService } from './venues.service';
import { AuthorizationModule } from '../auth/authorization.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    // VenueSession se registra aquí porque la noche es un ciclo de vida
    // del LOCAL. QueueModule la consume vía el TypeOrmModule que este
    // módulo exporta.
    TypeOrmModule.forFeature([Venue, VenueTable, VenueSession]),
    // Provee VenueRolesGuard. NO importamos AuthModule aquí: AuthModule
    // ya importa VenuesModule y se formaría un ciclo.
    AuthorizationModule,
    // Acortar el plazo de expiración adelanta la fecha de vencimiento del
    // dinero que los clientes YA tienen guardado. Eso se avisa.
    NotificationsModule,
  ],
  controllers: [VenuesController],
  providers: [VenuesService],
  exports: [VenuesService, TypeOrmModule],
})
export class VenuesModule {}
