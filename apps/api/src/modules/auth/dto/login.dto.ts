// apps/api/src/modules/auth/dto/login.dto.ts
//
// ROADMAP — Épica 1, login de staff. La "forma" que debe tener el
// body de POST /auth/login — solo email + contraseña en texto plano
// (la comparación contra el hash pasa DENTRO de loginStaff, nunca
// aquí; este archivo solo valida que el JSON tenga forma correcta).
import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8) // ajusta el mínimo si tu regla de negocio pide otra cosa
  password!: string;
}
