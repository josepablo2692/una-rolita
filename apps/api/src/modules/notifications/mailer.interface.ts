// apps/api/src/modules/notifications/mailer.interface.ts
//
// El transporte de correo, UNO para toda la aplicación.
//
// Hasta PR 5 había dos configuraciones de nodemailer copiadas —una en
// EmailOtpSender y otra en EmailExpiryNotifier— y eso quedó anotado como
// deuda. Aquí se paga: un solo lugar que sabe cómo se manda un correo.
//
// Es interfaz y no clase concreta para poder reemplazarla en las pruebas.
// Sin esto, cada corrida de `test:e2e` mandaría correos de verdad.

export interface CorreoSalida {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  /**
   * Debe RECHAZAR (throw) si el correo no salió. Quien llama usa esa
   * señal para registrar el fallo en la bitácora y reintentar después.
   */
  enviar(correo: CorreoSalida): Promise<void>;
}

export const MAILER = Symbol('MAILER');
