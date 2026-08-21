-- ============================================================
-- Una Rolita — Esquema de base de datos (Postgres)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ------------------------------------------------------------
-- Negocios (locales) y mesas
-- ------------------------------------------------------------

CREATE TABLE venues (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(150) NOT NULL,
    type            VARCHAR(30) NOT NULL CHECK (type IN ('bar', 'gym', 'strip_club', 'live_music')),
    playlist_mode   VARCHAR(20) NOT NULL DEFAULT 'free' CHECK (playlist_mode IN ('free', 'curated')),
    playback_mode   VARCHAR(20) NOT NULL DEFAULT 'spotify_managed' CHECK (playback_mode IN ('spotify_managed', 'dj_manual')), -- con DJ en vivo, no requiere Spotify
    cooldown_hours  INT NOT NULL DEFAULT 3,          -- horas antes de repetir una canción
    song_price      NUMERIC(10,2) NOT NULL DEFAULT 1.00,   -- costo base de pedir una canción (Q1)
    queue_jump_price NUMERIC(10,2) NOT NULL DEFAULT 5.00,
    dedication_price NUMERIC(10,2) NOT NULL DEFAULT 3.00,
    combo_jump_dedication_price NUMERIC(10,2) NOT NULL DEFAULT 7.00, -- precio fijo de paquete (marketing), independiente de la suma de los dos anteriores
    -- Expiración por INACTIVIDAD de la cuenta (ADR 0006 + su enmienda).
    -- 12 meses por default: el dinero ya lo cobró el local, así que
    -- expirar antes no le da liquidez nueva, solo castiga al cliente que
    -- sale poco. El 0 es válido y significa "no expiran nunca" — por eso
    -- el CHECK es >= 0 y no > 0.
    credit_expiry_months INT NOT NULL DEFAULT 12 CHECK (credit_expiry_months >= 0),
    bank_account_info JSONB,                          -- datos para transferencias directas
    spotify_account_id UUID,                          -- cuenta Spotify Premium vinculada al local
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Horas sin actividad tras las cuales el sistema cierra la noche solo.
    -- Configurable por local: un bar cierra a las 2 a.m., un gimnasio a
    -- las 9 p.m., y sus ritmos de inactividad no se parecen.
    session_timeout_hours INT NOT NULL DEFAULT 6 CHECK (session_timeout_hours > 0),

    -- Los precios se cobran en créditos ENTEROS (1 crédito = Q1), ver ADR 0006.
    -- Si el negocio algún día necesita centavos, primero hay que rediseñar la
    -- unidad del saldo. Reemplaza el ALTER TABLE que se corrió a mano y nunca
    -- llegó al archivo.
    CONSTRAINT venues_prices_are_whole_credits CHECK (
        song_price                  = trunc(song_price) AND
        queue_jump_price            = trunc(queue_jump_price) AND
        dedication_price            = trunc(dedication_price) AND
        combo_jump_dedication_price = trunc(combo_jump_dedication_price)
    )
);  

CREATE TABLE tables (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    venue_id        UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    label           VARCHAR(20) NOT NULL,              -- "Mesa 7"
    qr_code_token   VARCHAR(100) NOT NULL UNIQUE,       -- token único embebido en el QR
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (venue_id, label)
);

