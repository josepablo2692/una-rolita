# Backlog — Una Rolita

Este backlog está listo para copiarse como Issues en GitHub Projects. Cada historia se puede crear como un Issue individual, etiquetado con su épica.

## Épica 1 — Auth + QR (registro progresivo)
- [ ] Generar QR único por mesa con token firmado
- [ ] Endpoint: crear sesión de mesa (invitado) a partir del QR
- [ ] Endpoint: registro con teléfono + verificación OTP
- [ ] Upgrade de sesión de mesa a usuario autenticado
- [ ] JWT de acceso (15 min) + refresh token
- [ ] Guard de roles (`RolesGuard` + `@Roles()`)

## Épica 2 — Cola de pedidos
- [ ] Modelo de datos de `queue_requests` (ya en `schema.sql`)
- [ ] Lock distribuido con Redis (Redlock) al asignar posición
- [ ] Regla de cooldown: no repetir canción antes de N horas por local
- [ ] Salto de cola pagado, máximo 1 por hora por usuario
- [ ] WebSocket: actualización en vivo de la cola para pantalla del DJ
- [ ] Endpoint: cancelar un pedido en cola

## Épica 3 — Créditos y pagos
- [ ] Modelo de créditos y transacciones (`payment_method`, saldo)
- [ ] **Prioridad actual:** carga de créditos en recepción (efectivo/tarjeta), staff busca cliente por teléfono y acredita al instante
- [ ] Auditoría: registrar `created_by_staff_id` en cada carga para trazabilidad
- [ ] Acreditación atómica del saldo (Unit of Work)
- [ ] Regla: canción gratis por registro (con control antifraude)
- [ ] Expiración de créditos no usados (configurable)
- [ ] **En pausa:** transferencia directa (reportar comprobante + confirmación manual del admin) — se retoma cuando se defina el flujo de conciliación bancaria

## Épica 4 — Reproducción: Spotify o DJ en vivo
- [ ] Campo `playback_mode` por local: `spotify_managed` o `dj_manual`
- [ ] **Modo Spotify**: OAuth de Spotify Premium para la cuenta del local
- [ ] **Modo Spotify**: Adapter (`SpotifyAdapter` implementando `MusicProviderAdapter`)
- [ ] **Modo Spotify**: agregar canción a la cola real de Spotify Connect
- [ ] **Modo Spotify**: manejo de errores si el dispositivo del local se desconecta
- [ ] **Modo DJ manual**: botón "marcar como reproducida" en el panel (sin integración externa)
- [ ] **Modo DJ manual**: el propio DJ lee la dedicatoria o decide usar el sintetizador
- [ ] Sincronizar catálogo/búsqueda de canciones (solo aplica en modo Spotify)

## Épica 5 — Dedicatorias
- [ ] Formulario de dedicatoria (mensaje, anónimo o no)
- [ ] Filtro automático de palabras obscenas
- [ ] Panel del DJ: aprobar/rechazar antes de que se lea
- [ ] Opción de lectura por DJ o por sintetizador de voz
- [ ] Regla anti-acoso: alerta si una mesa recibe muchas dedicatorias de la misma persona

## Épica 6 — Panel Admin / DJ
- [ ] Dashboard con métricas (cola, créditos vendidos, mesas activas)
- [ ] Vista de cola en vivo con acciones (play/skip)
- [ ] Cola de moderación de dedicatorias
- [ ] Gestión de promociones propias del negocio
- [ ] Configuración del local (modo de playlist, precios, cooldown)
- [ ] Botón "abrir/cerrar cola" (para pausas en shows en vivo o strip-club)

## Épica 7 — Infraestructura y calidad
- [ ] CI/CD con GitHub Actions (lint + test en cada PR)
- [ ] Swagger/OpenAPI generado automáticamente
- [ ] Pruebas de carga con k6 sobre cola y créditos
- [ ] Monitoreo de errores (Sentry)