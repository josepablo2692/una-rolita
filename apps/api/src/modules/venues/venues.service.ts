import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { NotificationsService } from '../notifications/notifications.service';

// Formatea la fecha como la lee alguien en Guatemala: 15/03/2027.
const FORMATO_GT = new Intl.DateTimeFormat('es-GT', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
import { Venue } from './entities/venue.entity';
import { VenueTable } from './entities/venue-table.entity';
import { CreateVenueDto } from './dto/create-venue.dto';
import { CreateVenueTableDto } from './dto/create-venue-table.dto';
import { UpdateVenuePricingDto } from './dto/update-venue-pricing.dto';
import { UpdateVenuePoliciesDto } from './dto/update-venue-policies.dto';

@Injectable()
export class VenuesService {
  constructor(
    @InjectRepository(Venue)
    private readonly venueRepository: Repository<Venue>,
    @InjectRepository(VenueTable)
    private readonly venueTableRepository: Repository<VenueTable>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
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

  // Proyección PÚBLICA del venue: lo que un cliente necesita para pedir
  // canciones, y nada más. findOne() devuelve la Entity completa, que
  // incluye bankAccountInfo (datos de cuenta bancaria) y spotifyAccountId
  // — eso jamás debe salir hacia un cliente.
  //
  // Lista blanca, no lista negra: enumeramos lo que SÍ sale. Así, el día
  // que agregues una columna sensible a Venue, no se filtra sola.
  async findOnePublic(id: string): Promise<Partial<Venue>> {
    const venue = await this.venueRepository.findOne({
      where: { id },
      select: {
        id: true,
        name: true,
        type: true,
        playlistMode: true,
        playbackMode: true,
        cooldownHours: true,
        queueJumpPrice: true,
        dedicationPrice: true,
        comboJumpDedicationPrice: true,
        isActive: true,
      },
    });

    if (!venue) {
      throw new NotFoundException(`No se encontró un venue con id ${id}`);
    }
    return venue;
  }

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

    const comboPrice =
      dto.comboJumpDedicationPrice ??
      this.calculateSuggestedComboPrice(newJumpPrice, newDedicationPrice);

    venue.queueJumpPrice = newJumpPrice;
    venue.dedicationPrice = newDedicationPrice;
    venue.comboJumpDedicationPrice = comboPrice;

    return this.venueRepository.save(venue);
  }

  // Políticas de operación: cuándo expiran los créditos y cuándo se
  // cierra la noche sola. Es un PATCH parcial — el admin manda solo lo
  // que quiere cambiar y lo demás se queda como estaba.
  async updatePolicies(
    id: string,
    dto: UpdateVenuePoliciesDto,
  ): Promise<Venue> {
    const venue = await this.findOne(id);

    const plazoAnterior = venue.creditExpiryMonths;

    // `?? venue.x` y no `|| venue.x`: con `||` un 0 enviado a propósito
    // ("no expiran nunca") se leería como ausente y se descartaría. Es
    // justo el valor que este endpoint existe para poder poner.
    venue.creditExpiryMonths =
      dto.creditExpiryMonths ?? venue.creditExpiryMonths;
    venue.sessionTimeoutHours =
      dto.sessionTimeoutHours ?? venue.sessionTimeoutHours;

    const plazoNuevo = venue.creditExpiryMonths;

    // Todo en una transacción: el cambio de política y los avisos son una
    // sola cosa. Si los avisos fallan, la política no cambia — no queremos
    // un local con plazo nuevo y clientes que nunca se enteraron.
    return this.dataSource.transaction(async (manager) => {
      const guardado = await manager.save(venue);

      if (this.elPlazoSeAcorta(plazoAnterior, plazoNuevo)) {
        await this.avisarCambioDePlazo(manager, guardado, plazoNuevo);
      }

      return guardado;
    });
  }

  // ¿El dinero de los clientes quedó MÁS expuesto que antes?
  //
  // Solo se avisa cuando el riesgo aumenta. Si el dueño alarga el plazo o
  // lo pone en "nunca", el saldo está más seguro y no hace falta molestar
  // a nadie.
  //
  // El 0 significa "no expiran nunca", así que NO se puede comparar como
  // número: pasar de 0 a 12 es el peor caso posible —dinero que estaba a
  // salvo ahora tiene fecha de vencimiento— y una comparación ingenua
  // (`12 < 0`) lo leería como una mejora.
  private elPlazoSeAcorta(anterior: number, nuevo: number): boolean {
    if (nuevo === 0) {
      return false; // ahora no expiran nunca: buena noticia
    }
    if (anterior === 0) {
      return true; // antes no expiraban y ahora sí: el peor caso
    }
    return nuevo < anterior;
  }

  private async avisarCambioDePlazo(
    manager: EntityManager,
    venue: Venue,
    plazoNuevo: number,
  ): Promise<void> {
    // Solo los clientes CON saldo. A quien tiene cero no le cambia nada y
    // un aviso sería ruido.
    const afectados = await manager.query<
      Array<{ user_id: string; balance: number; nueva_fecha: Date }>
    >(
      `SELECT user_id,
              balance,
              last_activity_at + ($2::int * INTERVAL '1 month') AS nueva_fecha
         FROM credit_accounts
        WHERE venue_id = $1 AND balance > 0`,
      [venue.id, plazoNuevo],
    );

    if (afectados.length === 0) {
      return;
    }

    // SE REINICIA EL AVISO PREVIO DE TODOS LOS AFECTADOS.
    //
    // Alguien avisado en enero bajo un plazo de 12 meses ya tenía su
    // cuenta marcada. Si el dueño lo baja a 6 en febrero, esa cuenta
    // podría expirar casi de inmediato —al job le basta con que el aviso
    // tenga 30 días— y el cliente perdería su saldo por un cambio que no
    // pidió. Al limpiar la marca, los 30 días de gracia vuelven a correr
    // bajo las reglas NUEVAS.
    await manager.query(
      `UPDATE credit_accounts
          SET expiry_warning_sent_at = NULL
        WHERE venue_id = $1 AND balance > 0`,
      [venue.id],
    );

    for (const cliente of afectados) {
      const fecha = FORMATO_GT.format(new Date(cliente.nueva_fecha));

      await this.notifications.crear({
        userId: cliente.user_id,
        venueId: venue.id,
        type: 'rules_changed',
        title: `Cambió la vigencia de tus créditos en ${venue.name}`,
        body:
          `${venue.name} acortó el plazo de vencimiento de los créditos a ` +
          `${plazoNuevo} ${plazoNuevo === 1 ? 'mes' : 'meses'} sin actividad. ` +
          `Tus Q${cliente.balance} ahora vencen el ${fecha}. ` +
          `Para conservarlos solo tenés que usarlos antes de esa fecha.`,
        data: {
          creditos: cliente.balance,
          plazoNuevoMeses: plazoNuevo,
          nuevaFecha: new Date(cliente.nueva_fecha).toISOString(),
        },
        // Por correo también, agrupado a la mañana. No es urgente al
        // minuto —el plazo más corto posible es un mes— y así un cambio
        // de política no dispara cien correos de golpe.
        porCorreo: true,
        manager,
      });
    }
  }

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
