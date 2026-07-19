import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import DatabaseCtor, { type Database as DatabaseInstance } from "better-sqlite3";
import {
  createTempUserDataDir,
  type TempUserDataHandle,
} from "../../../src/main/persistence/temp-user-data";
import {
  openRegistryDatabase,
  openWorkspaceDatabase,
  resolveUserDataPathOverride,
  assertValidWorkspaceId,
  assertPathIsStrictDescendant,
  BUSY_TIMEOUT_MS,
} from "../../../src/main/persistence/db-connection";
import * as registrySchemaModule from "../../../src/main/persistence/registry-schema";
import * as workspaceSchemaModule from "../../../src/main/persistence/workspace-schema";

// Integration tests for T018-T020 (data-model.md, research.md #1/#10/#13),
// including the remediation pass covering path-traversal safety, SQLite
// runtime type enforcement, sequence bounds, failure-safe initialization,
// Windows path semantics, and WAL/SHM permission robustness. Every test uses
// a fresh temporary directory (never the real userData path — reusing T010's
// isolation helper) and closes its connection(s) in afterEach. Synthetic
// data only (constitution Principle VI).

const isPosix = process.platform !== "win32";
const VALID_WORKSPACE_ID = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";

function synthetic(byteValue: number, length = 16): Buffer {
  return Buffer.alloc(length, byteValue);
}

function hmacLike(byteValue: number): Buffer {
  return Buffer.alloc(32, byteValue);
}

