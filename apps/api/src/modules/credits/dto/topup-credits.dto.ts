import {
  IsInt,
  IsIn,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

// Carga manual de créditos en recepción.
//
// Solo se aceptan métodos presenciales: `transferencia_directa` está en
// pausa (falta definir la conciliación bancaria) y `recurrente` es un
// flujo distinto que pasa por la pasarela, no por caja.

export class TopupCreditsDto {
  @IsUUID('4', { message: 'El cliente indicado no es válido' })
  userId!: string;

  @IsInt({ message: 'Los créditos deben ser un número entero' })
  @Min(1, { message: 'La carga debe ser de al menos 1 crédito' })
  // Límite de cordura: protege contra el dedo pesado. Cargar 100000 por un
  // error de tecleo sería un desastre difícil de explicar, y la reversa
  // queda registrada para siempre en el libro mayor.
  @Max(10000, {
    message: 'La carga no puede pasar de 10,000 créditos en una sola operación',
  })
  credits!: number;

  @IsIn(['efectivo_recepcion', 'tarjeta_recepcion'], {
    message:
      'El método de pago debe ser efectivo_recepcion o tarjeta_recepcion',
  })
  paymentMethod!: 'efectivo_recepcion' | 'tarjeta_recepcion';

  // Quetzales realmente recibidos. Se guarda aparte de los créditos a
  // propósito: una promoción puede dar 12 créditos por Q10, y el negocio
  // necesita ambos números — uno para cuadrar caja, otro para medir la
  // promoción.
  @IsOptional()
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'El efectivo recibido debe ser un monto en quetzales' },
  )
  @Min(0, { message: 'El efectivo recibido no puede ser negativo' })
  cashAmount?: number;

  // OBLIGATORIA. La genera quien llama (un UUID nuevo por operación) y es
  // lo que hace que un doble clic del mesero no cobre dos veces. En un
  // endpoint que mueve dinero no puede ser opcional.
  @IsUUID('4', { message: 'La llave de idempotencia debe ser un UUID v4' })
  idempotencyKey!: string;
}
