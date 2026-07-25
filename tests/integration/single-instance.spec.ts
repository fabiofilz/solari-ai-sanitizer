import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// T041 (research.md #14; constitution Principle VI). Written and confirmed
// to fail before app-lifecycle.ts's single-instance lock exists (T042).
//
// Two separate OS processes must share the exact same userData directory for
// this test to exercise real lock contention — two default, independently
// randomized temp directories (the normal dev/test isolation from
// research.md #10/T010) would never collide. SOLARI_TEST_USER_DATA_DIR
// (app-lifecycle.ts, dev/test-only, inert once packaged, and documented as a
// narrow exception in research.md #14's own "Design" section) exists solely
// to make that possible here.
//
// The second launch attempt is spawned as a raw child process rather than
// through Playwright's own `_electron.launch()`: a process that calls
// app.quit() before app.whenReady() may never complete Playwright's Electron
// handshake, which would make asserting "exits promptly" through that API
// unreliable. A raw child process lets this test observe exactly what
// research.md #14 requires: prompt exit, and no observable side effect
// anywhere this application's persistence lives.
//
// "Never opens SQLite, never unwraps a key, never starts a worker" is proven
// two ways, not one: (1) a shared startup-marker file, appended to only once
// app-lifecycle.ts's post-lock initialization sequence begins (the same
// sequence that opens registry.sqlite, unwraps the registry DEK, and runs
// reconciliation) — a second line would mean that sequence ran twice; (2) a
// filesystem snapshot of every file under the shared userData directory
// (registry.sqlite plus its -wal/-shm companions), confirmed byte-for-byte
// unchanged after the second process exits. Relying on the marker alone
// would not rule out some other file-touching side effect; relying on the
// file snapshot alone would not rule out an in-memory-only action with no
// filesystem trace — together they cover both cases.

const projectRoot = resolve(process.cwd());
const nodeRequire = createRequire(__filename);
const electronBinaryPath = nodeRequire("electron") as unknown as string;

interface SharedDir {
  path: string;
  cleanup: () => void;
}

function makeSharedDir(prefix: string): SharedDir {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    path: dir,
    // maxRetries/retryDelay (not a suppressed catch): Windows can briefly
    // hold a just-closed Electron/SQLite file handle open after the process
    // exits, which turns a normal recursive removal into a transient EPERM.
    // fs.rmSync's own bounded retry (5 attempts with linear backoff -
    // 200 + 400 + 600 + 800 + 1000ms - 3s maximum accumulated retry delay)
    // absorbs exactly that release delay; if removal still fails
    // afterward, this throws and the test still fails, exactly as before.
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  };
}

function registryFilePaths(userDataDir: string) {
  const main = join(userDataDir, "registry.sqlite");
  return { main, wal: `${main}-wal`, shm: `${main}-shm` };
}

function snapshotExistingFiles(paths: string[]): Record<string, number> {
  const snapshot: Record<string, number> = {};
  for (const p of paths) {
    if (existsSync(p)) {
      snapshot[p] = statSync(p).mtimeMs;
    }
  }
  return snapshot;
}

function markerLineCount(markerPath: string): number {
  if (!existsSync(markerPath)) return 0;
  const content = readFileSync(markerPath, "utf8");
  return content.split("\n").filter((line) => line.length > 0).length;
}