describe("registry.sqlite schema and connection (T018, T020)", () => {
  let tempDir: TempUserDataHandle;
  let db: DatabaseInstance;

  beforeEach(() => {
    tempDir = createTempUserDataDir();
    db = openRegistryDatabase(tempDir.path);
  });

  afterEach(() => {
    db.close();
    tempDir.cleanup();
  });

  it("creates registry.sqlite under the given userData directory, not the real userData path", () => {
    const dbPath = join(tempDir.path, "registry.sqlite");
    expect(existsSync(dbPath)).toBe(true);
  });

  it("enables WAL mode", () => {
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("enables foreign key enforcement", () => {
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("configures the documented busy timeout", () => {
    expect(db.pragma("busy_timeout", { simple: true })).toBe(BUSY_TIMEOUT_MS);
  });

  it.runIf(isPosix)("creates the userData directory with mode 0700 on POSIX", () => {
    const mode = statSync(tempDir.path).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it.runIf(isPosix)(
    "creates registry.sqlite, its -wal, and its -shm with mode 0600 on POSIX immediately after open",
    () => {
      const dbPath = join(tempDir.path, "registry.sqlite");
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      expect(existsSync(`${dbPath}-shm`)).toBe(true);
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      expect(statSync(`${dbPath}-wal`).mode & 0o777).toBe(0o600);
      expect(statSync(`${dbPath}-shm`).mode & 0o777).toBe(0o600);
    },
  );

  it.runIf(isPosix)(
    "keeps registry.sqlite -wal/-shm at mode 0600 after a later write through the same connection",
    () => {
      const dbPath = join(tempDir.path, "registry.sqlite");
      db.prepare("INSERT INTO registry_key (id, wrapped_dek) VALUES (1, ?)").run(synthetic(0xaa));
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      expect(statSync(`${dbPath}-wal`).mode & 0o777).toBe(0o600);
      expect(statSync(`${dbPath}-shm`).mode & 0o777).toBe(0o600);
    },
  );

  it.runIf(isPosix)(
    "keeps registry.sqlite -wal/-shm at mode 0600 after a full checkpoint + close + reopen cycle",
    () => {
      db.prepare("INSERT INTO registry_key (id, wrapped_dek) VALUES (1, ?)").run(synthetic(0xaa));
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();

      // Reassign so afterEach's db.close() operates on the fresh handle.
      db = openRegistryDatabase(tempDir.path);
      db.prepare("UPDATE registry_key SET wrapped_dek = ? WHERE id = 1").run(synthetic(0xbb));

      const dbPath = join(tempDir.path, "registry.sqlite");
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      expect(statSync(`${dbPath}-wal`).mode & 0o777).toBe(0o600);
      expect(statSync(`${dbPath}-shm`).mode & 0o777).toBe(0o600);
    },
  );

  it("enforces the RegistryKey singleton constraint (id must be 1, only one row ever)", () => {
    db.prepare("INSERT INTO registry_key (id, wrapped_dek) VALUES (1, ?)").run(synthetic(0xaa));
    expect(() =>
      db.prepare("INSERT INTO registry_key (id, wrapped_dek) VALUES (2, ?)").run(synthetic(0xbb)),
    ).toThrow();
    expect(() =>
      db.prepare("INSERT INTO registry_key (id, wrapped_dek) VALUES (1, ?)").run(synthetic(0xcc)),
    ).toThrow();
  });

  it("rejects a duplicate normalized_name_hmac on Workspace", () => {
    const insert = db.prepare(
      "INSERT INTO workspace (id, name_ciphertext, normalized_name_hmac, status, wrapped_dek) VALUES (?, ?, ?, 'ACTIVE', ?)",
    );
    insert.run("workspace-a", synthetic(1), hmacLike(0x10), synthetic(2));
    expect(() => insert.run("workspace-b", synthetic(3), hmacLike(0x10), synthetic(4))).toThrow();
  });

  it("rejects an invalid Workspace.status value", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO workspace (id, name_ciphertext, normalized_name_hmac, status, wrapped_dek) VALUES (?, ?, ?, 'BOGUS', ?)",
        )
        .run("workspace-c", synthetic(1), hmacLike(0x20), synthetic(2)),
    ).toThrow();
  });

  it("rejects a NULL wrapped_dek unless status is DELETING (lifecycle constraint)", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO workspace (id, name_ciphertext, normalized_name_hmac, status, wrapped_dek) VALUES (?, ?, ?, 'ACTIVE', NULL)",
        )
        .run("workspace-d", synthetic(1), hmacLike(0x30)),
    ).toThrow();

    expect(() =>
      db
        .prepare(
          "INSERT INTO workspace (id, name_ciphertext, normalized_name_hmac, status, wrapped_dek) VALUES (?, ?, ?, 'DELETING', NULL)",
        )
        .run("workspace-e", synthetic(1), hmacLike(0x31)),
    ).not.toThrow();
  });

  it("re-running the migration on an existing database is idempotent and preserves data", () => {
    db.prepare("INSERT INTO registry_key (id, wrapped_dek) VALUES (1, ?)").run(synthetic(0xaa));
    db.close();

    const reopened = openRegistryDatabase(tempDir.path);
    const row = reopened.prepare("SELECT wrapped_dek FROM registry_key WHERE id = 1").get() as {
      wrapped_dek: Buffer;
    };
    expect(row.wrapped_dek.equals(synthetic(0xaa))).toBe(true);
    reopened.close();

    // afterEach will call db.close() again on the original handle; better-sqlite3
    // tolerates a double-close as a no-op, so re-assign to avoid a dangling ref.
    db = openRegistryDatabase(tempDir.path);
  });

  describe("SQLite runtime type/length enforcement (registry_key.wrapped_dek)", () => {
    it("rejects a TEXT value where a BLOB is required", () => {
      expect(() =>
        db.prepare("INSERT INTO registry_key (id, wrapped_dek) VALUES (1, 'not-a-blob')").run(),
      ).toThrow();
    });

    it("rejects an empty blob", () => {
      expect(() =>
        db.prepare("INSERT INTO registry_key (id, wrapped_dek) VALUES (1, ?)").run(Buffer.alloc(0)),
      ).toThrow();
    });

    it("accepts a non-empty blob", () => {
      expect(() =>
        db.prepare("INSERT INTO registry_key (id, wrapped_dek) VALUES (1, ?)").run(synthetic(0xaa)),
      ).not.toThrow();
    });
  });

  describe("SQLite runtime type/length enforcement (workspace)", () => {
    it("rejects a TEXT value for name_ciphertext", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO workspace (id, name_ciphertext, normalized_name_hmac, status, wrapped_dek) VALUES (?, 'plaintext-name', ?, 'ACTIVE', ?)",
          )
          .run("workspace-f", hmacLike(0x60), synthetic(1)),
      ).toThrow();
    });

    it("rejects an empty blob for name_ciphertext", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO workspace (id, name_ciphertext, normalized_name_hmac, status, wrapped_dek) VALUES (?, ?, ?, 'ACTIVE', ?)",
          )
          .run("workspace-g", Buffer.alloc(0), hmacLike(0x61), synthetic(1)),
      ).toThrow();
    });

    it("rejects a normalized_name_hmac that is not exactly 32 bytes", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO workspace (id, name_ciphertext, normalized_name_hmac, status, wrapped_dek) VALUES (?, ?, ?, 'ACTIVE', ?)",
          )
          .run("workspace-h", synthetic(1), synthetic(0x62, 16), synthetic(1)),
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO workspace (id, name_ciphertext, normalized_name_hmac, status, wrapped_dek) VALUES (?, ?, ?, 'ACTIVE', ?)",
          )
          .run("workspace-i", synthetic(1), synthetic(0x63, 33), synthetic(1)),
      ).toThrow();
    });

    it("rejects a TEXT value for wrapped_dek when non-null", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO workspace (id, name_ciphertext, normalized_name_hmac, status, wrapped_dek) VALUES (?, ?, ?, 'ACTIVE', 'not-a-blob')",
          )
          .run("workspace-j", synthetic(1), hmacLike(0x64)),
      ).toThrow();
    });

    it("rejects an empty blob for wrapped_dek when non-null", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO workspace (id, name_ciphertext, normalized_name_hmac, status, wrapped_dek) VALUES (?, ?, ?, 'ACTIVE', ?)",
          )
          .run("workspace-k", synthetic(1), hmacLike(0x65), Buffer.alloc(0)),
      ).toThrow();
    });

    it("accepts correctly-typed blob values", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO workspace (id, name_ciphertext, normalized_name_hmac, status, wrapped_dek) VALUES (?, ?, ?, 'ACTIVE', ?)",
          )
          .run("workspace-l", synthetic(1), hmacLike(0x66), synthetic(2)),
      ).not.toThrow();
    });
  });
});

