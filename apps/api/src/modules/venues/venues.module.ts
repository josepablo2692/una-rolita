import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Venue } from './entities/venue.entity';
import { VenueTable } from './entities/venue-table.entity';

@Module({
  imports: [
    // TypeOrmModule.forFeature registra estas Entities específicamente
    // dentro de ESTE módulo — así el resto de la app sabe que "venues"
    // es responsable de leer/escribir estas dos tablas.
    TypeOrmModule.forFeature([Venue, VenueTable]),
  ],
  // A medida que creemos VenuesService y VenuesController, se agregan aquí:
  // controllers: [VenuesController],
  // providers: [VenuesService],
  // exports: [VenuesService], // para que otros módulos (queue, credits) puedan usarlo
})
export class VenuesModule {}
