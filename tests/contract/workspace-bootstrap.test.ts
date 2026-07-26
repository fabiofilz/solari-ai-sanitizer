import { describe, expect, it, vi } from "vitest";
import {
  handleWorkspaceCreate,
  handleWorkspaceOpen,
  registerWorkspaceIpcHandlers,
  type WorkspaceHandlerDeps,
  type IpcMainLike,
} from "../../src/main/ipc/workspace-handlers";
import { WorkspaceError } from "../../src/domain/workspace/workspace-error";

// Contract test for T033 (contracts/workspace.md; constitution Principle VI):
// the workspace:create / workspace:open IPC handlers' request/response
// shapes and documented error codes, exercised with injected fake
// create/open functions — no real database or Electron runtime needed here,
// consistent with dispatch()'s own existing test pattern in
// tests/contract/ipc-schemas.test.ts. Synthetic names/values only.

const VALID_WORKSPACE_ID = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";

function depsWith(overrides: Partial<WorkspaceHandlerDeps> = {}): WorkspaceHandlerDeps {
  return {
    createWorkspace: vi.fn().mockResolvedValue({ id: VALID_WORKSPACE_ID, name: "Synthetic Co." }),
    openWorkspace: vi.fn().mockResolvedValue({ id: VALID_WORKSPACE_ID, name: "Synthetic Co." }),
    ...overrides,
  };
}

describe("workspace:create handler (contracts/workspace.md)", () => {
  it("returns { id, name } for a valid request", async () => {
    const deps = depsWith();
    const result = await handleWorkspaceCreate({ name: "Synthetic Co." }, deps);

    expect(result).toEqual({ ok: true, data: { id: VALID_WORKSPACE_ID, name: "Synthetic Co." } });
    expect(deps.createWorkspace).toHaveBeenCalledWith("Synthetic Co.");
  });

  it("rejects an invalid request without calling createWorkspace", async () => {
    const deps = depsWith();
    const result = await handleWorkspaceCreate({ name: "" }, deps);

    expect(result.ok).toBe(false);
    expect(deps.createWorkspace).not.toHaveBeenCalled();
  });

  it("returns DUPLICATE_NAME when createWorkspace rejects with that WorkspaceError code", async () => {
    const deps = depsWith({
      createWorkspace: vi.fn().mockRejectedValue(new WorkspaceError("DUPLICATE_NAME")),
    });
    const result = await handleWorkspaceCreate({ name: "Synthetic Co." }, deps);

    expect(result).toEqual({ ok: false, error: { code: "DUPLICATE_NAME" } });
  });

  it("returns REGISTRY_KEY_UNAVAILABLE when createWorkspace rejects with that WorkspaceError code", async () => {
    const deps = depsWith({
      createWorkspace: vi.fn().mockRejectedValue(new WorkspaceError("REGISTRY_KEY_UNAVAILABLE")),
    });
    const result = await handleWorkspaceCreate({ name: "Synthetic Co." }, deps);

    expect(result).toEqual({ ok: false, error: { code: "REGISTRY_KEY_UNAVAILABLE" } });
  });

  it("maps an unexpected error to INTERNAL_ERROR without forwarding its message", async () => {
    const deps = depsWith({
      createWorkspace: vi.fn().mockRejectedValue(new Error("synthetic secret leak: hunter2")),
    });
    const result = await handleWorkspaceCreate({ name: "Synthetic Co." }, deps);

    expect(result).toEqual({ ok: false, error: { code: "INTERNAL_ERROR" } });
  });
});

