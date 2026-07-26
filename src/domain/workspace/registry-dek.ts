import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { KeyManagerError, type KeyManager } from "../../main/persistence/key-manager";
import { WorkspaceError } from "./workspace-error";

// Registry-level DEK orchestration (research.md #13, "Database opening &
// failure behavior"; data-model.md's RegistryKey singleton). Shared by
// domain/workspace/create.ts and open.ts — both need the same registry DEK.
//
// Two distinct entry points (T032-T037 remediation, defect 3):
//   - getOrCreateRegistryDek: initial-setup/creation only (create.ts) — may
//     generate and persist a fresh key if none exists yet, and (see the
//     crash-recovery exception below) may also replace an existing key that
//     cannot be unwrapped, but only when doing so is provably safe.
//   - loadExistingRegistryDek: opening/listing/renaming an *existing*
//     encrypted record (open.ts) — never creates or persists a replacement
//     key, under any circumstance, including when zero workspaces exist. A
//     missing or unrecoverable key fails closed with
//     REGISTRY_KEY_UNAVAILABLE: every name already encrypted under a lost
//     key would otherwise be silently orphaned by a same-column-shape-but-
//     different replacement key.
//
// Deliberately not implemented inside key-manager.ts: key-manager.ts owns
// safeStorage wrap/unwrap only and has no SQL/database access of its own
// (kept that way through the T027-T031 remediation). This module supplies
// the SQL side via an already-open registryDb connection and calls
// key-manager.ts's own wrap/unwrap functions (via the injected KeyManager
// interface) for everything safeStorage-related — it never imports or
// touches safeStorage itself.
//
// Crash-recovery exception (FR-WORKSPACE-007, SC-020; research.md #13's
// "Crash-recovery exception" note; plan.md's "Fifth Phase-1 revision
// re-check"; tasks.md T034 revision note): a confirmed Windows crash-restart
// defect showed that an already-persisted, already-valid wrapped registry
// DEK can become genuinely unrecoverable through no application bug —
// Chromium's own DPAPI-backed safeStorage key material is not guaranteed
// durably written to Local State before an abrupt process termination, so a
// fresh process launched immediately after a crash can fail to unwrap a
// registry DEK the previous process itself just wrapped moments earlier.
// getOrCreateRegistryDek (this file's startup/create-path entry point only)
// may therefore replace an unrecoverable registry DEK automatically, but
// ONLY when the `workspace` table contains zero rows: an empty workspace
// table means the existing registry DEK protects no persisted
// `Workspace.name_ciphertext`, so a replacement orphans nothing. The moment
// any workspace row exists — ACTIVE or DELETING, the status is never
// filtered on — this exception no longer applies and the call fails closed
// with REGISTRY_KEY_UNAVAILABLE exactly as it always has, leaving the
// existing (unrecoverable) registry_key row byte-for-byte untouched.
// loadExistingRegistryDek is entirely unaffected by this exception.

const DEK_LENGTH = 32;

interface RegistryKeyRow {
  wrapped_dek: Buffer;
}

function readWrappedRegistryDek(registryDb: Database.Database): Buffer | undefined {
  const row = registryDb.prepare("SELECT wrapped_dek FROM registry_key WHERE id = 1").get() as
    RegistryKeyRow | undefined;
  return row?.wrapped_dek;
}

function insertWrappedRegistryDek(registryDb: Database.Database, wrapped: Buffer): void {
  registryDb.prepare("INSERT INTO registry_key (id, wrapped_dek) VALUES (1, ?)").run(wrapped);
}

function persistRewrappedRegistryDek(registryDb: Database.Database, wrapped: Buffer): void {
  registryDb.prepare("UPDATE registry_key SET wrapped_dek = ? WHERE id = 1").run(wrapped);
}

function countWorkspaceRows(registryDb: Database.Database): number {
  const row = registryDb.prepare("SELECT COUNT(*) as n FROM workspace").get() as { n: number };
  return row.n;
}

/**
 * Internal sentinel used only to abort the recheck-then-replace transaction
 * below. Never escapes this module: every external throw site converts it
 * (and any other transaction failure) to WorkspaceError({code:
 * "REGISTRY_KEY_UNAVAILABLE"}), never leaking which specific recheck failed
 * (constitution Principle I redaction rules).
 */
class RegistryDekRecoveryAborted extends Error {}

/**
 * Unwraps an already-persisted wrapped registry DEK, re-wrapping and
 * persisting the replacement first if key-manager signals shouldReEncrypt,
 * and only then returning the raw key. Fails closed with WorkspaceError
 * ({code: "REGISTRY_KEY_UNAVAILABLE"}) on any KeyManagerError.
 */
async function unwrapExisting(
  registryDb: Database.Database,
  keyManager: KeyManager,
  wrapped: Buffer,
): Promise<Buffer> {
  try {
    return await keyManager.unwrapRegistryDek(wrapped, async (rewrapped) => {
      persistRewrappedRegistryDek(registryDb, rewrapped);
    });
  } catch (err) {
    if (err instanceof KeyManagerError) {
      throw new WorkspaceError("REGISTRY_KEY_UNAVAILABLE");
    }
    throw err;
  }
}

