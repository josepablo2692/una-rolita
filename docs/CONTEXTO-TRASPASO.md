# Contexto de traspaso — Una Rolita

Última actualización: 15 de agosto 2026

## Estado actual

**Épica 1 (Auth + QR): completa**, salvo:

- OAuth con Facebook — APLAZADO, bloqueado en configuración de
  Facebook for Developers (no en código). Falta: crear la app,
  agregar producto "Facebook Login", configurar callback URL, y
  copiar App ID/Secret al .env. Una vez con las credenciales, el
  código es copia directa del patrón de GoogleStrategy.
- deviceFingerprint: backend listo (columna + DTO + Service), falta
  la generación real en frontend (no existe todavía).

**Épica 2 (Cola de pedidos): 100% completa.** Incluye WebSocket con
QueueGateway (manda lista completa, no solo aviso vacío), cancelar
pedido, saltar pedido (reembolso queda como TODO hasta Épica 3),
paginación con limit/offset.

**Épica 7 (parcial):** pruebas unitarias en OtpService,
RefreshTokenService, AuthService.loginStaff. Falta: pruebas e2e,
concurrencia, caja blanca/negra — diseño completo pendiente.

## Rama actual

develop (ambas épicas fusionadas y limpias)

## Decisiones de arquitectura clave (ver ADRs en docs/adr/)

- ADR 0004: pagos duales (manual + Recurrente) vía interfaz PaymentMethod
- ADR 0005: login dual — OTP por email (clientes) + password (staff/admin)
- Google OAuth reusa el mismo findOrCreateUser que OTP — la fuente
  de verificación cambia, la lógica de creación de usuario no.

## Reglas de negocio confirmadas, no obvias en el código

- Créditos SIEMPRE pertenecen al dueño del venue — sin split
- Salto de cola pagado (is_paid_jump) NUNCA se reembolsa al cancelar
  (ya se recibió el beneficio de posición); solo se reembolsa el
  costo base de la canción si nunca hubo salto
- Playlist curada restringe catálogo, no el salto pagado — el dinero
  compra posición, nunca acceso a canciones fuera de lista
- displayName se autocompleta desde OAuth solo si estaba vacío,
  nunca sobrescribe edición manual del usuario

## Siguiente paso pendiente

Épica 3 — Créditos y pagos. Arrancar por el modelo de datos
(credit_accounts, credit_transactions) y la carga manual en
recepción (prioridad de negocio ya confirmada).

## Deadline

31 de agosto — servidor real desplegado, con estrategia de pruebas
completa (concurrencia, caja blanca/negra) aún por diseñar.
Proveedor de despliegue: sin decidir (Railway/Render/VPS).

## Guías de trabajo (no olvidar)

- docs/UX-GUIDELINES.md: tono juvenil, regla de 3 clics, PWA instalable
- Nunca saltar pasos del backlog en orden
- Git: siempre confirmar `git branch --show-current` antes de add/commit
- Commits con prefijo Conventional Commits (feat/fix/docs/refactor/test/chore)
