import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { VenuesService } from './venues.service';
import { CreateVenueDto } from './dto/create-venue.dto';
import { Venue } from './entities/venue.entity';

// El Controller es la "recepción" del módulo: recibe la petición HTTP
// ya validada (el Pipe/DTO ya hizo su trabajo antes de llegar aquí),
// y le delega el trabajo real al Service. El Controller NUNCA debe
// tener lógica de negocio — solo recibe, delega, y devuelve.

@Controller('venues') // define el prefijo de la URL: /venues
export class VenuesController {
  constructor(private readonly venuesService: VenuesService) {}

  @Post() // responde a: POST /venues
  create(@Body() dto: CreateVenueDto): Promise<Venue> {
    return this.venuesService.create(dto);
  }

  @Get() // responde a: GET /venues
  findAll(): Promise<Venue[]> {
    return this.venuesService.findAll();
  }

  @Get(':id') // responde a: GET /venues/algun-uuid
  findOne(@Param('id') id: string): Promise<Venue> {
    return this.venuesService.findOne(id);
  }
}
