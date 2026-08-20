import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CreditAccount } from './entities/credit-account.entity';
import { CreditTransaction } from './entities/credit-transaction.entity';
import { CreditsService } from './credits.service';
import { CreditsController } from './credits.controller';
import { AuthorizationModule } from '../auth/authorization.module';
import { CreditExpiryService } from './expiry/credit-expiry.service';
import { EmailExpiryNotifier } from './expiry/email-expiry.notifier';
import { EXPIRY_NOTIFIER } from './expiry/expiry-notifier.interface';

@Module({
  imports: [
    TypeOrmModule.forFeature([CreditAccount, CreditTransaction]),
    // Provee VenueRolesGuard y los repositorios que necesita. Nest
    // construye el guard dentro del módulo que lo usa en @UseGuards
    // (este), no donde se declaró — por eso hay que importarlo aquí.
    AuthorizationModule,
  ],
  controllers: [CreditsController],
  providers: [
    CreditsService,
    CreditExpiryService,
    // El canal por el que sale el aviso. Está detrás de un token porque
    // una interfaz de TypeScript no existe en tiempo de ejecución: Nest
    // necesita algo concreto que buscar. En PR 6 se agrega el canal de
    // mensaje en la app cambiando SOLO esta línea.
    { provide: EXPIRY_NOTIFIER, useClass: EmailExpiryNotifier },
  ],
  // QueueModule lo va a necesitar en el PR 2 para cobrar al pedir canción.
  // CreditExpiryService se exporta para poder invocar los jobs desde las
  // pruebas sin esperar a que den las 4 de la mañana.
  exports: [CreditsService, CreditExpiryService, TypeOrmModule],
})
export class CreditsModule {}
