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
//     generate and persist a fresh key if none exists yet.
//   - loadExistingRegistryDek: opening/listing/renaming an *existing*
//     encrypted record (open.ts) — never creates or persists a replacement
//     key. A missing key fails closed with REGISTRY_KEY_UNAVAILABLE; every
//     name already encrypted under a lost key would otherwise be silently
//     orphaned by a same-column-shape-but-different replacement key.
//
// Deliberately not implemented inside key-manager.ts: key-manager.ts owns
// safeStorage wrap/unwrap only and has no SQL/database access of its own
// (kept that way through the T027-T031 remediation). This module supplies
// the SQL side via an already-open registryDb connection and calls
// key-manager.ts's own wrap/unwrap functions (via the injected KeyManager
// interface) for everything safeStorage-related — it never imports or
// touches safeStorage itself.

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
 * Returns the raw 256-bit registry DEK, creating and persisting a fresh
 * wrapped one on first use (data-model.md: "created on first application
 * launch or first workspace creation, whichever comes first"). For initial
 * setup / workspace creation only (create.ts) — see loadExistingRegistryDek
 * for opening an existing encrypted record. Fails closed with
 * WorkspaceError({code: "REGISTRY_KEY_UNAVAILABLE"}) if the DEK cannot be
 * created or unwrapped; never falls back to a plaintext key (research.md
 * #13).
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

  return unwrapExisting(registryDb, keyManager, existing);
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
