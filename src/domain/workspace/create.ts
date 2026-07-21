import { randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { encrypt } from "../crypto/aes-gcm";
import { deriveSubkeys } from "../crypto/hkdf";
import { computeBlindIndex } from "../crypto/blind-index";
import { KeyManagerError, type KeyManager } from "../../main/persistence/key-manager";
import { getOrCreateRegistryDek } from "./registry-dek";
import { normalizeWorkspaceName } from "./normalize-name";
import { WorkspaceError } from "./workspace-error";

// domain/workspace create (T034; FR-WORKSPACE-001; data-model.md Workspace
// lifecycle). Framework-independent apart from its sanctioned dependency on
// key-manager.ts (T028) for safeStorage wrap/unwrap — never imports
// db-connection.ts or safeStorage directly; the caller supplies an
// already-open registry connection and a way to create the new per-workspace
// file, keeping this module fully unit-testable without Electron.

const WORKSPACE_DEK_LENGTH = 32;

export interface CreateWorkspaceDeps {
  /** Already-open, already-migrated registry.sqlite connection. */
  registryDb: Database.Database;
  /** Creates (and migrates) a brand-new, empty per-workspace file. */
  createWorkspaceFile: (workspaceId: string) => Database.Database;
  keyManager: KeyManager;
}

export interface CreateWorkspaceResult {
  id: string;
  name: string;
}

const INSERT_WORKSPACE_SQL = `
  INSERT INTO workspace (id, name_ciphertext, normalized_name_hmac, status, wrapped_dek)
  VALUES (?, ?, ?, 'ACTIVE', ?)
`;

function isDuplicateNameConstraintError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /UNIQUE constraint failed:\s*workspace\.normalized_name_hmac/.test(err.message)
  );
}

/**
 * Creates a new workspace: normalizes and HMAC-checks the requested name
 * against the registry blind index (DUPLICATE_NAME), encrypts the name with
 * the registry DEK's encryption subkey, generates and wraps a fresh
 * per-workspace DEK (WORKSPACE_KEY_UNAVAILABLE on failure), creates the
 * empty per-workspace file, and only then inserts the registry row — so a
 * failure at any earlier step never leaves a registry row pointing at a
 * nonexistent file. Ordering follows data-model.md's Create lifecycle and
 * research.md #13's "checked before either key is generated" registry-DEK
 * gate (REGISTRY_KEY_UNAVAILABLE).
 */
export async function createWorkspace(
  deps: CreateWorkspaceDeps,
  name: string,
): Promise<CreateWorkspaceResult> {
  const registryDek = await getOrCreateRegistryDek(deps.registryDb, deps.keyManager);
  const { encryptionSubkey, indexSubkey } = deriveSubkeys(registryDek);

  const normalizedNameHmac = computeBlindIndex(indexSubkey, normalizeWorkspaceName(name));

  const existing = deps.registryDb
    .prepare("SELECT 1 FROM workspace WHERE normalized_name_hmac = ?")
    .get(normalizedNameHmac);
  if (existing !== undefined) {
    throw new WorkspaceError("DUPLICATE_NAME");
  }

  const workspaceId = randomUUID();

  let wrappedWorkspaceDek: Buffer;
  try {
    const rawWorkspaceDek = randomBytes(WORKSPACE_DEK_LENGTH);
    wrappedWorkspaceDek = await deps.keyManager.wrapWorkspaceDek(rawWorkspaceDek);
  } catch (err) {
    if (err instanceof KeyManagerError) {
      throw new WorkspaceError("WORKSPACE_KEY_UNAVAILABLE");
    }
    throw err;
  }

  const nameCiphertext = encrypt(encryptionSubkey, Buffer.from(name, "utf8"));

  const workspaceFile = deps.createWorkspaceFile(workspaceId);
  try {
    try {
      deps.registryDb
        .prepare(INSERT_WORKSPACE_SQL)
        .run(workspaceId, nameCiphertext, normalizedNameHmac, wrappedWorkspaceDek);
    } catch (err) {
      // TOCTOU defense: a concurrent create with the same normalized name
      // could win the race between the SELECT check above and this INSERT.
      if (isDuplicateNameConstraintError(err)) {
        throw new WorkspaceError("DUPLICATE_NAME");
      }
      throw err;
    }
  } finally {
    workspaceFile.close();
  }

  return { id: workspaceId, name };
}
