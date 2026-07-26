import { app, BrowserWindow, ipcMain } from "electron";
import { appendFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { createTempUserDataDir } from "./persistence/temp-user-data";
import {
  openRegistryDatabase,
  openWorkspaceDatabase,
  openExistingWorkspaceDatabase,
  resolveUserDataPathOverride,
} from "./persistence/db-connection";
import { reconcileDeletingWorkspacesOnStartup } from "./persistence/deletion-reconciler";
import {
  wrapRegistryDek,
  unwrapRegistryDek,
  wrapWorkspaceDek,
  unwrapWorkspaceDek,
  type KeyManager,
} from "./persistence/key-manager";
import { getOrCreateRegistryDek } from "../domain/workspace/registry-dek";
import { createWorkspace } from "../domain/workspace/create";
import { openWorkspace } from "../domain/workspace/open";
import { registerWorkspaceIpcHandlers, type WorkspaceHandlerDeps } from "./ipc/workspace-handlers";
import { logSafeEvent, redactUnknownError } from "./logging/redact";

// Main-process startup sequence (T042; research.md #14; data-model.md's
// Workspace deletion state machine). Ordering is enforced, not just
// documented: single-instance lock -> registry.sqlite open -> registry DEK
// unwrap -> startup deletion reconciliation -> workspace IPC handlers ->
// BrowserWindow creation. A second launch attempt that fails to acquire the
// lock quits before any of these steps runs, so it never opens SQLite, never
// touches safeStorage, and never starts a worker (research.md #14's own
// required proof).

if (app.isPackaged) {
  // Production (research.md #10 "Platform-appropriate application-data
  // locations"): Windows gets an explicit %LOCALAPPDATA% override so
  // userData never lands in a roaming profile; every other platform keeps
  // Electron's own default (macOS: ~/Library/Application Support/<AppName>,
  // already correct with no change needed).
  const packagedOverride = resolveUserDataPathOverride({
    platform: process.platform,
    appName: app.getName(),
  });
  if (packagedOverride) {
    app.setPath("userData", packagedOverride);
  }
} else {
  // Dev/test-only isolated userData path (research.md #10; T010). This must
  // run BEFORE requestSingleInstanceLock() below, even though lock
  // acquisition is otherwise the very first startup action (research.md
  // #14): the lock itself is scoped by the current userData path, so
  // tests/integration/single-instance.spec.ts can only exercise real lock
  // contention by forcing two processes to share one directory via
  // SOLARI_TEST_USER_DATA_DIR — see research.md #14's own documented,
  // narrow, production-inert exception for this. This whole branch never
  // runs once packaged.
  const overrideUserDataDir = process.env["SOLARI_TEST_USER_DATA_DIR"];
  app.setPath("userData", overrideUserDataDir ?? createTempUserDataDir().path);
}

// Fixed, closed-vocabulary startup-phase diagnostic tokens (research.md
// #14's test-observability paragraph). Test/dev-only observability for
// diagnosing the confirmed Windows crash-restart failure without exposing
// any raw error, message, stack, path, key, or content — only ever one of
// these literal tokens is written, never a caller-supplied string.
const STARTUP_PHASE_TOKENS = [
  "POST_LOCK_OK",
  "REGISTRY_OPEN_OK",
  "REGISTRY_DEK_OK",
  "RECONCILIATION_OK",
  "IPC_REGISTRATION_OK",
  "WINDOW_CREATED_OK",
  "FAIL_REGISTRY_OPEN",
  "FAIL_REGISTRY_DEK",
  "FAIL_RECONCILIATION",
  "FAIL_IPC_REGISTRATION",
  "FAIL_WINDOW_CREATION",
] as const;
type StartupPhaseToken = (typeof STARTUP_PHASE_TOKENS)[number];

// Appends exactly one closed-vocabulary token to
// SOLARI_TEST_STARTUP_PHASE_MARKER_PATH — separate from, and never altering,
// the existing SOLARI_TEST_STARTUP_MARKER_PATH PID marker above. No-op
// unless !app.isPackaged and the env var is set, so this never runs in a
// packaged build. `token`'s type is the closed StartupPhaseToken union, not
// `string` and not `unknown`/`Error`, so passing an arbitrary string or an
// error object is a compile-time type error, not something this function
// could accept and forward at runtime. A write failure here is swallowed
// rather than thrown, so this test-only diagnostic can never prevent the
// real fail-closed startup path below from logging its safe event and
// calling app.quit().
function appendStartupPhaseMarker(token: StartupPhaseToken): void {
  if (app.isPackaged) return;
  const phaseMarkerPath = process.env["SOLARI_TEST_STARTUP_PHASE_MARKER_PATH"];
  if (!phaseMarkerPath) return;
  // Re-validates membership even though the parameter type already
  // guarantees it, the same defense-in-depth pattern redact.ts's
  // assertSafeLogEvent applies to a branded SafeId — catches a bad-faith
  // `as StartupPhaseToken` cast that bypassed the type system.
  if (!(STARTUP_PHASE_TOKENS as readonly string[]).includes(token)) return;
  try {
    appendFileSync(phaseMarkerPath, `${token}\n`);
  } catch {
    /* best-effort test-only diagnostic; must never affect startup behavior */
  }
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "..", "..", "preload", "index.js"),
    },
  });

  if (process.env["VITE_DEV_SERVER_URL"]) {
    void win.loadURL(process.env["VITE_DEV_SERVER_URL"]);
  } else {
    void win.loadFile(path.join(__dirname, "..", "..", "renderer", "index.html"));
  }

  return win;
}

