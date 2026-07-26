import { z } from "zod";
import { workspaceIdSchema } from "./common";
import { withValidationErrorMapping } from "../dispatch";

// Zod schemas for the `translation:*` channels (contracts/translation.md).
//
// FR-SCALE-001 / SC-016 fix the ceiling at "500,000 Unicode characters"
// without stating whether that means UTF-16 code units or Unicode code
// points. This codebase runs on Node/V8, where a JavaScript string's
// `.length` (and Zod's `.max()` on `z.string()`) counts UTF-16 code units,
// not code points — a character outside the Basic Multilingual Plane (e.g.
// many emoji) is 2 code units but 1 code point. No spec artifact states an
// alternate interpretation, so this schema counts UTF-16 code units
// (`.length`/`.max()`), consistent with how every other length-sensitive
// piece of this codebase (Node/V8 strings throughout) already measures
// string size. This is a documented interpretation choice, not a value
// derived from the contract text itself.
export const MAX_TRANSLATION_INPUT_LENGTH = 500_000;

// translation.md: "a renderer-generated, monotonically increasing
// requestId: number, scoped per (workspace, direction)". Monotonic
// *ordering* across requests is stateful orchestration logic (research.md
// #11's requestId-supersession bookkeeping) and deliberately not enforced
// here — a single stateless Zod schema cannot see prior requests. What a
// schema *can* enforce, and what "a renderer-generated, monotonically
// increasing" value implies about any single value in isolation, is that
// it is always a finite, non-negative, whole number within JavaScript's
// safe-integer range (a fractional, negative, infinite, NaN, or
// unsafe-integer requestId could never legitimately occur from an
// incrementing counter).
const requestIdSchema = z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// The INPUT_TOO_LARGE mapping is attached directly to each request schema
// as metadata (withValidationErrorMapping), not as a separately-supplied
// dispatch() option — so any ChannelDefinition built from these exported
// schemas carries the mapping automatically, with nothing left to forget.
export const translationSanitizeRequestSchema = withValidationErrorMapping(
  z.strictObject({
    workspaceId: workspaceIdSchema,
    requestId: requestIdSchema,
    originalText: z.string().max(MAX_TRANSLATION_INPUT_LENGTH),
  }),
  [{ field: "originalText", issueCode: "too_big", errorCode: "INPUT_TOO_LARGE" }],
);

export const translationSanitizeResponseSchema = z.strictObject({
  requestId: requestIdSchema,
  sanitizedText: z.string(),
});

export const translationRestoreRequestSchema = withValidationErrorMapping(
  z.strictObject({
    workspaceId: workspaceIdSchema,
    requestId: requestIdSchema,
    sanitizedText: z.string().max(MAX_TRANSLATION_INPUT_LENGTH),
  }),
  [{ field: "sanitizedText", issueCode: "too_big", errorCode: "INPUT_TOO_LARGE" }],
);

export const translationRestoreResponseSchema = z.strictObject({
  requestId: requestIdSchema,
  restoredText: z.string(),
  unresolvedPlaceholders: z.array(z.string()),
});
