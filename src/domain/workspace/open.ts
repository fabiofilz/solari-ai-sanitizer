import type Database from "better-sqlite3";
import { decrypt } from "../crypto/aes-gcm";
import { deriveSubkeys } from "../crypto/hkdf";
import { KeyManagerError, type KeyManager } from "../../main/persistence/key-manager";
import { loadExistingRegistryDek } from "./registry-dek";
import { WorkspaceError } from "./workspace-error";

// domain/workspace open (T035; FR-WORKSPACE-003). Framework-independent
// apart from key-manager.ts (T028), exactly like create.ts. Per
// contracts/workspace.md's explicit design note, opening does not mutate
// any server-side "active workspace" state (every other channel resolves
// workspaceId directly instead) — this validates that the workspace exists,
// is not DELETING, its name can be decrypted, its own key can be unwrapped,
// and its file can genuinely be opened, then closes the file again before
// returning. No hidden "current workspace" is ever retained here or
// anywhere else in the main process.

export interface OpenWorkspaceDeps {
  /** Already-open, already-migrated registry.sqlite connection. */
  registryDb: Database.Database;
  /**
   * Opens an *existing* per-workspace file — must fail if it does not
   * already exist, never create it (T032-T037 remediation, defect 2; see
   * src/main/persistence/db-connection.ts's openExistingWorkspaceDatabase).
   */
  openExistingWorkspaceFile: (workspaceId: string) => Database.Database;
  keyManager: KeyManager;
}

export interface OpenWorkspaceResult {
  id: string;
  name: string;
}

interface WorkspaceRow {
  status: string;
  name_ciphertext: Buffer;
  wrapped_dek: Buffer | null;
}

/**
 * Opens (validates) an existing workspace: looks up its registry row
 * (NOT_FOUND if missing — never creates a replacement), refuses a
 * DELETING workspace immediately (WORKSPACE_DELETING — T032-T037
 * remediation, defect 1; contracts/workspace.md), decrypts
 * `name_ciphertext` with the *existing* registry DEK
 * (REGISTRY_KEY_UNAVAILABLE on failure — never regenerates a missing
 * registry key, defect 3), unwraps this workspace's own `wrapped_dek`
 * (WORKSPACE_KEY_UNAVAILABLE on failure — other workspaces are unaffected),
 * and confirms the per-workspace file itself can genuinely be opened before
 * returning `{id, name}`. The raw workspace DEK is never returned or
 * retained beyond this call — it exists only to prove the key material is
 * valid. The status/name/key checks below all run, in this exact order,
 * *before* any decrypt, key unwrap, or file-open operation, per the
 * defect-1 remediation requirement.
 */
export async function openWorkspace(
  deps: OpenWorkspaceDeps,
  id: string,
): Promise<OpenWorkspaceResult> {
  const row = deps.registryDb
    .prepare("SELECT status, name_ciphertext, wrapped_dek FROM workspace WHERE id = ?")
    .get(id) as WorkspaceRow | undefined;

  if (row === undefined) {
    throw new WorkspaceError("NOT_FOUND");
  }

  if (row.status === "DELETING") {
    throw new WorkspaceError("WORKSPACE_DELETING");
  }

  const registryDek = await loadExistingRegistryDek(deps.registryDb, deps.keyManager);
  const { encryptionSubkey } = deriveSubkeys(registryDek);

  let name: string;
  try {
    name = decrypt(encryptionSubkey, row.name_ciphertext).toString("utf8");
  } catch {
    throw new WorkspaceError("REGISTRY_KEY_UNAVAILABLE");
  }

  if (row.wrapped_dek === null) {
    // Schema-permitted only once the (not-yet-built) deletion protocol's
    // key-destruction step has run (research.md #12) — this workspace's key
    // material is gone even though its registry row still exists.
    throw new WorkspaceError("WORKSPACE_KEY_UNAVAILABLE");
  }

  try {
    await deps.keyManager.unwrapWorkspaceDek(row.wrapped_dek, async (rewrapped) => {
      deps.registryDb
        .prepare("UPDATE workspace SET wrapped_dek = ? WHERE id = ?")
        .run(rewrapped, id);
    });
  } catch (err) {
    if (err instanceof KeyManagerError) {
      throw new WorkspaceError("WORKSPACE_KEY_UNAVAILABLE");
    }
    throw err;
  }

  // Fail closed if the per-workspace database cannot itself be validated
  // (e.g. its file was deleted outside the application — T032-T037
  // remediation, defect 2); no server-side "active connection" is kept
  // afterward (see module note). No dedicated contract error code exists
  // for "registry row present, file missing" — see the completion report's
  // flagged ambiguity for why this reuses NOT_FOUND rather than inventing a
  // new ipc-level code.
  let workspaceFile: Database.Database;
  try {
    workspaceFile = deps.openExistingWorkspaceFile(id);
  } catch {
    throw new WorkspaceError("NOT_FOUND");
  }
  workspaceFile.close();

  return { id, name };
}
