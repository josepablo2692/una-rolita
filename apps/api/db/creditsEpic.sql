-- ============================================================
-- ÉPICA 3 — CRÉDITOS Y PAGOS
-- ============================================================

-- credit_accounts: el saldo de un cliente EN UN VENUE específico.
-- Un cliente que va a tres bares tiene TRES cuentas separadas.
-- Regla ADR 0004: el crédito pertenece al dueño del venue, sin split.
BEGIN;
CREATE TABLE credit_accounts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id           UUID NOT NULL REFERENCES users(id),
  venue_id          UUID NOT NULL REFERENCES venues(id),

  -- Saldo en créditos enteros (1 crédito = Q1).
  -- Esto es CACHÉ, no la verdad. La verdad es SUM(amount) del ledger.
  balance           INTEGER NOT NULL DEFAULT 0,

  -- Para expiración por inactividad (L43, opción B).
  last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Una sola cuenta por par (cliente, venue).
  CONSTRAINT credit_accounts_user_venue_unique
    UNIQUE (user_id, venue_id),

  -- Red de seguridad: si un bug intenta dejar el saldo negativo,
  -- la transacción revienta en vez de corromper el dato en silencio.
  CONSTRAINT credit_accounts_balance_non_negative
    CHECK (balance >= 0)
);

-- "Todas las cuentas de este venue" (dashboard admin, Épica 6).
-- El UNIQUE de arriba ya cubre las búsquedas por user_id.
CREATE INDEX idx_credit_accounts_venue
  ON credit_accounts (venue_id);

-- Índice PARCIAL: al job de expiración solo le importan las cuentas
-- con saldo. Las de saldo 0 ni siquiera entran al índice.
CREATE INDEX idx_credit_accounts_inactive
  ON credit_accounts (last_activity_at)
  WHERE balance > 0;


-- credit_transactions: el libro mayor. APPEND-ONLY.
-- Nunca se hace UPDATE ni DELETE sobre esta tabla. Corregir un error
-- es INSERTAR una fila reversa que apunta a la original.
CREATE TABLE credit_transactions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  credit_account_id        UUID NOT NULL REFERENCES credit_accounts(id),

  -- topup_manual | topup_gateway | grant_free_song
  -- charge_song  | charge_jump   | charge_dedication
  -- refund       | reversal      | expiration
  type                     VARCHAR(20) NOT NULL,

  -- CON SIGNO: positivo entra, negativo sale.
  -- Invariante del sistema: SUM(amount) = credit_accounts.balance
  amount                   INTEGER NOT NULL,

  -- Foto del saldo justo después de este movimiento.
  balance_after            INTEGER NOT NULL,

  -- Solo en recargas: cash | card | transfer | recurrente
  payment_method           VARCHAR(20),

  -- Quetzales reales recibidos en caja. NUMERIC porque es dinero
  -- de verdad y puede llevar centavos; el crédito no.
  cash_amount              NUMERIC(10, 2),

  -- Auditoría (L39): quién hizo la carga en recepción.
  created_by_staff_id      UUID REFERENCES users(id),

  -- Nota de crédito (L38): apunta a la transacción que corrige.
  reverses_transaction_id  UUID REFERENCES credit_transactions(id),

  -- Traza el cobro al pedido que lo originó (para reembolsos).
  queue_request_id         UUID REFERENCES queue_requests(id),

  -- L43: hoy no se usa, pero preserva el camino a lotes FIFO.
  expires_at               TIMESTAMPTZ,

  -- Antifraude de doble clic: la misma llave nunca se cobra dos veces.
  idempotency_key          VARCHAR(100),

  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Un movimiento de 0 créditos no es un movimiento, es basura.
  CONSTRAINT credit_transactions_amount_not_zero
    CHECK (amount <> 0),

  CONSTRAINT credit_transactions_balance_after_non_negative
    CHECK (balance_after >= 0),

  -- En Postgres los NULL no chocan entre sí en un UNIQUE, así que
  -- esto solo restringe a las filas que SÍ traen llave.
  CONSTRAINT credit_transactions_idempotency_unique
    UNIQUE (idempotency_key),

  -- Una transacción no puede revertirse a sí misma.
  CONSTRAINT credit_transactions_no_self_reversal
    CHECK (reverses_transaction_id <> id)
);

-- Consulta principal: "historial de esta cuenta, más reciente primero".
CREATE INDEX idx_credit_transactions_account_created
  ON credit_transactions (credit_account_id, created_at DESC);

-- "Qué cobros generó este pedido" (necesario para reembolsar).
CREATE INDEX idx_credit_transactions_queue_request
  ON credit_transactions (queue_request_id)
  WHERE queue_request_id IS NOT NULL;

-- Auditoría (L39): "qué cargó este empleado en su turno".
CREATE INDEX idx_credit_transactions_staff
  ON credit_transactions (created_by_staff_id, created_at DESC)
  WHERE created_by_staff_id IS NOT NULL;


-- Inmutabilidad forzada por la BASE DE DATOS, no por disciplina.
-- Si algún día alguien (o un bug de TypeORM) intenta editar o borrar
-- una transacción, Postgres lo rechaza. La regla deja de depender
-- de que todos los que toquen el código se acuerden de cumplirla.
CREATE OR REPLACE FUNCTION reject_credit_transaction_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'credit_transactions es append-only: % no permitido. '
    'Para corregir, inserte una transacción reversa.', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_credit_transactions_immutable
  BEFORE UPDATE OR DELETE ON credit_transactions
  FOR EACH ROW
  EXECUTE FUNCTION reject_credit_transaction_mutation();

  COMMIT;