import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CreditAccount } from './entities/credit-account.entity';
import { CreditTransaction } from './entities/credit-transaction.entity';
import { CreditsService } from './credits.service';

@Module({
  imports: [TypeOrmModule.forFeature([CreditAccount, CreditTransaction])],
  providers: [CreditsService],
  // QueueModule lo va a necesitar en el PR 2 para cobrar al pedir canción.
  exports: [CreditsService, TypeOrmModule],
})
export class CreditsModule {}
