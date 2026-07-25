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

    try {
      if (!app.isPackaged) {
        const markerPath = process.env["SOLARI_TEST_STARTUP_MARKER_PATH"];
        if (markerPath) {
          appendFileSync(markerPath, `${process.pid}\n`);
        }
      }

      registryDb = openRegistryDatabase(userDataDir);
      const keyManager = buildKeyManager();

      // Fail-fast startup validation (research.md #10 "Database opening &
      // failure behavior"): confirms the registry DEK is available before
      // continuing. Its result is intentionally not retained — every
      // domain call re-derives it via getOrCreateRegistryDek/
      // loadExistingRegistryDek, exactly like create.ts/open.ts already do,
      // so no raw key material lives in this module's memory for longer
      // than this one check.
      await getOrCreateRegistryDek(registryDb, keyManager);

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

      registerWorkspaceIpcHandlers(
        ipcMain,
        buildWorkspaceHandlerDeps(registryDb, userDataDir, keyManager),
      );

      mainWindow = createWindow();
    } catch (err) {
      // Fail closed (constitution Principle V "without compromise"): never
      // continue into a half-initialized state with no working registry
      // access, and never leave an open connection dangling on the way out.
      // Never logs the raw error (constitution Principle I) — only a safe,
      // closed-vocabulary category/code. The close itself is best-effort and
      // guarded: a throw from .close() must never prevent the safe log or
      // app.quit() below from running.
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
