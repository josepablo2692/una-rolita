// apps/api/src/modules/auth/dto/refresh.dto.ts
import { IsJWT } from 'class-validator';

export class RefreshDto {
  @IsJWT() // valida que tenga la FORMA de un JWT, no que sea válido de verdad — eso lo hace el servicio
  refreshToken!: string;
}
