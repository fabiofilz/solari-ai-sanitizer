import { z } from "zod";

// Shared IPC schema primitives (constitution Principle V; research.md #3).
// Every request/response object schema in this package is intentionally
// strict (z.strictObject) so an unexpected/extra field is rejected rather
// than silently ignored — none of contracts/*.md document a channel that
// accepts additional fields.

// Must stay in sync with src/main/persistence/db-connection.ts's
// CANONICAL_UUID_PATTERN (lowercase-only RFC 4122 textual form) — a
// workspaceId that would be rejected by the persistence layer must also be
// rejected here, before it ever reaches a domain-logic call.
const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const workspaceIdSchema = z
  .string()
  .regex(CANONICAL_UUID_PATTERN, "workspaceId must be a canonical UUID");

// A non-empty identifier that is not itself a workspaceId (Term/Placeholder/
// PendingDecision ids are per-workspace-file integer primary keys per
// data-model.md, represented as strings at the IPC boundary — no UUID shape
// is documented or required for these).
export const nonEmptyIdSchema = z.string().min(1, "identifier must not be empty");

// A required, non-empty content field (e.g. a name or original value) where
// an empty string is never meaningful.
export const nonEmptyStringSchema = z.string().min(1, "value must not be empty");

// data-model.md's Placeholder.rendered_value: "`${prefix.value}_${sequence}`,
// exactly one underscore before the sequence" — prefix.value is itself
// "[u]ppercase-letters-and-underscores form" (FR-PREFIX-002/003), and
// research.md #8 fixes the restoration-recognition pattern as
// `^[A-Z]+(?:_[A-Z]+)*_[0-9]+$`. Applied here to every `placeholderValue`
// field so a malformed value is rejected at the IPC boundary rather than
// only when domain logic later tries to parse it.
export const placeholderValueSchema = z
  .string()
  .regex(/^[A-Z]+(?:_[A-Z]+)*_[0-9]+$/, "placeholderValue must match PREFIX_N form");