describe("per-workspace schema and connection (T019, T020)", () => {
  let tempDir: TempUserDataHandle;
  let db: DatabaseInstance;

  beforeEach(() => {
    tempDir = createTempUserDataDir();
    db = openWorkspaceDatabase(tempDir.path, VALID_WORKSPACE_ID);
  });

  afterEach(() => {
    db.close();
    tempDir.cleanup();
  });

  it("creates <workspaceId>.sqlite under <userDataDir>/workspaces/, not the real userData path", () => {
    const dbPath = join(tempDir.path, "workspaces", `${VALID_WORKSPACE_ID}.sqlite`);
    expect(existsSync(dbPath)).toBe(true);
  });

  it("enables WAL mode, foreign keys, and the documented busy timeout", () => {
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(BUSY_TIMEOUT_MS);
  });

  it.runIf(isPosix)(
    "creates the workspaces directory, db file, -wal, and -shm with 0700/0600 on POSIX immediately after open",
    () => {
      const dbPath = join(tempDir.path, "workspaces", `${VALID_WORKSPACE_ID}.sqlite`);
      const dirMode = statSync(join(tempDir.path, "workspaces")).mode & 0o777;
      expect(dirMode).toBe(0o700);
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      expect(existsSync(`${dbPath}-shm`)).toBe(true);
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      expect(statSync(`${dbPath}-wal`).mode & 0o777).toBe(0o600);
      expect(statSync(`${dbPath}-shm`).mode & 0o777).toBe(0o600);
    },
  );

  it.runIf(isPosix)(
    "keeps -wal/-shm at mode 0600 after a later write and after a checkpoint+close+reopen cycle",
    () => {
      const dbPath = join(tempDir.path, "workspaces", `${VALID_WORKSPACE_ID}.sqlite`);

      db.prepare("INSERT INTO prefix (id, value, next_sequence) VALUES (1, 'BANK', 1)").run();
      expect(statSync(`${dbPath}-wal`).mode & 0o777).toBe(0o600);
      expect(statSync(`${dbPath}-shm`).mode & 0o777).toBe(0o600);

      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
      db = openWorkspaceDatabase(tempDir.path, VALID_WORKSPACE_ID);
      db.prepare("INSERT INTO prefix (id, value, next_sequence) VALUES (2, 'CUST', 1)").run();

      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      expect(statSync(`${dbPath}-wal`).mode & 0o777).toBe(0o600);
      expect(statSync(`${dbPath}-shm`).mode & 0o777).toBe(0o600);
    },
  );

  it("enforces foreign key constraints (rejects a Placeholder referencing a non-existent Prefix)", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO placeholder (id, prefix_id, sequence, rendered_value) VALUES (1, 999, 1, 'X_1')",
        )
        .run(),
    ).toThrow();
  });

  it("enforces Prefix.value uniqueness", () => {
    db.prepare("INSERT INTO prefix (id, value, next_sequence) VALUES (1, 'BANK', 1)").run();
    expect(() =>
      db.prepare("INSERT INTO prefix (id, value, next_sequence) VALUES (2, 'BANK', 1)").run(),
    ).toThrow();
  });

  it("enforces Placeholder.rendered_value uniqueness and (prefix_id, sequence) uniqueness", () => {
    db.prepare("INSERT INTO prefix (id, value, next_sequence) VALUES (1, 'BANK', 2)").run();
    db.prepare(
      "INSERT INTO placeholder (id, prefix_id, sequence, rendered_value) VALUES (1, 1, 1, 'BANK_1')",
    ).run();

    expect(() =>
      db
        .prepare(
          "INSERT INTO placeholder (id, prefix_id, sequence, rendered_value) VALUES (2, 1, 1, 'BANK_2')",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO placeholder (id, prefix_id, sequence, rendered_value) VALUES (3, 1, 2, 'BANK_1')",
        )
        .run(),
    ).toThrow();
  });

  it("rejects a Placeholder.sequence of zero or negative", () => {
    db.prepare("INSERT INTO prefix (id, value, next_sequence) VALUES (1, 'BANK', 1)").run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO placeholder (id, prefix_id, sequence, rendered_value) VALUES (1, 1, 0, 'BANK_0')",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO placeholder (id, prefix_id, sequence, rendered_value) VALUES (2, 1, -1, 'BANK_NEG')",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO placeholder (id, prefix_id, sequence, rendered_value) VALUES (3, 1, 1, 'BANK_1')",
        )
        .run(),
    ).not.toThrow();
  });

  it("stores Term.original_value only as ciphertext and normalized_lookup_hmac only as a blind index (no plaintext columns exist)", () => {
    const columns = db.prepare("PRAGMA table_info(term)").all() as Array<{ name: string }>;
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).toContain("original_value_ciphertext");
    expect(columnNames).toContain("normalized_lookup_hmac");
    expect(columnNames).not.toContain("original_value");
    expect(columnNames).not.toContain("normalized_lookup");
  });

  it("rejects a Term with policy=ALWAYS and no placeholder_id", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO term (id, original_value_ciphertext, normalized_lookup_hmac, policy, placeholder_id) VALUES (1, ?, ?, 'ALWAYS', NULL)",
        )
        .run(synthetic(1), hmacLike(0x40)),
    ).toThrow();
  });

  it("allows a Term with policy=NEVER and no placeholder_id (never been ALWAYS)", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO term (id, original_value_ciphertext, normalized_lookup_hmac, policy, placeholder_id) VALUES (1, ?, ?, 'NEVER', NULL)",
        )
        .run(synthetic(1), hmacLike(0x41)),
    ).not.toThrow();
  });

  it("allows a Term with policy=NEVER and a retained historical placeholder_id", () => {
    db.prepare("INSERT INTO prefix (id, value, next_sequence) VALUES (1, 'BANK', 2)").run();
    db.prepare(
      "INSERT INTO placeholder (id, prefix_id, sequence, rendered_value) VALUES (1, 1, 1, 'BANK_1')",
    ).run();

    expect(() =>
      db
        .prepare(
          "INSERT INTO term (id, original_value_ciphertext, normalized_lookup_hmac, policy, placeholder_id) VALUES (1, ?, ?, 'NEVER', 1)",
        )
        .run(synthetic(1), hmacLike(0x42)),
    ).not.toThrow();
  });

  it("rejects is_principal set on a Term with no placeholder_id", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO term (id, original_value_ciphertext, normalized_lookup_hmac, policy, placeholder_id, is_principal) VALUES (1, ?, ?, 'NEVER', NULL, 1)",
        )
        .run(synthetic(1), hmacLike(0x43)),
    ).toThrow();
  });

  it("rejects an invalid Term.policy value", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO term (id, original_value_ciphertext, normalized_lookup_hmac, policy, placeholder_id) VALUES (1, ?, ?, 'MAYBE', NULL)",
        )
        .run(synthetic(1), hmacLike(0x44)),
    ).toThrow();
  });

  describe("SQLite runtime type/length enforcement (term)", () => {
    it("rejects a TEXT value for original_value_ciphertext", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO term (id, original_value_ciphertext, normalized_lookup_hmac, policy, placeholder_id) VALUES (1, 'plaintext', ?, 'NEVER', NULL)",
          )
          .run(hmacLike(0x70)),
      ).toThrow();
    });

    it("rejects an empty blob for original_value_ciphertext", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO term (id, original_value_ciphertext, normalized_lookup_hmac, policy, placeholder_id) VALUES (1, ?, ?, 'NEVER', NULL)",
          )
          .run(Buffer.alloc(0), hmacLike(0x71)),
      ).toThrow();
    });

    it("rejects a normalized_lookup_hmac that is not exactly 32 bytes", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO term (id, original_value_ciphertext, normalized_lookup_hmac, policy, placeholder_id) VALUES (1, ?, ?, 'NEVER', NULL)",
          )
          .run(synthetic(1), synthetic(0x72, 31)),
      ).toThrow();
    });
  });

  it("stores PendingDecision.candidate only as ciphertext, with a unique blind index and no foreign key to Term/Placeholder", () => {
    const columns = db.prepare("PRAGMA table_info(pending_decision)").all() as Array<{
      name: string;
    }>;
    const foreignKeys = db.prepare("PRAGMA foreign_key_list(pending_decision)").all();
    expect(columns.map((c) => c.name)).toContain("candidate_ciphertext");
    expect(columns.map((c) => c.name)).not.toContain("candidate");
    expect(foreignKeys).toEqual([]);

    db.prepare(
      "INSERT INTO pending_decision (id, candidate_ciphertext, normalized_candidate_hmac) VALUES (1, ?, ?)",
    ).run(synthetic(1), hmacLike(0x50));
    expect(() =>
      db
        .prepare(
          "INSERT INTO pending_decision (id, candidate_ciphertext, normalized_candidate_hmac) VALUES (2, ?, ?)",
        )
        .run(synthetic(2), hmacLike(0x50)),
    ).toThrow();
  });

  describe("SQLite runtime type/length enforcement (pending_decision)", () => {
    it("rejects a TEXT value for candidate_ciphertext", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO pending_decision (id, candidate_ciphertext, normalized_candidate_hmac) VALUES (1, 'plaintext', ?)",
          )
          .run(hmacLike(0x80)),
      ).toThrow();
    });

    it("rejects a normalized_candidate_hmac that is not exactly 32 bytes", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO pending_decision (id, candidate_ciphertext, normalized_candidate_hmac) VALUES (1, ?, ?)",
          )
          .run(synthetic(1), synthetic(0x81, 40)),
      ).toThrow();
    });
  });

  it("re-running the migration on an existing workspace database is idempotent and preserves data", () => {
    db.prepare("INSERT INTO prefix (id, value, next_sequence) VALUES (1, 'BANK', 5)").run();
    db.close();

    const reopened = openWorkspaceDatabase(tempDir.path, VALID_WORKSPACE_ID);
    const row = reopened.prepare("SELECT next_sequence FROM prefix WHERE value = 'BANK'").get() as {
      next_sequence: number;
    };
    expect(row.next_sequence).toBe(5);
    reopened.close();

    db = openWorkspaceDatabase(tempDir.path, VALID_WORKSPACE_ID);
  });
});

