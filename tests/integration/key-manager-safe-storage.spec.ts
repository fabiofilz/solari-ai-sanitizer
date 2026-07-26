import { test, expect, _electron as electron } from "@playwright/test";
import { resolve } from "node:path";

// Real-Electron contract test for T027-T029: exercises the genuine, pinned
// Electron `safeStorage` asynchronous API exclusively through key-manager.ts's
// own production public API (verifyProductionSafeStorageCompatibility,
// wrapRegistryDek, unwrapRegistryDek, wrapWorkspaceDek, unwrapWorkspaceDek).
// This test never destructures, references, inspects, or calls
// `safeStorage` itself — key-manager.ts remains the only module in the
// codebase that does so. Runs after app.whenReady() (guaranteed by waiting
// for firstWindow(), the same pattern already used by
// tests/integration/app-launch.spec.ts, since app-lifecycle.ts only creates
// a window inside its app.whenReady().then(createWindow) callback).
//
// No sensitive value ever leaves the Electron main process: the synthetic
// DEKs are generated *inside* the evaluate() callback, compared there, and
// only a plain boolean/diagnostic summary is returned to this test process.

const projectRoot = resolve(process.cwd());
const keyManagerPath = resolve(projectRoot, "dist/main/main/persistence/key-manager.js");

test("real Electron safeStorage: a synthetic 32-byte DEK can be wrapped and unwrapped via key-manager.ts's production API, recovering the exact original bytes", async () => {
  const app = await electron.launch({ args: [projectRoot] });

  try {
    await app.firstWindow();

    const result = await app.evaluate(
      async (_electronApi, args: { keyManagerPath: string }) => {
        // Playwright's Electron evaluate() runs inside a restricted V8
        // context with no bare `require` (verified directly: `require` is
        // undefined there, but `process.mainModule.require` — Node's own
        // entry-module-bound require — works correctly and is how this
        // loads the real, already-compiled key-manager.ts). The first
        // parameter (Electron's exported API surface) is intentionally
        // never destructured or touched here: this test must never
        // reference safeStorage directly.
        const mainModuleRequire = (process as unknown as { mainModule: { require: NodeRequire } })
          .mainModule.require;
        const keyManager = mainModuleRequire(
          args.keyManagerPath,
        ) as typeof import("../../src/main/persistence/key-manager");
        const { randomBytes } = mainModuleRequire("node:crypto") as typeof import("node:crypto");

        try {
          keyManager.verifyProductionSafeStorageCompatibility();
        } catch {
          return {
            diagnosis: "SAFE_STORAGE_COMPATIBILITY_CHECK_FAILED" as const,
            registryMatches: false,
            workspaceMatches: false,
          };
        }

        const persistCalls: number[] = [];
        const noopPersist = async (wrapped: Buffer) => {
          persistCalls.push(wrapped.length);
        };

        try {
          const syntheticRegistryDek = randomBytes(32);
          const wrappedRegistry = await keyManager.wrapRegistryDek(syntheticRegistryDek);
          const recoveredRegistry = await keyManager.unwrapRegistryDek(
            wrappedRegistry,
            noopPersist,
          );

          const syntheticWorkspaceDek = randomBytes(32);
          const wrappedWorkspace = await keyManager.wrapWorkspaceDek(syntheticWorkspaceDek);
          const recoveredWorkspace = await keyManager.unwrapWorkspaceDek(
            wrappedWorkspace,
            noopPersist,
          );

          return {
            diagnosis: "OK" as const,
            registryMatches: recoveredRegistry.equals(syntheticRegistryDek),
            workspaceMatches: recoveredWorkspace.equals(syntheticWorkspaceDek),
            wrappedRegistryLength: wrappedRegistry.length,
            wrappedWorkspaceLength: wrappedWorkspace.length,
          };
        } catch {
          // A KeyManagerError here (e.g. REGISTRY_KEY_UNAVAILABLE /
          // WORKSPACE_KEY_UNAVAILABLE) most commonly indicates that
          // asynchronous safeStorage encryption is unavailable in this
          // Electron/OS environment — surfaced as an explicit diagnosis
          // rather than an uncaught crash inside evaluate().
          return {
            diagnosis: "WRAP_UNWRAP_FAILED" as const,
            registryMatches: false,
            workspaceMatches: false,
          };
        }
      },
      { keyManagerPath },
    );

    if (result.diagnosis === "SAFE_STORAGE_COMPATIBILITY_CHECK_FAILED") {
      throw new Error(
        "verifyProductionSafeStorageCompatibility() failed in this Electron/OS environment — " +
          "the real safeStorage object does not expose the expected async method surface. " +
          "This is an environment compatibility failure, not a silent skip.",
      );
    }
    if (result.diagnosis === "WRAP_UNWRAP_FAILED") {
      throw new Error(
        "key-manager.ts's production wrap/unwrap functions failed in this Electron/OS " +
          "environment — most likely asynchronous safeStorage encryption is unavailable here, " +
          "so the wrap/unwrap contract could not be verified. This is an environment " +
          "compatibility failure, not a silent skip.",
      );
    }

    expect(result.diagnosis).toBe("OK");
    expect(result.registryMatches).toBe(true);
    expect(result.workspaceMatches).toBe(true);
    expect(result.wrappedRegistryLength).toBeGreaterThan(0);
    expect(result.wrappedWorkspaceLength).toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});
