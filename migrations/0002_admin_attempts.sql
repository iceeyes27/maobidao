CREATE TABLE IF NOT EXISTS archive_admin_attempts (
  address_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
