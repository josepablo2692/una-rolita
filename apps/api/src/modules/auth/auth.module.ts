import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { TableSession } from './entities/table-session.entity';
import { VenuesModule } from '../venues/venues.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, TableSession]),
    // Necesario porque TableSession/AuthService tienen una relación hacia
    // VenueTable, que vive en el módulo venues.
    VenuesModule,
  ],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
