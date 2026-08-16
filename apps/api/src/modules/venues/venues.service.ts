import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Venue } from './entities/venue.entity';
import { VenueTable } from './entities/venue-table.entity';
import { CreateVenueDto } from './dto/create-venue.dto';
import { CreateVenueTableDto } from './dto/create-venue-table.dto';
import { UpdateVenuePricingDto } from './dto/update-venue-pricing.dto';

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

  // Proyección PÚBLICA del venue: lo que un cliente necesita para pedir
  // canciones, y nada más. findOne() devuelve la Entity completa, que
  // incluye bankAccountInfo (datos de cuenta bancaria) y spotifyAccountId
  // — eso jamás debe salir hacia un cliente.
  //
  // Lista blanca, no lista negra: enumeramos lo que SÍ sale. Así, el día
  // que agregues una columna sensible a Venue, no se filtra sola.
  async findOnePublic(id: string): Promise<Partial<Venue>> {
    const venue = await this.venueRepository.findOne({
      where: { id },
      select: {
        id: true,
        name: true,
        type: true,
        playlistMode: true,
        playbackMode: true,
        cooldownHours: true,
        queueJumpPrice: true,
        dedicationPrice: true,
        comboJumpDedicationPrice: true,
        isActive: true,
      },
    });

    if (!venue) {
      throw new NotFoundException(`No se encontró un venue con id ${id}`);
    }
    return venue;
  }

  calculateSuggestedComboPrice(
    queueJumpPrice: number,
    dedicationPrice: number,
  ): number {
    return Number((queueJumpPrice + dedicationPrice - 1).toFixed(2));
  }

  async updatePricing(id: string, dto: UpdateVenuePricingDto): Promise<Venue> {
    const venue = await this.findOne(id);

    const newJumpPrice = dto.queueJumpPrice ?? venue.queueJumpPrice;
    const newDedicationPrice = dto.dedicationPrice ?? venue.dedicationPrice;

    const comboPrice =
      dto.comboJumpDedicationPrice ??
      this.calculateSuggestedComboPrice(newJumpPrice, newDedicationPrice);

    venue.queueJumpPrice = newJumpPrice;
    venue.dedicationPrice = newDedicationPrice;
    venue.comboJumpDedicationPrice = comboPrice;

    return this.venueRepository.save(venue);
  }

  async createTable(
    venueId: string,
    dto: CreateVenueTableDto,
  ): Promise<VenueTable> {
    await this.findOne(venueId);

    const table = this.venueTableRepository.create({
      venueId,
      label: dto.label,
      qrCodeToken: randomUUID(),
    });

    return this.venueTableRepository.save(table);
  }

  async findTablesByVenue(venueId: string): Promise<VenueTable[]> {
    return this.venueTableRepository.find({ where: { venueId } });
  }
}
