// apps/api/src/modules/auth/jwt/jwt-payload.interface.ts
export interface JwtPayload {
  sub: string; // userId — claim estándar del RFC 7519 para "subject"
  role: string; // rol del usuario (admin, dj, etc.) — lo usará el RolesGuard más adelante
  venueId?: string; // opcional: útil si el token es de un admin ligado a un venue específico
}
