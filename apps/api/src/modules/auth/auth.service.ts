import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TableSession } from './entities/table-session.entity';
import { VenueTable } from '../venues/entities/venue-table.entity';

const SESSION_DURATION_HOURS = 10; // cubre una noche de bar completa, sin re-escaneo

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(TableSession)
    private readonly tableSessionRepository: Repository<TableSession>,
    @InjectRepository(VenueTable)
    private readonly venueTableRepository: Repository<VenueTable>,
  ) {}

  async createGuestSession(qrCodeToken: string): Promise<TableSession> {
    // Paso 1: la mesa debe existir Y estar activa.
    const table = await this.venueTableRepository.findOne({
      where: { qrCodeToken, isActive: true },
    });

    if (!table) {
      throw new NotFoundException('Código QR inválido o mesa inactiva');
    }

    // Paso 2: crear la sesión de invitado (userId null = progressive registration,
    // todavía no hay identidad verificada).
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + SESSION_DURATION_HOURS);

    const session = this.tableSessionRepository.create({
      tableId: table.id,
      userId: null,
      expiresAt,
    });

    return this.tableSessionRepository.save(session);
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