function buildKeyManager(): KeyManager {
  return { wrapRegistryDek, unwrapRegistryDek, wrapWorkspaceDek, unwrapWorkspaceDek };
}

function buildWorkspaceHandlerDeps(
  registryDb: Database.Database,
  userDataDir: string,
  keyManager: KeyManager,
): WorkspaceHandlerDeps {
  return {
    createWorkspace: (name) =>
      createWorkspace(
        {
          registryDb,
          createWorkspaceFile: (id) => openWorkspaceDatabase(userDataDir, id),
          keyManager,
        },
        name,
      ),
    openWorkspace: (id) =>
      openWorkspace(
        {
          registryDb,
          openExistingWorkspaceFile: (wsId) => openExistingWorkspaceDatabase(userDataDir, wsId),
          keyManager,
        },
        id,
      ),
  };
}

// Single-instance enforcement (research.md #14): the first "real" startup
// action (see the documented test/dev exception above). A `false` return
// means this process is a redundant second launch — it quits immediately,
// before ever opening registry.sqlite, unwrapping any key, or creating a
// window.
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  // Registered as soon as the lock is confirmed held, before whenReady(),
  // per research.md #14's "Focus behavior": a later redundant launch
  // attempt focuses (and restores, if minimized) this process's existing
  // window rather than opening a second one.
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    // Test-only observability hook (tests/integration/single-instance.spec.ts):
    // proves the post-lock initialization sequence below — where
    // registry.sqlite is opened, the registry DEK is unwrapped, and startup
    // reconciliation runs — genuinely never begins in a process that failed
    // to acquire the lock (that process quits above, before this callback is
    // ever reached). A no-op unless both !app.isPackaged and the env var are
    // set; never present in a packaged build.
    const userDataDir = app.getPath("userData");
    let registryDb: Database.Database | undefined;
    // Tracks which fixed failure token corresponds to the stage currently
    // executing, so the catch below can append exactly one closed-vocabulary
    // token identifying that stage — never a raw error (research.md #14).
    let currentFailureToken: StartupPhaseToken = "FAIL_REGISTRY_OPEN";

    try {
      appendStartupPhaseMarker("POST_LOCK_OK");

      if (!app.isPackaged) {
        const markerPath = process.env["SOLARI_TEST_STARTUP_MARKER_PATH"];
        if (markerPath) {
          appendFileSync(markerPath, `${process.pid}\n`);
        }
      }

      registryDb = openRegistryDatabase(userDataDir);
      appendStartupPhaseMarker("REGISTRY_OPEN_OK");
      currentFailureToken = "FAIL_REGISTRY_DEK";

      const keyManager = buildKeyManager();

      // Fail-fast startup validation (research.md #10 "Database opening &
      // failure behavior"): confirms the registry DEK is available before
      // continuing. Its result is intentionally not retained — every
      // domain call re-derives it via getOrCreateRegistryDek/
      // loadExistingRegistryDek, exactly like create.ts/open.ts already do,
      // so no raw key material lives in this module's memory for longer
      // than this one check.
      await getOrCreateRegistryDek(registryDb, keyManager);
      appendStartupPhaseMarker("REGISTRY_DEK_OK");
      currentFailureToken = "FAIL_RECONCILIATION";

      const workspacesDir = path.join(userDataDir, "workspaces");
      await reconcileDeletingWorkspacesOnStartup({
        registryDb,
        workspacesDir,
        // No open connections or workers exist yet at this point in
        // startup (worker-manager.ts, which will later track those, is not
        // implemented in this task range) — a no-op close is exactly what
        // deletion-reconciler.ts's own contract requires for this case.
        closeWorkspaceResources: () => undefined,
      });
      appendStartupPhaseMarker("RECONCILIATION_OK");
      currentFailureToken = "FAIL_IPC_REGISTRATION";

      registerWorkspaceIpcHandlers(
        ipcMain,
        buildWorkspaceHandlerDeps(registryDb, userDataDir, keyManager),
      );
      appendStartupPhaseMarker("IPC_REGISTRATION_OK");
      currentFailureToken = "FAIL_WINDOW_CREATION";

      mainWindow = createWindow();
      appendStartupPhaseMarker("WINDOW_CREATED_OK");
    } catch (err) {
      // Fail closed (constitution Principle V "without compromise"): never
      // continue into a half-initialized state with no working registry
      // access, and never leave an open connection dangling on the way out.
      // Never logs the raw error (constitution Principle I) — only a safe,
      // closed-vocabulary category/code. The close itself is best-effort and
      // guarded: a throw from .close() must never prevent the safe log or
      // app.quit() below from running. The phase-marker append is similarly
      // best-effort (research.md #14) and must never prevent it either.
      appendStartupPhaseMarker(currentFailureToken);
      try {
        registryDb?.close();
      } catch {
        /* best-effort cleanup only */
      }
      logSafeEvent(redactUnknownError(err, { category: "PERSISTENCE", code: "UNKNOWN_ERROR" }));
      app.quit();
    }
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
