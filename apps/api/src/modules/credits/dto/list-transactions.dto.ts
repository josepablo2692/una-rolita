import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

// Filtros del historial de movimientos del local.
//
// Los parámetros de query llegan SIEMPRE como texto. Con
// `enableImplicitConversion: false` en el ValidationPipe (que apagamos a
// propósito para que "abc" no se vuelva NaN en silencio), la conversión
// hay que pedirla explícitamente con @Type.

export class ListTransactionsDto {
  // Filtrar por un cliente específico. Sin esto, se ve todo el local.
  @IsOptional()
  @IsUUID('4', { message: 'El cliente indicado no es válido' })
  userId?: string;

  // El tope de 200 protege la base: sin él, `?limit=999999` obligaría a
  // recorrer el historial completo del local en una sola consulta.
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'El límite debe ser un número entero' })
  @Min(1, { message: 'El límite debe ser al menos 1' })
  @Max(200, { message: 'El límite no puede pasar de 200 movimientos' })
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'El desplazamiento debe ser un número entero' })
  @Min(0, { message: 'El desplazamiento no puede ser negativo' })
  offset?: number;
}
