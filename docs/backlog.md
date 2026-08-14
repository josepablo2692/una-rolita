# Backlog — Una Rolita

Este backlog está listo para copiarse como Issues en GitHub Projects. Cada historia se puede crear como un Issue individual, etiquetado con su épica.

## Épica 1 — Auth + QR (registro progresivo)

- [x] Generar QR único por mesa (token vía `randomUUID()`, embebido en la URL del QR)
- [x] Endpoint: crear sesión de mesa (invitado) a partir del QR (`POST /auth/scan`)
- [x] Endpoint: registro con verificación OTP por email (Redis + Mailtrap, arquitectura vía OtpSender/OTP_SENDER)
- [x] Upgrade de sesión de mesa a usuario autenticado (`POST /auth/upgrade`)
- [x] JWT de acceso (8 horas) — JwtStrategy + JwtAuthGuard
- [x] Refresh token — revocación individual y total vía Redis (jti por sesión + set por usuario, TTL 7 días)
- [x] Login de admin/venue_admin/DJ/staff — endpoint separado del OTP de cliente, entrega JWT con el `role` real desde `user_venue_roles`
- [x] Guard de roles (`RolesGuard` + `@Roles()`)
- [ ] OAuth con Google (y opcionalmente Facebook) como alternativa de bajo-fricción al OTP por correo — PRIORIDAD antes de iniciar Épica 3
- [ ] deviceFingerprint: capturar en frontend (silencioso) y usarlo para control antifraude de la canción gratis

## Épica 2 — Cola de pedidos

- [x] Modelo de datos de `queue_requests` (`schema.sql`)
- [x] Entities + Service + Controller de `queue` (Song, VenueSongHistory, QueueRequest, QueueJump)
- [x] Lock distribuido con Redis (SET NX simplificado) al asignar posición
- [x] Límite de salto de cola pagado: por USUARIO (no por mesa), con cooldown basado en número de canciones reproducidas desde el último salto (no por tiempo de reloj)
- [x] Cooldown de repetición de canción por venue (`assertCooldownNotActive`, usa `cooldownHours` del venue)
- [x] WebSocket: actualización en vivo de la cola para pantalla del DJ
- [x] Endpoint: cancelar un pedido en cola
- [x] Botón "Saltar" para el artista (marca `queue_request.status = 'skipped'`) — dispara devolución automática de crédito si `is_paid_jump`, sin justificación manual
- [ ] Paginación en GET /venues/:venueId/queue — limitar resultados cuando la cola crezca mucho (ej. ?limit=20&offset=0)
- [x] Sacar `userId` del JWT (Guard) en vez de recibirlo en el body — deuda técnica pendiente hasta que exista `RolesGuard` completo

## Épica 3 — Créditos y pagos

- [ ] Modelo de créditos y transacciones (`payment_method`, saldo)
- [ ] **Prioridad actual:** carga de créditos en recepción (efectivo/tarjeta), staff busca cliente por teléfono y acredita al instante
  - Nota: debe funcionar igual para venues de una sola persona (artistas solistas) — el mismo admin del venue hace la carga, sin mesero de por medio.
- [ ] Reversión de transacciones de crédito (nota de crédito) — nunca editar/borrar, crear transacción reversa referenciando la original vía `reverses_transaction_id`
- [ ] Auditoría: registrar `created_by_staff_id` en cada carga para trazabilidad
- [ ] Acreditación atómica del saldo (Unit of Work)
- [x] Precio combo (salto + dedicatoria) como campo independiente y configurable — sugerido automáticamente como (queueJumpPrice + dedicationPrice - 1), con opción de override manual por el admin
- [ ] Regla: canción gratis por registro (con control antifraude, usando verificacion de correo) — ya existe `free_song_used` en `users`, falta la lógica de negocio
- [ ] Expiración de créditos no usados (configurable)
- [ ] Integración con Recurrente (transferencias, checkout, Tap to Pay) como método de pago alterno al manual — arquitectura vía interfaz `PaymentMethod`, mismo patrón que `OtpSender` (ver ADR 0004)
- [ ] Regla fija: los créditos siempre pertenecen al dueño del venue registrado — sin split, sin excepción (ADR 0004)
- [ ] Modelo de `Tip` (propina) independiente de `credits` — no comparte tabla ni lógica de gasto. Campo de destino: venue por defecto, artista si "modo artista" está activo
- [ ] Toggle "modo artista" en configuración del venue — redirige propinas al artista contratado esa noche
- [ ] Separar en renglones un mismo checkout que incluya salto de cola + propina (dos registros internos, una sola transacción externa)
- [ ] **En pausa:** transferencia directa (reportar comprobante + confirmación manual del admin) — se retoma cuando se defina el flujo de conciliación bancaria
- [ ] Lógica de freeSongUsed en queue.service.createRequest — leer/voltear el booleano ANTES de cobrar, con lock para evitar doble uso concurrente (depende de Épica 3, sistema de créditos)
- [ ] Regla de reembolso en cancelRequest: si isPaidJump=true, el monto del salto NO se reembolsa (ya se recibió el beneficio de posición); solo se reembolsa si nunca hubo salto pagado

