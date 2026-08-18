import { IsEmail, IsOptional, IsString, Matches } from 'class-validator';

// Búsqueda de cliente desde recepción, por teléfono O por correo.
//
// El correo es la identidad verificada (OTP); el teléfono es solo una
// llave de búsqueda cómoda. Se acepta cualquiera de los dos porque en un
// bar con música alta, dictar un correo es un suplicio — pero hoy el
// teléfono está vacío para todos, así que el correo es el que funciona.

export class LookupCustomerDto {
  @IsOptional()
  @IsString({ message: 'El teléfono debe ser texto' })
  @Matches(/^[0-9]{8,15}$/, {
    message:
      'El teléfono debe tener entre 8 y 15 dígitos, sin espacios ni guiones',
  })
  phone?: string;

  @IsOptional()
  @IsEmail({}, { message: 'El correo no tiene un formato válido' })
  email?: string;
}
