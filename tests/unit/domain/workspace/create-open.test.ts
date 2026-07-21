import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import {
  createTempUserDataDir,
  type TempUserDataHandle,
} from "../../../../src/main/persistence/temp-user-data";
import {
  openRegistryDatabase,
  openWorkspaceDatabase,
  openExistingWorkspaceDatabase,
} from "../../../../src/main/persistence/db-connection";
import {
  createKeyManager,
  type KeyManager,
  type SafeStorageLike,
} from "../../../../src/main/persistence/key-manager";
import { createWorkspace, type CreateWorkspaceDeps } from "../../../../src/domain/workspace/create";
import { openWorkspace, type OpenWorkspaceDeps } from "../../../../src/domain/workspace/open";
import { WorkspaceError } from "../../../../src/domain/workspace/workspace-error";

// Unit tests for T032 (FR-WORKSPACE-001/003; constitution Principle VI).
// Real temporary SQLite files (never the real userData path), and a fake
// injected safeStorage (never the real Electron runtime) — the same
// established patterns as tests/unit/main/persistence-schema.test.ts and
// tests/unit/main/key-manager.test.ts. Synthetic names/values only.

function createFakeSafeStorage(overrides: Partial<SafeStorageLike> = {}): SafeStorageLike & {
  encryptStringAsync: ReturnType<typeof vi.fn>;
  decryptStringAsync: ReturnType<typeof vi.fn>;
  isAsyncEncryptionAvailable: ReturnType<typeof vi.fn>;
} {
  const store = new Map<string, string>();
  let counter = 0;
  return {
    isAsyncEncryptionAvailable: vi.fn().mockResolvedValue(true),
    encryptStringAsync: vi.fn().mockImplementation(async (plainText: string) => {
      const token = `token-${counter++}`;
      store.set(token, plainText);
      return Buffer.from(token, "utf8");
    }),
    decryptStringAsync: vi.fn().mockImplementation(async (encrypted: Buffer) => {
      const token = encrypted.toString("utf8");
      const result = store.get(token);
      if (result === undefined) {
        throw new Error("synthetic fake safeStorage: unknown token");
      }
      return { result, shouldReEncrypt: false };
    }),
    ...overrides,
  } as SafeStorageLike & {
    encryptStringAsync: ReturnType<typeof vi.fn>;
    decryptStringAsync: ReturnType<typeof vi.fn>;
    isAsyncEncryptionAvailable: ReturnType<typeof vi.fn>;
  };
}

