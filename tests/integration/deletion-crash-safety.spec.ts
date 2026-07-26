import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { resolve } from "node:path";

// T038 (research.md #12 "Tests"; constitution Principle VI; FR-WORKSPACE-005/
// 006 via the crash-safe deletion protocol). Written and confirmed to fail
// before src/main/persistence/deletion-reconciler.ts exists (T039/T040).
//
// Three assertions were later strengthened against non-vacuous-test gaps
// found in an independent review: (1) the crashStep=5 fault-injection hook
// is now asserted to fire even though the row is already deleted by then;
// (2) `-wal`/`-shm` companion fixtures are written directly via Node fs APIs
// rather than relying on SQLite's own (non-guaranteed) WAL-checkpoint
// behavior, and every relevant scenario now checks all three files, not just
// the main one; (3) the ordering scenario's `closeWorkspaceResources` is now
// genuinely asynchronous (a real macrotask boundary) so the `await` in
// runDeletionProtocol is actually exercised. Each was verified by disclosed,
// reverted mutation testing against the unchanged implementation (breaking
// the guarantee, confirming the exact assertion failed, then restoring it) —
// distinct from this file's original T038 red-state evidence above.
//
// Scope: this suite covers only the crash-safe deletion PROTOCOL itself
// (research.md #12) — never FR-WORKSPACE-005's user-facing confirmation
// dialog (a later task) nor the cross-workspace mapping/policy isolation
// half of FR-WORKSPACE-006 (the US5 isolation test suite); both are separate,
// later tasks. Also deliberately out of scope, and not a gap in this file:
//   - Worker-thread close semantics: `closeWorkspaceResources` is exercised
//     only via an injected fake, since the translation worker (research.md
//     #11) doesn't exist until a later task; T039/T040 only depend on T028.
//   - Concurrent/duplicate reconciliation races across process instances:
//     prevented structurally by the single-instance lock (research.md #14,
//     T041/T042), not re-tested here.
//   - "Registry row ACTIVE, file unexpectedly missing": that is the *open*
//     path's concern (src/domain/workspace/open.ts), not deletion
//     reconciliation.
//
// Runs entirely inside a real, separately-spawned Electron process
// (app.evaluate()) rather than importing better-sqlite3-backed modules at
// the top of this Playwright spec file directly — the same pattern already
// established by tests/integration/key-manager-safe-storage.spec.ts. This
// matters structurally, not just stylistically: `npm run test:e2e`'s
// pretest hook rebuilds better-sqlite3's native binding for Electron's Node
// ABI, not the plain Node ABI this Playwright test file's own process runs
// under, so requiring an Electron-ABI-compiled native module directly from
// here would throw a NODE_MODULE_VERSION mismatch — an environment problem,
// not a genuine signal about missing deletion behavior. Every module under
// test is instead required from *inside* the launched Electron process via
// `process.mainModule.require` against the already-built `dist/main/...`
// output, so the failure this test produces before deletion-reconciler.ts
// exists is an unambiguous `MODULE_NOT_FOUND` for that one file — nothing
// else in `dist/main` references it yet, so `npm run build` itself still
// succeeds either way, isolating the failure to exactly the missing behavior.
//
// Every scenario uses only synthetic placeholder values (never real
// encryption, since deletion-reconciler.ts never decrypts anything) and real
// temporary SQLite files under the OS temp directory (never the real
// userData path, via the existing createTempUserDataDir() helper) — portable
// across macOS/Windows since every path is built with node:path's `join`.

const projectRoot = resolve(process.cwd());
const distMain = (relativePath: string) => resolve(projectRoot, "dist/main/main", relativePath);

let app: ElectronApplication;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  app = await electron.launch({ args: [projectRoot] });
  await app.firstWindow();
});

test.afterAll(async () => {
  await app.close();
});

function harnessArgs(scenario: string, extra: Record<string, unknown> = {}) {
  return {
    scenario,
    dbConnectionPath: distMain("persistence/db-connection.js"),
    tempUserDataPath: distMain("persistence/temp-user-data.js"),
    deletionReconcilerPath: distMain("persistence/deletion-reconciler.js"),
    ...extra,
  };
}

