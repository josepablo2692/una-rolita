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
    queue_jump_price NUMERIC(10,2) NOT NULL DEFAULT 5.00,
    dedication_price NUMERIC(10,2) NOT NULL DEFAULT 3.00,
    combo_jump_dedication_price NUMERIC(10,2) NOT NULL DEFAULT 7.00, -- precio fijo de paquete (marketing), independiente de la suma de los dos anteriores
    bank_account_info JSONB,                          -- datos para transferencias directas
    spotify_account_id UUID,                          -- cuenta Spotify Premium vinculada al local
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
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
    is_phone_verified BOOLEAN NOT NULL DEFAULT false,
    is_email_verified BOOLEAN NOT NULL DEFAULT false,
    free_song_used  BOOLEAN NOT NULL DEFAULT false,     -- controla la canción gratis por registro
    marketing_opt_in BOOLEAN NOT NULL DEFAULT false,
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
-- Créditos y pagos
-- ------------------------------------------------------------

CREATE TABLE credit_accounts (
    user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance         NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE credit_transactions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id),
    venue_id        UUID NOT NULL REFERENCES venues(id),
    amount          NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    payment_method  VARCHAR(20) NOT NULL DEFAULT 'efectivo_recepcion'
                        CHECK (payment_method IN ('efectivo_recepcion', 'tarjeta_recepcion', 'transferencia_directa')), -- transferencia_directa en pausa por ahora
    status          VARCHAR(20) NOT NULL DEFAULT 'confirmed'
                        CHECK (status IN ('pending', 'in_review', 'confirmed', 'rejected')), -- efectivo/tarjeta en recepcion nace 'confirmed' (no hay espera)
    bank_reference  VARCHAR(100),                       -- solo aplica si payment_method = transferencia_directa
    receipt_url     TEXT,                                -- solo aplica si payment_method = transferencia_directa
    created_by_staff_id UUID REFERENCES users(id),        -- staff/admin que registro la carga en recepcion (auditoria)
    reviewed_by     UUID REFERENCES users(id),            -- admin del local que confirmo (solo aplica a transferencia_directa)
    reviewed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_credit_transactions_staff_audit ON credit_transactions (created_by_staff_id, created_at);

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

CREATE INDEX idx_venue_song_history_lookup ON venue_song_history (venue_id, song_id, played_at);

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