import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { Database as DatabaseInstance } from "better-sqlite3";
import {
  createTempUserDataDir,
  type TempUserDataHandle,
} from "../../../../src/main/persistence/temp-user-data";
import { openRegistryDatabase } from "../../../../src/main/persistence/db-connection";
import { KeyManagerError, type KeyManager } from "../../../../src/main/persistence/key-manager";
import {
  getOrCreateRegistryDek,
  loadExistingRegistryDek,
} from "../../../../src/domain/workspace/registry-dek";
import { WorkspaceError } from "../../../../src/domain/workspace/workspace-error";

// Regression tests for the Windows registry-DEK crash-recovery fix
// (FR-WORKSPACE-007, SC-020; research.md #13's crash-recovery exception;
// plan.md's "Fifth Phase-1 revision re-check"; tasks.md T034 revision
// note). Written and confirmed to fail against the real, unmodified
// getOrCreateRegistryDek before this fix, per constitution Principle VI.
//
// A real temporary registry.sqlite (never the real userData path) provides
// genuine `registry_key`/`workspace` tables and real SQLite transaction
// semantics; a hand-built fake KeyManager (not routed through safeStorage)
// gives each test precise, independent control over wrap/unwrap
// success/failure without depending on key-manager.ts's own behavior.
// Synthetic data only throughout (constitution Principle VI).

const OLD_WRAPPED = Buffer.from("synthetic-old-wrapped-registry-dek");
const NEW_WRAPPED = Buffer.from("synthetic-new-wrapped-registry-dek");

function insertRegistryKeyRow(registryDb: DatabaseInstance, wrapped: Buffer): void {
  registryDb.prepare("INSERT INTO registry_key (id, wrapped_dek) VALUES (1, ?)").run(wrapped);
}

function readRegistryKeyRow(registryDb: DatabaseInstance): Buffer | undefined {
  const row = registryDb.prepare("SELECT wrapped_dek FROM registry_key WHERE id = 1").get() as
    { wrapped_dek: Buffer } | undefined;
  return row?.wrapped_dek;
}