// The single shared in-Electron-process harness. Every scenario below is a
// case of this one function so setup helpers (insert a workspace row, create
// a real per-workspace file with WAL/SHM companions, read back file/row
// state) are defined once, not duplicated per test. Each `app.evaluate()`
// call is an independent RPC into the Electron main process — no state is
// shared across calls except through the real filesystem/SQLite files this
// harness itself creates and tears down per call.
async function runHarness(scenario: string, extra: Record<string, unknown> = {}) {
  return app.evaluate(
    async (_electronApi, args: ReturnType<typeof harnessArgs>) => {
      const mainModuleRequire = (process as unknown as { mainModule: { require: NodeRequire } })
        .mainModule.require;
      const fs = mainModuleRequire("node:fs") as typeof import("node:fs");
      const path = mainModuleRequire("node:path") as typeof import("node:path");
      const nodeCrypto = mainModuleRequire("node:crypto") as typeof import("node:crypto");

      // Intentionally NOT wrapped in try/catch: before T039/T040 exist, this
      // throws MODULE_NOT_FOUND, which is exactly the genuine red-state
      // signal T038 must produce — letting app.evaluate() itself reject with
      // that error is the correct behavior, not something to swallow here.
      const dbConn = mainModuleRequire(
        args.dbConnectionPath,
      ) as typeof import("../../src/main/persistence/db-connection");
      const tempUserData = mainModuleRequire(
        args.tempUserDataPath,
      ) as typeof import("../../src/main/persistence/temp-user-data");
      const reconciler = mainModuleRequire(
        args.deletionReconcilerPath,
      ) as typeof import("../../src/main/persistence/deletion-reconciler");

      const tempDir = tempUserData.createTempUserDataDir();
      const workspacesDir = path.join(tempDir.path, "workspaces");

      function syntheticBuffers() {
        return {
          nameCiphertext: Buffer.from("synthetic-name-ciphertext-not-real-content", "utf8"),
          normalizedHmac: nodeCrypto.randomBytes(32),
          wrappedDek: Buffer.from("synthetic-wrapped-dek-not-a-real-key", "utf8"),
        };
      }

      function insertActiveWorkspaceRow(registryDb: import("better-sqlite3").Database, id: string) {
        const b = syntheticBuffers();
        registryDb
          .prepare(
            "INSERT INTO workspace (id, name_ciphertext, normalized_name_hmac, status, wrapped_dek) VALUES (?, ?, ?, 'ACTIVE', ?)",
          )
          .run(id, b.nameCiphertext, b.normalizedHmac, b.wrappedDek);
      }

      function workspacePaths(id: string) {
        const dbPath = path.join(workspacesDir, `${id}.sqlite`);
        return { dbPath, wal: `${dbPath}-wal`, shm: `${dbPath}-shm` };
      }

      // Creates a real per-workspace database file, then deliberately writes
      // real synthetic `-wal`/`-shm` companion files via plain Node fs APIs
      // *after* the connection is closed. SQLite may checkpoint away (or
      // never materialize) its own `-wal`/`-shm` files on close depending on
      // platform/SQLite version, so relying on that would make any
      // WAL/SHM-deletion assertion vacuous — it could pass even if
      // deletion-reconciler.ts never touched those files at all, simply
      // because they never existed to begin with. Writing real bytes here,
      // independent of SQLite's own WAL lifecycle, guarantees both
      // companion files genuinely exist on disk before any deletion step
      // runs, so asserting they are gone afterward actually proves
      // something.
      function createWorkspaceFileWithWal(id: string) {
        const db = dbConn.openWorkspaceDatabase(tempDir.path, id);
        db.prepare("INSERT INTO prefix (value, next_sequence) VALUES (?, 1)").run(
          `synthetic-prefix-${id}`,
        );
        db.close();

        const paths = workspacePaths(id);
        fs.writeFileSync(paths.wal, Buffer.from(`synthetic-wal-content-${id}`, "utf8"));
        fs.writeFileSync(paths.shm, Buffer.from(`synthetic-shm-content-${id}`, "utf8"));
      }

      function fileState(id: string) {
        const p = workspacePaths(id);
        return {
          main: fs.existsSync(p.dbPath),
          wal: fs.existsSync(p.wal),
          shm: fs.existsSync(p.shm),
        };
      }

      function rowFor(registryDb: import("better-sqlite3").Database, id: string) {
        return registryDb
          .prepare("SELECT status, wrapped_dek FROM workspace WHERE id = ?")
          .get(id) as { status: string; wrapped_dek: Buffer | null } | undefined;
      }

      function countWorkspaceRows(registryDb: import("better-sqlite3").Database) {
        return (registryDb.prepare("SELECT COUNT(*) as n FROM workspace").get() as { n: number }).n;
      }

      try {
        switch (args.scenario) {
          case "crash-after-step": {
            const registryDb = dbConn.openRegistryDatabase(tempDir.path);
            const id = nodeCrypto.randomUUID();
            insertActiveWorkspaceRow(registryDb, id);
            createWorkspaceFileWithWal(id);

            const closeCalls: string[] = [];
            const deps: import("../../src/main/persistence/deletion-reconciler").DeletionReconcilerDeps =
              {
                registryDb,
                workspacesDir,
                closeWorkspaceResources: (wsId: string) => {
                  closeCalls.push(wsId);
                },
              };

            let crashed = false;
            try {
              await reconciler.runDeletionProtocol(deps, id, {
                afterStep: (step) => {
                  if (step === args.crashStep) {
                    throw new Error(`synthetic crash after step ${String(step)}`);
                  }
                },
              });
            } catch {
              crashed = true;
            }

            const rowAfterCrash = rowFor(registryDb, id);
            const filesAfterCrash = fileState(id);
            registryDb.close();

            // Simulate an application restart: a fresh connection against the
            // same on-disk registry.sqlite file, exactly as startup would open
            // it, with nothing carried over from the crashed in-memory state.
            const resumedRegistryDb = dbConn.openRegistryDatabase(tempDir.path);
            const resumedDeps: import("../../src/main/persistence/deletion-reconciler").DeletionReconcilerDeps =
              {
                registryDb: resumedRegistryDb,
                workspacesDir,
                closeWorkspaceResources: () => undefined,
              };
            await reconciler.reconcileDeletingWorkspacesOnStartup(resumedDeps);

            const finalRow = rowFor(resumedRegistryDb, id);
            const finalFiles = fileState(id);
            resumedRegistryDb.close();
            tempDir.cleanup();

            return {
              crashed,
              rowAfterCrashExists: rowAfterCrash !== undefined,
              rowAfterCrashStatus: rowAfterCrash ? rowAfterCrash.status : null,
              filesAfterCrash,
              finalRowExists: finalRow !== undefined,
              finalFiles,
            };
          }

          case "idempotent-retry-full-deletion": {
            const registryDb = dbConn.openRegistryDatabase(tempDir.path);
            const id = nodeCrypto.randomUUID();
            insertActiveWorkspaceRow(registryDb, id);
            createWorkspaceFileWithWal(id);

            const deps: import("../../src/main/persistence/deletion-reconciler").DeletionReconcilerDeps =
              {
                registryDb,
                workspacesDir,
                closeWorkspaceResources: () => undefined,
              };

            await reconciler.runDeletionProtocol(deps, id);
            const rowCountAfterFirst = countWorkspaceRows(registryDb);
            const filesAfterFirst = fileState(id);

            let secondThrew = false;
            try {
              await reconciler.runDeletionProtocol(deps, id);
            } catch {
              secondThrew = true;
            }
            const rowCountAfterSecond = countWorkspaceRows(registryDb);
            const filesAfterSecond = fileState(id);

            registryDb.close();
            tempDir.cleanup();

            return {
              rowCountAfterFirst,
              filesAfterFirst,
              secondThrew,
              rowCountAfterSecond,
              filesAfterSecond,
            };
          }

          case "idempotent-reconcile-scan-twice": {
            const registryDb = dbConn.openRegistryDatabase(tempDir.path);
            const activeId = nodeCrypto.randomUUID();
            insertActiveWorkspaceRow(registryDb, activeId);
            createWorkspaceFileWithWal(activeId);

            const deps: import("../../src/main/persistence/deletion-reconciler").DeletionReconcilerDeps =
              {
                registryDb,
                workspacesDir,
                closeWorkspaceResources: () => undefined,
              };

            const firstResults = await reconciler.reconcileDeletingWorkspacesOnStartup(deps);
            const rowAfterFirst = rowFor(registryDb, activeId);
            const filesAfterFirst = fileState(activeId);

            const secondResults = await reconciler.reconcileDeletingWorkspacesOnStartup(deps);
            const rowAfterSecond = rowFor(registryDb, activeId);
            const filesAfterSecond = fileState(activeId);

            registryDb.close();
            tempDir.cleanup();

            return {
              firstResultsLength: firstResults.length,
              secondResultsLength: secondResults.length,
              rowAfterFirstStatus: rowAfterFirst ? rowAfterFirst.status : null,
              filesAfterFirst,
              rowAfterSecondStatus: rowAfterSecond ? rowAfterSecond.status : null,
              filesAfterSecond,
            };
          }

          case "active-rows-never-silently-deleted": {
            const registryDb = dbConn.openRegistryDatabase(tempDir.path);
            const activeId = nodeCrypto.randomUUID();
            const deletingId = nodeCrypto.randomUUID();
            insertActiveWorkspaceRow(registryDb, activeId);
            createWorkspaceFileWithWal(activeId);
            insertActiveWorkspaceRow(registryDb, deletingId);
            createWorkspaceFileWithWal(deletingId);
            registryDb
              .prepare("UPDATE workspace SET status = 'DELETING', wrapped_dek = NULL WHERE id = ?")
              .run(deletingId);

            const deps: import("../../src/main/persistence/deletion-reconciler").DeletionReconcilerDeps =
              {
                registryDb,
                workspacesDir,
                closeWorkspaceResources: () => undefined,
              };
            await reconciler.reconcileDeletingWorkspacesOnStartup(deps);

            const activeRow = rowFor(registryDb, activeId);
            const activeFiles = fileState(activeId);
            const deletingRow = rowFor(registryDb, deletingId);
            const deletingFiles = fileState(deletingId);

            registryDb.close();
            tempDir.cleanup();

            return {
              activeRowExists: activeRow !== undefined,
              activeRowStatus: activeRow ? activeRow.status : null,
              activeWrappedDekIsNull: activeRow ? activeRow.wrapped_dek === null : null,
              activeFiles,
              deletingRowExists: deletingRow !== undefined,
              deletingFiles,
            };
          }

          case "orphan-file-never-silently-deleted": {
            const registryDb = dbConn.openRegistryDatabase(tempDir.path);

            // A real, valid per-workspace file with no matching registry row —
            // e.g. left over from before this reconciliation logic existed.
            const orphanId = nodeCrypto.randomUUID();
            createWorkspaceFileWithWal(orphanId);

            // One legitimate DELETING workspace so the scan performs real work.
            const deletingId = nodeCrypto.randomUUID();
            insertActiveWorkspaceRow(registryDb, deletingId);
            createWorkspaceFileWithWal(deletingId);
            registryDb
              .prepare("UPDATE workspace SET status = 'DELETING', wrapped_dek = NULL WHERE id = ?")
              .run(deletingId);

            const deps: import("../../src/main/persistence/deletion-reconciler").DeletionReconcilerDeps =
              {
                registryDb,
                workspacesDir,
                closeWorkspaceResources: () => undefined,
              };
            await reconciler.reconcileDeletingWorkspacesOnStartup(deps);

            const orphanFiles = fileState(orphanId);
            const deletingRow = rowFor(registryDb, deletingId);
            const deletingFiles = fileState(deletingId);

            registryDb.close();
            tempDir.cleanup();

            return {
              orphanFiles,
              deletingRowExists: deletingRow !== undefined,
              deletingFiles,
            };
          }

          case "ordering-close-then-key-then-file": {
            const registryDb = dbConn.openRegistryDatabase(tempDir.path);
            const id = nodeCrypto.randomUUID();
            insertActiveWorkspaceRow(registryDb, id);
            createWorkspaceFileWithWal(id);

            const closeCalls: string[] = [];
            const observations: Record<string, unknown> = {};

            // Genuinely asynchronous close: resolves only after a real
            // macrotask boundary (setTimeout, not a same-tick
            // Promise.resolve()), so `asyncCloseCompleted` cannot become
            // true until the event loop actually yields and comes back —
            // it is not merely "eventually true after synchronous code
            // finishes." If `await` were ever removed from
            // `await deps.closeWorkspaceResources(workspaceId)` in
            // deletion-reconciler.ts, the remaining synchronous steps
            // (3-5, none of which contain any further `await`) would run
            // to completion in the same tick, so this flag would still be
            // `false` when step 2's observation below reads it.
            let asyncCloseCompleted = false;
            const deps: import("../../src/main/persistence/deletion-reconciler").DeletionReconcilerDeps =
              {
                registryDb,
                workspacesDir,
                closeWorkspaceResources: (wsId: string) => {
                  closeCalls.push(wsId);
                  return new Promise<void>((resolveClose) => {
                    setTimeout(() => {
                      asyncCloseCompleted = true;
                      resolveClose();
                    }, 10);
                  });
                },
              };

            const paths = workspacePaths(id);

            await reconciler.runDeletionProtocol(deps, id, {
              afterStep: (step) => {
                if (step === 1) {
                  observations["statusAfterStep1"] = rowFor(registryDb, id)?.status ?? null;
                }
                if (step === 2) {
                  observations["closeCallsAfterStep2"] = [...closeCalls];
                  observations["asyncCloseCompletedAtStep2"] = asyncCloseCompleted;
                  observations["wrappedDekNullAfterStep2"] =
                    rowFor(registryDb, id)?.wrapped_dek === null;
                  observations["filesAfterStep2"] = fileState(id);
                }
                if (step === 3) {
                  observations["wrappedDekNullAfterStep3"] =
                    rowFor(registryDb, id)?.wrapped_dek === null;
                  observations["fileExistsAfterStep3"] = fs.existsSync(paths.dbPath);
                  observations["filesAfterStep3"] = fileState(id);
                }
                if (step === 4) {
                  observations["fileExistsAfterStep4"] = fs.existsSync(paths.dbPath);
                  observations["filesAfterStep4"] = fileState(id);
                }
              },
            });

            registryDb.close();
            tempDir.cleanup();

            return observations;
          }

          case "registry-level-dek-untouched": {
            const registryDb = dbConn.openRegistryDatabase(tempDir.path);
            const registryKeyBefore = Buffer.from(
              "synthetic-registry-wrapped-dek-not-real",
              "utf8",
            );
            registryDb
              .prepare("INSERT INTO registry_key (id, wrapped_dek) VALUES (1, ?)")
              .run(registryKeyBefore);

            const id = nodeCrypto.randomUUID();
            insertActiveWorkspaceRow(registryDb, id);
            createWorkspaceFileWithWal(id);

            const deps: import("../../src/main/persistence/deletion-reconciler").DeletionReconcilerDeps =
              {
                registryDb,
                workspacesDir,
                closeWorkspaceResources: () => undefined,
              };
            await reconciler.runDeletionProtocol(deps, id);

            const registryKeyAfter = (
              registryDb.prepare("SELECT wrapped_dek FROM registry_key WHERE id = 1").get() as {
                wrapped_dek: Buffer;
              }
            ).wrapped_dek;

            registryDb.close();
            tempDir.cleanup();

            return {
              registryKeyUnchanged: registryKeyBefore.equals(registryKeyAfter),
            };
          }

          case "path-safety-rejects-malformed-id": {
            const registryDb = dbConn.openRegistryDatabase(tempDir.path);
            const rowCountBefore = countWorkspaceRows(registryDb);

            const deps: import("../../src/main/persistence/deletion-reconciler").DeletionReconcilerDeps =
              {
                registryDb,
                workspacesDir,
                closeWorkspaceResources: () => undefined,
              };

            let threw = false;
            try {
              await reconciler.runDeletionProtocol(deps, "../../evil-not-a-uuid");
            } catch {
              threw = true;
            }

            const rowCountAfter = countWorkspaceRows(registryDb);
            const escapedFileExists = fs.existsSync(
              path.join(tempDir.path, "..", "evil-not-a-uuid.sqlite"),
            );

            registryDb.close();
            tempDir.cleanup();

            return { threw, rowCountBefore, rowCountAfter, escapedFileExists };
          }

          case "missing-file-during-retry-is-idempotent": {
            const registryDb = dbConn.openRegistryDatabase(tempDir.path);
            const id = nodeCrypto.randomUUID();
            insertActiveWorkspaceRow(registryDb, id);
            createWorkspaceFileWithWal(id);

            const deps: import("../../src/main/persistence/deletion-reconciler").DeletionReconcilerDeps =
              {
                registryDb,
                workspacesDir,
                closeWorkspaceResources: () => undefined,
              };

            // Stop right after the key is nulled (step 3), then manually
            // remove the file out-of-band — simulating a prior attempt that
            // got further than a fresh retry will know about.
            let crashed = false;
            try {
              await reconciler.runDeletionProtocol(deps, id, {
                afterStep: (step) => {
                  if (step === 3) {
                    throw new Error("synthetic crash after step 3");
                  }
                },
              });
            } catch {
              crashed = true;
            }
            const paths = workspacePaths(id);
            for (const p of [paths.dbPath, paths.wal, paths.shm]) {
              if (fs.existsSync(p)) fs.unlinkSync(p);
            }

            let retryThrew = false;
            try {
              await reconciler.runDeletionProtocol(deps, id);
            } catch {
              retryThrew = true;
            }

            const finalRow = rowFor(registryDb, id);
            registryDb.close();
            tempDir.cleanup();

            return { crashed, retryThrew, finalRowExists: finalRow !== undefined };
          }

          case "no-sensitive-console-output": {
            const registryDb = dbConn.openRegistryDatabase(tempDir.path);
            const id = nodeCrypto.randomUUID();
            insertActiveWorkspaceRow(registryDb, id);
            createWorkspaceFileWithWal(id);

            const consoleCalls: string[] = [];
            const originalLog = console.log;
            const originalError = console.error;
            const originalWarn = console.warn;
            console.log = (...a: unknown[]) => {
              consoleCalls.push(a.map(String).join(" "));
            };
            console.error = (...a: unknown[]) => {
              consoleCalls.push(a.map(String).join(" "));
            };
            console.warn = (...a: unknown[]) => {
              consoleCalls.push(a.map(String).join(" "));
            };

            try {
              const deps: import("../../src/main/persistence/deletion-reconciler").DeletionReconcilerDeps =
                {
                  registryDb,
                  workspacesDir,
                  closeWorkspaceResources: () => undefined,
                };
              await reconciler.runDeletionProtocol(deps, id);

              // A deliberately failing run: closeWorkspaceResources throws
              // carrying a fake secret token, on a second workspace.
              const failingId = nodeCrypto.randomUUID();
              insertActiveWorkspaceRow(registryDb, failingId);
              createWorkspaceFileWithWal(failingId);
              const failingDeps: import("../../src/main/persistence/deletion-reconciler").DeletionReconcilerDeps =
                {
                  registryDb,
                  workspacesDir,
                  closeWorkspaceResources: () => {
                    throw new Error("synthetic secret leak: hunter2-token");
                  },
                };
              try {
                await reconciler.runDeletionProtocol(failingDeps, failingId);
              } catch {
                // expected — the failure itself is what's under test here
              }
            } finally {
              console.log = originalLog;
              console.error = originalError;
              console.warn = originalWarn;
            }

            registryDb.close();
            tempDir.cleanup();

            return { consoleCallCount: consoleCalls.length, consoleCalls };
          }

          default:
            throw new Error(`Unknown scenario: ${args.scenario}`);
        }
      } finally {
        // no-op: each case above cleans up its own tempDir before returning.
      }
    },
    harnessArgs(scenario, extra),
  );
}

