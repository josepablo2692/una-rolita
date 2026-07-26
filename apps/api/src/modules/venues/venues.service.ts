import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Venue } from './entities/venue.entity';
import { VenueTable } from './entities/venue-table.entity';
import { CreateVenueDto } from './dto/create-venue.dto';
import { CreateVenueTableDto } from './dto/create-venue-table.dto';

@Injectable()
export class VenuesService {
  constructor(
    @InjectRepository(Venue)
    private readonly venueRepository: Repository<Venue>,
    @InjectRepository(VenueTable)
    private readonly venueTableRepository: Repository<VenueTable>,
  ) {}

  async create(dto: CreateVenueDto): Promise<Venue> {
    const venue = this.venueRepository.create(dto);
    return this.venueRepository.save(venue);
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

  // ------------------------------------------------------------
  // Mesas (VenueTable) — aquí nace el qr_code_token de cada mesa
  // ------------------------------------------------------------

  async createTable(
    venueId: string,
    dto: CreateVenueTableDto,
  ): Promise<VenueTable> {
    // Confirma que el venue existe antes de crearle una mesa (Guard Clause).
    await this.findOne(venueId);

    const table = this.venueTableRepository.create({
      venueId,
      label: dto.label,
      qrCodeToken: randomUUID(), // identificador único que se codifica en la imagen QR
    });

    return this.venueTableRepository.save(table);
  }

  async findTablesByVenue(venueId: string): Promise<VenueTable[]> {
    return this.venueTableRepository.find({ where: { venueId } });
  }
}
