// Shared logging/error helper (T031; research.md #10 redaction rules;
// constitution Principle I). Every log line, thrown error, and diagnostic
// in this application must go through this module.
//
// Design: prevention by construction, not scrubbing, and closed by
// construction rather than merely shape-validated. A length-capped
// "arbitrary string" field is not a guarantee — a short customer name,
// password, or text fragment fits comfortably under any workable length
// cap. So this module has no such field anywhere:
//
//   - `category` and `code` are drawn only from fixed, closed,
//     application-defined sets (SAFE_CATEGORIES / SAFE_CODES) grounded in
//     error domains that already exist in this codebase today
//     (key-manager.ts's KeyManagerErrorCode) plus one fixed "unknown"
//     fallback each. There is no free-text category/code.
//   - `id` is a branded SafeId, obtainable only through the dedicated
//     `workspaceId()`/`entityId()` constructors, which validate a strict,
//     non-sensitive identifier shape matching how this codebase's own IDs
//     are actually shaped (Workspace.id: canonical UUID;
//     Prefix/Placeholder/Term/PendingDecision.id: positive integer — see
//     src/main/persistence/{registry,workspace}-schema.ts). There is no
//     constructor that can brand an arbitrary string as safe, and
//     assertSafeLogEvent re-validates the same shape at the boundary, so a
//     bad-faith `as SafeId` type cast is still caught before anything is
//     formatted or logged.
//   - There is no metadata field. Nothing in the current specification
//     defines diagnostic metadata fields this application needs yet, so
//     none are speculatively added; category + code + id is the complete,
//     narrowest surface today.
//
// Decrypted values, original/restored text, customer names, passwords,
// tokens, raw/wrapped DEKs, derived subkeys, nonces, authentication tags,
// and ciphertext blobs all fail every one of the checks above — not
// because their *content* is inspected and matched against a pattern, but
// because none of them can ever be a member of a closed category/code set
// or match a canonical-UUID/positive-integer identifier shape. There is
// nothing to strip after the fact because there is no field for arbitrary
// content to enter through in the first place.

export const SAFE_CATEGORIES = ["KEY_MANAGER", "PERSISTENCE", "UNKNOWN"] as const;
export type SafeCategory = (typeof SAFE_CATEGORIES)[number];

// Grounded in the error codes that already exist in this codebase
// (src/main/persistence/key-manager.ts's KeyManagerErrorCode), plus one
// fixed fallback for a genuinely unrecognized failure. Not a shape pattern:
// membership in this literal array is required, so an arbitrary
// UPPER_SNAKE_CASE-shaped value invented by a caller or supplied by a
// malicious/accidental thrown object is rejected even though its syntax
// looks identical to a real code.
export const SAFE_CODES = [
  "REGISTRY_KEY_UNAVAILABLE",
  "WORKSPACE_KEY_UNAVAILABLE",
  "UNKNOWN_ERROR",
] as const;
export type SafeCode = (typeof SAFE_CODES)[number];

declare const SAFE_ID_BRAND: unique symbol;
/**
 * An opaque, pre-validated identifier. The only way to obtain one is
 * through `workspaceId()` or `entityId()` below — there is no constructor
 * that brands an arbitrary string as safe.
 */
export type SafeId = string & { readonly [SAFE_ID_BRAND]: "SafeId" };

export interface SafeLogEvent {
  category: SafeCategory;
  code?: SafeCode;
  id?: SafeId;
}

export class RedactionViolationError extends Error {
  constructor(reason: string) {
    super(`unsafe log event rejected: ${reason}`);
    this.name = "RedactionViolationError";
  }
}