test("crash after each of the five deletion-protocol steps converges to a fully deleted state on the next reconciliation pass", async () => {
  for (const crashStep of [1, 2, 3, 4, 5] as const) {
    const result = (await runHarness("crash-after-step", { crashStep })) as {
      crashed: boolean;
      rowAfterCrashExists: boolean;
      rowAfterCrashStatus: string | null;
      filesAfterCrash: { main: boolean; wal: boolean; shm: boolean };
      finalRowExists: boolean;
      finalFiles: { main: boolean; wal: boolean; shm: boolean };
    };
    const label = `crashStep=${String(crashStep)}`;

    // The fault-injection hook must genuinely fire for every crash point,
    // including step 5 — even though by then the row is already deleted
    // (the "final deletion state is already complete" case), the hook
    // itself must still have been invoked and thrown. This fails if
    // deletion-reconciler.ts ever stops calling afterStep(5).
    expect(result.crashed, label).toBe(true);

    // The end state always converges: registry row gone, every file gone —
    // regardless of which step the simulated crash occurred after.
    expect(result.finalRowExists, label).toBe(false);
    expect(result.finalFiles.main, label).toBe(false);
    expect(result.finalFiles.wal, label).toBe(false);
    expect(result.finalFiles.shm, label).toBe(false);

    if (crashStep < 5) {
      // Steps 1-4 crashing must leave a real, resumable DELETING row right
      // after the crash (this is the "failures leave the workspace
      // resumable" guarantee).
      expect(result.rowAfterCrashExists, label).toBe(true);
      expect(result.rowAfterCrashStatus, label).toBe("DELETING");
    } else {
      // Step 5 crashing means nothing was left to interrupt — the row is
      // already gone by then.
      expect(result.rowAfterCrashExists, label).toBe(false);
    }

    if (crashStep <= 3) {
      // Before step 4 runs, the file and both companions must still be
      // fully intact — nothing is deleted until step 4 specifically.
      expect(result.filesAfterCrash.main, label).toBe(true);
      expect(result.filesAfterCrash.wal, label).toBe(true);
      expect(result.filesAfterCrash.shm, label).toBe(true);
    } else {
      // By the time a crash happens after step 4 or step 5, step 4 has
      // already deleted the main file AND both companions — a partial
      // deletion (e.g. main removed but a companion forgotten) would fail
      // this.
      expect(result.filesAfterCrash.main, label).toBe(false);
      expect(result.filesAfterCrash.wal, label).toBe(false);
      expect(result.filesAfterCrash.shm, label).toBe(false);
    }
  }
});

