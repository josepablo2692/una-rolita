import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.get<string>('DATABASE_URL'),
        autoLoadEntities: true, // detecta automaticamente las Entities de cada modulo
        synchronize: false, // NUNCA true en un proyecto real: synchronize borra/recrea columnas solo. Usamos schema.sql + migraciones manuales.
      }),
    }),
  ],
})
export class DatabaseModule {}