describe("workspace:open handler (contracts/workspace.md)", () => {
  it("returns { id, name } for a valid request", async () => {
    const deps = depsWith();
    const result = await handleWorkspaceOpen({ id: VALID_WORKSPACE_ID }, deps);

    expect(result).toEqual({ ok: true, data: { id: VALID_WORKSPACE_ID, name: "Synthetic Co." } });
    expect(deps.openWorkspace).toHaveBeenCalledWith(VALID_WORKSPACE_ID);
  });

  it("rejects an invalid (non-UUID) request without calling openWorkspace", async () => {
    const deps = depsWith();
    const result = await handleWorkspaceOpen({ id: "not-a-uuid" }, deps);

    expect(result.ok).toBe(false);
    expect(deps.openWorkspace).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND when openWorkspace rejects with that WorkspaceError code", async () => {
    const deps = depsWith({
      openWorkspace: vi.fn().mockRejectedValue(new WorkspaceError("NOT_FOUND")),
    });
    const result = await handleWorkspaceOpen({ id: VALID_WORKSPACE_ID }, deps);

    expect(result).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("returns WORKSPACE_KEY_UNAVAILABLE when openWorkspace rejects with that WorkspaceError code", async () => {
    const deps = depsWith({
      openWorkspace: vi.fn().mockRejectedValue(new WorkspaceError("WORKSPACE_KEY_UNAVAILABLE")),
    });
    const result = await handleWorkspaceOpen({ id: VALID_WORKSPACE_ID }, deps);

    expect(result).toEqual({ ok: false, error: { code: "WORKSPACE_KEY_UNAVAILABLE" } });
  });

  it("returns REGISTRY_KEY_UNAVAILABLE when openWorkspace rejects with that WorkspaceError code", async () => {
    const deps = depsWith({
      openWorkspace: vi.fn().mockRejectedValue(new WorkspaceError("REGISTRY_KEY_UNAVAILABLE")),
    });
    const result = await handleWorkspaceOpen({ id: VALID_WORKSPACE_ID }, deps);

    expect(result).toEqual({ ok: false, error: { code: "REGISTRY_KEY_UNAVAILABLE" } });
  });

  it("returns WORKSPACE_DELETING when openWorkspace rejects with that WorkspaceError code (defect 1)", async () => {
    const deps = depsWith({
      openWorkspace: vi.fn().mockRejectedValue(new WorkspaceError("WORKSPACE_DELETING")),
    });
    const result = await handleWorkspaceOpen({ id: VALID_WORKSPACE_ID }, deps);

    expect(result).toEqual({ ok: false, error: { code: "WORKSPACE_DELETING" } });
  });

  it("maps an unexpected error to INTERNAL_ERROR without forwarding its message", async () => {
    const deps = depsWith({
      openWorkspace: vi.fn().mockRejectedValue(new Error("synthetic secret leak: hunter2")),
    });
    const result = await handleWorkspaceOpen({ id: VALID_WORKSPACE_ID }, deps);

    expect(result).toEqual({ ok: false, error: { code: "INTERNAL_ERROR" } });
  });
});

describe("registerWorkspaceIpcHandlers (defect 4: IPC channel registration)", () => {
  function createFakeIpcMain(): IpcMainLike & {
    handlers: Map<string, (event: unknown, request: unknown) => unknown>;
  } {
    const handlers = new Map<string, (event: unknown, request: unknown) => unknown>();
    return {
      handlers,
      handle: vi.fn((channel: string, listener: (event: unknown, request: unknown) => unknown) => {
        handlers.set(channel, listener);
      }),
    };
  }

  it("registers exactly workspace:create and workspace:open, and nothing else", () => {
    const ipcMain = createFakeIpcMain();
    registerWorkspaceIpcHandlers(ipcMain, depsWith());

    expect([...ipcMain.handlers.keys()].sort()).toEqual(["workspace:create", "workspace:open"]);
  });

  it("registered workspace:create delegates to the Zod/dispatch-validated handler", async () => {
    const ipcMain = createFakeIpcMain();
    const deps = depsWith();
    registerWorkspaceIpcHandlers(ipcMain, deps);

    const listener = ipcMain.handlers.get("workspace:create")!;
    const result = await listener({}, { name: "Synthetic Co." });

    expect(result).toEqual({ ok: true, data: { id: VALID_WORKSPACE_ID, name: "Synthetic Co." } });
    expect(deps.createWorkspace).toHaveBeenCalledWith("Synthetic Co.");
  });

  it("registered workspace:open delegates to the Zod/dispatch-validated handler", async () => {
    const ipcMain = createFakeIpcMain();
    const deps = depsWith();
    registerWorkspaceIpcHandlers(ipcMain, deps);

    const listener = ipcMain.handlers.get("workspace:open")!;
    const result = await listener({}, { id: VALID_WORKSPACE_ID });

    expect(result).toEqual({ ok: true, data: { id: VALID_WORKSPACE_ID, name: "Synthetic Co." } });
    expect(deps.openWorkspace).toHaveBeenCalledWith(VALID_WORKSPACE_ID);
  });

  it("registered workspace:create still rejects invalid requests without calling createWorkspace", async () => {
    const ipcMain = createFakeIpcMain();
    const deps = depsWith();
    registerWorkspaceIpcHandlers(ipcMain, deps);

    const listener = ipcMain.handlers.get("workspace:create")!;
    const result = (await listener({}, { name: "" })) as { ok: boolean };

    expect(result.ok).toBe(false);
    expect(deps.createWorkspace).not.toHaveBeenCalled();
  });
});

describe("handlers never emit sensitive content to console/stdio", () => {
  it("logs nothing containing the synthetic name or error detail during any scenario above", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await handleWorkspaceCreate(
        { name: "Synthetic Confidential Co." },
        depsWith({ createWorkspace: vi.fn().mockRejectedValue(new Error("leak: hunter2")) }),
      );
      await handleWorkspaceOpen(
        { id: VALID_WORKSPACE_ID },
        depsWith({ openWorkspace: vi.fn().mockRejectedValue(new Error("leak: hunter2")) }),
      );

      const allCalls = [...logSpy.mock.calls, ...errorSpy.mock.calls, ...warnSpy.mock.calls]
        .flat()
        .map(String)
        .join("\n");
      expect(allCalls).not.toContain("hunter2");
      expect(allCalls).not.toContain("Synthetic Confidential Co.");
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