-- ------------------------------------------------------------
-- Usuarios y roles
-- ------------------------------------------------------------

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone_number    VARCHAR(20) UNIQUE,                -- identidad principal, verificada por OTP
    email           VARCHAR(150) UNIQUE,
    display_name    VARCHAR(80),
    password_hash   VARCHAR(255),                      -- SOLO staff/admin/DJ; los clientes entran por OTP y lo tienen NULL
    is_phone_verified BOOLEAN NOT NULL DEFAULT false,
    is_email_verified BOOLEAN NOT NULL DEFAULT false,
    free_song_used  BOOLEAN NOT NULL DEFAULT false,     -- controla la canción gratis por registro
    marketing_opt_in BOOLEAN NOT NULL DEFAULT false,
    terms_version_accepted VARCHAR(20),                 -- qué versión de T&C aceptó ESTE usuario
    terms_accepted_at      TIMESTAMPTZ,                 -- y cuándo — sin esto no se puede sostener una auditoría (ADR 0006)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE roles (
    id      SERIAL PRIMARY KEY,
    name    VARCHAR(30) NOT NULL UNIQUE  -- 'super_admin', 'venue_admin', 'dj', 'staff', 'customer' (staff = mesero/recepcion, puede cargar creditos)
);
-- Catálogo de valores esperados (se insertan una vez, ON CONFLICT DO NOTHING):
-- 1 = super_admin  (acceso total a la plataforma, todos los venues)
-- 2 = venue_admin  (dueño/administrador de un venue específico)
-- 3 = dj           (artista/DJ, gestiona su cola y playlist)
-- 4 = staff        (mesero/recepción, puede cargar créditos)
-- 5 = customer     (cliente final, rol implícito, normalmente no pasa por login de staff)

-- Data de CATÁLOGO, no de prueba: toda instalación la necesita, incluida
-- producción. Sin estas filas, loginStaff no puede resolver ningún rol y
-- nadie del personal puede entrar.
INSERT INTO roles (id, name) VALUES
    (1, 'super_admin'),
    (2, 'venue_admin'),
    (3, 'dj'),
    (4, 'staff'),
    (5, 'customer')
ON CONFLICT (id) DO NOTHING;

-- Insertar ids explícitos en una columna SERIAL no adelanta el contador
-- de la secuencia. Sin este setval, el próximo INSERT sin id intentaría
-- usar el 1 y chocaría con la llave primaria.
SELECT setval('roles_id_seq', (SELECT MAX(id) FROM roles));

CREATE TABLE user_venue_roles (
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    venue_id    UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    role_id     INT NOT NULL REFERENCES roles(id),
    PRIMARY KEY (user_id, venue_id, role_id)
);

-- Sesión de mesa: token de invitado antes de que el usuario se registre
CREATE TABLE table_sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    table_id        UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES users(id),          -- null hasta que se registre (progressive registration)
    device_fingerprint VARCHAR(255),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL
);

-- ------------------------------------------------------------
-- Catálogo de canciones e historial (para el cooldown)
-- ------------------------------------------------------------

CREATE TABLE songs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider        VARCHAR(20) NOT NULL DEFAULT 'spotify',
    provider_track_id VARCHAR(100) NOT NULL,
    title           VARCHAR(200) NOT NULL,
    artist          VARCHAR(200) NOT NULL,
    duration_ms     INT,
    UNIQUE (provider, provider_track_id)
);



CREATE TABLE venue_song_history (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    venue_id        UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    song_id         UUID NOT NULL REFERENCES songs(id),
    played_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);



-- ------------------------------------------------------------
-- Sesiones de noche
-- ------------------------------------------------------------

-- Una "noche" del local. La cola NO es perpetua: pertenece a una sesión.
-- Al día siguiente hay otra playlist, otro cantante, otras canciones.
--
-- La sesión se abre SOLA con el primer pedido (apertura perezosa): la
-- noche empieza cuando alguien pide música, no cuando alguien aprieta un
-- botón. El cierre sí es explícito, porque mueve dinero.
--
-- Va ANTES de queue_requests porque esa tabla la referencia.
CREATE TABLE venue_sessions (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    venue_id             UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,

    opened_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Última vez que pasó algo en esta sesión. Es lo que usa el job para
    -- decidir si cerrar, Y la hora con la que cierra: si usara la hora
    -- del job, una noche de 4h30m que nadie cerró mediría 8h30m.
    last_activity_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    closed_at            TIMESTAMPTZ,
    closed_by_user_id    UUID REFERENCES users(id),

    -- Distingue "el DJ cerró" de "el sistema cerró porque se olvidaron".
    -- Es un dato de calidad de operación, no solo un detalle técnico.
    closed_automatically BOOLEAN NOT NULL DEFAULT false,

    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Coherencia básica: no se puede cerrar antes de abrir.
    CONSTRAINT venue_sessions_cierre_posterior
        CHECK (closed_at IS NULL OR closed_at >= opened_at)
);

