import type { ZodType, ZodIssue, ZodTypeAny } from "zod";

// Shared, schema-validated IPC dispatch helper (constitution Principle V;
// data-model.md's Workspace deletion state machine). No Electron IPC is
// wired here — this module is a plain function callable by whatever wires
// `ipcMain.handle` in a later task, and by tests directly.
//
// Workspace scoping (remediation): scope is derived unconditionally from
// the *validated* request's own shape — if it has a string `workspaceId`
// field, the DELETING check always runs. There is no caller-supplied flag
// to misconfigure.
//
// Channel-specific validation-error codes (remediation): a request that
// fails schema validation returns the generic `VALIDATION_ERROR` code by
// default. A schema may instead carry its own field-level error-code
// mapping as *schema metadata* (via Zod's `.meta()`, attached with
// withValidationErrorMapping below) — e.g. translation's 500,000-character
// ceiling maps to the documented `INPUT_TOO_LARGE` code. Because this
// mapping lives on the schema value itself, not on a separately-supplied
// option next to it, a caller who builds a ChannelDefinition from nothing
// but the exported request/response schemas gets the correct documented
// code automatically — there is no longer any place to forget to attach a
// mapper. dispatch() only ever reads Zod's structural issue list
// (code/path) from this metadata lookup, never the raw request or any
// field's received value, so this stays safe by construction.

// A canonical, typed union of every safe error code this application may
// return over IPC: dispatch's own infrastructure codes, plus every
// documented per-channel error code across contracts/*.md. Constraining
// error codes to this set — rather than an arbitrary, unrestricted string —
// makes an invented or mistyped code a compile-time error.
export type IpcErrorCode =
  | "VALIDATION_ERROR"
  | "INTERNAL_ERROR"
  | "WORKSPACE_DELETING"
  | "REGISTRY_KEY_UNAVAILABLE"
  | "DUPLICATE_NAME"
  | "NOT_FOUND"
  | "WORKSPACE_KEY_UNAVAILABLE"
  | "CONFIRMATION_REQUIRED"
  | "WORKSPACE_NOT_FOUND"
  | "INPUT_TOO_LARGE"
  | "TRANSLATION_WORKER_FAILED"
  | "INVALID_PREFIX"
  | "PRINCIPAL_REQUIRED"
  | "PRINCIPAL_REASSIGNMENT_REQUIRED";

/**
 * Declares that a specific Zod issue on a specific top-level request field
 * must be reported as a specific documented IpcErrorCode instead of the
 * generic VALIDATION_ERROR fallback.
 */
export interface FieldValidationErrorMapping {
  /** Top-level request field this mapping applies to. */
  field: string;
  /** The ZodIssue `code` (e.g. "too_big") that triggers this mapping. */
  issueCode: string;
  /** The documented, safe error code to report for a matching issue. */
  errorCode: IpcErrorCode;
}

interface SchemaValidationErrorMeta {
  validationErrorMappings?: FieldValidationErrorMapping[];
}

/**
 * Attaches field-level validation-error-code mappings to a schema as
 * metadata (Zod's `.meta()`), so every consumer of the returned schema
 * value — dispatch(), direct `.safeParse()` calls in tests, anything else —
 * automatically carries the same mapping. There is no separate option to
 * omit: the mapping travels with the schema itself.
 */
export function withValidationErrorMapping<T extends ZodTypeAny>(
  schema: T,
  mappings: FieldValidationErrorMapping[],
): T {
  return schema.meta({ validationErrorMappings: mappings }) as T;
}

function resolveRequestValidationErrorCode(
  schema: { meta?: () => unknown },
  issues: ZodIssue[],
): IpcErrorCode {
  const meta = schema.meta?.() as SchemaValidationErrorMeta | undefined;
  const mappings = meta?.validationErrorMappings ?? [];
  for (const issue of issues) {
    const match = mappings.find(
      (mapping) =>
        issue.code === mapping.issueCode &&
        issue.path.length === 1 &&
        issue.path[0] === mapping.field,
    );
    if (match) {
      return match.errorCode;
    }
  }
  return "VALIDATION_ERROR";
}

export type WorkspaceStatus = "ACTIVE" | "DELETING";

/**
 * Resolves a workspace's current registry status. Returns null if no such
 * workspace exists. Injected so tests never need a real registry database
 * (constitution Principle VI; kept independent of src/main/persistence/*).
 */
export type WorkspaceStatusLookup = (
  workspaceId: string,
) => WorkspaceStatus | null | Promise<WorkspaceStatus | null>;

export interface ChannelDefinition<TRequest extends object, TResponse> {
  requestSchema: ZodType<TRequest>;
  responseSchema: ZodType<TResponse>;
}

export type DispatchResult<TResponse> =
  { ok: true; data: TResponse } | { ok: false; error: { code: IpcErrorCode } };

export interface DispatchDependencies {
  getWorkspaceStatus?: WorkspaceStatusLookup;
}

function extractWorkspaceId(request: object): string | undefined {
  const value = (request as { workspaceId?: unknown }).workspaceId;
  return typeof value === "string" ? value : undefined;
}

/**
 * Validates rawRequest against the channel's request schema (reporting any
 * schema-declared field-specific error code — e.g. INPUT_TOO_LARGE — in
 * place of the generic VALIDATION_ERROR fallback), checks the target
 * workspace's DELETING status whenever the validated request itself
 * carries a `workspaceId` string field (never configurable, never
 * bypassable), invokes handler only if both pass, then validates the
 * handler's result against the channel's response schema before returning
 * it.
 */
export async function dispatch<TRequest extends object, TResponse>(
  definition: ChannelDefinition<TRequest, TResponse>,
  rawRequest: unknown,
  handler: (request: TRequest) => TResponse | Promise<TResponse>,
  deps: DispatchDependencies = {},
): Promise<DispatchResult<TResponse>> {
  const parsedRequest = definition.requestSchema.safeParse(rawRequest);
  if (!parsedRequest.success) {
    const code = resolveRequestValidationErrorCode(
      definition.requestSchema,
      parsedRequest.error.issues,
    );
    return { ok: false, error: { code } };
  }

  const workspaceId = extractWorkspaceId(parsedRequest.data);
  if (workspaceId !== undefined) {
    if (!deps.getWorkspaceStatus) {
      return { ok: false, error: { code: "INTERNAL_ERROR" } };
    }
    const status = await deps.getWorkspaceStatus(workspaceId);
    if (status === "DELETING") {
      return { ok: false, error: { code: "WORKSPACE_DELETING" } };
    }
  }

  const rawResponse = await handler(parsedRequest.data);
  const parsedResponse = definition.responseSchema.safeParse(rawResponse);
  if (!parsedResponse.success) {
    return { ok: false, error: { code: "INTERNAL_ERROR" } };
  }

  return { ok: true, data: parsedResponse.data };
}