describe("workspace ID validation and path-traversal safety (remediation item 1)", () => {
  let tempDir: TempUserDataHandle;

  beforeEach(() => {
    tempDir = createTempUserDataDir();
  });

  afterEach(() => {
    tempDir.cleanup();
  });

  it("accepts a valid canonical UUID and opens the expected file", () => {
    const db = openWorkspaceDatabase(tempDir.path, VALID_WORKSPACE_ID);
    expect(existsSync(join(tempDir.path, "workspaces", `${VALID_WORKSPACE_ID}.sqlite`))).toBe(true);
    db.close();
  });

  const maliciousOrMalformedIds = [
    "../../../etc/passwd",
    "..\\..\\windows\\system32\\config",
    "/etc/passwd",
    "C:\\Windows\\System32\\config",
    "%2e%2e%2fetc%2fpasswd",
    "....//....//etc/passwd",
    `${VALID_WORKSPACE_ID}/../../../etc/passwd`,
    `${VALID_WORKSPACE_ID}.sqlite`,
    `${VALID_WORKSPACE_ID};DROP TABLE workspace;--`,
    VALID_WORKSPACE_ID.toUpperCase(),
    "11111111-1111-4111-8111", // too short / missing segment
    "11111111111141118111111111111111", // no hyphens
    "1111111-1111-4111-8111-111111111111", // wrong segment length
    "11111111-1111-4111-8111-1111111111111", // trailing extra hex digit
    "11111111-1111-4111-8111-11111111111g", // non-hex character
    "",
    "   ",
    `  ${VALID_WORKSPACE_ID}  `,
  ];

  it.each(maliciousOrMalformedIds)("rejects malicious/malformed workspace ID: %j", (badId) => {
    expect(() => openWorkspaceDatabase(tempDir.path, badId)).toThrow();
  });

  it.each(maliciousOrMalformedIds)("assertValidWorkspaceId rejects: %j", (badId) => {
    expect(() => assertValidWorkspaceId(badId)).toThrow();
  });

  it("assertValidWorkspaceId accepts a valid canonical UUID", () => {
    expect(() => assertValidWorkspaceId(VALID_WORKSPACE_ID)).not.toThrow();
  });

  describe("assertPathIsStrictDescendant (defense-in-depth, independent of ID validation)", () => {
    it("accepts a genuine descendant path", () => {
      expect(() =>
        assertPathIsStrictDescendant(
          join(tempDir.path, "workspaces"),
          join(tempDir.path, "workspaces", "valid.sqlite"),
        ),
      ).not.toThrow();
    });

    it("rejects a path that resolves outside the parent directory", () => {
      expect(() =>
        assertPathIsStrictDescendant(
          join(tempDir.path, "workspaces"),
          join(tempDir.path, "other", "evil.sqlite"),
        ),
      ).toThrow();
    });

    it("rejects the parent directory itself (not a strict descendant)", () => {
      expect(() =>
        assertPathIsStrictDescendant(
          join(tempDir.path, "workspaces"),
          join(tempDir.path, "workspaces"),
        ),
      ).toThrow();
    });

    it("rejects a sibling directory that merely shares a name prefix", () => {
      expect(() =>
        assertPathIsStrictDescendant(
          join(tempDir.path, "workspaces"),
          join(tempDir.path, "workspaces-evil", "x.sqlite"),
        ),
      ).toThrow();
    });
  });
});