## Épica 4 — Reproducción: Spotify o DJ en vivo

- [x] Campo `playback_mode` por local: `spotify_managed` o `dj_manual`
- [ ] **Modo Spotify**: OAuth de Spotify Premium para la cuenta del local
- [ ] **Modo Spotify**: Adapter (`SpotifyAdapter` implementando `MusicProviderAdapter`)
- [ ] **Modo Spotify**: agregar canción a la cola real de Spotify Connect
- [ ] **Modo Spotify**: manejo de errores si el dispositivo del local se desconecta
- [ ] **Modo DJ manual**: botón "marcar como reproducida" en el panel (ya existe el endpoint `PATCH /queue/:id/played`, falta la UI)
- [ ] **Modo DJ manual**: el propio DJ lee la dedicatoria o decide usar el sintetizador
- [ ] Sincronizar catálogo/búsqueda de canciones (solo aplica en modo Spotify)
- [ ] Biblioteca de playlists por artista — vive en su perfil, portátil entre venues (no atada a un solo local), el artista puede tener varias según el tipo de evento
- [ ] Asignar cuál playlist del artista está activa en el venue/noche actual
- [ ] Sincronizar la playlist activa a tabla propia (`VenueCuratedTrack` o similar) y validar contra ella ANTES de aceptar un pedido en `queue.service.ts` — el salto pagado nunca da acceso a canciones fuera de esta lista

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
- [ ] Generar QR por cada mesa para que el admin los pueda imprimir
- [ ] Indicador visual para el cliente: "Playlist curada por [Artista]" cuando `playlist_mode = curated`
- [ ] Aclarar alcance de marketing_opt_in: separar consentimiento por venue vs. consentimiento de plataforma (Una Rolita) — posible campo adicional o tabla de consentimientos
- [ ] Términos y condiciones: checkbox de aceptación en el registro (upgrade), con versión y fecha de aceptación guardada para auditoría legal
- [ ] Diseño visual de la pantalla de cola en vivo (paginación/scroll, orden claro, indicadores de saltos pagados)

## Épica 7 — Infraestructura y calidad

- [x] CI/CD con GitHub Actions (lint + test en cada PR y en push a develop, con servicios Postgres y Redis temporales)
- [x] Swagger/OpenAPI generado automáticamente (`/docs`)
- [x] Transformer reutilizable para columnas NUMERIC (`NumericColumnTransformer`) — corrige bug de concatenación string/number
- [ ] Pruebas de carga con k6 sobre cola y créditos
- [ ] Monitoreo de errores (Sentry)
- [x] ADR 0003: frontend mobile-first y PWA (ya documentado en `docs/adr/`)
- [x] ADR 0004: métodos de pago duales, arquitectura extensible vía PaymentMethod
- [x] Pruebas unitarias para OtpService, RefreshTokenService, AuthService (loginStaff, upgradeGuestToUser)
- [ ] Pruebas e2e del flujo completo: scan → otp → upgrade → refresh → revoke
- [ ] Pruebas de RolesGuard (con y sin rol permitido)
- [ ] Estrategia de pruebas completa antes del 31/ago: unitarias + e2e + concurrencia + caja blanca + caja negra
- [ ] Pruebas de concurrencia sobre el lock distribuido de Redis (queue.service.ts) — simular pedidos simultáneos reales
- [ ] Pruebas de caja negra: casos de uso end-to-end sin mirar implementación (solo inputs/outputs esperados)
- [ ] Pruebas de caja blanca: cobertura de ramas internas (branches) de la lógica de negocio crítica
- [ ] Identificar "fallas fantasma" tempranas: código con condiciones de carrera o dependencias de timing no deterministas (candidatos: lock de Redis, expiración de OTP, rotación de refresh token)
- [ ] Plan de despliegue a servidor real antes del 31/ago (definir proveedor: Railway, Render, VPS propio — pendiente de decisión)
- [ ] Checklist de "listo para producción" por módulo (backend Y frontend cuando exista)
- [ ] Restringir CORS de QueueGateway (cors: { origin: '*' }) al dominio real del frontend antes de producción — actualmente abierto a cualquier origen, solo válido en desarrollo
- [ ] Redis Adapter para Socket.io — necesario SOLO cuando se corra más de una instancia del servidor (escalamiento horizontal)

## Épica 8 — Analítica y KPIs (fase 2, requiere datos históricos acumulados)

- [ ] Análisis de géneros más pedidos por local — insumo para promociones dirigidas
- [ ] KPIs de estacionalidad (día de la semana, hora pico) por local
- [ ] Popularidad de canciones/artistas por local y agregado global
- [ ] Desempeño histórico como base para sugerencias de promociones al admin (ej. "los jueves baja tu tráfico, considera una promo de créditos")
- [ ] Internacionalización (i18n): soporte para español e inglés en el frontend/respuestas al usuario, inglés como idioma base del sistema
- [ ] Definir mecanismo (ej. nestjs-i18n, o diccionario de strings por locale) — decisión pendiente, no es de esta fase,
