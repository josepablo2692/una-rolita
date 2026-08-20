// apps/api/src/modules/venues/dto/update-venue-policies.dto.ts
//
// Políticas de operación del local. Van APARTE de los precios a
// propósito: cambiar cuánto cuesta una canción y cambiar cuándo expiran
// los créditos son decisiones distintas, con consecuencias distintas.
// Mezclarlas en un mismo endpoint hace que un error de tecleo en el
// precio pueda alterar la vigencia del dinero de los clientes.

import { IsOptional, IsInt, Min, Max } from 'class-validator';

export class UpdateVenuePoliciesDto {
  // Meses de inactividad antes de que expire el saldo de una cuenta.
  //
  // El 0 es VÁLIDO y significa "no expiran nunca" — por eso Min(0) y no
  // Min(1). Un gimnasio con membresía anual puede querer justamente eso.
  //
  // El techo de 60 no es capricho: un plazo de más de cinco años no es
  // una política, es un olvido. Y sin techo, un dedazo (120 en vez de 12)
  // se vuelve indetectable hasta que alguien reclama en 2036.
  @IsOptional()
  @IsInt({ message: 'Los meses de expiración deben ser un número entero' })
  @Min(0, {
    message:
      'Los meses de expiración no pueden ser negativos. Usa 0 si no querés que los créditos expiren',
  })
  @Max(60, {
    message: 'Los meses de expiración no pueden pasar de 60 (cinco años)',
  })
  creditExpiryMonths?: number;

  // Horas sin actividad antes de que el sistema cierre la noche solo.
  //
  // Mínimo 1: con 0 se cerraría la noche en cuanto el job pasara, en
  // media sala llena. Máximo 24: un local que lleva más de un día sin un
  // solo pedido no tiene una noche abierta, tiene un olvido.
  @IsOptional()
  @IsInt({ message: 'Las horas de cierre automático deben ser un entero' })
  @Min(1, { message: 'El cierre automático no puede ser menor a 1 hora' })
  @Max(24, { message: 'El cierre automático no puede pasar de 24 horas' })
  sessionTimeoutHours?: number;
}
