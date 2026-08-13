import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { ScanQrDto } from './dto/scan-qr.dto';
import { TableSession } from './entities/table-session.entity';
import { UpgradeDto } from './dto/upgrade.dto';
import { RefreshDto } from './dto/refresh.dto';
import { User } from './entities/user.entity';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { LoginDto } from './dto/login.dto';
import { Roles } from './decorators/roles.decorator';
import { RolesGuard } from './guards/roles.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('scan')
  scan(@Body() dto: ScanQrDto): Promise<TableSession> {
    return this.authService.createGuestSession(dto.qrCodeToken);
  }

  @Get('session/:id')
  getSession(@Param('id') id: string): Promise<TableSession> {
    return this.authService.findActiveSession(id);
  }
  // apps/api/src/modules/auth/auth.controller.ts (agrega este método a la clase existente)

  @Post('upgrade')
  upgrade(
    @Body() dto: UpgradeDto,
  ): Promise<{ accessToken: string; refreshToken: string; user: User }> {
    return this.authService.upgradeGuestToUser(dto);
  }
  @Post('refresh')
  refreshToken(
    @Body() dto: RefreshDto,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    return this.authService.refreshAccessToken(dto.refreshToken);
  }

  @Post('logout')
  async logout(@Body() dto: RefreshDto): Promise<{ message: string }> {
    await this.authService.logout(dto.refreshToken);
    return { message: 'Sesión cerrada' };
  }

  // Primer endpoint del proyecto protegido de verdad con JwtAuthGuard —
  // necesitas un access token vigente para poder pedir "cierra todo".
  @UseGuards(JwtAuthGuard)
  @Post('revoke-sessions')
  async revokeSessions(
    @Req() req: Request & { user: { userId: string } },
  ): Promise<{ message: string }> {
    await this.authService.revokeAllSessions(req.user.userId);
    return { message: 'Todas las sesiones fueron cerradas' };
  }

  //Login de administadores y usuarios del venue
  @Post('login')
  login(
    @Body() dto: LoginDto,
  ): Promise<{ accessToken: string; refreshToken: string; user: User }> {
    return this.authService.loginStaff(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('venue_admin', 'super_admin')
  @Get('admin-only-test')
  adminOnlyTest(): { message: string } {
    return { message: 'Si ves esto, tu rol tiene permiso' };
  }
}
