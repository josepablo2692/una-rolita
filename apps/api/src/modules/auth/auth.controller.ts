import { Controller, Post, Get, Body, Param } from '@nestjs/common';
import { AuthService } from './auth.service';
import { ScanQrDto } from './dto/scan-qr.dto';
import { TableSession } from './entities/table-session.entity';
import { UpgradeDto } from './dto/upgrade.dto';
import { User } from './entities/user.entity';

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
  ): Promise<{ accessToken: string; user: User }> {
    return this.authService.upgradeGuestToUser(dto);
  }
}
