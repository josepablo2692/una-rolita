// apps/api/src/modules/auth/otp/otp.constants.ts
//
// ROADMAP — Paso 4 (registro con OTP).
// Constantes de negocio para el ciclo de vida del código OTP.
// Separadas en su propio archivo para no tener "números mágicos"
// sueltos en el servicio — si el negocio decide otro TTL, se cambia
// en un solo lugar.

export const OTP_CODE_LENGTH = 6;

// Cuánto tiempo vive el código en Redis antes de expirar solo.
export const OTP_TTL_SECONDS = 300; // 5 minutos

// Evita que alguien spamee el botón "reenviar" y sature tu cuota de
// correos (Mailtrap, y después el proveedor real de producción).
export const OTP_RESEND_COOLDOWN_SECONDS = 60;
