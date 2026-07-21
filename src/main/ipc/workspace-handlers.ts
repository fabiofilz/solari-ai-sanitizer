import {
  workspaceCreateRequestSchema,
  workspaceCreateResponseSchema,
  workspaceOpenRequestSchema,
  workspaceOpenResponseSchema,
} from "./schemas/workspace.schema";
import { dispatch, type DispatchResult, type ChannelDefinition } from "./dispatch";
import { WorkspaceError } from "../../domain/workspace/workspace-error";
import { logSafeEvent, redactUnknownError } from "../logging/redact";

// workspace:create / workspace:open IPC handlers (T036; contracts/workspace.md).
// Thin boundary only: validates via dispatch() (T026), calls the injected
// domain create/open functions (T034/T035), and translates their outcome
// into the documented IPC response shape — never forwards a raw
// Error.message/stack/cause across the boundary (constitution Principle I;
// research.md #10/#13 redaction rules).

export interface WorkspaceHandlerDeps {
  createWorkspace: (name: string) => Promise<{ id: string; name: string }>;
  openWorkspace: (id: string) => Promise<{ id: string; name: string }>;
}

const workspaceCreateDefinition: ChannelDefinition<{ name: string }, { id: string; name: string }> =
  {
    requestSchema: workspaceCreateRequestSchema,
    responseSchema: workspaceCreateResponseSchema,
  };

const workspaceOpenDefinition: ChannelDefinition<{ id: string }, { id: string; name: string }> = {
  requestSchema: workspaceOpenRequestSchema,
  responseSchema: workspaceOpenResponseSchema,
};

/**
 * Maps a caught error to a safe IPC error code. A WorkspaceError's own code
 * is already one of the documented, safe codes and is returned as-is.
 * Anything else is unexpected: logged via the safe diagnostic API (T031,
 * never the raw error's message/stack/cause) and reported to the caller as
 * the generic INTERNAL_ERROR.
 */
function toIpcErrorCode(
  err: unknown,
):
  | "DUPLICATE_NAME"
  | "REGISTRY_KEY_UNAVAILABLE"
  | "NOT_FOUND"
  | "WORKSPACE_KEY_UNAVAILABLE"
  | "WORKSPACE_DELETING"
  | "INTERNAL_ERROR" {
  if (err instanceof WorkspaceError) {
    return err.code;
  }
  logSafeEvent(redactUnknownError(err, { category: "PERSISTENCE", code: "UNKNOWN_ERROR" }));
  return "INTERNAL_ERROR";
}

export async function handleWorkspaceCreate(
  rawRequest: unknown,
  deps: WorkspaceHandlerDeps,
): Promise<DispatchResult<{ id: string; name: string }>> {
  try {
    return await dispatch(workspaceCreateDefinition, rawRequest, (request) =>
      deps.createWorkspace(request.name),
    );
  } catch (err) {
    return { ok: false, error: { code: toIpcErrorCode(err) } };
  }
}

export async function handleWorkspaceOpen(
  rawRequest: unknown,
  deps: WorkspaceHandlerDeps,
): Promise<DispatchResult<{ id: string; name: string }>> {
  try {
    return await dispatch(workspaceOpenDefinition, rawRequest, (request) =>
      deps.openWorkspace(request.id),
    );
  } catch (err) {
    return { ok: false, error: { code: toIpcErrorCode(err) } };
  }
}

// IPC channel registration (T032-T037 remediation, defect 4). A narrow
// structural interface — not electron's own IpcMain type — so this module
// stays fully unit-testable without a real Electron runtime, and so
// nothing here imports "electron" at all (no safeStorage/ipcMain access at
// module load time; registerWorkspaceIpcHandlers has zero side effects
// until it is actually called).
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, request: unknown) => unknown): void;
}

/**
 * Registers the workspace:create / workspace:open channels against the
 * given ipcMain-like object, each delegating to the existing
 * Zod/dispatch-validated handler above. Electron's real `ipcMain` already
 * satisfies IpcMainLike structurally, so a caller passes it directly.
 *
 * One-time-registration contract: call this exactly once, for the lifetime
 * of the process — there is no duplicate-registration guard here, by
 * design (electron's own `ipcMain.handle` already throws if the same
 * channel is registered twice, which is the correct signal for a
 * programming error, not something to silently tolerate or speculatively
 * guard against).
 *
 * Ordering contract for the real caller (T042, not implemented here): call
 * this only after the single-instance lock is acquired, registry.sqlite has
 * been opened, and startup deletion reconciliation has finished — i.e.
 * after `deps.createWorkspace`/`deps.openWorkspace` are backed by real,
 * ready-to-use dependencies, never before.
 */
export function registerWorkspaceIpcHandlers(
  ipcMain: IpcMainLike,
  deps: WorkspaceHandlerDeps,
): void {
  ipcMain.handle("workspace:create", (_event, request) => handleWorkspaceCreate(request, deps));
  ipcMain.handle("workspace:open", (_event, request) => handleWorkspaceOpen(request, deps));
}
