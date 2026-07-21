import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, win32 as pathWin32 } from "node:path";
import { migrateRegistrySchema } from "./registry-schema";
import { migrateWorkspaceSchema } from "./workspace-schema";

// SQLite connection management (research.md #1, #10): WAL mode, foreign-key
// enforcement, a busy-timeout for transient same-process lock contention
// (research.md's own note that "multiple writers [proceed] via busy-timeout
// retries" under WAL), and platform-appropriate userData paths/permissions.
// No encryption/key-management logic lives here — callers own DEK wrap/unwrap
// (research.md #10, #13) and pass this module only already-open connections
// to work with.
//
// better-sqlite3 native module ABI: this module's native binding must be
// compiled against whichever Node.js runtime will load it, and that differs
// by consumer — Vitest runs under the plain configured Node.js runtime,
// while Electron (dev, Playwright e2e, and the packaged app) runs under the
// Node ABI bundled inside the pinned Electron release, which is a different
// NODE_MODULE_VERSION. There is exactly one on-disk binary at a time, so
// every entry point that needs a specific ABI ensures it for itself via an
// npm "pre<script>" hook (confirmed to run unconditionally before its main
// script, unlike "post<script>", which npm does NOT run if the main script
// exits non-zero — verified directly, not assumed):
//   - `npm test`      -> pretest      -> `npm run rebuild:native:node`
//     (`npm rebuild better-sqlite3`, targets whatever Node is running npm)
//   - `npm run test:e2e` -> pretest:e2e -> `npm run rebuild:native:electron`
//   - `npm run package`  -> prepackage  -> `npm run rebuild:native:electron`
//   - `npm run dev:electron` also runs rebuild:native:electron first
//   - `postinstall` (after every `npm ci`/`npm install`) also runs
//     rebuild:native:electron, so the default post-install state is
//     Electron-ready (the most common next action).
// `rebuild:native:electron` uses `electron-rebuild --force` (the
// `@electron/rebuild` CLI), not `electron-builder install-app-deps`: the
// latter has an internal staleness cache and was verified (via a real
// Electron main-process load, not just `ELECTRON_RUN_AS_NODE`, which is not
// a reliable proxy for this) to sometimes skip rebuilding after an external
// `npm rebuild` changed the binary underneath it, silently leaving a
// wrong-ABI binary in place. `--force` bypasses that cache unconditionally.

// No specific value is mandated by research.md/data-model.md; 5s is a
// conservative default for a single local user, well above the sub-second
// cost of this schema's small (≤10,000-row) tables, and defense-in-depth
// against transient contention that the single-instance lock (research.md
// #14) does not eliminate within one process (e.g. a WAL checkpoint
// overlapping a statement).
export const BUSY_TIMEOUT_MS = 5000;

const REGISTRY_FILE_NAME = "registry.sqlite";
const WORKSPACES_DIR_NAME = "workspaces";

// Workspace IDs are used to build filesystem paths (data-model.md: "id | uuid,
// PK"). Accepting an arbitrary string here would let a caller-supplied value
// escape the workspaces directory (path traversal, absolute-path override,
// encoded separators, etc.) — so every workspace ID is validated against a
// strict canonical (lowercase, RFC 4122 textual form) UUID shape before it
// ever touches a path or filesystem call. This is a security boundary, not a
// formatting preference: canonical form is required, not merely "UUID-like".
const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertValidWorkspaceId(workspaceId: string): void {
  if (!CANONICAL_UUID_PATTERN.test(workspaceId)) {
    throw new Error("Workspace ID must be a canonical UUID");
  }
}

/**
 * Defense-in-depth behind assertValidWorkspaceId(): independent of whether
 * the ID validation above is correct or complete, this confirms the actual
 * resolved database path never ends up outside the resolved workspaces
 * directory before any file is opened.
 */
export function assertPathIsStrictDescendant(parentDir: string, candidatePath: string): void {
  const resolvedParent = resolve(parentDir);
  const resolvedCandidate = resolve(candidatePath);
  const rel = relative(resolvedParent, resolvedCandidate);

  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Resolved database path escapes the expected directory");
  }
}

function ensureDirectory(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
  if (process.platform !== "win32") {
    // Explicit at creation time — never rely on the umask alone
    // (research.md #10 "Filesystem permissions"). No Windows ACL
    // manipulation: that platform relies on default per-user-profile ACL
    // inheritance under %LOCALAPPDATA% instead (research.md #10). No global
    // process umask change: this targets only the directories/files this
    // module itself creates, not every file the process ever writes.
    chmodSync(dirPath, 0o700);
  }
}

function restrictFilePermissionsIfExists(filePath: string): void {
  if (process.platform !== "win32" && existsSync(filePath)) {
    chmodSync(filePath, 0o600);
  }
}

function restrictDatabaseFilePermissions(dbPath: string): void {
  restrictFilePermissionsIfExists(dbPath);
  restrictFilePermissionsIfExists(`${dbPath}-wal`);
  restrictFilePermissionsIfExists(`${dbPath}-shm`);
}

function configureConnection(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
}

