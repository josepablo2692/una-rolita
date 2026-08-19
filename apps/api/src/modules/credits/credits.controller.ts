import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { CreditsService } from './credits.service';
import { TopupCreditsDto } from './dto/topup-credits.dto';
import { LookupCustomerDto } from './dto/lookup-customer.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { VenueRolesGuard } from '../auth/guards/venue-roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

// El crédito siempre pertenece a un local (ADR 0004), así que la ruta
// cuelga del venue: nunca existe "suelto".
//
// CRITERIO DE GUARDS, igual que en QueueController:
// - Operación del local (buscar cliente, cargar crédito) → VenueRolesGuard
//   + @Roles: solo quien trabaja en ESE local.
// - Acción de cliente (ver mi saldo) → solo JwtAuthGuard: los clientes no
//   tienen fila en user_venue_roles y VenueRolesGuard los dejaría afuera.

@Controller('venues/:venueId/credits')
export class CreditsController {
  constructor(private readonly creditsService: CreditsService) {}

  // Buscar al cliente por teléfono y ver su saldo en este local, en una
  // sola llamada — que es exactamente el flujo del mesero en recepción.
  @UseGuards(JwtAuthGuard, VenueRolesGuard)
  @Roles('staff', 'venue_admin')
  @Get('account')
  lookup(
    @Param('venueId') venueId: string,
    @Query() dto: LookupCustomerDto,
  ): Promise<{
    userId: string;
    displayName: string | null;
    tienePhone: boolean;
    balance: number;
  }> {
    return this.creditsService.findCustomerForTopup(venueId, {
      phone: dto.phone,
      email: dto.email,
    });
  }

  // Carga manual en recepción — el renglón de prioridad de negocio del
  // backlog. El motor (applyTransaction) ya resuelve atomicidad e
  // idempotencia; aquí solo se abre la puerta con los permisos correctos.
  @UseGuards(JwtAuthGuard, VenueRolesGuard)
  @Roles('staff', 'venue_admin')
  @Post('topup')
  async topup(
    @Param('venueId') venueId: string,
    @Body() dto: TopupCreditsDto,
    @Req() req: Request & { user: { userId: string } },
  ): Promise<{
    transactionId: string;
    userId: string;
    credits: number;
    balance: number;
    createdAt: Date;
  }> {
    const movimiento = await this.creditsService.applyTransaction({
      userId: dto.userId,
      venueId,
      type: 'topup_manual',
      amount: dto.credits, // positivo: el crédito ENTRA
      paymentMethod: dto.paymentMethod,
      cashAmount: dto.cashAmount ?? null,
      // Sale del JWT, NUNCA del body. Si viniera del cuerpo, un mesero
      // podría registrar la carga a nombre de un compañero y la auditoría
      // no valdría nada — que es justamente para lo que existe.
      createdByStaffId: req.user.userId,
      idempotencyKey: dto.idempotencyKey,
    });

    // Proyección de lista blanca: devolvemos lo que el mesero necesita
    // ver, no la Entity completa con sus columnas internas.
    return {
      transactionId: movimiento.id,
      userId: dto.userId,
      credits: movimiento.amount,
      balance: movimiento.balanceAfter,
      createdAt: movimiento.createdAt,
    };
  }

  // El cliente consulta SU saldo en este local. El userId sale del token,
  // así que es estructuralmente imposible pedir el saldo de otro: no hay
  // parámetro que manipular.
  @UseGuards(JwtAuthGuard)
  @Get('me')
  async myBalance(
    @Param('venueId') venueId: string,
    @Req() req: Request & { user: { userId: string } },
  ): Promise<{ balance: number }> {
    return {
      balance: await this.creditsService.getBalance(req.user.userId, venueId),
    };
  }
}
