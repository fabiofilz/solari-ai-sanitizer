import type Database from "better-sqlite3";

// registry.sqlite schema (data-model.md "Registry database"): RegistryKey
// (singleton) and Workspace. No encryption/key-management logic lives here —
// this module only defines and migrates table shape.
//
// SQLite's column type affinity does not guarantee that a column declared
// BLOB actually stores a blob — a TEXT value can be inserted into a BLOB
// column without error. The typeof()/length() CHECK constraints below make
// that a real, enforced invariant at the database layer, not merely the
// absence of a plaintext-named column: sensitive fields must be non-empty
// blobs, and blind-index (HMAC-SHA256) fields must be exactly 32 bytes.

const CREATE_REGISTRY_KEY_TABLE = `
  CREATE TABLE IF NOT EXISTS registry_key (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    wrapped_dek BLOB NOT NULL,
    CHECK (typeof(wrapped_dek) = 'blob' AND length(wrapped_dek) > 0)
  )
`;

const CREATE_WORKSPACE_TABLE = `
  CREATE TABLE IF NOT EXISTS workspace (
    id TEXT PRIMARY KEY,
    name_ciphertext BLOB NOT NULL,
    normalized_name_hmac BLOB NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'DELETING')),
    wrapped_dek BLOB,
    CHECK (wrapped_dek IS NOT NULL OR status = 'DELETING'),
    CHECK (typeof(name_ciphertext) = 'blob' AND length(name_ciphertext) > 0),
    CHECK (typeof(normalized_name_hmac) = 'blob' AND length(normalized_name_hmac) = 32),
    CHECK (wrapped_dek IS NULL OR (typeof(wrapped_dek) = 'blob' AND length(wrapped_dek) > 0))
  )
`;

/**
 * Creates the registry.sqlite schema if it does not already exist. Runs
 * inside a single transaction and is idempotent — safe to call on every
 * application startup against an already-migrated database.
 */
export function migrateRegistrySchema(db: Database.Database): void {
  const migrate = db.transaction(() => {
    db.exec(CREATE_REGISTRY_KEY_TABLE);
    db.exec(CREATE_WORKSPACE_TABLE);
  });
  migrate();
}
