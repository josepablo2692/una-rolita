import { IsString, MinLength, IsOptional } from 'class-validator';

// Lo único que el cliente manda al escanear el QR: el token que viene
// embebido en la URL/código. Todo lo demás (mesa, local, expiración)
// lo resuelve el Service, nunca el cliente.

export class ScanQrDto {
  @IsString()
  @MinLength(10)
  qrCodeToken!: string;

  // Opcional: el frontend lo genera solo, sin pedirle nada al
  // usuario. Si no llega (como ahora, sin frontend), simplemente
  // queda null — no rompe nada de lo que ya funciona.
  @IsOptional()
  @IsString()
  deviceFingerprint?: string;
}
