# Backlog — Una Rolita

Este backlog está listo para copiarse como Issues en GitHub Projects. Cada historia se puede crear como un Issue individual, etiquetado con su épica.

## Fase 0 — Blindaje previo a Épica 3 (fuerza mayor) — COMPLETA

Desviación deliberada del orden del backlog. Justificación: Épica 3 conecta
dinero real a `venue.queueJumpPrice`, a `skipRequest` y a las posiciones de
cola. Los tres tenían vulnerabilidades explotables. Rama:
`chore/hardening-pre-epica-3`.

- [x] P0-1: `ValidationPipe` global con `whitelist` + `forbidNonWhitelisted`.
      Antes NO existía: todos los decoradores de class-validator del proyecto
      eran inertes y había mass assignment abierto en `repository.create(dto)`
- [x] P0-2: `VenueRolesGuard` — resuelve el rol del usuario EN EL VENUE DE
      LA RUTA contra `user_venue_roles`, en vez de leer el `role` del JWT.
      `RolesGuard` solo comparaba el nombre del rol, así que un `venue_admin`
      del Bar A podía administrar el Bar B. Aplicado a los 6 endpoints de
      `VenuesController`
- [x] P0-3: guards y pertenencia en `QueueController` — `played` estaba sin
      guard; `skip` exigía JWT pero no rol (habría permitido forzar reembolsos
      en Épica 3); el `venueId` de la ruta se ignoraba en played/cancel/skip
      (IDOR, ahora va dentro del WHERE); `tableId` ahora se valida y se
      verifica que pertenezca al venue y esté activa
- [x] P0-4: release del lock de Redis ahora es atómico vía script Lua
      (antes GET+DEL con ventana de carrera); `calculateJumpPosition` empuja
      a los pedidos posteriores antes de insertar — antes dos saltos pagados
      quedaban en la misma posición y se cobraba dos veces el mismo lugar
- [x] P0-5: `GET /venues/:id` devolvía `bankAccountInfo` y
      `spotifyAccountId`; ahora usa proyección pública de lista blanca.
      Precios pasan de `@IsNumber()` a `@IsInt()` (ADR 0006)
- [x] P0-6: `loginStaff` elegía el rol sin `ORDER BY` — un artista solista
      (venue_admin + dj en su propio venue) recibía cualquiera de los dos al
      azar. Ahora ordena por `roleId ASC` (menor id = mayor privilegio)
- [x] Mensajes de error en español en los DTOs tocados y en `JwtAuthGuard`
- [x] Catálogo de roles agregado a `schema.sql` — la tabla `roles` estaba
      VACÍA, así que `loginStaff` no podía resolver ningún rol en una base
      recién creada. Es data de catálogo, no de prueba: producción también
      la necesita
- [x] Datos semilla para pruebas (`src/seed/seed.ts`)
- [ ] Evidencia de cada P0 (400 de mass assignment, 403 de venue ajeno)

## Épica 1 — Auth + QR (registro progresivo)

- [x] Generar QR único por mesa (token vía `randomUUID()`, embebido en la URL del QR)
- [x] Endpoint: crear sesión de mesa (invitado) a partir del QR (`POST /auth/scan`)
- [x] Endpoint: registro con verificación OTP por email (Redis + Mailtrap, arquitectura vía OtpSender/OTP_SENDER)
- [x] Upgrade de sesión de mesa a usuario autenticado (`POST /auth/upgrade`)
- [x] JWT de acceso (8 horas) — JwtStrategy + JwtAuthGuard
- [x] Refresh token — revocación individual y total vía Redis (jti por sesión + set por usuario, TTL 7 días)
- [x] Login de admin/venue_admin/DJ/staff — endpoint separado del OTP de cliente, entrega JWT con el `role` real desde `user_venue_roles`
- [x] Guard de roles (`RolesGuard` + `@Roles()`)
- [x] OAuth con Google (y opcionalmente Facebook) como alternativa de bajo-fricción al OTP por correo — PRIORIDAD antes de iniciar Épica 3
- [x] deviceFingerprint: columna + DTO + Service listos para recibirlo (backend)
- [ ] deviceFingerprint: generación real en frontend (fingerprintjs o similar) — pendiente hasta que exista frontend
- [ ] OAuth con Facebook — APLAZADO: bloqueado en configuración de Facebook for Developers (no en código). Falta: crear la app, agregar producto "Facebook Login", configurar callback URL, y copiar App ID/Secret al .env. Una vez con las credenciales, el código es copia del patrón de GoogleStrategy (mismo archivo, misma estructura) — no debería tomar más de 15-20 min una vez resuelto el lado de Facebook.

