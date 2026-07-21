// Domain-level workspace error (T032-T037; contracts/workspace.md). Carries
// only one of the documented workspace:create/workspace:open error codes —
// never a message derived from user input, so it is always safe to surface
// directly (constitution Principle I; research.md #10/#13 redaction rules).

export type WorkspaceErrorCode =
  | "DUPLICATE_NAME"
  | "REGISTRY_KEY_UNAVAILABLE"
  | "NOT_FOUND"
  | "WORKSPACE_KEY_UNAVAILABLE"
  | "WORKSPACE_DELETING";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode) {
    super(`workspace error: ${code}`);
    this.name = "WorkspaceError";
    this.code = code;
  }
}
