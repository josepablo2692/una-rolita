import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { VenuesService } from './venues.service';
import { CreateVenueDto } from './dto/create-venue.dto';
import { CreateVenueTableDto } from './dto/create-venue-table.dto';
import { UpdateVenuePricingDto } from './dto/update-venue-pricing.dto';
import { UpdateVenuePoliciesDto } from './dto/update-venue-policies.dto';
import { Venue } from './entities/venue.entity';
import { VenueTable } from './entities/venue-table.entity';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { VenueRolesGuard } from '../auth/guards/venue-roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('venues')
export class VenuesController {
  constructor(private readonly venuesService: VenuesService) {}

  // Crear un negocio es una operación de PLATAFORMA, no de venue: el
  // venue todavía no existe, así que no hay pertenencia que verificar.
  // Por eso usa RolesGuard (rol del token) y no VenueRolesGuard.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Post()
  create(@Body() dto: CreateVenueDto): Promise<Venue> {
    return this.venuesService.create(dto);
  }

  // Listar TODOS los negocios de la plataforma — solo el dueño del SaaS.
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  @Get()
  findAll(): Promise<Venue[]> {
    return this.venuesService.findAll();
  }

  // Un cliente necesita ver el local y sus precios para pedir canciones.
  // Devuelve la proyección pública: sin datos bancarios ni cuenta Spotify.
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  findOne(@Param('id') id: string): Promise<Partial<Venue>> {
    return this.venuesService.findOnePublic(id);
  }

  // Cambiar precios: solo el admin DE ESE negocio.
  @UseGuards(JwtAuthGuard, VenueRolesGuard)
  @Roles('venue_admin')
  @Patch(':id/pricing')
  updatePricing(
    @Param('id') id: string,
    @Body() dto: UpdateVenuePricingDto,
  ): Promise<Venue> {
    return this.venuesService.updatePricing(id, dto);
  }

  // Políticas de operación: expiración de créditos y cierre automático.
  //
  // Endpoint aparte de /pricing a propósito. Cambiar un precio afecta el
  // próximo pedido; cambiar la expiración afecta el dinero que los
  // clientes YA tienen guardado. No deben poder tocarse por accidente en
  // la misma llamada.
  @UseGuards(JwtAuthGuard, VenueRolesGuard)
  @Roles('venue_admin')
  @Patch(':id/policies')
  updatePolicies(
    @Param('id') id: string,
    @Body() dto: UpdateVenuePoliciesDto,
  ): Promise<Venue> {
    return this.venuesService.updatePolicies(id, dto);
  }

  // Crear mesas genera qrCodeToken — la llave de acceso de la mesa.
  @UseGuards(JwtAuthGuard, VenueRolesGuard)
  @Roles('venue_admin')
  @Post(':venueId/tables')
  createTable(
    @Param('venueId') venueId: string,
    @Body() dto: CreateVenueTableDto,
  ): Promise<VenueTable> {
    return this.venuesService.createTable(venueId, dto);
  }

  // Ver las mesas: quien opera el local.
  @UseGuards(JwtAuthGuard, VenueRolesGuard)
  @Roles('venue_admin', 'dj', 'staff')
  @Get(':venueId/tables')
  findTables(@Param('venueId') venueId: string): Promise<VenueTable[]> {
    return this.venuesService.findTablesByVenue(venueId);
  }
}
