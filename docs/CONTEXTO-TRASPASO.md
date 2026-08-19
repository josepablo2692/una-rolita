# Contexto de traspaso — Una Rolita

Última actualización: 18 de agosto 2026

## Estado actual

**Épica 1 (Auth + QR): completa en código.** Lo pendiente es trámite
externo, no desarrollo — ver "Dependencias externas" abajo.

**Épica 2 (Cola de pedidos): completa.** WebSocket con QueueGateway
(manda lista completa, no aviso vacío), cancelar, saltar, paginación.
Corregidos en Fase 0 dos bugs que no se veían: el lock de Redis no era
atómico al liberarse, y `calculateJumpPosition` asignaba posiciones
duplicadas — dos saltos pagados quedaban en el mismo lugar, o sea que se
cobraba dos veces la misma posición.

**Fase 0 (blindaje, PR #27): completa.** Seis vulnerabilidades P0
cerradas antes de conectar dinero. La más grave: `ValidationPipe` global
no existía, así que TODOS los decoradores de class-validator del proyecto
eran inertes. La segunda: `RolesGuard` comparaba el nombre del rol pero
nunca el local, así que un `venue_admin` del Bar A podía administrar el
Bar B. Detalle completo en `docs/backlog.md` → sección "Fase 0".

**Épica 3 (Créditos): PR 1 de 3 completo (PR #29).**

- Modelo: libro mayor inmutable según ADR 0006
- `CreditsService.applyTransaction()` — única puerta por la que se mueve
  un crédito. `SELECT ... FOR UPDATE` en transacción
- Endpoints de recepción: `topup`, `account` (búsqueda), `me` (saldo)
- Idempotencia obligatoria contra el doble clic del mesero

**Épica 7 (pruebas): 41 pruebas verdes.** 18 unitarias + 23 e2e en 4
suites. Las e2e cubren aislamiento entre locales, los seis P0, y —la más
importante— concurrencia real: 10 cargas simultáneas deben dejar
exactamente 50 créditos. Falta: caja blanca/negra y pruebas de carga.

## Rama actual

`develop`, con PR #27 y #29 fusionados.

## Decisiones de arquitectura (ver ADRs en `docs/adr/`)

- **ADR 0004:** pagos duales (manual + Recurrente) vía interfaz `PaymentMethod`
- **ADR 0005:** login dual — OTP por email (clientes) + password (staff/admin)
- **ADR 0006:** libro mayor inmutable de créditos. Reemplaza el modelo
  original, que con `CHECK (amount > 0)` no podía registrar un solo gasto
- Google OAuth reusa el mismo `findOrCreateUser` que OTP — la fuente de
  verificación cambia, la lógica de creación de usuario no

## Reglas de negocio confirmadas, no obvias en el código

- Créditos SIEMPRE pertenecen al dueño del venue — sin split. La cuenta
  es por par (usuario, venue): un cliente que va a tres bares tiene tres
  saldos separados, y no viajan entre locales
- Créditos en ENTEROS: 1 crédito = Q1. Un `CHECK` en `venues` obliga a
  que todos los precios sean enteros. El dinero real (efectivo recibido)
  se guarda aparte en NUMERIC
- **Reembolso: se decide por quién incumplió, no por qué se cobró.**
  Artista/DJ salta el pedido → el local falló → reembolso TOTAL.
  Cliente cancela → decisión propia y ya se benefició de la posición →
  NO se reembolsa el salto
- Playlist curada restringe catálogo, no el salto pagado — el dinero
  compra posición, nunca acceso a canciones fuera de lista
- `displayName` se autocompleta desde OAuth solo si estaba vacío
- El correo es la IDENTIDAD (verificada por OTP). El teléfono es solo
  una LLAVE DE BÚSQUEDA y no está verificado — por eso nunca debe usarse
  para decidir nada de dinero ni de antifraude

## Dependencias externas que bloquean producción (no son código)

El código está terminado y probado en los tres casos. Lo que falta es
trámite con terceros: **son lentos y no dependen de nosotros**, así que
hay que arrancarlos con anticipación, no la semana del lanzamiento.

- **Google OAuth sigue en modo "Testing"** en Google Cloud Console. Solo
  los correos agregados como _test users_ pueden entrar. Cualquier
  cliente real de un bar sería rechazado **por Google, no por nuestro
  código**. La verificación puede exigir política de privacidad pública,
  términos de uso y revisión de la pantalla de consentimiento. Es la
  diferencia entre "probado por mí" y "funciona para cualquiera"
- **Proveedor de correo transaccional sin definir.** `EmailOtpSender` usa
  SMTP genérico vía nodemailer, así que cambiar de proveedor es solo
  tocar el `.env`. Falta verificar límites de envío y reputación de
  entrega: un OTP que cae en spam es un cliente que no puede registrarse
- **Facebook OAuth** — bloqueado en Facebook for Developers. El código es
  copia directa del patrón de `GoogleStrategy`
- **GitHub Actions no ejecuta** por facturación de la cuenta. Mientras
  tanto, el CI se corre a mano: `lint`, `test`, `test:e2e`

## Riesgo número 1 del proyecto

**No hay respaldos de la base de datos.** `credit_transactions` es el
registro de a quién se le debe cuánto, y el dinero entra en efectivo: no
existe rastro externo con el cual reconstruirlo. Si el volumen se pierde,
no hay vuelta. Debe resolverse antes del 31 de agosto.

## Siguiente paso

**Épica 3, PR 2 — cobros.** Debitar al pedir canción, la regla de
reembolso de ADR 0006, y la canción gratis por registro.

Regla fijada de antemano: al cobrar se van a bloquear DOS recursos (la
cuenta de créditos y las posiciones de cola). **Siempre en el mismo
orden: primero el crédito, después la cola** — si no hay saldo, no vale
la pena tocar posiciones. Sin esa regla aparecen interbloqueos.

Después: PR 3 (reversas y auditoría), despliegue, y estrategia de pruebas
completa.

## Deadline

31 de agosto — servidor real desplegado, con estrategia de pruebas
completa. Proveedor de despliegue: sin decidir (Railway/Render/VPS).

## Guías de trabajo (no olvidar)

- `docs/UX-GUIDELINES.md`: tono juvenil, regla de 3 clics, PWA instalable
- Nunca saltar pasos del backlog en orden, salvo fuerza mayor documentada
- **Orden de trabajo: teoría → esquema → entidad → servicio → controller
  → prueba e2e → commit.** Compilar no es probar; probar antes de
  commitear; un commit es una afirmación sobre el código
- Git: siempre confirmar `git branch --show-current` antes de add/commit
- Correr `lint` ANTES del `git add`: lleva `--fix` y modifica archivos
- Commits con prefijo Conventional Commits (feat/fix/docs/refactor/test/chore)
- `schema.sql` es la única fuente de verdad del esquema. Ningún cambio
  se hace a mano contra la base: se edita el archivo y se reconstruye.
  Ya hubo dos derivas por saltarse esto (`password_hash` y el CHECK de
  precios existían en la base pero no en el archivo)

- **Simular antes de construir.** Cuando una regla de negocio dependa de
  volumen o del paso del tiempo, se recorre un escenario concreto con
  números ANTES de escribir código. Así se encontró el defecto FIFO de la
  cola: la regla se veía razonable hasta que se simularon 50 pedidos y 10
  saltos. Un bug de reglas descubierto en el frontend cuesta mucho más
