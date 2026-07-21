import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Venue } from './entities/venue.entity';
import { CreateVenueDto } from './dto/create-venue.dto';

// El Service es donde vive la LÓGICA DE NEGOCIO real.
// El Controller nunca habla directo con la base de datos — siempre
// le pide el trabajo al Service, y el Service usa el Repository
// (una herramienta que TypeORM nos da automáticamente) para
// leer/escribir en Postgres.

@Injectable() // le dice a NestJS "esta clase se puede inyectar en otras (ej. el Controller)"
export class VenuesService {
  constructor(
    @InjectRepository(Venue)
    private readonly venueRepository: Repository<Venue>,
  ) {}

  async create(dto: CreateVenueDto): Promise<Venue> {
    const venue = this.venueRepository.create(dto); // arma el objeto en memoria
    return this.venueRepository.save(venue); // lo guarda de verdad en Postgres
  }

  async findAll(): Promise<Venue[]> {
    return this.venueRepository.find();
  }

  async findOne(id: string): Promise<Venue> {
    const venue = await this.venueRepository.findOne({ where: { id } });
    if (!venue) {
      throw new NotFoundException(`No se encontró un venue con id ${id}`);
    }
    return venue;
  }
}