/**
 * FR-WORKSPACE-007/SC-020 recovery path, invoked only from
 * getOrCreateRegistryDek when unwrapping an existing registry DEK has
 * already failed with the expected key-unavailability error. Never invoked
 * for any other kind of failure, and never invoked from
 * loadExistingRegistryDek.
 *
 * Ordering, never violated:
 *   1. Count every `workspace` row, no status filter. Nonzero -> fail closed
 *      immediately: no key generation, no wrap attempt, no mutation of
 *      `registry_key`.
 *   2. Generate a fresh raw 32-byte DEK and wrap it successfully BEFORE
 *      touching the existing `registry_key` row — a wrap failure here still
 *      leaves that row byte-for-byte unchanged and still fails closed.
 *   3. Only after a successful wrap, run one real SQLite transaction that
 *      rechecks the `workspace` count is still zero and that the singleton
 *      `registry_key` row still holds the exact wrapped value already found
 *      unrecoverable, then atomically replaces it. Any mismatch (a
 *      workspace was created, or the row changed or disappeared, between
 *      step 1 and this recheck) aborts the transaction — better-sqlite3
 *      rolls it back automatically — and this fails closed. This recheck is
 *      retained as defense in depth even though the single-instance lock
 *      (research.md #14) already prevents two processes from racing this
 *      path in practice.
 *   4. The raw DEK is returned to the caller only after the transaction
 *      commits successfully.
 *
 * Never logs or includes the raw DEK, the wrapped DEK, workspace data, or
 * any underlying exception detail in what it throws — every failure surfaces
 * only as WorkspaceError({code: "REGISTRY_KEY_UNAVAILABLE"}).
 */
async function recoverRegistryDek(
  registryDb: Database.Database,
  keyManager: KeyManager,
  previouslyWrapped: Buffer,
): Promise<Buffer> {
  if (countWorkspaceRows(registryDb) > 0) {
    throw new WorkspaceError("REGISTRY_KEY_UNAVAILABLE");
  }

  let rawDek: Buffer;
  let wrapped: Buffer;
  try {
    rawDek = randomBytes(DEK_LENGTH);
    wrapped = await keyManager.wrapRegistryDek(rawDek);
  } catch (err) {
    if (err instanceof KeyManagerError) {
      throw new WorkspaceError("REGISTRY_KEY_UNAVAILABLE");
    }
    throw err;
  }

  const replaceIfStillRecoverable = registryDb.transaction(() => {
    if (countWorkspaceRows(registryDb) > 0) {
      throw new RegistryDekRecoveryAborted();
    }
    const current = readWrappedRegistryDek(registryDb);
    if (current === undefined || !current.equals(previouslyWrapped)) {
      throw new RegistryDekRecoveryAborted();
    }
    persistRewrappedRegistryDek(registryDb, wrapped);
  });

  try {
    replaceIfStillRecoverable();
  } catch {
    // Covers RegistryDekRecoveryAborted (the defense-in-depth recheck
    // failed) and any unexpected database error during the transaction —
    // either way, better-sqlite3's automatic rollback leaves the previous
    // row byte-for-byte unchanged, and this fails closed exactly like every
    // other path in this module.
    throw new WorkspaceError("REGISTRY_KEY_UNAVAILABLE");
  }

  return rawDek;
}

/**
 * Returns the raw 256-bit registry DEK, creating and persisting a fresh
 * wrapped one on first use (data-model.md: "created on first application
 * launch or first workspace creation, whichever comes first"). For initial
 * setup / workspace creation only (create.ts) — see loadExistingRegistryDek
 * for opening an existing encrypted record. Fails closed with
 * WorkspaceError({code: "REGISTRY_KEY_UNAVAILABLE"}) if the DEK cannot be
 * created or unwrapped; never falls back to a plaintext key (research.md
 * #13) — except for the narrow crash-recovery exception documented at the
 * top of this file (FR-WORKSPACE-007/SC-020): if an *existing* wrapped
 * registry DEK cannot be unwrapped, and the `workspace` table currently has
 * zero rows, this function replaces it automatically instead of failing
 * closed. An unrelated (non-key-unavailability) error is never treated as
 * recoverable and is always rethrown unchanged, never triggering
 * replacement.
 */
export async function getOrCreateRegistryDek(
  registryDb: Database.Database,
  keyManager: KeyManager,
): Promise<Buffer> {
  const existing = readWrappedRegistryDek(registryDb);

  if (existing === undefined) {
    try {
      const rawDek = randomBytes(DEK_LENGTH);
      const wrapped = await keyManager.wrapRegistryDek(rawDek);
      insertWrappedRegistryDek(registryDb, wrapped);
      return rawDek;
    } catch (err) {
      if (err instanceof KeyManagerError) {
        throw new WorkspaceError("REGISTRY_KEY_UNAVAILABLE");
      }
      throw err;
    }
  }

  try {
    return await unwrapExisting(registryDb, keyManager, existing);
  } catch (err) {
    if (err instanceof WorkspaceError && err.code === "REGISTRY_KEY_UNAVAILABLE") {
      return recoverRegistryDek(registryDb, keyManager, existing);
    }
    throw err;
  }
}

/**
 * Returns the raw 256-bit registry DEK for an *existing* encrypted record.
 * open.ts's only entry point into the registry DEK (T032-T037 remediation,
 * defect 3): if no RegistryKey row exists yet, fails closed with
 * WorkspaceError({code: "REGISTRY_KEY_UNAVAILABLE"}) — it never creates or
 * persists a replacement key, unlike getOrCreateRegistryDek. Still performs
 * the shouldReEncrypt rewrap-then-persist-then-return flow for a key that
 * does exist.
 */
export async function loadExistingRegistryDek(
  registryDb: Database.Database,
  keyManager: KeyManager,
): Promise<Buffer> {
  const existing = readWrappedRegistryDek(registryDb);
  if (existing === undefined) {
    throw new WorkspaceError("REGISTRY_KEY_UNAVAILABLE");
  }
  return unwrapExisting(registryDb, keyManager, existing);
}
