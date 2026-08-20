import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

// Nota de crédito: corrige un movimiento del libro mayor SIN borrarlo.
//
// El libro mayor es inmutable (trigger en Postgres), así que corregir
// significa insertar un asiento contrario que apunta al original.

export class ReverseTransactionDto {
  // El mínimo de 10 caracteres no es capricho: obliga a escribir una
  // explicación de verdad. Un motivo de dos letras convierte la auditoría
  // en un trámite vacío, y el punto de la nota de crédito es justamente
  // que quede constancia de POR QUÉ se corrigió.
  @IsString({ message: 'El motivo debe ser texto' })
  @MinLength(10, {
    message: 'Explica qué pasó: el motivo debe tener al menos 10 caracteres',
  })
  @MaxLength(255, { message: 'El motivo no puede pasar de 255 caracteres' })
  reason!: string;

  // Opcional: por defecto se revierte el movimiento completo.
  // Se manda un monto menor cuando el cliente ya gastó parte y solo se
  // puede devolver lo que queda.
  @IsOptional()
  @IsInt({ message: 'El monto a revertir debe ser un número entero' })
  @Min(1, { message: 'El monto a revertir debe ser al menos 1 crédito' })
  amount?: number;
}
