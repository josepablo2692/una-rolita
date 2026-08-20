import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Venue } from './entities/venue.entity';
import { VenueTable } from './entities/venue-table.entity';
import { VenueSession } from './entities/venue-session.entity';
import { VenuesController } from './venues.controller';
import { VenuesService } from './venues.service';
import { AuthorizationModule } from '../auth/authorization.module';

@Module({
  imports: [
    // VenueSession se registra aquí porque la noche es un ciclo de vida
    // del LOCAL. QueueModule la consume vía el TypeOrmModule que este
    // módulo exporta.
    TypeOrmModule.forFeature([Venue, VenueTable, VenueSession]),
    // Provee VenueRolesGuard. NO importamos AuthModule aquí: AuthModule
    // ya importa VenuesModule y se formaría un ciclo.
    AuthorizationModule,
  ],
  controllers: [VenuesController],
  providers: [VenuesService],
  exports: [VenuesService, TypeOrmModule],
})
export class VenuesModule {}
