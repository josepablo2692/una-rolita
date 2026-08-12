// apps/api/src/modules/auth/auth.service.ts
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { TableSession } from './entities/table-session.entity';
import { VenueTable } from '../venues/entities/venue-table.entity';
import { User } from './entities/user.entity';
import { OtpService } from './otp/otp.service';
import { JwtPayload } from './jwt/jwt-payload.interface';
import { UpgradeDto } from './dto/upgrade.dto';
import { RefreshTokenService } from './jwt/refresh-token.service';

const SESSION_DURATION_HOURS = 10;

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(TableSession)
    private readonly tableSessionRepository: Repository<TableSession>,
    @InjectRepository(VenueTable)
    private readonly venueTableRepository: Repository<VenueTable>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly otpService: OtpService,
    private readonly jwtService: JwtService,
    private readonly refreshTokenService: RefreshTokenService,
  ) {}

  // ...createGuestSession y findActiveSession se quedan exactamente igual...

  async upgradeGuestToUser(
    dto: UpgradeDto,
  ): Promise<{ accessToken: string; refreshToken: string; user: User }> {
    // Guard Clause: sin código válido, no hay upgrade posible.
    const isValidCode = await this.otpService.verifyOtp(dto.email, dto.code);
    if (!isValidCode) {
      throw new BadRequestException('Código inválido o expirado');
    }

    // La sesión de invitado debe seguir viva — reutilizamos la validación
    // que ya existe, no la reescribimos.
    const session = await this.findActiveSession(dto.sessionId);

    const user = await this.findOrCreateUser(dto.email);

    // Conecta la sesión de mesa con el usuario real recién identificado.
    session.userId = user.id;
    await this.tableSessionRepository.save(session);

    const payload: JwtPayload = {
      sub: user.id,
      role: 'customer', // los roles de admin/DJ llegan en el paso 6 del roadmap
    };
    const accessToken = this.jwtService.sign(payload);
    const refreshToken = await this.refreshTokenService.generate(user.id); // ← nuevo

    return { accessToken, refreshToken, user };
  }

  private async findOrCreateUser(email: string): Promise<User> {
    const existing = await this.userRepository.findOne({ where: { email } });
    if (existing) {
      existing.isEmailVerified = true;
      return this.userRepository.save(existing);
    }

    const user = this.userRepository.create({
      email,
      isEmailVerified: true,
      phoneNumber: null,
    });
    return this.userRepository.save(user);
  }

  async createGuestSession(qrCodeToken: string): Promise<TableSession> {
    const table = await this.venueTableRepository.findOne({
      where: { qrCodeToken, isActive: true },
    });

    if (!table) {
      throw new NotFoundException('Código QR inválido o mesa inactiva');
    }

    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + SESSION_DURATION_HOURS);

    const session = this.tableSessionRepository.create({
      tableId: table.id,
      userId: null,
      expiresAt,
    });

    return this.tableSessionRepository.save(session);
  }
  // Pide un access token nuevo usando el refresh token. Rotación: el
  // refresh token usado muere aquí mismo, se entrega uno nuevo — si
  // alguien más lo intenta usar después, ya está revocado.
  async refreshAccessToken(
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const { userId, jti } = await this.refreshTokenService.verify(refreshToken);
    await this.refreshTokenService.revoke(jti, userId);

    const payload: JwtPayload = { sub: userId, role: 'customer' };
    const accessToken = this.jwtService.sign(payload);
    const newRefreshToken = await this.refreshTokenService.generate(userId);

    return { accessToken, refreshToken: newRefreshToken };
  }

  // Logout normal: solo mata la sesión de ESTE dispositivo.
  async logout(refreshToken: string): Promise<void> {
    const { userId, jti } = await this.refreshTokenService.verify(refreshToken);
    await this.refreshTokenService.revoke(jti, userId);
  }

  // El botón de emergencia: mata TODAS las sesiones del usuario.
  async revokeAllSessions(userId: string): Promise<void> {
    await this.refreshTokenService.revokeAllForUser(userId);
  }

  async findActiveSession(sessionId: string): Promise<TableSession> {
    const session = await this.tableSessionRepository.findOne({
      where: { id: sessionId },
    });

    if (!session) {
      throw new NotFoundException('Sesión no encontrada');
    }

    if (session.expiresAt < new Date()) {
      throw new BadRequestException(
        'La sesión ha expirado, escanea el QR de nuevo',
      );
    }

    return session;
  }
}