test("retrying the full deletion protocol on an already-deleted workspace is idempotent and mutates nothing further", async () => {
  const result = (await runHarness("idempotent-retry-full-deletion")) as {
    rowCountAfterFirst: number;
    filesAfterFirst: { main: boolean; wal: boolean; shm: boolean };
    secondThrew: boolean;
    rowCountAfterSecond: number;
    filesAfterSecond: { main: boolean; wal: boolean; shm: boolean };
  };

  expect(result.rowCountAfterFirst).toBe(0);
  expect(result.filesAfterFirst.main).toBe(false);
  expect(result.filesAfterFirst.wal).toBe(false);
  expect(result.filesAfterFirst.shm).toBe(false);
  expect(result.secondThrew).toBe(false);
  expect(result.rowCountAfterSecond).toBe(0);
  expect(result.filesAfterSecond.main).toBe(false);
  expect(result.filesAfterSecond.wal).toBe(false);
  expect(result.filesAfterSecond.shm).toBe(false);
});

test("running the startup reconciliation scan twice with nothing to reconcile is a genuine no-op, not merely non-throwing", async () => {
  const result = (await runHarness("idempotent-reconcile-scan-twice")) as {
    firstResultsLength: number;
    secondResultsLength: number;
    rowAfterFirstStatus: string | null;
    filesAfterFirst: { main: boolean; wal: boolean; shm: boolean };
    rowAfterSecondStatus: string | null;
    filesAfterSecond: { main: boolean; wal: boolean; shm: boolean };
  };

  expect(result.firstResultsLength).toBe(0);
  expect(result.secondResultsLength).toBe(0);
  expect(result.rowAfterFirstStatus).toBe("ACTIVE");
  expect(result.filesAfterFirst.main).toBe(true);
  expect(result.filesAfterFirst.wal).toBe(true);
  expect(result.filesAfterFirst.shm).toBe(true);
  expect(result.rowAfterSecondStatus).toBe("ACTIVE");
  expect(result.filesAfterSecond.main).toBe(true);
  expect(result.filesAfterSecond.wal).toBe(true);
  expect(result.filesAfterSecond.shm).toBe(true);
});