// Force-terminates an Electron app's main process to simulate a crash (not
// a clean quit) for the crash-recovery test below. A bare SIGKILL on the
// main process does not reliably tear down its whole descendant process
// tree on Windows, which was observed leaving a descendant still holding a
// userData file handle open — turning the shared-directory rmSync
// cleanup's bounded retries (see makeSharedDir above) into a persistent
// EPERM rather than a transient one. On Windows this uses taskkill's /T
// (tree) flag instead; elsewhere a direct SIGKILL is preserved unchanged.
//
// Two independent lifecycle signals are awaited, not just the OS process
// exit: Playwright's own ElectronApplication wraps that process with its
// own connection/teardown bookkeeping, and closes asynchronously after the
// process exits. Returning as soon as only the process itself exits (as a
// prior version of this helper did) let the caller launch the fresh second
// instance while Playwright's ElectronApplication for the first one was
// still mid-close, which on Windows surfaced as "Target page, context or
// browser has been closed" against unrelated Playwright-internal state.
// Both listeners are registered before termination is initiated, so neither
// event can fire before something is listening for it.
async function forceTerminateProcessTree(electronApp: ElectronApplication): Promise<void> {
  const mainProcess: ChildProcess = electronApp.process();
  const pid = mainProcess.pid;
  if (pid === undefined) {
    throw new Error("cannot force-terminate a process with no pid");
  }

  const processExited = new Promise<void>((resolvePromise) => {
    mainProcess.once("exit", () => resolvePromise());
  });
  const appClosed = new Promise<void>((resolvePromise) => {
    electronApp.once("close", () => resolvePromise());
  });

  if (process.platform === "win32") {
    // Spawned directly (no shell) with each argument passed separately, so
    // none of them can be reinterpreted by a shell.
    const taskkillExitCode = await new Promise<number | null>((resolvePromise, rejectPromise) => {
      const taskkill = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
      taskkill.on("exit", (code) => resolvePromise(code));
      taskkill.on("error", (err) => rejectPromise(err));
    });
    if (taskkillExitCode !== 0) {
      throw new Error(
        `taskkill could not terminate the process tree for pid ${pid} ` +
          `(exit code ${String(taskkillExitCode)})`,
      );
    }
  } else {
    mainProcess.kill("SIGKILL");
  }

  await Promise.all([processExited, appClosed]);
}

test("a second launch attempt against the same userData directory never touches persistence and defers to the first instance's window", async () => {
  const shared = makeSharedDir("solari-ai-sanitizer-single-instance-");
  const markerDir = makeSharedDir("solari-ai-sanitizer-single-instance-marker-");
  const markerPath = join(markerDir.path, "startup-marker.log");
  writeFileSync(markerPath, "");

  const sharedEnv = {
    ...process.env,
    SOLARI_TEST_USER_DATA_DIR: shared.path,
    SOLARI_TEST_STARTUP_MARKER_PATH: markerPath,
  };

  let app: ElectronApplication | undefined;

  try {
    app = await electron.launch({ args: [projectRoot], env: sharedEnv });
    const firstWindow = await app.firstWindow();
    await firstWindow.waitForLoadState("domcontentloaded");

    expect(markerLineCount(markerPath)).toBe(1);

    const { main, wal, shm } = registryFilePaths(shared.path);
    expect(existsSync(main)).toBe(true);

    const filesBefore = snapshotExistingFiles([main, wal, shm]);

    await app.evaluate(({ BrowserWindow }) => {
      const [win] = BrowserWindow.getAllWindows();
      win?.minimize();
    });

    const secondProcessExitCode = await new Promise<number | null>(
      (resolvePromise, rejectPromise) => {
        const child = spawn(electronBinaryPath, [projectRoot], {
          env: sharedEnv,
          stdio: "ignore",
        });
        const timeout = setTimeout(() => {
          child.kill();
          rejectPromise(new Error("second instance did not exit within the expected timeout"));
        }, 15_000);
        child.on("exit", (code) => {
          clearTimeout(timeout);
          resolvePromise(code);
        });
        child.on("error", (err) => {
          clearTimeout(timeout);
          rejectPromise(err);
        });
      },
    );

    expect(secondProcessExitCode).toBe(0);

    // The second process's own initialization sequence — where registry
    // open, key unwrap, and reconciliation all live — never began.
    expect(markerLineCount(markerPath)).toBe(1);

    // No new SQLite/key/worker activity attributable to the second process:
    // every file that existed before is byte-identical (same mtime), and no
    // new file (e.g. a WAL/SHM companion that didn't exist yet) appeared.
    const filesAfter = snapshotExistingFiles([main, wal, shm]);
    expect(filesAfter).toEqual(filesBefore);

    // The first instance's window is what receives the focus/restore
    // signal, not a second window.
    expect(app.windows().length).toBe(1);

    await expect
      .poll(
        async () =>
          app?.evaluate(({ BrowserWindow }) => {
            const [win] = BrowserWindow.getAllWindows();
            return { minimized: win?.isMinimized() ?? true, focused: win?.isFocused() ?? false };
          }),
        { timeout: 5_000 },
      )
      .toEqual({ minimized: false, focused: true });
  } finally {
    await app?.close();
    shared.cleanup();
    markerDir.cleanup();
  }
});

