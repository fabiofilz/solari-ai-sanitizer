import { contextBridge, ipcRenderer } from "electron";

// contextBridge API surface skeleton (T037; constitution Principle V).
// contextIsolation: true and nodeIntegration: false (app-lifecycle.ts's
// BrowserWindow webPreferences) make this file the *only* bridge the
// renderer ever talks to: no Node.js global, Electron internal, database
// connection, filesystem access, cryptographic key, or safeStorage
// reference is ever exposed here — only the two documented workspace
// channels this task range implements. Every subsequent user story adds its
// own channels to this same file (plan.md Project Structure), never a
// second bridge.
//
// Types are declared locally rather than imported from src/main/ipc/
// dispatch.ts: tsconfig.preload.json's rootDir is scoped to src/preload, so
// pulling in a main/ file (even for a type-only import) fails the preload
// build — and keeping preload/ independent of main/ipc/'s internals is the
// correct boundary regardless (mirrors dispatch.ts's own DispatchResult
// shape, contracts/workspace.md's documented error codes only).

export type WorkspaceOperationResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code:
          | "DUPLICATE_NAME"
          | "REGISTRY_KEY_UNAVAILABLE"
          | "NOT_FOUND"
          | "WORKSPACE_KEY_UNAVAILABLE"
          | "WORKSPACE_DELETING"
          | "VALIDATION_ERROR"
          | "INTERNAL_ERROR";
      };
    };

export interface SolariWorkspaceAPI {
  create: (name: string) => Promise<WorkspaceOperationResult<{ id: string; name: string }>>;
  open: (id: string) => Promise<WorkspaceOperationResult<{ id: string; name: string }>>;
}

export interface SolariAPI {
  workspace: SolariWorkspaceAPI;
}

const solariAPI: SolariAPI = {
  workspace: {
    create: (name: string) => ipcRenderer.invoke("workspace:create", { name }),
    open: (id: string) => ipcRenderer.invoke("workspace:open", { id }),
  },
};

contextBridge.exposeInMainWorld("solari", solariAPI);
