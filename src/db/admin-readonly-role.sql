-- Read-only Postgres role for the admin analytics pool (ADMIN_DATABASE_URL). Not run by any code:
-- an operator applies it once per database, after replacing the placeholder password.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/db/admin-readonly-role.sql

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'epsilon_admin_ro') THEN
    CREATE ROLE epsilon_admin_ro LOGIN PASSWORD 'CHANGE_ME_BEFORE_RUNNING';
  END IF;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM epsilon_admin_ro;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM epsilon_admin_ro;
REVOKE CREATE ON SCHEMA public FROM epsilon_admin_ro;
GRANT USAGE ON SCHEMA public TO epsilon_admin_ro;

-- SELECT on every current table ...
GRANT SELECT ON ALL TABLES IN SCHEMA public TO epsilon_admin_ro;

-- ... except the ones holding secrets, which get no access or a column list without the secret.
REVOKE ALL ON otp_challenges, idempotency_keys, admin_sessions FROM epsilon_admin_ro;

REVOKE SELECT ON sessions FROM epsilon_admin_ro;            -- refresh_token_hash
GRANT SELECT (id, user_id, family_id, authenticated_at, expires_at, revoked_at, created_at) ON sessions TO epsilon_admin_ro;

REVOKE SELECT ON devices FROM epsilon_admin_ro;             -- token (push token)
GRANT SELECT (id, user_id, created_at) ON devices TO epsilon_admin_ro;

REVOKE SELECT ON fiscal_receipts FROM epsilon_admin_ro;     -- raw (provider payload)
GRANT SELECT (id, issuer, fiscal_id, provider, extraction_engine, document, merchant_voen, object_code, sector, business_type,
              classification_method, classification_evidence, restaurant_id, branch_id, retrieved_at, created_at)
  ON fiscal_receipts TO epsilon_admin_ro;

REVOKE SELECT ON restaurants FROM epsilon_admin_ro;         -- pos_key_hash
GRANT SELECT (id, name, logo_url, cuisine, cashback_bps, voen, created_at) ON restaurants TO epsilon_admin_ro;

REVOKE SELECT ON purchases FROM epsilon_admin_ro;           -- reference_hash
GRANT SELECT (id, branch_id, fiscal_receipt_id, issued_at, total_minor, currency, status, expires_at, claimed_by, claimed_at, created_at)
  ON purchases TO epsilon_admin_ro;

-- Future tables are readable by default; a table with secrets must be revoked in the migration that adds it.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO epsilon_admin_ro;