/**
 * Opens (creating if necessary) registry.sqlite under the given userData
 * directory, applies WAL/foreign-key/busy-timeout pragmas, runs the
 * idempotent schema migration, and restricts file permissions on POSIX.
 * Closes the connection before rethrowing if any step after open fails, so a
 * failed initialization never leaves an open handle or locked file behind.
 */
export function openRegistryDatabase(userDataDir: string): Database.Database {
  ensureDirectory(userDataDir);
  const dbPath = join(userDataDir, REGISTRY_FILE_NAME);

  const db = new Database(dbPath);
  try {
    // Chmod the main file to 0600 before WAL mode is enabled / before the
    // first write: SQLite's unix VFS creates new -wal/-shm files inheriting
    // the main file's permission bits, so restricting it first means those
    // sibling files are born restricted rather than created world-readable
    // and fixed up afterward (verified empirically — see
    // restrictDatabaseFilePermissions below for the belt-and-suspenders
    // re-assertion after migration, which also covers SQLite versions or
    // platforms that do not inherit permissions this way).
    restrictFilePermissionsIfExists(dbPath);
    configureConnection(db);
    migrateRegistrySchema(db);
    restrictDatabaseFilePermissions(dbPath);
  } catch (err) {
    db.close();
    throw err;
  }

  return db;
}

/**
 * Opens (creating if necessary) <workspaceId>.sqlite under
 * <userDataDir>/workspaces/, applies WAL/foreign-key/busy-timeout pragmas,
 * runs the idempotent schema migration, and restricts file permissions on
 * POSIX. Validates workspaceId as a canonical UUID and defensively confirms
 * the resolved path stays inside the workspaces directory before any file is
 * opened. Closes the connection before rethrowing if any step after open
 * fails, so a failed initialization never leaves an open handle or locked
 * file behind.
 */
export function openWorkspaceDatabase(userDataDir: string, workspaceId: string): Database.Database {
  assertValidWorkspaceId(workspaceId);

  const workspacesDir = join(userDataDir, WORKSPACES_DIR_NAME);
  ensureDirectory(workspacesDir);
  const dbPath = join(workspacesDir, `${workspaceId}.sqlite`);
  assertPathIsStrictDescendant(workspacesDir, dbPath);

  const db = new Database(dbPath);
  try {
    restrictFilePermissionsIfExists(dbPath);
    configureConnection(db);
    migrateWorkspaceSchema(db);
    restrictDatabaseFilePermissions(dbPath);
  } catch (err) {
    db.close();
    throw err;
  }

  return db;
}

/**
 * Opens an *existing* <workspaceId>.sqlite under <userDataDir>/workspaces/
 * — never creates the workspaces directory or the database file itself
 * (T032-T037 remediation, defect 2). Validates workspaceId as a canonical
 * UUID and defensively confirms the resolved path stays inside the
 * workspaces directory before any filesystem check, exactly like
 * openWorkspaceDatabase. Throws if the file does not already exist, before
 * ever constructing a better-sqlite3 Database (which would otherwise create
 * it). Applies the same WAL/foreign-key/busy-timeout pragmas, idempotent
 * schema migration, and permission restriction as openWorkspaceDatabase for
 * a database that does exist, and closes the connection before rethrowing
 * if any step after open fails.
 */
export function openExistingWorkspaceDatabase(
  userDataDir: string,
  workspaceId: string,
): Database.Database {
  assertValidWorkspaceId(workspaceId);

  const workspacesDir = join(userDataDir, WORKSPACES_DIR_NAME);
  const dbPath = join(workspacesDir, `${workspaceId}.sqlite`);
  assertPathIsStrictDescendant(workspacesDir, dbPath);

  if (!existsSync(dbPath)) {
    throw new Error("Workspace database does not exist");
  }

  const db = new Database(dbPath);
  try {
    restrictFilePermissionsIfExists(dbPath);
    configureConnection(db);
    migrateWorkspaceSchema(db);
    restrictDatabaseFilePermissions(dbPath);
  } catch (err) {
    db.close();
    throw err;
  }

  return db;
}

/**
 * Computes the Windows userData override path under %LOCALAPPDATA%
 * (research.md #10 "Platform-appropriate application-data locations").
 * Returns undefined on every other platform, meaning "no override — use
 * Electron's own default" (macOS: `~/Library/Application Support/<AppName>`,
 * already correct with no change needed).
 *
 * Always builds the Windows path with node:path's win32 API (backslash
 * separators), regardless of the host OS actually running this code — using
 * the host-native `path` module here would silently produce a POSIX-style
 * path when computing a *hypothetical* Windows path on a macOS/Linux
 * development or CI machine, which is not a real Windows path at all. This
 * keeps the function itself host-platform-independent and testable for the
 * Windows case from any development machine.
 */
export function resolveUserDataPathOverride(options: {
  platform: NodeJS.Platform;
  appName: string;
  localAppData?: string;
  homeDirectory?: string;
}): string | undefined {
  if (options.platform !== "win32") {
    return undefined;
  }
  const base =
    options.localAppData ?? pathWin32.join(options.homeDirectory ?? homedir(), "AppData", "Local");
  return pathWin32.join(base, options.appName);
}
