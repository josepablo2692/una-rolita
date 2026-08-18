import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Venue } from './entities/venue.entity';
import { VenueTable } from './entities/venue-table.entity';
import { VenuesController } from './venues.controller';
import { VenuesService } from './venues.service';
import { AuthorizationModule } from '../auth/authorization.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Venue, VenueTable]),
    // Provee VenueRolesGuard. NO importamos AuthModule aquí: AuthModule
    // ya importa VenuesModule y se formaría un ciclo.
    AuthorizationModule,
  ],
  controllers: [VenuesController],
  providers: [VenuesService],
  exports: [VenuesService, TypeOrmModule],
})
export class VenuesModule {}