-- UN local tiene COMO MÁXIMO UNA sesión abierta.
-- Índice único PARCIAL: solo aplica a las filas sin closed_at, así que no
-- estorba al historial de sesiones cerradas. Lo garantiza Postgres, no el
-- código — es imposible abrir dos noches a la vez.
CREATE UNIQUE INDEX idx_venue_sessions_una_abierta
    ON venue_sessions (venue_id) WHERE closed_at IS NULL;

-- Para el job de cierre automático: solo le importan las abiertas.
CREATE INDEX idx_venue_sessions_inactivas
    ON venue_sessions (last_activity_at) WHERE closed_at IS NULL;

-- Historial de sesiones del local, más reciente primero.
CREATE INDEX idx_venue_sessions_venue
    ON venue_sessions (venue_id, opened_at DESC);

-- ------------------------------------------------------------
-- Cola de pedidos
-- ------------------------------------------------------------

CREATE TABLE queue_requests (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    venue_id        UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    session_id      UUID NOT NULL REFERENCES venue_sessions(id), -- a qué noche pertenece
    table_id        UUID NOT NULL REFERENCES tables(id),
    user_id         UUID NOT NULL REFERENCES users(id),
    song_id         UUID NOT NULL REFERENCES songs(id),
    position        INT NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'playing', 'played', 'skipped', 'cancelled')),
    is_paid_jump    BOOLEAN NOT NULL DEFAULT false,
    paid_amount     NUMERIC(10,2) DEFAULT 0,
    requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    played_at       TIMESTAMPTZ
);

CREATE INDEX idx_queue_requests_venue_status ON queue_requests (venue_id, status, position);

