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

  // ------------------------------------------------------------
  // Actualización de precios, con sugerencia automática del combo
  // ------------------------------------------------------------

  /**
   * Fórmula de sugerencia de negocio: salto + dedicatoria - 1.
   * Existe como método propio (no inline) para que la regla tenga
   * un solo lugar de verdad — si el descuento cambia de Q1 a Q2 en
   * el futuro, se toca aquí y en ningún otro lado (principio DRY).
   */
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

    // Si el admin NO mandó un comboPrice explícito, pero sí cambió
    // alguno de los otros dos precios, recalculamos la sugerencia.
    // Si SÍ lo mandó explícito, se respeta su decisión tal cual.
    const comboPrice =
      dto.comboJumpDedicationPrice ??
      this.calculateSuggestedComboPrice(newJumpPrice, newDedicationPrice);

    venue.queueJumpPrice = newJumpPrice;
    venue.dedicationPrice = newDedicationPrice;
    venue.comboJumpDedicationPrice = comboPrice;

    return this.venueRepository.save(venue);
  }

  // ------------------------------------------------------------
  // Mesas (VenueTable) — aquí nace el qr_code_token de cada mesa
  // ------------------------------------------------------------

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