describe("failure-safe database initialization (remediation item 4)", () => {
  let tempDir: TempUserDataHandle;

  beforeEach(() => {
    tempDir = createTempUserDataDir();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    tempDir.cleanup();
  });

  it("closes the connection and rethrows the original error if registry migration fails", () => {
    const syntheticError = new Error("synthetic migration failure — test only");
    const migrateSpy = vi
      .spyOn(registrySchemaModule, "migrateRegistrySchema")
      .mockImplementation(() => {
        throw syntheticError;
      });
    const closeSpy = vi.spyOn(DatabaseCtor.prototype, "close");

    expect(() => openRegistryDatabase(tempDir.path)).toThrow(syntheticError);
    expect(closeSpy).toHaveBeenCalledTimes(1);

    migrateSpy.mockRestore();
  });

  it("closes the connection and rethrows the original error if workspace migration fails", () => {
    const syntheticError = new Error("synthetic migration failure — test only");
    const migrateSpy = vi
      .spyOn(workspaceSchemaModule, "migrateWorkspaceSchema")
      .mockImplementation(() => {
        throw syntheticError;
      });
    const closeSpy = vi.spyOn(DatabaseCtor.prototype, "close");

    expect(() => openWorkspaceDatabase(tempDir.path, VALID_WORKSPACE_ID)).toThrow(syntheticError);
    expect(closeSpy).toHaveBeenCalledTimes(1);

    migrateSpy.mockRestore();
  });

  it("does not leave a locked file behind after a failed initialization — a subsequent open succeeds", () => {
    const syntheticError = new Error("synthetic migration failure — test only");
    const migrateSpy = vi
      .spyOn(registrySchemaModule, "migrateRegistrySchema")
      .mockImplementationOnce(() => {
        throw syntheticError;
      });

    expect(() => openRegistryDatabase(tempDir.path)).toThrow(syntheticError);
    migrateSpy.mockRestore();

    // If the failed attempt had leaked an open handle/lock, this would hang
    // or throw a busy/locked error instead of succeeding.
    const db = openRegistryDatabase(tempDir.path);
    expect(db.open).toBe(true);
    db.close();
  });
});