test("startup reconciliation never touches an ACTIVE workspace's row or file, only the DELETING one", async () => {
  const result = (await runHarness("active-rows-never-silently-deleted")) as {
    activeRowExists: boolean;
    activeRowStatus: string | null;
    activeWrappedDekIsNull: boolean | null;
    activeFiles: { main: boolean; wal: boolean; shm: boolean };
    deletingRowExists: boolean;
    deletingFiles: { main: boolean; wal: boolean; shm: boolean };
  };

  expect(result.activeRowExists).toBe(true);
  expect(result.activeRowStatus).toBe("ACTIVE");
  expect(result.activeWrappedDekIsNull).toBe(false);
  expect(result.activeFiles.main).toBe(true);
  expect(result.activeFiles.wal).toBe(true);
  expect(result.activeFiles.shm).toBe(true);

  expect(result.deletingRowExists).toBe(false);
  expect(result.deletingFiles.main).toBe(false);
  expect(result.deletingFiles.wal).toBe(false);
  expect(result.deletingFiles.shm).toBe(false);
});

test("startup reconciliation never deletes an orphaned file that has no matching registry row", async () => {
  const result = (await runHarness("orphan-file-never-silently-deleted")) as {
    orphanFiles: { main: boolean; wal: boolean; shm: boolean };
    deletingRowExists: boolean;
    deletingFiles: { main: boolean; wal: boolean; shm: boolean };
  };

  expect(result.orphanFiles.main).toBe(true);
  expect(result.orphanFiles.wal).toBe(true);
  expect(result.orphanFiles.shm).toBe(true);

  expect(result.deletingRowExists).toBe(false);
  expect(result.deletingFiles.main).toBe(false);
  expect(result.deletingFiles.wal).toBe(false);
  expect(result.deletingFiles.shm).toBe(false);
});