## Épica 2 — Cola de pedidos

- [x] Modelo de datos de `queue_requests` (`schema.sql`)
- [x] Entities + Service + Controller de `queue` (Song, VenueSongHistory, QueueRequest, QueueJump)
- [x] Lock distribuido con Redis (SET NX simplificado) al asignar posición
- [x] Límite de salto de cola pagado: por USUARIO (no por mesa), con cooldown basado en número de canciones reproducidas desde el último salto (no por tiempo de reloj)
- [x] Cooldown de repetición de canción por venue (`assertCooldownNotActive`, usa `cooldownHours` del venue)
- [x] WebSocket: actualización en vivo de la cola para pantalla del DJ
- [x] Endpoint: cancelar un pedido en cola
- [x] Botón "Saltar" para el artista (marca `queue_request.status = 'skipped'`)
      — dispara devolución automática y total del crédito, sin justificación manual
- [x] Paginación en GET /venues/:venueId/queue — limitar resultados cuando la cola crezca mucho (ej. ?limit=20&offset=0)
- [x] Sacar `userId` del JWT (Guard) en vez de recibirlo en el body — deuda técnica pendiente hasta que exista `RolesGuard` completo

## Épica 3 — Créditos y pagos

- [x] Modelo de créditos y transacciones (`payment_method`, saldo) — libro
      mayor inmutable según ADR 0006. Esquema en `schema.sql` + entidades
      `CreditAccount` y `CreditTransaction`. Reemplaza el modelo original,
      que con `CHECK (amount > 0)` no podía registrar un solo gasto
- [x] Acreditación atómica del saldo (Unit of Work) — `CreditsService.
      applyTransaction()` es la ÚNICA puerta por la que se mueve un
      crédito. `SELECT ... FOR UPDATE` dentro de una transacción cierra el
      hueco entre leer y escribir. Probado con 10 cargas concurrentes que
      deben dejar exactamente 50 créditos
- [x] Idempotencia (`idempotency_key`) — el doble clic del mesero devuelve
      el movimiento original en vez de cobrar dos veces. Chequeo en el
      servicio + restricción UNIQUE de la base como respaldo ante la carrera
- [ ] **PRÓXIMO — Prioridad actual:** carga de créditos en recepción
      (efectivo/tarjeta), staff busca cliente por teléfono y acredita al
      instante. Falta el endpoint `POST /venues/:venueId/credits/topup`,
      su DTO y los guards; el motor (`applyTransaction`) ya está
  - Nota: debe funcionar igual para venues de una sola persona (artistas solistas) — el mismo admin del venue hace la carga, sin mesero de por medio.
- [ ] Buscar cliente por teléfono desde recepción — endpoint de búsqueda
      acotado al venue, sin exponer datos de clientes de otros locales
- [ ] Reversión de transacciones de crédito (nota de crédito) — nunca editar/borrar, crear transacción reversa referenciando la original vía `reverses_transaction_id`
- [ ] Auditoría: registrar `created_by_staff_id` en cada carga para trazabilidad
      (la columna y el parámetro ya existen; falta exponerlo en el endpoint
      y en la vista de historial)
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
- [ ] Regla de reembolso — PRINCIPIO: se reembolsa según quién incumplió,
      no según qué se cobró.
  - Artista/DJ salta el pedido → el servicio nunca se entregó por decisión
    del local → reembolso TOTAL (canción + salto + dedicatoria)
  - Cliente cancela → decisión propia, ya se benefició de la posición
    ganada → NO se reembolsa el salto (`is_paid_jump`); solo se reembolsa
    el costo base de la canción si nunca hubo salto pagado

### Riesgos de base de datos — ordenados por cuánto dolería, no por esfuerzo

Detectados al construir el libro mayor. Son las "sorpresas caras" que no
avisan: ninguna produce un error hoy.

- [ ] **1. NO HAY RESPALDOS.** Es la única de esta lista que puede matar el
      negocio. `credit_transactions` es el registro de a quién se le debe
      cuánto, y el dinero entró en efectivo: no existe rastro externo con
      el cual reconstruirlo. Si el volumen se pierde (disco, error humano,
      proveedor), no hay vuelta. Respaldo diario automático DEBE existir
      antes del 31/ago, no después
