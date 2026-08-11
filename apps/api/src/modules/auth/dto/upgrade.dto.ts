// apps/api/src/modules/auth/dto/upgrade.dto.ts
import { IsEmail, IsUUID, Length } from 'class-validator';

export class UpgradeDto {
  @IsUUID() // el id de la TableSession que ya tiene el invitado
  sessionId!: string;

  @IsEmail()
  email!: string;

  @Length(6, 6)
  code!: string;
}
