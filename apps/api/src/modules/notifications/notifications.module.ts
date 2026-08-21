import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Notification } from './entities/notification.entity';
import { NotificationDelivery } from './entities/notification-delivery.entity';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { MAILER } from './mailer.interface';
import { NodemailerMailer } from './nodemailer.mailer';

@Module({
  imports: [TypeOrmModule.forFeature([Notification, NotificationDelivery])],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    // El transporte de correo, detrás de un token para poder cambiarlo
    // en las pruebas. Sin esto, cada `test:e2e` mandaría correos reales.
    { provide: MAILER, useClass: NodemailerMailer },
  ],
  // QueueModule y CreditsModule lo necesitan para avisar del reembolso
  // al cerrar la noche y de la expiración de saldos.
  exports: [NotificationsService, TypeOrmModule],
})
export class NotificationsModule {}