describe("domain/workspace create + open (T032)", () => {
  let tempDir: TempUserDataHandle;
  let registryDb: DatabaseInstance;
  let fakeSafeStorage: ReturnType<typeof createFakeSafeStorage>;
  let keyManager: KeyManager;
  let openedWorkspaceFiles: DatabaseInstance[];

  function createDeps(): CreateWorkspaceDeps {
    return {
      registryDb,
      keyManager,
      createWorkspaceFile: (workspaceId: string) => {
        const db = openWorkspaceDatabase(tempDir.path, workspaceId);
        openedWorkspaceFiles.push(db);
        return db;
      },
    };
  }

  function openDeps(): OpenWorkspaceDeps {
    return {
      registryDb,
      keyManager,
      openExistingWorkspaceFile: (workspaceId: string) => {
        const db = openExistingWorkspaceDatabase(tempDir.path, workspaceId);
        openedWorkspaceFiles.push(db);
        return db;
      },
    };
  }

  beforeEach(() => {
    tempDir = createTempUserDataDir();
    registryDb = openRegistryDatabase(tempDir.path);
    fakeSafeStorage = createFakeSafeStorage();
    keyManager = createKeyManager(fakeSafeStorage);
    openedWorkspaceFiles = [];
  });

  afterEach(() => {
    for (const db of openedWorkspaceFiles) {
      if (db.open) db.close();
    }
    if (registryDb.open) registryDb.close();
    tempDir.cleanup();
  });

  describe("create", () => {
    it("creates a workspace with synthetic data and returns its id and name", async () => {
      const result = await createWorkspace(createDeps(), "Synthetic Acme Consultoria");
      expect(result.name).toBe("Synthetic Acme Consultoria");
      expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("stores name_ciphertext rather than the plaintext name", async () => {
      const result = await createWorkspace(createDeps(), "Synthetic Beta Holdings");
      const row = registryDb
        .prepare("SELECT name_ciphertext FROM workspace WHERE id = ?")
        .get(result.id) as { name_ciphertext: Buffer };

      expect(Buffer.isBuffer(row.name_ciphertext)).toBe(true);
      expect(row.name_ciphertext.toString("utf8")).not.toContain("Synthetic Beta Holdings");
      expect(row.name_ciphertext.toString("base64")).not.toContain("Synthetic Beta Holdings");
    });

    it("computes a deterministic 32-byte blind index for the normalized name", async () => {
      const result = await createWorkspace(createDeps(), "Synthetic Gamma");
      const row = registryDb
        .prepare("SELECT normalized_name_hmac FROM workspace WHERE id = ?")
        .get(result.id) as { normalized_name_hmac: Buffer };

      expect(Buffer.isBuffer(row.normalized_name_hmac)).toBe(true);
      expect(row.normalized_name_hmac.length).toBe(32);
    });

    it("rejects a second workspace whose name is a case/diacritic/whitespace variant of an existing one", async () => {
      await createWorkspace(createDeps(), "Synthetic Ácme  Corp");

      await expect(createWorkspace(createDeps(), "  synthetic acme corp ")).rejects.toMatchObject({
        code: "DUPLICATE_NAME",
      });
    });

    it("rejects an exact duplicate name", async () => {
      await createWorkspace(createDeps(), "Synthetic Delta");
      await expect(createWorkspace(createDeps(), "Synthetic Delta")).rejects.toMatchObject({
        code: "DUPLICATE_NAME",
      });
    });

    it("assigns a unique workspace id and an isolated database path per workspace", async () => {
      const first = await createWorkspace(createDeps(), "Synthetic Epsilon One");
      const second = await createWorkspace(createDeps(), "Synthetic Epsilon Two");

      expect(first.id).not.toBe(second.id);

      const workspacesDir = join(tempDir.path, "workspaces");
      expect(existsSync(join(workspacesDir, `${first.id}.sqlite`))).toBe(true);
      expect(existsSync(join(workspacesDir, `${second.id}.sqlite`))).toBe(true);
    });

    it("persists a wrapped workspace DEK, never the raw DEK, on the registry row", async () => {
      const result = await createWorkspace(createDeps(), "Synthetic Zeta");
      const row = registryDb
        .prepare("SELECT wrapped_dek FROM workspace WHERE id = ?")
        .get(result.id) as { wrapped_dek: Buffer };

      expect(Buffer.isBuffer(row.wrapped_dek)).toBe(true);
      expect(row.wrapped_dek.length).toBeGreaterThan(0);
      // The fake safeStorage's wrap output is a short opaque token, never a
      // 32-byte buffer or its Base64 form appearing anywhere raw.
      expect(row.wrapped_dek.toString("utf8")).toMatch(/^token-/);
    });

    it("creates and persists the registry DEK on first use, and reuses it for a second workspace", async () => {
      await createWorkspace(createDeps(), "Synthetic Eta");
      const afterFirst = registryDb
        .prepare("SELECT wrapped_dek FROM registry_key WHERE id = 1")
        .get() as { wrapped_dek: Buffer } | undefined;
      expect(afterFirst).toBeDefined();

      await createWorkspace(createDeps(), "Synthetic Theta");
      const afterSecond = registryDb
        .prepare("SELECT wrapped_dek FROM registry_key WHERE id = 1")
        .get() as {
        wrapped_dek: Buffer;
      };

      // Same registry DEK row reused (not regenerated) for the second create.
      expect(afterSecond.wrapped_dek.equals(afterFirst!.wrapped_dek)).toBe(true);
    });

    it("fails closed with REGISTRY_KEY_UNAVAILABLE when the registry DEK cannot be created, and inserts no workspace row", async () => {
      keyManager = createKeyManager(
        createFakeSafeStorage({ isAsyncEncryptionAvailable: vi.fn().mockResolvedValue(false) }),
      );

      await expect(createWorkspace(createDeps(), "Synthetic Iota")).rejects.toMatchObject({
        code: "REGISTRY_KEY_UNAVAILABLE",
      });

      const count = registryDb.prepare("SELECT COUNT(*) as n FROM workspace").get() as {
        n: number;
      };
      expect(count.n).toBe(0);
    });

    it("fails closed with WORKSPACE_KEY_UNAVAILABLE when wrapping the fresh workspace DEK fails, and inserts no workspace row", async () => {
      // The first encryptStringAsync call wraps the (not-yet-created)
      // registry DEK; only the second wraps the workspace's own fresh DEK —
      // that second call must fail here, not the first, or this would
      // exercise REGISTRY_KEY_UNAVAILABLE instead.
      const originalEncrypt = fakeSafeStorage.encryptStringAsync.getMockImplementation()!;
      let calls = 0;
      fakeSafeStorage.encryptStringAsync.mockImplementation(async (plainText: string) => {
        calls += 1;
        if (calls === 2) {
          throw new Error("synthetic keychain failure");
        }
        return originalEncrypt(plainText);
      });

      await expect(createWorkspace(createDeps(), "Synthetic Kappa")).rejects.toMatchObject({
        code: "WORKSPACE_KEY_UNAVAILABLE",
      });

      const count = registryDb.prepare("SELECT COUNT(*) as n FROM workspace").get() as {
        n: number;
      };
      expect(count.n).toBe(0);
    });

    it("closes the per-workspace file connection it opened, whether creation succeeds or fails", async () => {
      const deps = createDeps();
      await createWorkspace(deps, "Synthetic Lambda");
      expect(openedWorkspaceFiles.every((db) => !db.open)).toBe(true);
    });

    it("never writes to any console/stdio channel during a successful create", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        await createWorkspace(createDeps(), "Synthetic Mu Corp");
        expect(logSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        logSpy.mockRestore();
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });
  });

  describe("open", () => {
    it("reopens a workspace by id and returns the same identity and decrypted name", async () => {
      const created = await createWorkspace(createDeps(), "Synthetic Nu Enterprises");

      const opened = await openWorkspace(openDeps(), created.id);

      expect(opened.id).toBe(created.id);
      expect(opened.name).toBe("Synthetic Nu Enterprises");
    });

    it("fails closed with NOT_FOUND for a workspace id that was never created", async () => {
      await expect(
        openWorkspace(openDeps(), "11111111-2222-4333-8444-555555555555"),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("never creates a replacement per-workspace file when the workspace id does not exist", async () => {
      const openExistingWorkspaceFile = vi.fn();
      await expect(
        openWorkspace(
          { registryDb, keyManager, openExistingWorkspaceFile },
          "11111111-2222-4333-8444-555555555555",
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      expect(openExistingWorkspaceFile).not.toHaveBeenCalled();
    });

    it("fails closed with REGISTRY_KEY_UNAVAILABLE when the workspace's encrypted name cannot be decrypted", async () => {
      const created = await createWorkspace(createDeps(), "Synthetic Xi Group");

      // Corrupt the stored ciphertext so decryption genuinely fails.
      registryDb
        .prepare("UPDATE workspace SET name_ciphertext = ? WHERE id = ?")
        .run(Buffer.from("corrupted-not-a-real-token", "utf8"), created.id);

      await expect(openWorkspace(openDeps(), created.id)).rejects.toMatchObject({
        code: "REGISTRY_KEY_UNAVAILABLE",
      });
    });

    it("fails closed with WORKSPACE_KEY_UNAVAILABLE when this workspace's own wrapped_dek cannot be unwrapped, leaving other workspaces unaffected", async () => {
      const affected = await createWorkspace(createDeps(), "Synthetic Omicron");
      const unaffected = await createWorkspace(createDeps(), "Synthetic Pi Systems");

      registryDb
        .prepare("UPDATE workspace SET wrapped_dek = ? WHERE id = ?")
        .run(Buffer.from("corrupted-not-a-real-token", "utf8"), affected.id);

      await expect(openWorkspace(openDeps(), affected.id)).rejects.toMatchObject({
        code: "WORKSPACE_KEY_UNAVAILABLE",
      });

      const stillOpens = await openWorkspace(openDeps(), unaffected.id);
      expect(stillOpens.name).toBe("Synthetic Pi Systems");
    });

    it("persists the re-wrapped registry DEK when shouldReEncrypt is signaled, before returning a successfully opened workspace", async () => {
      const created = await createWorkspace(createDeps(), "Synthetic Rho Ltda");

      const before = registryDb
        .prepare("SELECT wrapped_dek FROM registry_key WHERE id = 1")
        .get() as {
        wrapped_dek: Buffer;
      };

      // Mutate the SAME fake instance already used by createWorkspace()
      // above (not a fresh createFakeSafeStorage()) — a new instance would
      // have its own empty in-memory wrap/unwrap store and could never
      // decrypt tokens the original instance produced.
      const originalDecrypt = fakeSafeStorage.decryptStringAsync.getMockImplementation()!;
      fakeSafeStorage.decryptStringAsync.mockImplementation(async (encrypted: Buffer) => {
        const decrypted = await originalDecrypt(encrypted);
        return { ...decrypted, shouldReEncrypt: true };
      });

      const opened = await openWorkspace(openDeps(), created.id);
      expect(opened.name).toBe("Synthetic Rho Ltda");

      const after = registryDb
        .prepare("SELECT wrapped_dek FROM registry_key WHERE id = 1")
        .get() as {
        wrapped_dek: Buffer;
      };
      expect(after.wrapped_dek.equals(before.wrapped_dek)).toBe(false);
    });

    it("fails the whole open() call if persisting the re-wrapped registry DEK fails, and never returns a raw key", async () => {
      const created = await createWorkspace(createDeps(), "Synthetic Sigma");

      // A registryDb whose UPDATE always fails simulates a persistence
      // failure during the re-wrap-and-persist step. Delegates every other
      // call to the real connection rather than spreading it (better-
      // sqlite3's Database methods live on the prototype, not as own
      // properties, so `{ ...registryDb }` would silently drop them).
      const failingRegistryDb = {
        prepare: (sql: string) => {
          if (sql.startsWith("UPDATE registry_key")) {
            return {
              run: () => {
                throw new Error("synthetic disk write failure");
              },
            };
          }
          return registryDb.prepare(sql);
        },
      } as unknown as DatabaseInstance;

      const originalDecrypt = fakeSafeStorage.decryptStringAsync.getMockImplementation()!;
      fakeSafeStorage.decryptStringAsync.mockImplementation(async (encrypted: Buffer) => {
        const decrypted = await originalDecrypt(encrypted);
        return { ...decrypted, shouldReEncrypt: true };
      });

      await expect(
        openWorkspace(
          {
            registryDb: failingRegistryDb,
            keyManager,
            openExistingWorkspaceFile: (id) => {
              const db = openExistingWorkspaceDatabase(tempDir.path, id);
              openedWorkspaceFiles.push(db);
              return db;
            },
          },
          created.id,
        ),
      ).rejects.toMatchObject({ code: "REGISTRY_KEY_UNAVAILABLE" });
    });

    it("closes the per-workspace file connection it opened to validate the workspace", async () => {
      const created = await createWorkspace(createDeps(), "Synthetic Tau");
      openedWorkspaceFiles = [];

      await openWorkspace(openDeps(), created.id);

      expect(openedWorkspaceFiles.length).toBe(1);
      expect(openedWorkspaceFiles[0]!.open).toBe(false);
    });

    it("never writes to any console/stdio channel, including on failure", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        await openWorkspace(openDeps(), "11111111-2222-4333-8444-555555555555").catch(
          () => undefined,
        );
        expect(logSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        logSpy.mockRestore();
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it("fails closed with WORKSPACE_DELETING for a workspace whose registry status is DELETING, without decrypting the name, unwrapping any key, or opening its file (defect 1)", async () => {
      const created = await createWorkspace(createDeps(), "Synthetic Upsilon Deleting");
      registryDb.prepare("UPDATE workspace SET status = 'DELETING' WHERE id = ?").run(created.id);

      const decryptCallsBefore = fakeSafeStorage.decryptStringAsync.mock.calls.length;
      const openExistingWorkspaceFile = vi.fn();

      await expect(
        openWorkspace({ registryDb, keyManager, openExistingWorkspaceFile }, created.id),
      ).rejects.toMatchObject({ code: "WORKSPACE_DELETING" });

      // No unwrap/decrypt call (registry or workspace DEK) beyond whatever
      // createWorkspace() itself already performed, and the per-workspace
      // file was never opened.
      expect(fakeSafeStorage.decryptStringAsync.mock.calls.length).toBe(decryptCallsBefore);
      expect(openExistingWorkspaceFile).not.toHaveBeenCalled();
    });

    it("fails and never recreates the file when an existing workspace's per-workspace .sqlite file has been deleted (defect 2)", async () => {
      const created = await createWorkspace(createDeps(), "Synthetic Phi Missing File");

      const lastOpened = openedWorkspaceFiles[openedWorkspaceFiles.length - 1]!;
      if (lastOpened.open) lastOpened.close();

      const dbPath = join(tempDir.path, "workspaces", `${created.id}.sqlite`);
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      expect(existsSync(dbPath)).toBe(false);

      await expect(openWorkspace(openDeps(), created.id)).rejects.toThrow();

      expect(existsSync(dbPath)).toBe(false);
    });

    it("fails closed with REGISTRY_KEY_UNAVAILABLE and inserts no replacement RegistryKey row when the singleton row is missing, without decrypting, unwrapping, or opening the file (defect 3)", async () => {
      const created = await createWorkspace(createDeps(), "Synthetic Chi Corp");

      registryDb.prepare("DELETE FROM registry_key WHERE id = 1").run();
      expect(registryDb.prepare("SELECT COUNT(*) as n FROM registry_key").get()).toEqual({ n: 0 });

      const decryptCallsBefore = fakeSafeStorage.decryptStringAsync.mock.calls.length;
      const openExistingWorkspaceFile = vi.fn();

      await expect(
        openWorkspace({ registryDb, keyManager, openExistingWorkspaceFile }, created.id),
      ).rejects.toMatchObject({ code: "REGISTRY_KEY_UNAVAILABLE" });

      const count = registryDb.prepare("SELECT COUNT(*) as n FROM registry_key").get() as {
        n: number;
      };
      expect(count.n).toBe(0);
      expect(fakeSafeStorage.decryptStringAsync.mock.calls.length).toBe(decryptCallsBefore);
      expect(openExistingWorkspaceFile).not.toHaveBeenCalled();
    });
  });

  describe("errors never leak sensitive content", () => {
    it("WorkspaceError messages never contain the workspace name", async () => {
      const secretName = "Synthetic Upsilon Confidential Client";
      await createWorkspace(createDeps(), secretName);

      let caught: unknown;
      try {
        await createWorkspace(createDeps(), secretName);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(WorkspaceError);
      const message = caught instanceof Error ? caught.message : String(caught);
      expect(message).not.toContain(secretName);
    });
  });
});
