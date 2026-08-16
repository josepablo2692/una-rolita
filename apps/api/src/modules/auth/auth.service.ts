// apps/api/src/modules/auth/auth.service.ts
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
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
import * as bcrypt from 'bcryptjs';
import { Role } from './entities/role.entity';
import { UserVenueRole } from './entities/user-venue-role.entity';
import { LoginDto } from './dto/login.dto'; // lo creamos en el paso 4

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
    @InjectRepository(UserVenueRole) // ← nuevo
    private readonly userVenueRoleRepository: Repository<UserVenueRole>,
    @InjectRepository(Role) // ← nuevo
    private readonly roleRepository: Repository<Role>,
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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash, ...safeUser } = user;

    return { accessToken, refreshToken, user: safeUser as User };
  }

  private async findOrCreateUser(
    email: string,
    displayName?: string,
  ): Promise<User> {
    const existing = await this.userRepository.findOne({ where: { email } });
    if (existing) {
      existing.isEmailVerified = true;
      // Solo actualiza el nombre si no tenía uno antes — no queremos
      // sobrescribir un nombre que el usuario ya haya puesto a mano.
      if (displayName && !existing.displayName) {
        existing.displayName = displayName;
      }
      return this.userRepository.save(existing);
    }

    const user = this.userRepository.create({
      email,
      isEmailVerified: true,
      phoneNumber: null,
      displayName: displayName ?? null,
    });
    return this.userRepository.save(user);
  }

  async createGuestSession(
    qrCodeToken: string,
    deviceFingerprint?: string,
  ): Promise<TableSession> {
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
      deviceFingerprint: deviceFingerprint ?? null,
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

  // Login de staff/admin/DJ — email + contraseña, distinto al OTP de
  // clientes. Resuelve el rol REAL desde user_venue_roles, no lo
  // asume — a diferencia de upgradeGuestToUser, que siempre pone
  // 'customer'.
  async loginStaff(
    dto: LoginDto,
  ): Promise<{ accessToken: string; refreshToken: string; user: User }> {
    const user = await this.userRepository.findOne({
      where: { email: dto.email },
    });

    // Guard Clause: si no existe el usuario O no tiene password_hash
    // (es un cliente, nunca se le asignó uno), rechaza igual — mismo
    // mensaje para ambos casos, para no revelarle a un atacante cuál
    // de las dos cosas falló.
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const passwordMatches = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );
    if (!passwordMatches) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Busca el rol real. El ORDER BY roleId ASC no es cosmético: el
    // catálogo de roles está numerado por privilegio descendente
    // (1=super_admin, 2=venue_admin, 3=dj, 4=staff), así que el id más
    // bajo es el rol más alto. Sin este orden, Postgres devuelve la fila
    // que quiera: un artista solista (venue_admin Y dj en su propio
    // venue) recibiría 'dj' unas veces y 'venue_admin' otras, perdiendo
    // acceso a sus propios precios de forma intermitente.
    const assignment = await this.userVenueRoleRepository.findOne({
      where: { userId: user.id },
      order: { roleId: 'ASC' },
    });
    if (!assignment) {
      throw new UnauthorizedException(
        'Usuario sin rol asignado en ningún negocio',
      );
    }

    const role = await this.roleRepository.findOne({
      where: { id: assignment.roleId },
    });

    const payload: JwtPayload = {
      sub: user.id,
      role: role!.name, // el ! es seguro aquí: roleId viene de una FK válida, el rol SIEMPRE existe
      venueId: assignment.venueId,
    };
    const accessToken = this.jwtService.sign(payload);
    const refreshToken = await this.refreshTokenService.generate(user.id);

    // Nunca devolver el hash de la contraseña al cliente, aunque esté
    // hasheado — reduce la superficie de ataque si la respuesta se
    // intercepta o queda en un log.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash, ...safeUser } = user;

    return { accessToken, refreshToken, user: safeUser as User };
  } // Login vía Google — reusa findOrCreateUser (mismo método que
  // upgradeGuestToUser), porque el resultado final es el mismo: un
  // User real con email verificado. Solo cambia CÓMO se verificó
  // la identidad (Google, en vez de un código OTP).
  async loginWithGoogle(
    email: string,
    displayName: string,
  ): Promise<{ accessToken: string; refreshToken: string; user: User }> {
    const user = await this.findOrCreateUser(email, displayName);

    const payload: JwtPayload = {
      sub: user.id,
      role: 'customer', // igual que OTP: Google es para clientes, no reemplaza el login de staff
    };
    const accessToken = this.jwtService.sign(payload);
    const refreshToken = await this.refreshTokenService.generate(user.id);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash, ...safeUser } = user;

    return { accessToken, refreshToken, user: safeUser as User };
  }
}