function insertSyntheticWorkspace(
  registryDb: DatabaseInstance,
  status: "ACTIVE" | "DELETING",
): void {
  registryDb
    .prepare(
      `INSERT INTO workspace (id, name_ciphertext, normalized_name_hmac, status, wrapped_dek)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      `11111111-2222-4333-8444-${status === "ACTIVE" ? "555555555501" : "555555555502"}`,
      Buffer.from("synthetic-name-ciphertext"),
      randomBytes(32),
      status,
      status === "DELETING" ? null : Buffer.from("synthetic-workspace-wrapped-dek"),
    );
}

function countWorkspaceRows(registryDb: DatabaseInstance): number {
  return (registryDb.prepare("SELECT COUNT(*) as n FROM workspace").get() as { n: number }).n;
}

/** A KeyManager double whose four methods are independently controllable per test. */
function createFakeKeyManager(overrides: Partial<KeyManager> = {}): KeyManager {
  return {
    wrapRegistryDek: vi.fn().mockRejectedValue(new Error("not configured for this test")),
    unwrapRegistryDek: vi.fn().mockRejectedValue(new Error("not configured for this test")),
    wrapWorkspaceDek: vi.fn().mockRejectedValue(new Error("not configured for this test")),
    unwrapWorkspaceDek: vi.fn().mockRejectedValue(new Error("not configured for this test")),
    ...overrides,
  };
}

describe("domain/workspace registry-dek crash-recovery (FR-WORKSPACE-007, SC-020)", () => {
  let tempDir: TempUserDataHandle;
  let registryDb: DatabaseInstance;

  beforeEach(() => {
    tempDir = createTempUserDataDir();
    registryDb = openRegistryDatabase(tempDir.path);
  });

  afterEach(() => {
    if (registryDb.open) registryDb.close();
    tempDir.cleanup();
  });

  describe("getOrCreateRegistryDek: recovery when zero workspace rows exist", () => {
    it("recovers with a new 32-byte raw DEK and replaces the stored wrapped value", async () => {
      insertRegistryKeyRow(registryDb, OLD_WRAPPED);
      expect(countWorkspaceRows(registryDb)).toBe(0);

      const keyManager = createFakeKeyManager({
        unwrapRegistryDek: vi
          .fn()
          .mockRejectedValue(
            new KeyManagerError("REGISTRY_KEY_UNAVAILABLE", "synthetic: cannot unwrap"),
          ),
        wrapRegistryDek: vi.fn().mockResolvedValue(NEW_WRAPPED),
      });

      const rawDek = await getOrCreateRegistryDek(registryDb, keyManager);

      expect(Buffer.isBuffer(rawDek)).toBe(true);
      expect(rawDek.length).toBe(32);
      expect(keyManager.wrapRegistryDek).toHaveBeenCalledTimes(1);

      const stored = readRegistryKeyRow(registryDb);
      expect(stored?.equals(NEW_WRAPPED)).toBe(true);
      expect(stored?.equals(OLD_WRAPPED)).toBe(false);
    });
  });

  describe("getOrCreateRegistryDek: replacement wrapping fails", () => {
    it("fails closed and leaves the original wrapped value byte-for-byte unchanged", async () => {
      insertRegistryKeyRow(registryDb, OLD_WRAPPED);
      expect(countWorkspaceRows(registryDb)).toBe(0);

      const keyManager = createFakeKeyManager({
        unwrapRegistryDek: vi
          .fn()
          .mockRejectedValue(
            new KeyManagerError("REGISTRY_KEY_UNAVAILABLE", "synthetic: cannot unwrap"),
          ),
        wrapRegistryDek: vi
          .fn()
          .mockRejectedValue(
            new KeyManagerError("REGISTRY_KEY_UNAVAILABLE", "synthetic: wrap failed"),
          ),
      });

      await expect(getOrCreateRegistryDek(registryDb, keyManager)).rejects.toMatchObject({
        code: "REGISTRY_KEY_UNAVAILABLE",
      });

      const stored = readRegistryKeyRow(registryDb);
      expect(stored?.equals(OLD_WRAPPED)).toBe(true);
    });
  });

  describe("getOrCreateRegistryDek: refuses recovery when a workspace row exists", () => {
    it("returns REGISTRY_KEY_UNAVAILABLE with no wrap attempt when one ACTIVE workspace exists", async () => {
      insertRegistryKeyRow(registryDb, OLD_WRAPPED);
      insertSyntheticWorkspace(registryDb, "ACTIVE");
      expect(countWorkspaceRows(registryDb)).toBe(1);

      const keyManager = createFakeKeyManager({
        unwrapRegistryDek: vi
          .fn()
          .mockRejectedValue(
            new KeyManagerError("REGISTRY_KEY_UNAVAILABLE", "synthetic: cannot unwrap"),
          ),
      });

      await expect(getOrCreateRegistryDek(registryDb, keyManager)).rejects.toMatchObject({
        code: "REGISTRY_KEY_UNAVAILABLE",
      });

      expect(keyManager.wrapRegistryDek).not.toHaveBeenCalled();
      const stored = readRegistryKeyRow(registryDb);
      expect(stored?.equals(OLD_WRAPPED)).toBe(true);
    });

    it("returns REGISTRY_KEY_UNAVAILABLE with no wrap attempt when one DELETING workspace exists", async () => {
      insertRegistryKeyRow(registryDb, OLD_WRAPPED);
      insertSyntheticWorkspace(registryDb, "DELETING");
      expect(countWorkspaceRows(registryDb)).toBe(1);

      const keyManager = createFakeKeyManager({
        unwrapRegistryDek: vi
          .fn()
          .mockRejectedValue(
            new KeyManagerError("REGISTRY_KEY_UNAVAILABLE", "synthetic: cannot unwrap"),
          ),
      });

      await expect(getOrCreateRegistryDek(registryDb, keyManager)).rejects.toMatchObject({
        code: "REGISTRY_KEY_UNAVAILABLE",
      });

      expect(keyManager.wrapRegistryDek).not.toHaveBeenCalled();
      const stored = readRegistryKeyRow(registryDb);
      expect(stored?.equals(OLD_WRAPPED)).toBe(true);
    });
  });

  describe("getOrCreateRegistryDek: transactional recheck", () => {
    it("aborts replacement if a workspace row appears between the initial count and the recheck", async () => {
      insertRegistryKeyRow(registryDb, OLD_WRAPPED);
      expect(countWorkspaceRows(registryDb)).toBe(0);

      // Simulates a workspace being created concurrently while the recovery
      // path is awaiting the replacement wrap — the recheck inside the
      // transaction must still catch this and abort (defense in depth on
      // top of the single-instance lock, research.md #14).
      const keyManager = createFakeKeyManager({
        unwrapRegistryDek: vi
          .fn()
          .mockRejectedValue(
            new KeyManagerError("REGISTRY_KEY_UNAVAILABLE", "synthetic: cannot unwrap"),
          ),
        wrapRegistryDek: vi.fn().mockImplementation(async () => {
          insertSyntheticWorkspace(registryDb, "ACTIVE");
          return NEW_WRAPPED;
        }),
      });

      await expect(getOrCreateRegistryDek(registryDb, keyManager)).rejects.toMatchObject({
        code: "REGISTRY_KEY_UNAVAILABLE",
      });

      const stored = readRegistryKeyRow(registryDb);
      expect(stored?.equals(OLD_WRAPPED)).toBe(true);
      expect(stored?.equals(NEW_WRAPPED)).toBe(false);
    });

    it("aborts replacement if the singleton registry_key row disappears between the initial check and the recheck", async () => {
      insertRegistryKeyRow(registryDb, OLD_WRAPPED);
      expect(countWorkspaceRows(registryDb)).toBe(0);

      // Simulates the singleton row being deleted concurrently (e.g. by an
      // unrelated process) while the recovery path is awaiting the
      // replacement wrap — the recheck's `current === undefined` branch
      // must catch this and abort, per the ordering requirement that
      // replacement "fails closed if the singleton row changed or
      // disappeared unexpectedly."
      const keyManager = createFakeKeyManager({
        unwrapRegistryDek: vi
          .fn()
          .mockRejectedValue(
            new KeyManagerError("REGISTRY_KEY_UNAVAILABLE", "synthetic: cannot unwrap"),
          ),
        wrapRegistryDek: vi.fn().mockImplementation(async () => {
          registryDb.prepare("DELETE FROM registry_key WHERE id = 1").run();
          return NEW_WRAPPED;
        }),
      });

      await expect(getOrCreateRegistryDek(registryDb, keyManager)).rejects.toMatchObject({
        code: "REGISTRY_KEY_UNAVAILABLE",
      });

      // The row must remain deleted (as the concurrent mutation left it) —
      // recovery must never re-insert or overwrite it with NEW_WRAPPED.
      expect(readRegistryKeyRow(registryDb)).toBeUndefined();
    });

    it("aborts replacement if the singleton registry_key row's wrapped value changes to something else between the initial check and the recheck", async () => {
      insertRegistryKeyRow(registryDb, OLD_WRAPPED);
      expect(countWorkspaceRows(registryDb)).toBe(0);

      const CONCURRENTLY_WRAPPED = Buffer.from("synthetic-concurrently-wrapped-registry-dek");

      // Simulates the singleton row being re-wrapped by an unrelated
      // concurrent operation (not this recovery attempt) while the recovery
      // path is awaiting the replacement wrap — the recheck's
      // `!current.equals(previouslyWrapped)` branch must catch this and
      // abort, per the same ordering requirement as above.
      const keyManager = createFakeKeyManager({
        unwrapRegistryDek: vi
          .fn()
          .mockRejectedValue(
            new KeyManagerError("REGISTRY_KEY_UNAVAILABLE", "synthetic: cannot unwrap"),
          ),
        wrapRegistryDek: vi.fn().mockImplementation(async () => {
          registryDb
            .prepare("UPDATE registry_key SET wrapped_dek = ? WHERE id = 1")
            .run(CONCURRENTLY_WRAPPED);
          return NEW_WRAPPED;
        }),
      });

      await expect(getOrCreateRegistryDek(registryDb, keyManager)).rejects.toMatchObject({
        code: "REGISTRY_KEY_UNAVAILABLE",
      });

      // The row must remain exactly what the concurrent mutation left it as
      // — recovery must never overwrite it with NEW_WRAPPED.
      const stored = readRegistryKeyRow(registryDb);
      expect(stored?.equals(CONCURRENTLY_WRAPPED)).toBe(true);
      expect(stored?.equals(NEW_WRAPPED)).toBe(false);
    });
  });

  describe("loadExistingRegistryDek: remains strict even with zero workspace rows", () => {
    it("never recovers or replaces the key, even though no workspace exists", async () => {
      insertRegistryKeyRow(registryDb, OLD_WRAPPED);
      expect(countWorkspaceRows(registryDb)).toBe(0);

      const keyManager = createFakeKeyManager({
        unwrapRegistryDek: vi
          .fn()
          .mockRejectedValue(
            new KeyManagerError("REGISTRY_KEY_UNAVAILABLE", "synthetic: cannot unwrap"),
          ),
      });

      await expect(loadExistingRegistryDek(registryDb, keyManager)).rejects.toMatchObject({
        code: "REGISTRY_KEY_UNAVAILABLE",
      });

      expect(keyManager.wrapRegistryDek).not.toHaveBeenCalled();
      const stored = readRegistryKeyRow(registryDb);
      expect(stored?.equals(OLD_WRAPPED)).toBe(true);
    });
  });

  describe("getOrCreateRegistryDek: unexpected non-key errors never trigger recovery", () => {
    it("propagates an unrelated error unchanged and never attempts a wrap", async () => {
      insertRegistryKeyRow(registryDb, OLD_WRAPPED);
      expect(countWorkspaceRows(registryDb)).toBe(0);

      const keyManager = createFakeKeyManager({
        unwrapRegistryDek: vi
          .fn()
          .mockRejectedValue(new Error("synthetic unrelated programming bug")),
      });

      await expect(getOrCreateRegistryDek(registryDb, keyManager)).rejects.toThrow(
        "synthetic unrelated programming bug",
      );

      expect(keyManager.wrapRegistryDek).not.toHaveBeenCalled();
      const stored = readRegistryKeyRow(registryDb);
      expect(stored?.equals(OLD_WRAPPED)).toBe(true);
    });
  });

  describe("no sensitive data ever leaks via logs or thrown errors", () => {
    it("never writes to console during a successful recovery or a fail-closed refusal", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      try {
        insertRegistryKeyRow(registryDb, OLD_WRAPPED);
        const recoveringKeyManager = createFakeKeyManager({
          unwrapRegistryDek: vi
            .fn()
            .mockRejectedValue(new KeyManagerError("REGISTRY_KEY_UNAVAILABLE", "synthetic")),
          wrapRegistryDek: vi.fn().mockResolvedValue(NEW_WRAPPED),
        });
        await getOrCreateRegistryDek(registryDb, recoveringKeyManager);

        insertSyntheticWorkspace(registryDb, "ACTIVE");
        const refusingKeyManager = createFakeKeyManager({
          unwrapRegistryDek: vi
            .fn()
            .mockRejectedValue(new KeyManagerError("REGISTRY_KEY_UNAVAILABLE", "synthetic")),
        });
        await getOrCreateRegistryDek(registryDb, refusingKeyManager).catch(() => undefined);

        expect(logSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        logSpy.mockRestore();
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it("the fail-closed error message never contains the wrapped DEK bytes or the underlying exception message", async () => {
      insertRegistryKeyRow(registryDb, OLD_WRAPPED);
      insertSyntheticWorkspace(registryDb, "ACTIVE");

      const keyManager = createFakeKeyManager({
        unwrapRegistryDek: vi
          .fn()
          .mockRejectedValue(
            new KeyManagerError(
              "REGISTRY_KEY_UNAVAILABLE",
              "synthetic underlying detail that must never leak",
            ),
          ),
      });

      let caught: unknown;
      try {
        await getOrCreateRegistryDek(registryDb, keyManager);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(WorkspaceError);
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).not.toContain("synthetic underlying detail that must never leak");
      expect(message).not.toContain(OLD_WRAPPED.toString("utf8"));
    });
  });
});