function describeType(value: unknown): string {
  if (Buffer.isBuffer(value)) return "Buffer";
  if (value instanceof Uint8Array) return "Uint8Array";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// Workspace.id per data-model.md / registry-schema.ts: a TEXT canonical
// UUID primary key. Must stay in sync with the same canonical, lowercase-
// only pattern already used at the IPC/persistence boundary (see
// src/main/ipc/schemas/common.ts and src/main/persistence/db-connection.ts).
const CANONICAL_WORKSPACE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Prefix/Placeholder/Term/PendingDecision.id per workspace-schema.ts: an
// INTEGER PRIMARY KEY, always a positive whole number with no leading zero.
const POSITIVE_INTEGER_ID_PATTERN = /^[1-9][0-9]*$/;

function isSafeIdShape(value: string): boolean {
  return CANONICAL_WORKSPACE_ID_PATTERN.test(value) || POSITIVE_INTEGER_ID_PATTERN.test(value);
}

/** Validates and brands a canonical Workspace UUID as a SafeId. */
export function workspaceId(raw: string): SafeId {
  if (typeof raw !== "string" || !CANONICAL_WORKSPACE_ID_PATTERN.test(raw)) {
    throw new RedactionViolationError(
      `workspaceId must be a canonical UUID, received ${describeType(raw)}`,
    );
  }
  return raw as SafeId;
}

/** Validates and brands a per-workspace integer primary key as a SafeId. */
export function entityId(raw: string | number): SafeId {
  const asString = typeof raw === "number" ? String(raw) : raw;
  if (typeof asString !== "string" || !POSITIVE_INTEGER_ID_PATTERN.test(asString)) {
    throw new RedactionViolationError(
      `entityId must be a positive integer identifier, received ${describeType(raw)}`,
    );
  }
  return asString as SafeId;
}

/**
 * Validates a SafeLogEvent against the closed category/code sets and the
 * SafeId shape, throwing RedactionViolationError (never including the
 * offending value itself, only the field name and its kind) otherwise.
 * Re-validates `id`'s shape even though it is already branded, so a
 * bad-faith `as SafeId` cast that bypassed workspaceId()/entityId() is
 * still caught here, at the point closest to actually producing output.
 */
export function assertSafeLogEvent(event: SafeLogEvent): void {
  if (typeof event !== "object" || event === null) {
    throw new RedactionViolationError(`event must be an object, received ${describeType(event)}`);
  }
  if (
    typeof event.category !== "string" ||
    !(SAFE_CATEGORIES as readonly string[]).includes(event.category)
  ) {
    throw new RedactionViolationError(
      `category must be one of the closed application category set, received ${describeType(event.category)}`,
    );
  }
  if (event.code !== undefined) {
    if (typeof event.code !== "string" || !(SAFE_CODES as readonly string[]).includes(event.code)) {
      throw new RedactionViolationError(
        `code must be one of the closed application code set, received ${describeType(event.code)}`,
      );
    }
  }
  if (event.id !== undefined) {
    if (typeof event.id !== "string" || !isSafeIdShape(event.id)) {
      throw new RedactionViolationError(
        `id must be a SafeId obtained from workspaceId()/entityId(), received ${describeType(event.id)}`,
      );
    }
  }
}

/**
 * Validates and serializes a SafeLogEvent to a single JSON line containing
 * only its allowlisted fields. Throws before producing any output if the
 * event is unsafe.
 */
export function formatSafeLogEvent(event: SafeLogEvent): string {
  assertSafeLogEvent(event);
  const record: SafeLogEvent = { category: event.category };
  if (event.code !== undefined) record.code = event.code;
  if (event.id !== undefined) record.id = event.id;
  return JSON.stringify(record);
}

export type SafeLogSink = (line: string) => void;

const defaultSink: SafeLogSink = (line) => console.error(line);

/**
 * Validates, then writes, a SafeLogEvent through the given sink (default:
 * console.error). Fails closed: an unsafe event throws and the sink is
 * never invoked, so no partial/unsafe content is ever written.
 */
export function logSafeEvent(event: SafeLogEvent, sink: SafeLogSink = defaultSink): void {
  const line = formatSafeLogEvent(event);
  sink(line);
}

/**
 * An Error whose message is exactly a safe, serialized SafeLogEvent — never
 * any wrapped/underlying error's message, stack, or cause. Frozen after
 * construction so a caller cannot mutate `.message`/`.category`/`.code`
 * (or attach new properties) into something unsafe after the fact.
 */
export class SafeError extends Error {
  readonly category: SafeCategory;
  readonly code?: SafeCode;

  constructor(event: SafeLogEvent) {
    const line = formatSafeLogEvent(event);
    super(line);
    this.name = "SafeError";
    this.category = event.category;
    this.code = event.code;
    Object.freeze(this);
  }
}

/** Validates event, then returns a frozen SafeError built from it. */
export function toSafeError(event: SafeLogEvent): SafeError {
  return new SafeError(event);
}

function allowlistedCodeOf(error: unknown): SafeCode | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const candidate = (error as { code: unknown }).code;
  return typeof candidate === "string" && (SAFE_CODES as readonly string[]).includes(candidate)
    ? (candidate as SafeCode)
    : undefined;
}

/**
 * Maps any caught value of unknown shape — a real Error, a malformed
 * error-like object, a thrown non-Error value — to a SafeLogEvent. Never
 * reads `.message`, `.stack`, or `.cause` from the unknown value, since any
 * of those may contain sensitive content from a lower-level exception.
 * `context.category`/`context.id` (already-validated, closed/branded
 * values known to the caller from its own operation, not derived from the
 * unknown error) are used unconditionally. A `.code` is preserved from the
 * unknown value only when it is already a member of the closed SAFE_CODES
 * set — matching the UPPER_SNAKE_CASE shape alone is not sufficient, since
 * a malicious or accidental thrown value could supply an arbitrary
 * matching-shaped code. Otherwise `context.code` is used, defaulting to the
 * fixed "UNKNOWN_ERROR" fallback.
 */
export function redactUnknownError(error: unknown, context: SafeLogEvent): SafeLogEvent {
  return {
    category: context.category,
    code: allowlistedCodeOf(error) ?? context.code ?? "UNKNOWN_ERROR",
    id: context.id,
  };
}
