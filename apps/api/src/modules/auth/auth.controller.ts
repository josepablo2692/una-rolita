import { Controller, Post, Get, Body, Param } from '@nestjs/common';
import { AuthService } from './auth.service';
import { ScanQrDto } from './dto/scan-qr.dto';
import { TableSession } from './entities/table-session.entity';

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
}
