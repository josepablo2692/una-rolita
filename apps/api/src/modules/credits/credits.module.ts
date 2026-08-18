import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CreditAccount } from './entities/credit-account.entity';
import { CreditTransaction } from './entities/credit-transaction.entity';
import { CreditsService } from './credits.service';
import { CreditsController } from './credits.controller';
import { AuthorizationModule } from '../auth/authorization.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([CreditAccount, CreditTransaction]),
    // Provee VenueRolesGuard y los repositorios que necesita. Nest
    // construye el guard dentro del módulo que lo usa en @UseGuards
    // (este), no donde se declaró — por eso hay que importarlo aquí.
    AuthorizationModule,
  ],
  controllers: [CreditsController],
  providers: [CreditsService],
  // QueueModule lo va a necesitar en el PR 2 para cobrar al pedir canción.
  exports: [CreditsService, TypeOrmModule],
})
export class CreditsModule {}
