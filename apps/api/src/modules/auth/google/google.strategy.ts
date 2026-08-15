// apps/api/src/modules/auth/google/google.strategy.ts
//
// ROADMAP — Épica 1, OAuth Google. Se dispara cuando el flujo de
// Google redirige de vuelta a nuestro /auth/google/callback. Google
// ya verificó la identidad — nuestro trabajo es solo leer el perfil
// que nos entrega y decidir qué hacer con esos datos.

import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback, Profile } from 'passport-google-oauth20';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(configService: ConfigService) {
    super({
      clientID: configService.get<string>('GOOGLE_CLIENT_ID')!,
      clientSecret: configService.get<string>('GOOGLE_CLIENT_SECRET')!,
      callbackURL: configService.get<string>('GOOGLE_CALLBACK_URL')!,
      scope: ['email', 'profile'],
    });
  }

  // Nunca lo llamas tú directo — Passport lo ejecuta automáticamente
  // después de que Google confirma la identidad y redirige de vuelta.
  validate(
    accessToken: string,
    refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): void {
    const email = profile.emails?.[0]?.value;
    const displayName = profile.displayName;

    // Guard Clause: si por alguna razón Google no comparte el correo
    // (raro, pero posible según configuración de privacidad del
    // usuario), no podemos identificarlo — cortamos aquí.
    if (!email) {
      done(new Error('Google no compartió un correo verificado'), undefined);
      return;
    }

    // Lo que le pasamos a "done" es lo que termina en req.user dentro
    // del controller — igual que el retorno de JwtStrategy.validate().
    done(null, { email, displayName });
  }
}