test("resources are closed before the key is nulled, and the key is nulled before the file is deleted", async () => {
  const result = (await runHarness("ordering-close-then-key-then-file")) as Record<
    string,
    unknown
  > & {
    filesAfterStep2: { main: boolean; wal: boolean; shm: boolean };
    filesAfterStep3: { main: boolean; wal: boolean; shm: boolean };
    filesAfterStep4: { main: boolean; wal: boolean; shm: boolean };
  };

  expect(result["statusAfterStep1"]).toBe("DELETING");
  expect(result["closeCallsAfterStep2"]).toEqual(expect.arrayContaining([expect.any(String)]));
  expect((result["closeCallsAfterStep2"] as string[]).length).toBe(1);

  // Proves the close is genuinely awaited, not fire-and-forget: this can
  // only be true if runDeletionProtocol suspended at
  // `await deps.closeWorkspaceResources(...)` until the real macrotask
  // boundary (setTimeout) fired. Fails if `await` is removed in
  // deletion-reconciler.ts, since step 2's hook would then run
  // synchronously before the timer ever has a chance to fire.
  expect(result["asyncCloseCompletedAtStep2"]).toBe(true);

  expect(result["wrappedDekNullAfterStep2"]).toBe(false);
  expect(result.filesAfterStep2.main).toBe(true);
  expect(result.filesAfterStep2.wal).toBe(true);
  expect(result.filesAfterStep2.shm).toBe(true);

  expect(result["wrappedDekNullAfterStep3"]).toBe(true);
  expect(result["fileExistsAfterStep3"]).toBe(true);
  expect(result.filesAfterStep3.main).toBe(true);
  expect(result.filesAfterStep3.wal).toBe(true);
  expect(result.filesAfterStep3.shm).toBe(true);

  expect(result["fileExistsAfterStep4"]).toBe(false);
  expect(result.filesAfterStep4.main).toBe(false);
  expect(result.filesAfterStep4.wal).toBe(false);
  expect(result.filesAfterStep4.shm).toBe(false);
});

