import { test, expect, _electron as electron } from "@playwright/test";
import { resolve } from "node:path";

// Real-Electron contract test for T037: verifies the preload contextBridge
// API surface the renderer actually sees at window.solari — a real
// contextIsolation:true / nodeIntegration:false renderer page, not a mock,
// since preload/index.ts's top-level contextBridge.exposeInMainWorld() call
// cannot run under plain Node/Vitest (constitution Principle V; "the sole
// bridge the renderer uses"). Confirms both that the documented API exists
// and that nothing privileged leaks alongside it.

const projectRoot = resolve(process.cwd());

test("renderer sees only the documented window.solari.workspace.{create,open} API — no privileged globals", async () => {
  const app = await electron.launch({ args: [projectRoot] });

  try {
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");

    const surface = await window.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const solari = w["solari"] as
        { workspace?: { create?: unknown; open?: unknown } } | undefined;

      return {
        hasSolari: typeof solari === "object" && solari !== null,
        workspaceKeys: solari?.workspace ? Object.keys(solari.workspace).sort() : [],
        createIsFunction: typeof solari?.workspace?.create === "function",
        openIsFunction: typeof solari?.workspace?.open === "function",
        solariTopLevelKeys: solari ? Object.keys(solari).sort() : [],
        hasRequire: typeof w["require"] !== "undefined",
        hasProcess: typeof w["process"] !== "undefined",
        hasModule: typeof w["module"] !== "undefined",
        hasElectron: typeof w["electron"] !== "undefined",
        hasIpcRenderer: typeof w["ipcRenderer"] !== "undefined",
        hasContextBridge: typeof w["contextBridge"] !== "undefined",
        hasSafeStorage: typeof w["safeStorage"] !== "undefined",
      };
    });

    expect(surface.hasSolari).toBe(true);
    expect(surface.solariTopLevelKeys).toEqual(["workspace"]);
    expect(surface.workspaceKeys).toEqual(["create", "open"]);
    expect(surface.createIsFunction).toBe(true);
    expect(surface.openIsFunction).toBe(true);

    expect(surface.hasRequire).toBe(false);
    expect(surface.hasProcess).toBe(false);
    expect(surface.hasModule).toBe(false);
    expect(surface.hasElectron).toBe(false);
    expect(surface.hasIpcRenderer).toBe(false);
    expect(surface.hasContextBridge).toBe(false);
    expect(surface.hasSafeStorage).toBe(false);
  } finally {
    await app.close();
  }
});