- [ ] **2. `COUNT` que se degrada para siempre.** `queue.service.ts` corre
      `historyRepository.count({ where: { venueId } })` en cada salto
      pagado y en cada `registerJump`. Postgres no guarda un contador:
      recorre las filas. Un bar activo genera ~100k filas al año, y esa
      consulta se hace más lenta linealmente. No falla nunca — solo un
      sábado el salto tarda dos segundos y "el sistema está lento".
      Arreglar con un contador incremental por venue
- [ ] **3. Interbloqueos — llegan en el PR de cobros.** Hoy se bloquea UNA
      fila por transacción, así que es imposible. Pero pedir una canción va
      a tocar dos recursos: la cuenta de créditos y las posiciones de cola.
      REGLA A FIJAR ANTES DE ESCRIBIR ESE CÓDIGO: siempre en el mismo
      orden, primero el crédito y después la cola (si no hay saldo, no
      vale la pena tocar posiciones)
- [ ] **4. Pool de conexiones.** TypeORM abre ~10 conexiones por instancia;
      Postgres acepta ~100 por defecto. Con una instancia sobra; con varias
      detrás de un balanceador se multiplica hasta que la app no puede
      conectarse. Se define al desplegar, junto con el proveedor
- [ ] **5. Verificación diaria de la invariante en TODAS las cuentas.**
      `verifyIntegrity` valida una sola. En producción hace falta un job
      que recorra todas y avise. Debe devolver SIEMPRE cero filas:
      ```sql
      SELECT ca.id, ca.balance, COALESCE(SUM(ct.amount), 0) AS ledger
        FROM credit_accounts ca
        LEFT JOIN credit_transactions ct ON ct.credit_account_id = ca.id
       GROUP BY ca.id, ca.balance
      HAVING ca.balance <> COALESCE(SUM(ct.amount), 0);
      ```

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
- [ ] Vista de cola: scroll infinito (no paginación con números), estilo Spotify — reusa GET /queue?limit=&offset= ya construido
- [ ] Endpoint PATCH /users/me — el usuario puede editar su propio displayName, marketingOptIn, etc.
- [ ] manifest.json con branding de Una Rolita (colores, ícono, nombre)
- [ ] Service worker básico para instalabilidad
- [ ] Prompt activo de "instalar app" (evento beforeinstallprompt), no depender de que el usuario lo encuentre solo
- [ ] Auditar cada flujo principal contra la regla de 3 clics antes de darlo por terminado

## Épica 7 — Infraestructura y calidad

- [x] CI/CD con GitHub Actions (lint + test en cada PR y en push a develop, con servicios Postgres y Redis temporales)
- [x] Swagger/OpenAPI generado automáticamente (`/docs`)
- [x] Transformer reutilizable para columnas NUMERIC (`NumericColumnTransformer`) — corrige bug de concatenación string/number
- [ ] Pruebas de carga con k6 sobre cola y créditos
- [ ] Monitoreo de errores (Sentry)
- [x] ADR 0003: frontend mobile-first y PWA (ya documentado en `docs/adr/`)
- [x] ADR 0004: métodos de pago duales, arquitectura extensible vía PaymentMethod
- [x] Pruebas unitarias para OtpService, RefreshTokenService, AuthService (loginStaff, upgradeGuestToUser)
- [ ] **PRIORITARIO — Convertir la evidencia manual de Fase 1 en pruebas
      automáticas** (`test/venue-access.e2e-spec.ts` con supertest).
      Contexto: los seis P0 se verificaron a mano con `curl.exe` y dieron
      `200 · 403 · 400 · 403 · 200`. Esa evidencia demuestra que funcionaba
      ESE día, en ESA máquina, porque alguien la corrió. No es durable:
      nadie va a volver a pegar cinco comandos después de cada cambio.
      Una prueba solo vale si corre sola.
      Casos a cubrir (uno por cada `curl` ejecutado): 1. `venue_admin` cambia precios de SU local → 200 2. `venue_admin` cambia precios de local AJENO → 403 3. Precio con centavos (4.5) → 400 4. `venue_admin` crea mesa en local AJENO → 403 5. `super_admin` toca local ajeno → 200 6. Campo no declarado en el body (`isAdmin`) → 400
      Requiere: el seed corriendo antes de la suite, y que GitHub Actions
      la ejecute en cada PR. Sin el paso de CI, la prueba existe pero
      nadie se entera cuando falla