test("deleting a workspace never touches the shared registry-level DEK", async () => {
  const result = (await runHarness("registry-level-dek-untouched")) as {
    registryKeyUnchanged: boolean;
  };

  expect(result.registryKeyUnchanged).toBe(true);
});

test("a malformed workspace id is rejected before any registry mutation or filesystem access", async () => {
  const result = (await runHarness("path-safety-rejects-malformed-id")) as {
    threw: boolean;
    rowCountBefore: number;
    rowCountAfter: number;
    escapedFileExists: boolean;
  };

  expect(result.threw).toBe(true);
  expect(result.rowCountAfter).toBe(result.rowCountBefore);
  expect(result.escapedFileExists).toBe(false);
});

test("a target file already missing when a retry runs is handled idempotently, not as an error", async () => {
  const result = (await runHarness("missing-file-during-retry-is-idempotent")) as {
    crashed: boolean;
    retryThrew: boolean;
    finalRowExists: boolean;
  };

  expect(result.crashed).toBe(true);
  expect(result.retryThrew).toBe(false);
  expect(result.finalRowExists).toBe(false);
});

test("no key, path, or sensitive value is ever written to console output, including during a failure", async () => {
  const result = (await runHarness("no-sensitive-console-output")) as {
    consoleCallCount: number;
    consoleCalls: string[];
  };

  expect(result.consoleCallCount).toBe(0);
});
