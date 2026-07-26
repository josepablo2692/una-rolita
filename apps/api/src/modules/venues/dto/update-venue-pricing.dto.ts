import { IsOptional, IsNumber, Min } from 'class-validator';

// Todos los campos son opcionales porque es un PATCH parcial:
// el admin puede mandar solo el precio que quiere cambiar.

export class UpdateVenuePricingDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  queueJumpPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  dedicationPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  comboJumpDedicationPrice?: number; // si el admin lo manda, se respeta tal cual (override manual)
}
