// apps/api/src/modules/credits/expiry/expiry-notifier.interface.ts
//
// Cómo se le avisa a un cliente que su saldo está por expirar.
//
// Es una interfaz y no una clase concreta por el mismo motivo que
// OtpSender (ADR 0004): hoy el aviso sale por correo, y en PR 6 tiene que
// salir TAMBIÉN por un mensaje dentro de la aplicación. Con la interfaz,
// agregar el segundo canal es escribir una clase nueva y registrarla —
// CreditExpiryService no se entera ni cambia.

export interface AvisoDeExpiracion {
  email: string;
  displayName: string | null;
  venueName: string;
  /** Créditos que se van a perder si no vuelve. 1 crédito = Q1. */
  balance: number;
  expiraEl: Date;
}

export interface ExpiryNotifier {
  /**
   * Debe RECHAZAR (throw) si el aviso no salió. El job usa esa señal para
   * no marcar la cuenta como avisada y reintentar mañana. Un notificador
   * que se traga sus errores hace que el cliente pierda su saldo sin que
   * nadie se entere — que es exactamente lo que este módulo evita.
   */
  avisar(aviso: AvisoDeExpiracion): Promise<void>;
}

// Token de inyección. Va aparte porque una interfaz de TypeScript no
// existe en tiempo de ejecución: Nest necesita algo concreto que buscar.
export const EXPIRY_NOTIFIER = Symbol('EXPIRY_NOTIFIER');