-- Control del límite de salto de cola pagado: por USUARIO (no por mesa),
-- y basado en cuántas canciones han sonado desde el último salto de ese
-- usuario (cooldown por actividad, no por reloj).
CREATE TABLE queue_jumps (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id                 UUID NOT NULL REFERENCES users(id),
    venue_id                UUID NOT NULL REFERENCES venues(id),
    queue_request_id        UUID NOT NULL REFERENCES queue_requests(id),
    songs_played_snapshot   INT NOT NULL, -- cuántas canciones había reproducidas en el venue al momento del salto
    jumped_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_queue_jumps_rate_limit ON queue_jumps (user_id, venue_id, jumped_at);

-- ------------------------------------------------------------
-- Créditos y pagos
-- ------------------------------------------------------------

-- Saldo de un cliente EN UN VENUE específico. Un cliente que visita tres
-- locales tiene TRES cuentas separadas: el crédito pertenece al dueño del
-- venue donde se compró (ADR 0004) y no viaja entre negocios.
CREATE TABLE credit_accounts (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    venue_id          UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,

    -- Saldo en créditos ENTEROS (1 crédito = Q1).
    -- Esto es CACHÉ, no la verdad. La verdad es SUM(amount) del ledger.
    balance           INTEGER NOT NULL DEFAULT 0,

    -- Para la expiración por inactividad (ADR 0006).
    last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Cuándo se le avisó al cliente que su saldo está por expirar.
    -- NULL = todavía no se le ha avisado en este ciclo de inactividad.
    --
    -- Guarda el HECHO ("a esta cuenta ya se le avisó"), no el canal: el
    -- mismo aviso sale por correo Y dentro de la app, y ninguno de los
    -- dos debe repetirse cada día que corra el job.
    --
    -- SE VUELVE A PONER EN NULL cada vez que la cuenta se mueve. Sin eso
    -- pasa esto: se le avisa en enero, el cliente vuelve en febrero y
    -- recarga, y cuando en el próximo ciclo le toque expirar otra vez la
    -- marca vieja hace que NO se le avise. Se le expiraría el saldo en
    -- silencio justo al cliente que sí regresó.
    expiry_warning_sent_at TIMESTAMPTZ,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT credit_accounts_user_venue_unique UNIQUE (user_id, venue_id),

    -- Red de seguridad: si un bug intenta dejar el saldo negativo, la
    -- transacción revienta en vez de corromper el dato en silencio.
    CONSTRAINT credit_accounts_balance_non_negative CHECK (balance >= 0)
);

CREATE INDEX idx_credit_accounts_venue ON credit_accounts (venue_id);

-- Índice PARCIAL: a los jobs de aviso y de expiración solo les importan
-- las cuentas CON saldo. Las de saldo 0 ni siquiera entran al índice, y
-- son la mayoría en cualquier local con tiempo funcionando.
--
-- Este mismo índice sirve para los dos jobs. NO se agrega un segundo
-- índice con `AND expiry_warning_sent_at IS NULL`: este ya reduce la
-- búsqueda a "cuentas con saldo pasadas de fecha", que son pocas, y
-- filtrar el aviso sobre ese puñado es gratis. Cada índice se paga en
-- cada escritura, y aquí se escribe en cada cobro.
CREATE INDEX idx_credit_accounts_inactive
    ON credit_accounts (last_activity_at) WHERE balance > 0;


-- Libro mayor. APPEND-ONLY: nunca UPDATE ni DELETE sobre esta tabla.
-- Corregir un error es INSERTAR una fila reversa (ADR 0006).
CREATE TABLE credit_transactions (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    credit_account_id       UUID NOT NULL REFERENCES credit_accounts(id),

    type                    VARCHAR(20) NOT NULL CHECK (type IN (
                                'topup_manual', 'topup_gateway', 'grant_free_song',
                                'charge_song', 'charge_jump', 'charge_dedication',
                                'refund', 'reversal', 'expiration')),

    -- CON SIGNO: positivo entra, negativo sale.
    -- Invariante del sistema: SUM(amount) = credit_accounts.balance
    amount                  INTEGER NOT NULL,

    -- Foto del saldo justo después de este movimiento.
    balance_after           INTEGER NOT NULL,

    -- Solo en recargas. Se conservan los valores en español que ya existían.
    payment_method          VARCHAR(25) CHECK (payment_method IN (
                                'efectivo_recepcion', 'tarjeta_recepcion',
                                'transferencia_directa', 'recurrente')),

    -- Quetzales reales recibidos en caja. NUMERIC porque es dinero de
    -- verdad y puede llevar centavos; el crédito no.
    cash_amount             NUMERIC(10,2),

    created_by_staff_id     UUID REFERENCES users(id),              -- auditoría de la carga
    reverses_transaction_id UUID REFERENCES credit_transactions(id), -- nota de crédito
    queue_request_id        UUID REFERENCES queue_requests(id),      -- traza el cobro al pedido
    expires_at              TIMESTAMPTZ,                             -- hoy sin uso; preserva el camino a lotes FIFO
    idempotency_key         VARCHAR(100),                            -- antifraude de doble clic

    -- ORDEN ESTRICTO DE INSERCIÓN. Necesario porque created_at NO sirve
    -- para ordenar: TypeORM lo llena con un Date de JavaScript, que tiene
    -- precisión de MILISEGUNDOS. Los dos renglones de la canción gratis
    -- (el regalo y el cobro) se insertan dentro del mismo milisegundo, así
    -- que quedan con timestamps idénticos y el ORDER BY desempata al azar.
    -- Un libro mayor sin orden estricto no es un libro mayor: el cliente
    -- vería el cobro antes del regalo y el replay del ledger sería ambiguo.
    seq                     BIGSERIAL NOT NULL UNIQUE,
     -- Por qué se hizo este movimiento. OBLIGATORIO en las reversas: una
    -- corrección sin explicación no sirve para auditar. Opcional en el
    -- resto, aunque también sirve para justificar una carga promocional.
    reason                  VARCHAR(255),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT credit_transactions_amount_not_zero CHECK (amount <> 0),
    CONSTRAINT credit_transactions_balance_after_non_negative CHECK (balance_after >= 0),
    -- En Postgres los NULL no chocan en un UNIQUE: solo restringe las filas
    -- que SÍ traen llave de idempotencia.
    CONSTRAINT credit_transactions_idempotency_unique UNIQUE (idempotency_key),
    CONSTRAINT credit_transactions_no_self_reversal CHECK (reverses_transaction_id <> id)
);

-- Consulta principal: historial de una cuenta, más reciente primero.
-- Se ordena por `seq` y no por `created_at`, porque created_at empata
-- entre renglones de la misma operación.
CREATE INDEX idx_credit_transactions_account_seq
    ON credit_transactions (credit_account_id, seq DESC);

-- "Qué cobros generó este pedido" — necesario para reembolsar.
CREATE INDEX idx_credit_transactions_queue_request
    ON credit_transactions (queue_request_id) WHERE queue_request_id IS NOT NULL;

-- Auditoría: qué cargó este empleado en su turno.
CREATE INDEX idx_credit_transactions_staff_audit
    ON credit_transactions (created_by_staff_id, created_at DESC)
    WHERE created_by_staff_id IS NOT NULL;


-- Inmutabilidad forzada por la BASE DE DATOS, no por disciplina del equipo.
-- La regla deja de depender de que todos la recuerden.
CREATE OR REPLACE FUNCTION reject_credit_transaction_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'credit_transactions es append-only: % no permitido. Para corregir, inserte una transacción reversa.', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_credit_transactions_immutable
    BEFORE UPDATE OR DELETE ON credit_transactions
    FOR EACH ROW EXECUTE FUNCTION reject_credit_transaction_mutation();

CREATE INDEX idx_venue_song_history_lookup ON venue_song_history (venue_id, song_id, played_at);


-- ------------------------------------------------------------
-- Dedicatorias
-- ------------------------------------------------------------

CREATE TABLE dedications (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    queue_request_id    UUID NOT NULL REFERENCES queue_requests(id) ON DELETE CASCADE,
    from_user_id        UUID NOT NULL REFERENCES users(id),
    to_table_id         UUID REFERENCES tables(id),
    message             TEXT NOT NULL,
    show_sender_name    BOOLEAN NOT NULL DEFAULT false,
    moderation_status    VARCHAR(20) NOT NULL DEFAULT 'pending'
                            CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
    delivery_method     VARCHAR(20) DEFAULT 'dj_voice' CHECK (delivery_method IN ('dj_voice', 'synth_voice', 'screen_only')),
    moderated_by        UUID REFERENCES users(id),
    moderated_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Publicidad / promociones propias del negocio
-- ------------------------------------------------------------

CREATE TABLE promotions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    venue_id        UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    title           VARCHAR(150) NOT NULL,
    image_url       TEXT,
    frequency_every_n_songs INT NOT NULL DEFAULT 3,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    starts_at       TIMESTAMPTZ,
    ends_at         TIMESTAMPTZ
);

-- ------------------------------------------------------------
-- Avisos al cliente
--
-- SON DOS TABLAS Y NO UNA, a propósito:
--
--   notifications           = EL MENSAJE. Una fila es un aviso que el
--                             cliente ve dentro de la app. No hay que
--                             "enviarlo": existir ES el canal in-app.
--   notification_deliveries = LA BITÁCORA. Una fila por cada intento de
--                             mandar ese mensaje por un canal externo,
--                             con su resultado y su error.
--
-- Son cosas distintas: "le avisamos a Ana" y "el correo a Ana rebotó
-- tres veces". Si vivieran juntas, cada reintento ensuciaría el mensaje
-- que Ana ve en pantalla.
--
-- Es el mismo par que ya usamos con el dinero: credit_accounts.balance
-- es el ESTADO (lo que hay ahora) y credit_transactions es la HISTORIA
-- (todo lo que pasó, append-only). Aquí notifications lleva el estado
-- del despacho y deliveries lleva la historia de intentos.
-- ------------------------------------------------------------

CREATE TABLE notifications (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Nullable: un cambio de reglas de la plataforma no pertenece a
    -- ningún local. ON DELETE SET NULL y no CASCADE — si un local cierra,
    -- el aviso de que le devolvimos Q5 a alguien no debe desaparecer.
    venue_id    UUID REFERENCES venues(id) ON DELETE SET NULL,

    type        VARCHAR(40) NOT NULL CHECK (type IN (
                    'refund_night_close',   -- se cerró la noche y se le devolvió
                    'credits_expiring',     -- aviso previo de expiración
                    'credits_expired',      -- ya expiró
                    'rules_changed')),      -- cambio de reglas de negocio

    title       VARCHAR(150) NOT NULL,
    body        TEXT NOT NULL,

    -- Datos crudos del aviso (monto, id del pedido, fecha de vencimiento).
    -- Permite que la app arme su propia presentación sin volver a
    -- consultar, y que el texto cambie sin perder el dato.
    data        JSONB,

    read_at     TIMESTAMPTZ,

    -- Máquina de estados del correo. El mensaje in-app ya está entregado
    -- por el solo hecho de existir; esto solo gobierna el canal externo.
    --
    -- 'pending' = el job matutino lo tiene que mandar. El reembolso de
    -- cierre de noche nace así: el mensaje aparece en la app a las 2 a.m.
    -- pero el correo se manda agrupado a las 9, para no despertar a nadie
    -- con un correo por cada canción que no sonó.
    email_status VARCHAR(20) NOT NULL DEFAULT 'not_applicable'
                    CHECK (email_status IN
                        ('not_applicable', 'pending', 'sent', 'failed')),

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- La bandeja del cliente: sus avisos, más reciente primero.
CREATE INDEX idx_notifications_usuario
    ON notifications (user_id, created_at DESC);

-- Índice PARCIAL para el contador de "no leídos". Los avisos ya leídos
-- —que con el tiempo son casi todos— ni entran al índice.
CREATE INDEX idx_notifications_sin_leer
    ON notifications (user_id) WHERE read_at IS NULL;

-- Índice PARCIAL para el job matutino: solo le importan los que esperan
-- correo. Va por user_id además de la fecha porque el job AGRUPA por
-- persona — un solo correo con todo lo de anoche, no uno por aviso.
CREATE INDEX idx_notifications_correo_pendiente
    ON notifications (user_id, created_at) WHERE email_status = 'pending';


CREATE TABLE notification_deliveries (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,

    channel         VARCHAR(20) NOT NULL CHECK (channel IN ('email', 'in_app')),
    status          VARCHAR(20) NOT NULL CHECK (status IN ('sent', 'failed')),

    -- A dónde se mandó, tal como estaba en ese momento. Se guarda copiado
    -- y no por referencia a users.email: si mañana el cliente cambia de
    -- correo, la bitácora tiene que seguir diciendo a dónde se mandó
    -- REALMENTE. Una bitácora que se actualiza sola no prueba nada.
    destination     VARCHAR(255),

    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notification_deliveries_aviso
    ON notification_deliveries (notification_id, created_at DESC);

-- Append-only, igual que el libro mayor. Una bitácora que se puede editar
-- no sirve para demostrar nada — y con la expiración de créditos esto
-- dejó de ser un detalle técnico.
--
-- Función GENÉRICA (usa TG_TABLE_NAME) en vez de copiar la de
-- credit_transactions, que tiene su mensaje cableado adentro.
CREATE OR REPLACE FUNCTION reject_table_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        '% es append-only: % no permitido. Para corregir, inserte una fila nueva.',
        TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notification_deliveries_immutable
    BEFORE UPDATE OR DELETE ON notification_deliveries
    FOR EACH ROW EXECUTE FUNCTION reject_table_mutation();

-- ------------------------------------------------------------
-- Auditoría general
-- ------------------------------------------------------------

CREATE TABLE audit_logs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    actor_user_id   UUID REFERENCES users(id),
    action          VARCHAR(100) NOT NULL,
    entity_type     VARCHAR(50) NOT NULL,
    entity_id       UUID,
    metadata        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);