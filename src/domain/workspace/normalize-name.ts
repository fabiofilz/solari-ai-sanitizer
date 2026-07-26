// Workspace-name normalization for blind-index comparison (research.md #2,
// #13: "the same case/diacritic/whitespace normalization already defined
// for prefixes and lookups"). No concrete case/diacritic/whitespace
// normalization function exists elsewhere in this codebase yet — the only
// fully-specified normalization algorithm anywhere is FR-PREFIX-003, which
// is a *prefix-shaping* transform (uppercase, spaces/hyphens to
// underscores, collapse, trim) owned by the not-yet-built, out-of-scope
// src/domain/dictionary/prefix-normalize.ts (T099, User Story 3) — not
// listed as a T034/T035 dependency, and not appropriate for a workspace
// *name* (which must remain human-readable text once decrypted, not be
// mangled into an identifier shape).
//
// This function implements exactly the three transforms research.md names
// for lookup normalization — case, diacritics, whitespace — and nothing
// else. It exists only for computing Workspace.normalized_name_hmac's
// input; the stored `name`/`name_ciphertext` always preserves the original
// text exactly as entered.

// Unicode "Combining Diacritical Marks" block (U+0300-U+036F): what NFD
// decomposition splits accents/diacritics into, separate from their base
// letter. Built from numeric code points (not literal combining characters
// or a \u escape in the regex source) so the pattern stays unambiguous
// regardless of editor/encoding.
const COMBINING_DIACRITICAL_MARKS_RANGE_START = 0x0300;
const COMBINING_DIACRITICAL_MARKS_RANGE_END = 0x036f;
const COMBINING_DIACRITICAL_MARKS_PATTERN = new RegExp(
  `[${String.fromCharCode(COMBINING_DIACRITICAL_MARKS_RANGE_START)}-${String.fromCharCode(COMBINING_DIACRITICAL_MARKS_RANGE_END)}]`,
  "g",
);
const WHITESPACE_RUN_PATTERN = /\s+/g;

export function normalizeWorkspaceName(rawName: string): string {
  return rawName
    .normalize("NFD")
    .replace(COMBINING_DIACRITICAL_MARKS_PATTERN, "")
    .toLowerCase()
    .trim()
    .replace(WHITESPACE_RUN_PATTERN, " ");
}
