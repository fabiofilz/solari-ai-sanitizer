import type Database from "better-sqlite3";

// Per-workspace <id>.sqlite schema (data-model.md "Per-workspace database"):
// Prefix, Placeholder, Term, PendingDecision. No workspace_id column anywhere
// — the file itself is the isolation boundary (research.md #1). No
// encryption/key-management logic lives here — this module only defines and
// migrates table shape.
//
// SQLite's column type affinity does not guarantee that a column declared
// BLOB actually stores a blob — a TEXT value can be inserted into a BLOB
// column without error. The typeof()/length() CHECK constraints below make
// that a real, enforced invariant at the database layer, not merely the
// absence of a plaintext-named column: sensitive fields must be non-empty
// blobs, and blind-index (HMAC-SHA256) fields must be exactly 32 bytes.

const CREATE_PREFIX_TABLE = `
  CREATE TABLE IF NOT EXISTS prefix (
    id INTEGER PRIMARY KEY,
    value TEXT NOT NULL UNIQUE,
    next_sequence INTEGER NOT NULL CHECK (next_sequence >= 1)
  )
`;

const CREATE_PLACEHOLDER_TABLE = `
  CREATE TABLE IF NOT EXISTS placeholder (
    id INTEGER PRIMARY KEY,
    prefix_id INTEGER NOT NULL REFERENCES prefix(id),
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    rendered_value TEXT NOT NULL UNIQUE,
    UNIQUE (prefix_id, sequence)
  )
`;

const CREATE_PLACEHOLDER_PREFIX_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_placeholder_prefix_id ON placeholder (prefix_id)
`;

// is_principal is stored as INTEGER 0/1 (SQLite has no native boolean type).
// CHECK constraints below encode the row-level invariants from data-model.md:
//   - a Term whose policy is ALWAYS must already have a placeholder_id
//     ("Null only for a term that has never been ALWAYS").
//   - is_principal may only be set (0 or 1) on a Term that has a
//     placeholder_id at all.
// The cross-row invariant "exactly one principal among ≥2 aliased Terms"
// cannot be expressed as a single-row CHECK constraint and is enforced by
// the domain-layer term-lifecycle logic that owns those transitions
// (future task), not by this schema.
const CREATE_TERM_TABLE = `
  CREATE TABLE IF NOT EXISTS term (
    id INTEGER PRIMARY KEY,
    original_value_ciphertext BLOB NOT NULL,
    normalized_lookup_hmac BLOB NOT NULL UNIQUE,
    policy TEXT NOT NULL CHECK (policy IN ('ALWAYS', 'NEVER')),
    placeholder_id INTEGER REFERENCES placeholder(id),
    is_principal INTEGER CHECK (is_principal IN (0, 1)),
    CHECK (policy != 'ALWAYS' OR placeholder_id IS NOT NULL),
    CHECK (is_principal IS NULL OR placeholder_id IS NOT NULL),
    CHECK (typeof(original_value_ciphertext) = 'blob' AND length(original_value_ciphertext) > 0),
    CHECK (typeof(normalized_lookup_hmac) = 'blob' AND length(normalized_lookup_hmac) = 32)
  )
`;

const CREATE_TERM_PLACEHOLDER_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_term_placeholder_id ON term (placeholder_id)
`;

// No foreign key to Term/Placeholder by design (data-model.md "Relationships
// summary": PendingDecision is independent).
const CREATE_PENDING_DECISION_TABLE = `
  CREATE TABLE IF NOT EXISTS pending_decision (
    id INTEGER PRIMARY KEY,
    candidate_ciphertext BLOB NOT NULL,
    normalized_candidate_hmac BLOB NOT NULL UNIQUE,
    CHECK (typeof(candidate_ciphertext) = 'blob' AND length(candidate_ciphertext) > 0),
    CHECK (typeof(normalized_candidate_hmac) = 'blob' AND length(normalized_candidate_hmac) = 32)
  )
`;

/**
 * Creates the per-workspace schema if it does not already exist. Runs inside
 * a single transaction and is idempotent — safe to call on every workspace
 * open against an already-migrated file.
 */
export function migrateWorkspaceSchema(db: Database.Database): void {
  const migrate = db.transaction(() => {
    db.exec(CREATE_PREFIX_TABLE);
    db.exec(CREATE_PLACEHOLDER_TABLE);
    db.exec(CREATE_PLACEHOLDER_PREFIX_INDEX);
    db.exec(CREATE_TERM_TABLE);
    db.exec(CREATE_TERM_PLACEHOLDER_INDEX);
    db.exec(CREATE_PENDING_DECISION_TABLE);
  });
  migrate();
}
