import {
  Controller,
  Get,
  Patch,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { Request } from 'express';
import { NotificationsService } from './notifications.service';
import { Notification } from './entities/notification.entity';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

// Rutas del CLIENTE sobre sus propios avisos. Solo JwtAuthGuard: los
// clientes no tienen fila en user_venue_roles, así que un VenueRolesGuard
// los dejaría a todos afuera.
//
// No existe una ruta para ver los avisos de OTRA persona. El userId sale
// siempre del token, nunca de un parámetro — así no hay forma de pedir la
// bandeja ajena aunque se adivine un id.
@UseGuards(JwtAuthGuard)
@Controller('me/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  listar(
    @Req() req: Request & { user: { userId: string } },
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<Notification[]> {
    return this.notifications.listarDe(
      req.user.userId,
      limit ? parseInt(limit, 10) : 30,
      offset ? parseInt(offset, 10) : 0,
    );
  }

  // El contador del globito. Va aparte de la lista porque la app lo
  // consulta mucho más seguido de lo que abre la bandeja, y tiene su
  // propio índice parcial en la base.
  @Get('unread-count')
  contar(
    @Req() req: Request & { user: { userId: string } },
  ): Promise<{ sinLeer: number }> {
    return this.notifications
      .contarSinLeer(req.user.userId)
      .then((sinLeer) => ({ sinLeer }));
  }

  @Patch(':notificationId/read')
  async marcarLeido(
    @Param('notificationId', ParseUUIDPipe) notificationId: string,
    @Req() req: Request & { user: { userId: string } },
  ): Promise<{ ok: true }> {
    const marcado = await this.notifications.marcarLeido(
      req.user.userId,
      notificationId,
    );

    // Un aviso de otra persona da el MISMO 404 que uno inexistente: no
    // se revela si el id es real.
    if (!marcado) {
      throw new NotFoundException('No se encontró ese aviso');
    }

    return { ok: true };
  }
}
