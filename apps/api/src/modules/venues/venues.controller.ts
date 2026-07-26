import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { VenuesService } from './venues.service';
import { CreateVenueDto } from './dto/create-venue.dto';
import { CreateVenueTableDto } from './dto/create-venue-table.dto';
import { Venue } from './entities/venue.entity';
import { VenueTable } from './entities/venue-table.entity';

@Controller('venues')
export class VenuesController {
  constructor(private readonly venuesService: VenuesService) {}

  @Post()
  create(@Body() dto: CreateVenueDto): Promise<Venue> {
    return this.venuesService.create(dto);
  }

  @Get()
  findAll(): Promise<Venue[]> {
    return this.venuesService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<Venue> {
    return this.venuesService.findOne(id);
  }

  // Mesas anidadas bajo un venue: /venues/:venueId/tables
  @Post(':venueId/tables')
  createTable(
    @Param('venueId') venueId: string,
    @Body() dto: CreateVenueTableDto,
  ): Promise<VenueTable> {
    return this.venuesService.createTable(venueId, dto);
  }

  @Get(':venueId/tables')
  findTables(@Param('venueId') venueId: string): Promise<VenueTable[]> {
    return this.venuesService.findTablesByVenue(venueId);
  }
}