- [ ] **BLOQUEA lo anterior** — Extraer la configuración global de la app
      (`ValidationPipe`, y más adelante filtros e interceptores) a una
      función reutilizable, ej. `src/common/setup-app.ts`, que llamen tanto
      `main.ts` como el `beforeAll` de las pruebas e2e.
      Motivo: las pruebas e2e arman la app con
      `Test.createTestingModule({ imports: [AppModule] })`, y `main.ts` NO
      participa — así que el `ValidationPipe` no existe en el entorno de
      prueba. Hoy eso significa que una prueba de "campo colado devuelve
      400" fallaría aunque el código esté bien. Y si se duplica la config
      a mano en cada prueba, el día que cambie una de las dos copias las
      pruebas dejan de reflejar producción: pasarían en verde mientras el
      servidor real se comporta distinto
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
- [ ] Migraciones de TypeORM antes del segundo despliegue a producción.
      `schema.sql` queda como línea base (migración 0); de ahí en adelante todo
      cambio de esquema es una migración versionada. Sin esto, el primer cambio
      de columna en producción es manual y sin vuelta atrás
- [ ] Pruebas de `VenueRolesGuard`: rol correcto en venue propio (pasa),
      rol correcto en venue ajeno (403), sin rol en el venue (403),
      super_admin en cualquier venue (pasa)
- [ ] Pruebas de aislamiento entre locales: pedido del Bar A no accesible
      desde la ruta del Bar B
- [ ] Separar el rol de PLATAFORMA del rol de VENUE. Hoy `super_admin`
      necesita una fila nominal en `user_venue_roles` para que `loginStaff`
      le emita token, aunque no pertenezca a ningún local. Opciones:
      columna `users.is_platform_admin`, o tabla `platform_roles` aparte.
      Se vuelve urgente cuando existan varios super_admin o un rol de
      "cobrador" que tampoco pertenece a ningún local
- [x] Datos semilla (`pnpm --filter api run seed`) — dos locales
      independientes con personal propio, idempotente, bloqueado en
      producción por `NODE_ENV`. Es lo que hace posible probar el
      aislamiento entre negocios

## Épica 8 — Analítica y KPIs (fase 2, requiere datos históricos acumulados)

- [ ] Análisis de géneros más pedidos por local — insumo para promociones dirigidas
- [ ] KPIs de estacionalidad (día de la semana, hora pico) por local
- [ ] Popularidad de canciones/artistas por local y agregado global
- [ ] Desempeño histórico como base para sugerencias de promociones al admin (ej. "los jueves baja tu tráfico, considera una promo de créditos")
- [ ] Internacionalización (i18n): soporte para español e inglés en el frontend/respuestas al usuario, inglés como idioma base del sistema
- [ ] Definir mecanismo (ej. nestjs-i18n, o diccionario de strings por locale) — decisión pendiente, no es de esta fase.
- [ ] Credenciales OAuth adicionales (Android/iOS) cuando exista app móvil nativa — backend no cambia
- [ ] Botón opcional "Síguenos en WhatsApp" (link wa.me) al pedir número de teléfono — incentivo, NUNCA obligatorio (contradice regla de 3 clics)
- [ ] Verificar reglas reales de visibilidad de Estados de WhatsApp antes de diseñar la estrategia (¿requiere guardado mutuo?)
- [ ] Vista de facturación: créditos emitidos por venue y por mes,
      derivada del ledger. Insumo para decidir el modelo de precios
      después del piloto.

### Hallazgos nuevos, diferidos

- [ ] La inserción del pedido y el empuje de posiciones son dos escrituras
      sin transacción de BD. Un fallo entre ambas deja un hueco en la
      numeración (no corrompe el orden). Se envuelve en transacción cuando
      Épica 3 agregue el débito de créditos como tercera escritura
- [ ] `findOrCreateSong` puede correr en carrera entre dos venues pidiendo
      la misma canción por primera vez y violar
      `UNIQUE(provider, provider_track_id)`. Resolver con
      `ON CONFLICT DO NOTHING` (P2)
- [ ] Los parámetros de ruta no se validan. El `ValidationPipe` global cubre
      el CUERPO de la petición, pero `@Param('id') id: string` pasa sin
      revisar: un UUID malformado llega hasta Postgres y produce un 500
      (`invalid input syntax for type uuid`) en vez de un 400. Aplicar
      `ParseUUIDPipe` en `venues.controller.ts` y `queue.controller.ts`
- [ ] `RedisModule` no cierra su conexión: crea el cliente con `useFactory`
      pero no implementa `onModuleDestroy`, así que `app.close()` no lo
      desconecta. En la API no se nota porque el proceso vive para siempre,
      pero deja conexiones colgadas del lado del servidor en cada reinicio,
      y cuelga cualquier script de una sola pasada (nos pasó con el seed).
      Arreglar con un provider que implemente `OnModuleDestroy`
