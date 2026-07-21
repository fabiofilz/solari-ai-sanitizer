import { unlinkSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { assertValidWorkspaceId, assertPathIsStrictDescendant } from "./db-connection";

// Crash-safe, idempotent, resumable workspace deletion protocol (T039/T040;
// research.md #12; data-model.md "Workspace deletion state machine";
// FR-WORKSPACE-005/006). No single cross-resource transaction spans
// registry.sqlite and a separate per-workspace file — none exists — so this
// is instead five individually idempotent steps, safely re-run from the top
// on every call: mark DELETING → close resources → null the key → delete
// the file(s) → delete the registry row. Re-running an already-partially-
// completed sequence naturally resumes from wherever it stopped, since every
// earlier step is a no-op once already done.
//
// This is crash-safe LOGICAL deletion and removal of this application's own
// live key reference — never a guaranteed cryptographic-erasure or
// secure-physical-deletion claim (research.md #10 "Workspace deletion & key
// destruction — honest scope"). Nulling `wrapped_dek` and deleting the
// per-workspace file are the only two things this module does to the
// key/data; nothing here overwrites disk blocks, touches the OS-level
// safeStorage wrapping key, or verifies unrecoverability at the
// filesystem/OS level.
//
// No safeStorage/key-manager import: step 3 only ever writes a SQL NULL to
// an existing column, never unwraps or decrypts anything, so this module has
// no dependency on key-manager.ts.

export interface DeletionReconcilerDeps {
  /** Already-open, already-migrated registry.sqlite connection. */
  registryDb: Database.Database;
  /** Directory containing every `<id>.sqlite` (+ `-wal`/`-shm`) file. */
  workspacesDir: string;
  /**
   * Closes any live resources this process holds for the given workspace
   * (an open better-sqlite3 handle, a running translation worker — research
   * topic #11, owned by a later task, not this module). MUST be safe to
   * call when nothing is currently open for that workspace — a no-op in
   * that case, not an error — since startup reconciliation resumes a
   * workspace nothing was opened for yet in the current process. Whatever
   * it returns is awaited before this protocol proceeds to step 3, so a
   * slow or asynchronous close is guaranteed to finish before the key is
   * nulled or the file is deleted.
   */
  closeWorkspaceResources: (workspaceId: string) => void | Promise<void>;
}

export type DeletionStep = 1 | 2 | 3 | 4 | 5;

export interface DeletionProtocolOptions {
  /**
   * Test-only fault-injection hook (research.md #12 "Tests": "a test-only
   * fault-injection hook, or literally terminating and restarting the
   * process"). Invoked immediately after the named step completes;
   * throwing from it simulates a crash before the next step runs. No
   * production caller may ever supply this.
   */
  afterStep?: (step: DeletionStep) => void;
}

interface WorkspaceStatusRow {
  status: string;
  wrapped_dek: Buffer | null;
}

function runAfterStepHook(options: DeletionProtocolOptions, step: DeletionStep): void {
  options.afterStep?.(step);
}

function readWorkspaceStatus(
  registryDb: Database.Database,
  workspaceId: string,
): WorkspaceStatusRow | undefined {
  return registryDb
    .prepare("SELECT status, wrapped_dek FROM workspace WHERE id = ?")
    .get(workspaceId) as WorkspaceStatusRow | undefined;
}

// Step 1: mark DELETING. Idempotent — a no-op if already DELETING; the WHERE
// clause never touches a row that isn't currently ACTIVE.
function markDeleting(registryDb: Database.Database, workspaceId: string): void {
  registryDb
    .prepare("UPDATE workspace SET status = 'DELETING' WHERE id = ? AND status = 'ACTIVE'")
    .run(workspaceId);
}

// Step 3: destroy the live key reference. Idempotent — a no-op if already
// NULL. registry-schema.ts's own CHECK (wrapped_dek IS NOT NULL OR status =
// 'DELETING') means this can only ever succeed once step 1 has already run,
// enforced by the database itself, not merely by this module's call order.
function nullWrappedDek(registryDb: Database.Database, workspaceId: string): void {
  registryDb
    .prepare("UPDATE workspace SET wrapped_dek = NULL WHERE id = ? AND wrapped_dek IS NOT NULL")
    .run(workspaceId);
}

function workspaceFilePaths(workspacesDir: string, workspaceId: string): string[] {
  assertValidWorkspaceId(workspaceId);
  const dbPath = join(workspacesDir, `${workspaceId}.sqlite`);
  assertPathIsStrictDescendant(workspacesDir, dbPath);
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
}

// Step 4: delete the per-workspace file and its -wal/-shm companions.
// Attempt-then-catch-ENOENT (rather than existsSync-then-delete) avoids a
// check-then-act race and matches research.md #12's own framing directly: "A
// missing file at this point... is treated as success, not an error."
function deleteWorkspaceFiles(workspacesDir: string, workspaceId: string): void {
  for (const filePath of workspaceFilePaths(workspacesDir, workspaceId)) {
    try {
      unlinkSync(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
}

// Step 5: delete the registry row. Idempotent — a no-op if already absent.
function deleteRegistryRow(registryDb: Database.Database, workspaceId: string): void {
  registryDb.prepare("DELETE FROM workspace WHERE id = ?").run(workspaceId);
}

/**
 * Runs (or resumes) the five-step crash-safe deletion protocol for a single
 * workspace: mark DELETING → close resources → null the key → delete the
 * file(s) → delete the registry row (research.md #12). Every step is
 * individually idempotent, so calling this repeatedly — after an
 * interruption, or as an explicit user retry against an already-DELETING
 * workspace (contracts/workspace.md: "treated as a resume, not a new
 * deletion") — always converges toward the fully deleted end state,
 * regardless of which step a prior call reached before stopping.
 *
 * A workspace whose registry row is already fully gone (a prior call
 * already finished, or the id never existed) is a silent no-op success —
 * there is nothing left to converge toward.
 *
 * Validates `workspaceId` as a canonical UUID before any registry mutation
 * or filesystem access (path-safety boundary, reused from db-connection.ts).
 */
export async function runDeletionProtocol(
  deps: DeletionReconcilerDeps,
  workspaceId: string,
  options: DeletionProtocolOptions = {},
): Promise<void> {
  assertValidWorkspaceId(workspaceId);

  markDeleting(deps.registryDb, workspaceId);
  runAfterStepHook(options, 1);

  if (readWorkspaceStatus(deps.registryDb, workspaceId) === undefined) {
    return;
  }

  await deps.closeWorkspaceResources(workspaceId);
  runAfterStepHook(options, 2);

  nullWrappedDek(deps.registryDb, workspaceId);
  runAfterStepHook(options, 3);

  deleteWorkspaceFiles(deps.workspacesDir, workspaceId);
  runAfterStepHook(options, 4);

  deleteRegistryRow(deps.registryDb, workspaceId);
  runAfterStepHook(options, 5);
}

export interface ReconciliationResult {
  workspaceId: string;
  succeeded: boolean;
}

/**
 * Startup reconciliation (T040): resumes every workspace left in DELETING
 * state by an interrupted deletion, inferring the remaining work purely from
 * persisted registry/key/file state (research.md #12; data-model.md's
 * deletion state machine) — every step in runDeletionProtocol above is a
 * no-op if already done, so re-running the full sequence for a DELETING
 * workspace naturally resumes from wherever it actually stopped.
 *
 * Reasons only from registry rows whose `status = 'DELETING'` — never from
 * directory contents. This is what keeps an ACTIVE workspace's row and file
 * untouched, and what keeps a truly orphaned file (no matching registry row
 * at all) untouched rather than silently deleted (research.md #12 "Missing
 * and orphaned files").
 *
 * One workspace's failure (e.g. a locked file) does not block reconciling
 * the others — its row is simply left in DELETING state for the next retry
 * (research.md #12 "Retry behavior").
 */
export async function reconcileDeletingWorkspacesOnStartup(
  deps: DeletionReconcilerDeps,
  options: DeletionProtocolOptions = {},
): Promise<ReconciliationResult[]> {
  const deletingIds = (
    deps.registryDb.prepare("SELECT id FROM workspace WHERE status = 'DELETING'").all() as {
      id: string;
    }[]
  ).map((row) => row.id);

  const results: ReconciliationResult[] = [];
  for (const workspaceId of deletingIds) {
    try {
      await runDeletionProtocol(deps, workspaceId, options);
      results.push({ workspaceId, succeeded: true });
    } catch {
      results.push({ workspaceId, succeeded: false });
    }
  }
  return results;
}
