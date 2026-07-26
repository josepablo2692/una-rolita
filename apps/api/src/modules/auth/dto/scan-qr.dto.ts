import { IsString, MinLength } from 'class-validator';

// Lo único que el cliente manda al escanear el QR: el token que viene
// embebido en la URL/código. Todo lo demás (mesa, local, expiración)
// lo resuelve el Service, nunca el cliente.

export class ScanQrDto {
  @IsString()
  @MinLength(10)
  qrCodeToken!: string;
}