- [ ] Paginación de `GET /queue` usa `parseInt` sin validar: `?limit=999999`
      descarga toda la cola, `?limit=abc` produce NaN. Debe ser un DTO con
      `@Type(() => Number) @IsInt() @Min(1) @Max(100)` (P2)

## Épica 9 — Generación e impresión de QR

Premisa: el local imprime UNA VEZ y no vuelve a tocar el papel. La
unicidad ya está resuelta (`randomUUID()` = 122 bits + columna UNIQUE +
`UNIQUE (venue_id, label)`); un token no se adivina. El riesgo real es
otro: **alguien fotografía el QR y lo comparte**, y desde su casa
cualquiera crea sesión y pide canciones. Un QR pegado en una mesa no es
una credencial secreta, es una dirección pública. La seguridad viene de
que la sesión sea corta, limitada y revocable — no del token.

- [ ] Generación del PDF imprimible: un QR por mesa, con nombre del local
      y etiqueta de mesa visibles. Impresión por lote de todas las mesas
      del venue. Es el entregable principal de la épica
- [ ] Rotar el token de una mesa BAJO DEMANDA, nunca programado
      (`PATCH /venues/:venueId/tables/:tableId/rotate`) — botón de
      emergencia para cuando un QR se filtra. Invalida el anterior y
      obliga a reimprimir SOLO esa mesa. Es la excepción, no la rutina
- [ ] Vigencia explícita de `table_sessions.expires_at` — la columna ya
      existe pero falta definir a cuánto se fija (¿4h? ¿cierre del local?).
      Una sesión eterna vuelve inútil poder rotar el QR
- [ ] Límite de sesiones simultáneas por mesa y de pedidos por sesión —
      una mesa de 4 personas no genera 200 pedidos. Es la señal más clara
      de que un QR se filtró
- [ ] Bitácora de escaneos por mesa — insumo para detectar el filtrado
      antes de que el cliente lo reporte

## Épica 10 — Facturación de la plataforma (post-lanzamiento)

Contexto SEPARADO del negocio del venue: aquí Una Rolita le cobra al
LOCAL. No comparte tablas con `credit_accounts` / `credit_transactions`,
que son el dinero del local con sus clientes. Mezclar ambos flujos en las
mismas tablas es el error clásico de este tipo de plataforma.

NO CONSTRUIR ANTES DE TENER ~20 CLIENTES. Con tres o cinco locales, una
hoja de cálculo y correos escritos a mano funcionan mejor y enseñan cómo
negocian los dueños. Se automatiza cuando duela.

- [ ] `subscriptions`: venue, plan, precio, ciclo, fecha de corte, estado
      (prueba / activa / vencida / suspendida)
- [ ] `invoices` + `invoice_payments` — mismo principio que ADR 0006:
      nunca editar una factura emitida, emitir nota de crédito
- [ ] Medidor de uso: créditos emitidos por venue y por mes, derivado del
      ledger. Ya es posible con el diseño actual, es una sola consulta.
      El producto ES el medidor: sin créditos emitidos en el sistema,
      nadie puede pedir canciones
- [ ] Recordatorio 5 días antes del corte (job programado, `@nestjs/schedule`)
- [ ] `notification_log`: qué aviso se mandó, a quién, cuándo, por qué
      canal y si se entregó. Sin esto no podés probar que avisaste
- [ ] Canal correo (la infraestructura de nodemailer ya existe)
- [ ] Canal WhatsApp — requiere WhatsApp Business API (Meta directo o
      proveedor tipo Twilio/360dialog). OJO: las plantillas necesitan
      aprobación previa de Meta y cada mensaje tiene costo. No es
      "mandar un WhatsApp", es una integración con trámite
- [ ] Política de suspensión por falta de pago: ¿se apaga la cola? ¿solo
      el panel? Decisión de negocio, no técnica
- [ ] Rol de plataforma "cobrador" — depende de separar roles de
      plataforma de roles de venue (ver hallazgo del super_admin, Épica 7)
- [ ] Dashboard super_admin: locales al día / por vencer / vencidos,
      ingreso mensual recurrente, créditos emitidos por local
- [ ] Tablero "cuánto generaste este mes" para el venue_admin — no es una
      función bonita, es la principal herramienta de retención: la
      mensualidad compra el primer mes, los números compran el segundo
