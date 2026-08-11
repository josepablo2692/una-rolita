import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Venue } from './entities/venue.entity';
import { VenueTable } from './entities/venue-table.entity';
import { VenuesController } from './venues.controller';
import { VenuesService } from './venues.service';

@Module({
  imports: [
    // TypeOrmModule.forFeature registra estas Entities específicamente
    // dentro de ESTE módulo — así el resto de la app sabe que "venues"
    // es responsable de leer/escribir estas dos tablas.
    TypeOrmModule.forFeature([Venue, VenueTable]),
  ],
  controllers: [VenuesController],
  providers: [VenuesService],
  exports: [
    VenuesService,
    TypeOrmModule, // permite que otros módulos (auth, queue) inyecten Repository<Venue> y Repository<VenueTable>
  ], // para que otros módulos (queue, credits) puedan usarlo
})
export class VenuesModule {}