describe("platform-appropriate userData path resolution (T020, remediation item 5)", () => {
  it("returns undefined on macOS/POSIX (no override — Electron's own default applies)", () => {
    expect(
      resolveUserDataPathOverride({ platform: "darwin", appName: "Solari AI Sanitizer" }),
    ).toBeUndefined();
    expect(
      resolveUserDataPathOverride({ platform: "linux", appName: "Solari AI Sanitizer" }),
    ).toBeUndefined();
  });

  it("resolves a genuine Windows-style backslash path under %LOCALAPPDATA%, tested from any host OS", () => {
    const resolved = resolveUserDataPathOverride({
      platform: "win32",
      appName: "Solari AI Sanitizer",
      localAppData: "C:\\Users\\synthetic-user\\AppData\\Local",
    });
    expect(resolved).toBe("C:\\Users\\synthetic-user\\AppData\\Local\\Solari AI Sanitizer");
    expect(resolved).toContain("\\");
    expect(resolved).not.toContain("/");
  });

  it("never resolves under the roaming %APPDATA% location", () => {
    const resolved = resolveUserDataPathOverride({
      platform: "win32",
      appName: "Solari AI Sanitizer",
      localAppData: "C:\\Users\\synthetic-user\\AppData\\Local",
    });
    expect(resolved).not.toContain("Roaming");
    expect(resolved).toContain("Local");
  });

  it("falls back to homeDirectory\\AppData\\Local (win32 join) when localAppData is not supplied", () => {
    const resolved = resolveUserDataPathOverride({
      platform: "win32",
      appName: "Solari AI Sanitizer",
      homeDirectory: "C:\\Users\\synthetic-user",
    });
    expect(resolved).toBe("C:\\Users\\synthetic-user\\AppData\\Local\\Solari AI Sanitizer");
  });
});
