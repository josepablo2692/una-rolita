import { IsOptional, IsInt, Min } from 'class-validator';

// Todos los campos son opcionales porque es un PATCH parcial:
// el admin puede mandar solo el precio que quiere cambiar.

export class UpdateVenuePricingDto {
  // apps/api/src/modules/venues/dto/update-venue-pricing.dto.ts
  @IsOptional()
  @IsInt({
    message:
      'El precio del salto de cola debe ser un número entero de quetzales (sin centavos)',
  })
  @Min(0, { message: 'El precio del salto de cola no puede ser negativo' })
  queueJumpPrice?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  dedicationPrice?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  comboJumpDedicationPrice?: number; // si el admin lo manda, se respeta tal cual (override manual)
}