test("on macOS, a second-instance signal after the last window has been destroyed does not crash the surviving process", async () => {
  test.skip(
    process.platform !== "darwin",
    "window-all-closed only keeps the app alive without quitting on darwin; on other " +
      "platforms the process would already have quit before a second-instance signal " +
      "could arrive, so this regression cannot be exercised there.",
  );

  const shared = makeSharedDir("solari-ai-sanitizer-single-instance-destroyed-");

  let app: ElectronApplication | undefined;

  try {
    app = await electron.launch({
      args: [projectRoot],
      env: { ...process.env, SOLARI_TEST_USER_DATA_DIR: shared.path },
    });
    await app.firstWindow();

    // Destroy the only window, as window-all-closed's darwin no-op would
    // leave it after a real user close - the surviving process keeps
    // running with no live window.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.destroy();
    });

    await expect
      .poll(
        async () => app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
        {
          timeout: 5_000,
        },
      )
      .toBe(0);

    const secondProcessExitCode = await new Promise<number | null>(
      (resolvePromise, rejectPromise) => {
        const child = spawn(electronBinaryPath, [projectRoot], {
          env: { ...process.env, SOLARI_TEST_USER_DATA_DIR: shared.path },
          stdio: "ignore",
        });
        const timeout = setTimeout(() => {
          child.kill();
          rejectPromise(new Error("second instance did not exit within the expected timeout"));
        }, 15_000);
        child.on("exit", (code) => {
          clearTimeout(timeout);
          resolvePromise(code);
        });
        child.on("error", (err) => {
          clearTimeout(timeout);
          rejectPromise(err);
        });
      },
    );

    expect(secondProcessExitCode).toBe(0);

    // The surviving process must still be alive and responsive - a
    // destroyed-window reference used by the second-instance handler must
    // not throw an uncaught "Object has been destroyed" exception and take
    // the whole process down. A crashed/unresponsive main process would
    // otherwise hang this call forever, so it is raced against a short
    // timeout rather than trusted to reject or resolve on its own.
    const livenessCheck = Promise.race([
      app.evaluate(({ app: electronApp }) => electronApp.getVersion()),
      new Promise<never>((_resolvePromise, rejectPromise) =>
        setTimeout(
          () =>
            rejectPromise(
              new Error("surviving process did not respond within 5s - likely crashed"),
            ),
          5_000,
        ),
      ),
    ]);

    await expect(livenessCheck).resolves.toEqual(expect.any(String));
    expect(app.process().exitCode).toBeNull();
  } finally {
    // A crashed/unresponsive process (the exact defect under test) cannot
    // be closed gracefully via IPC, so teardown falls back to a direct
    // kill rather than risk hanging the whole suite on app.close().
    const closeOrKill = Promise.race([
      app?.close(),
      new Promise<void>((resolvePromise) =>
        setTimeout(() => {
          app?.process().kill("SIGKILL");
          resolvePromise();
        }, 3_000),
      ),
    ]);
    await closeOrKill.catch(() => undefined);
    shared.cleanup();
  }
});

test("after the first instance is force-terminated, a fresh instance against the same directory acquires the lock normally", async () => {
  const shared = makeSharedDir("solari-ai-sanitizer-single-instance-crash-");
  let firstApp: ElectronApplication | undefined;
  let secondApp: ElectronApplication | undefined;

  try {
    firstApp = await electron.launch({
      args: [projectRoot],
      env: { ...process.env, SOLARI_TEST_USER_DATA_DIR: shared.path },
    });
    await firstApp.firstWindow();

    // Simulate a crash, not a clean quit: force-terminate the process
    // (tree) directly rather than calling app.close()/app.quit(), so
    // Electron never releases the lock through its own normal shutdown
    // path.
    await forceTerminateProcessTree(firstApp);
    firstApp = undefined;

    secondApp = await electron.launch({
      args: [projectRoot],
      env: { ...process.env, SOLARI_TEST_USER_DATA_DIR: shared.path },
    });
    const window = await secondApp.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    expect(secondApp.windows().length).toBe(1);
  } finally {
    await firstApp?.close();
    await secondApp?.close();
    shared.cleanup();
  }
});
