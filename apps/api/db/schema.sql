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
    credit_expiry_months INT NOT NULL DEFAULT 3 CHECK (credit_expiry_months > 0), -- expiración por INACTIVIDAD de la cuenta (ADR 0006)
    bank_account_info JSONB,                          -- datos para transferencias directas
    spotify_account_id UUID,                          -- cuenta Spotify Premium vinculada al local
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

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
-- Cola de pedidos
-- ------------------------------------------------------------

CREATE TABLE queue_requests (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    venue_id        UUID NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
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

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT credit_accounts_user_venue_unique UNIQUE (user_id, venue_id),

    -- Red de seguridad: si un bug intenta dejar el saldo negativo, la
    -- transacción revienta en vez de corromper el dato en silencio.
    CONSTRAINT credit_accounts_balance_non_negative CHECK (balance >= 0)
);

CREATE INDEX idx_credit_accounts_venue ON credit_accounts (venue_id);

-- Índice PARCIAL: al job de expiración solo le importan las cuentas con
-- saldo. Las de saldo 0 ni siquiera entran al índice.
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
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT credit_transactions_amount_not_zero CHECK (amount <> 0),
    CONSTRAINT credit_transactions_balance_after_non_negative CHECK (balance_after >= 0),
    -- En Postgres los NULL no chocan en un UNIQUE: solo restringe las filas
    -- que SÍ traen llave de idempotencia.
    CONSTRAINT credit_transactions_idempotency_unique UNIQUE (idempotency_key),
    CONSTRAINT credit_transactions_no_self_reversal CHECK (reverses_transaction_id <> id)
);

-- Consulta principal: historial de una cuenta, más reciente primero.
CREATE INDEX idx_credit_transactions_account_created
    ON credit_transactions (credit_account_id, created_at DESC);

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