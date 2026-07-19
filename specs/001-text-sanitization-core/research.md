# Phase 0 Research: Text Sanitization Core Workflow

Each topic below resolves one open design question from `plan.md`'s Technical
Context. Format: Decision / Rationale / Alternatives considered.

## 1. Workspace persistence isolation strategy

**Decision**: One SQLite database file per workspace (e.g.
`<userData>/workspaces/<workspace-id>.sqlite`), plus one small top-level registry
database (`<userData>/registry.sqlite`) holding only `{id, name, created_at,
updated_at}` rows for the workspace list/rename/open UI (FR-WORKSPACE-001–004).

**Rationale**: FR-WORKSPACE-006 and constitution Principle II require that
cross-workspace lookup, suggestion, restoration, and identifier allocation are not
merely discouraged but impossible. A separate file per workspace makes this a
physical property of the architecture — a connection to workspace A's file has no
way to observe workspace B's rows — rather than a discipline that depends on every
query in the domain layer remembering a `WHERE workspace_id = ?` clause. It also
makes FR-WORKSPACE-005 (delete workspace) simple and atomic (delete one file inside
a crash-safe rename-then-delete sequence) and needs no extra work to guarantee "two
workspaces may map the same original value differently without any data leaking
between them" (spec Success Criteria, SC-005).

**Alternatives considered**:
- Single shared SQLite database with a `workspace_id` foreign key on every table.
  Rejected as the primary approach: every domain-layer query must remember to
  filter by workspace, and a single missed filter anywhere is a silent isolation
  bug — exactly the failure class Principle II calls out. It also does not let
  isolation be tested as "the architecture prevents this," only "the query
  happens to filter correctly today."
- One workspace database per file, but no persisted registry (derive the list by
  scanning the workspaces directory). Rejected: rename (FR-WORKSPACE-002) would
  either require renaming files (added filesystem-crash-safety complexity) or the
  registry would need to exist anyway to decouple the workspace's *name* from its
  *file*, so a registry is simpler in both directions.

## 2. Deterministic similarity comparison (FR-ALIAS-005, FR-ALIAS-008)

**Decision**: A normalized edit-distance ratio (Levenshtein-based), computed only
between a newly flagged/added candidate and the active workspace's existing
original values whose *current* policy is ALWAYS — never against another
unresolved pending decision (FR-PENDING-010) and never against a term whose
current policy is NEVER (FR-ALIAS-005) — using the same normalization already
defined for prefixes and lookups (case, diacritics, whitespace).

**Rationale**: The spec's Assumptions section already commits this to "deterministic
text comparison (e.g., normalized/fuzzy string matching)," explicitly not an AI/ML
technique (constitution Principle III: deterministic core, AI is optional and out
of scope for this feature entirely). Edit distance is simple to implement and
audit, has no need for a heavyweight dependency, and produces a stable 0–1 score
suitable for the advisory-only confidence indicator (FR-ALIAS-008) — it is never
trusted to merge terms automatically regardless of how high it scores
(AC/edge-case: 97%-confidence example in the spec still requires explicit
confirmation).

**Alternatives considered**:
- A third-party fuzzy-matching npm package instead of a hand-rolled function. Left
  open for `/speckit-tasks` to decide as an implementation detail (a small, pinned,
  audited dependency is acceptable under the constitution's supply-chain rule) —
  the decision fixed *here* is the algorithm family (edit distance), not the
  package.
- Token-set / Jaccard similarity on word tokens. Rejected as the primary metric:
  it handles reordered multi-word names well but scores the spec's own worked
  example poorly ("Synthetic Bank" vs. "Synthetic Bank SA" is already a strong
  edit-distance match); can be layered in later without a spec change if
  real-world false negatives appear.
- Semantic/embedding-based similarity. Rejected outright: it would require a
  model, which is out of scope for this feature (Principle III, spec Out of
  Scope).

## 3. IPC boundary schema validation

**Decision**: Zod schemas define the request and response shape of every
preload-exposed IPC channel; the main process validates every incoming payload
against its schema before any domain-logic handler runs, and rejects invalid
payloads without executing handler logic.

**Rationale**: Constitution Principle V: "All inputs crossing a process, IPC, or
API boundary MUST be schema-validated, size-limited, and treated as untrusted."
Zod is TypeScript-native — schemas double as compile-time types, so the contract
documented in `contracts/` cannot silently drift from the implementation's types.
It has no native/binary dependency, keeping the supply-chain surface small.

**Alternatives considered**:
- Hand-written manual validation functions. Rejected: easy to let drift from the
  TypeScript types, more error-prone, and produces no reusable schema artifact.
- io-ts or ajv + JSON Schema. Viable alternatives; not chosen because Zod's
  inference and composability best fit a small TypeScript codebase, but this is a
  low-risk, easily revisited choice that does not affect the contract shapes
  documented in `contracts/`.

## 4. Editor component for 500,000-character bidirectional panels

**Decision**: Monaco Editor for both panels, in plain-text mode (no language
services that are not needed), with the automatic-translation update
(FR-EDITOR-002/003) triggered on a debounced content-change event rather than per
keystroke, and the destination panel's content set through Monaco's model API in a
way that does not itself re-fire that debounced handler (FR-EDITOR-007's
no-feedback-loop rule).

**Rationale**: Monaco is a proven choice for large single-document editing (it is
VS Code's own editor), and its model/decoration APIs make "replace only the
matched spans, preserve everything else exactly" (FR-SANITIZE-004 and the
restoration preservation rules) straightforward without full-document
re-renders — important at the 500,000-character scale required by FR-SCALE-001.

**Alternatives considered**:
- CodeMirror 6. A strong, more modular alternative with excellent large-document
  virtualization. Not chosen only because Monaco already has a validated pattern
  for this exact bidirectional-diff use case; switching later if bundle size
  becomes a problem would not require a spec change.
- A plain `<textarea>`. Rejected: no practical way to preserve line/column-precise
  decorations or keep the UI responsive (FR-SCALE-003) at 500,000-character scale
  without reimplementing what an editor component already provides.

**Implementation note (Setup phase T003, 2026-07-19)**: pinned to
**`monaco-editor@0.53.0`**, not the newer `0.55.1` initially considered.
`0.55.1` (and `0.54.x`) pull in `dompurify` as a dependency of Monaco's
markdown-hover renderer, and the installed `dompurify` version carried
multiple open moderate-severity XSS advisories (`npm audit`) with no patched
release inside `monaco-editor`'s own dependency range at pin time. `0.53.0`
has no `dompurify` dependency at all — the markdown-hover/language-service
renderer that pulls it in is exactly the kind of feature this decision already
says is unneeded ("plain-text mode, no language services that are not
needed"), so dropping to `0.53.0` removes the vulnerable dependency entirely
rather than working around it, at no functional cost to this feature's actual
use of Monaco. `npm audit` reports zero vulnerabilities against `0.53.0`.

## 5. Deterministic multi-pattern matching at scale

**Decision**: A single-pass Aho-Corasick automaton built from the active
workspace's known original values (terms whose current policy is ALWAYS) plus the
deterministic structured-value regexes, matched once, left-to-right, over the
input; overlapping matches are resolved by preferring the longest match at a given
start position (FR-SANITIZE-003) before a single replacement pass is applied.

**Rationale**: A naive "one scan per known term" approach cannot reliably meet the
2-second budget (FR-SCALE-002 / SC-018) as the dictionary grows toward its
10,000-term minimum (FR-SCALE-001) against a 500,000-character input. Aho-Corasick
finds all dictionary matches in one linear pass regardless of dictionary size —
the standard algorithm for "many known substrings, one long text."

**Alternatives considered**:
- Naive per-term `String.includes`/regex loop. Rejected: does not scale to the
  specified worst case within the 2-second budget; fine for a handful of terms but
  not a safe default at 10,000.
- One combined regular expression alternating all terms. Rejected: catastrophic-
  backtracking risk and practical regex-engine limits on alternation count at
  10,000 terms; Aho-Corasick avoids both.

## 6. Deterministic structured-value detectors (FR-SANITIZE-005 categories)

**Decision**: A dedicated, independently unit-tested detector module per category
— email, phone, CPF/CNPJ (with checksum validation), IPv4/IPv6, UUID, JWT/bearer
token shape, private-key PEM headers, common secret/password assignment patterns,
cloud account/subscription/tenant/project identifier shapes, ARNs, database
connection-string shapes, and labeled business-identifier `key = value` / `key:
value` patterns — each returning a normalized match plus its category.

**Rationale**: Small, independently testable detectors directly support Principle
VI (one test file per detector, each test citing its FR-SANITIZE-005 category) and
let one category's pattern be corrected later without risking a regression in an
unrelated category.

**Alternatives considered**:
- One large combined regex. Rejected: unreadable, untestable in isolation, and a
  single edit risks silently breaking an unrelated category.
- A third-party PII-detection library. Rejected for this feature: most such
  libraries are probabilistic/ML-based (conflicts with Principle III's
  deterministic-core requirement) or pull in dependencies far beyond what this
  fixed set of structured formats needs.

## 7. Testing strategy

**Decision**: Vitest for domain-layer unit tests (detectors, sanitizer, restorer,
dictionary, prefix normalization, pending-decision store) and IPC contract tests
(validating every channel's Zod schema against representative valid/invalid
payloads); Playwright's Electron support for end-to-end tests that drive the full
application through each user story's acceptance scenarios.

**Rationale**: Matches Principle VI's requirement for automated coverage traceable
to specific requirement IDs, and its "core automated tests MUST run offline" rule
— both Vitest and Playwright run entirely locally with no network calls.

**Alternatives considered**:
- Jest. A very close alternative; not chosen because Vitest's native
  TypeScript/ESM support avoids extra transpilation configuration in an
  Electron+TS project. Low-risk, easily revisited.
- Spectron. Rejected: no longer maintained; Playwright's Electron support is the
  current standard for this kind of end-to-end testing.

## 8. Placeholder-token recognition for restoration

**Decision**: Restoration scans sanitized input for tokens matching
`^[A-Z]+(?:_[A-Z]+)*_[0-9]+$` at word boundaries (consistent with the placeholder
shape fixed by FR-PREFIX-002/005), looks each candidate token up against the
active workspace's placeholder table, and replaces only tokens with an actual
match — anything else, including text that merely looks like a placeholder, is
left untouched and reported per the unresolved-placeholder rules (FR-RESTORE
behavior in User Story 2 and its edge cases).

**Rationale**: This directly operationalizes the existing spec edge case that
placeholder-pattern recognition applies only during restoration and only for
placeholders the active workspace actually generated — a lookup-gated match (not a
blind pattern replace) is what makes that guarantee possible.

**Alternatives considered**: None material — this follows directly from the
placeholder format already fixed by FR-PREFIX-005.

## 9. Desktop application architecture: Electron + TypeScript only (Python/FastAPI sidecar deferred)

**Decision**: Electron with a single TypeScript/Node.js runtime end-to-end — no
separate backend process, no Python. Domain logic lives in the
framework-independent `src/domain/` package (`plan.md` Project Structure),
running inside the Electron main process and reachable from the renderer only
through the Zod-validated IPC boundary (research.md #3). This deliberately
departs from the historical `discovery/` architecture
(`discovery/specs/007-architecture.yaml`, `discovery/docs/architecture.md`),
which paired an Electron+React renderer with a separate Python/FastAPI/SQLAlchemy
backend sidecar over an authenticated loopback HTTP API.

**Rationale**: The sidecar's entire purpose in the discovery material was to host
a Python-based local-AI integration point (Ollama) for a later phase — this
feature (the deterministic core) has no AI component at all; local AI is
explicitly out of scope (spec.md Out of Scope). Building a second language
runtime, a second build/test toolchain, a sidecar process-lifecycle manager, and
an authenticated loopback HTTP API now, to serve a capability this feature does
not include, is exactly the complexity constitution Principle VII prohibits
without justification ("Architectural complexity beyond what the current
specifications require MUST be explicitly justified in a specification change
before it is built"). No specification currently requires it, so it is deferred,
not built.

This is a **deferral, not a rejection**: if a future local-AI feature
specification demonstrates a concrete requirement that TypeScript/Node cannot
reasonably satisfy, a Python sidecar (or any other architecture) can be
reconsidered then, against that feature's actual needs. Two properties of the
current design keep that door open cheaply, without building anything for it
now:

- Ollama's own interface is a loopback HTTP API (constitution Principle III:
  local AI is reached only at "a model endpoint verified as a loopback local
  address"). Node can call that API directly with no Python intermediary, so
  Python was never strictly *necessary* even for the future case discovery
  anticipated — it was a convenience choice there, not a technical requirement.
- The domain layer's advisory-adjacent logic — the deterministic similarity
  module (research.md #2) — is a plain TypeScript module with a narrow, explicit
  signature (compare one candidate against the active workspace's ALWAYS terms,
  return an advisory suggestion or none), called from the sanitizer/alias-
  resolution code and not entangled with Electron, the renderer, or the IPC
  layer. A future local-AI feature could introduce an additional, optional
  advisory source consulted the same way (constitution Principle III: local AI
  "may suggest... but MUST NOT persist... without explicit user confirmation")
  without restructuring or relocating today's deterministic core. Nothing about
  that future adapter is built, stubbed, or referenced by this feature — only the
  module boundary that would let it be added later without moving the
  deterministic core out of TypeScript.

**Alternatives considered**:
- Electron (React/TS renderer) + Python/FastAPI/SQLAlchemy sidecar (discovery's
  historical architecture). Rejected for this feature: two languages, two
  toolchains, and a sidecar lifecycle to build, secure, and test — none of which
  any FR in spec.md requires today. Revisit only if a future local-AI
  specification shows TypeScript/Node cannot meet its needs.
- Tauri + Rust core. Rejected: a bigger departure from any existing project
  material, and introduces a third language (Rust) with no current requirement
  driving it either.

## 10. Local-at-rest protection for reversible sensitive data (encryption & key management)

Every `Term.original_value` and `PendingDecision.candidate` is, by definition, the
exact confidential text the product exists to protect (company names, person
names, business identifiers the deterministic detectors didn't already catch).
Storing them in a plain, human-readable SQLite file would let anyone with
filesystem access to the device read out everything the product is supposed to
keep confidential — directly undermining constitution Principle I ("Original
text... MUST remain on the user's device at all times") even though the data
technically never leaves the device. This is not a hypothetical future need; it
follows directly from data spec.md already requires this feature to persist
(FR-PERSIST-001, FR-TERM-005, FR-PENDING-001/002), so hardening it does not
require a specification change — it fulfills Principles I and V more completely
for a persistence requirement that already exists.

### Decision

**Application-level authenticated field encryption**: `Term.original_value` and
`PendingDecision.candidate` are encrypted with **AES-256-GCM** (Node's built-in
`crypto` module — no new dependency) using a per-workspace 256-bit data
encryption key (DEK). The DEK itself is never stored in plaintext: it is wrapped
with **Electron's `safeStorage` API**, which transparently uses macOS Keychain or
Windows DPAPI depending on platform (also built into Electron — no new
dependency). The wrapped DEK blob is stored on the workspace's row in
`registry.sqlite`, not inside the per-workspace file it protects. Every other
column (`Placeholder.rendered_value`, `Prefix.value`, `policy`, `is_principal`,
sequence numbers) stays plaintext — none of it is reversible to a sensitive
original value, so encrypting it would add cost with no confidentiality benefit
and would slow down the uniqueness/sequence operations that need to stay fast.

Dedup/uniqueness for the encrypted columns uses a **blind index**: instead of a
plaintext `normalized_lookup` (which would itself reveal the sensitive value,
just case/diacritic-folded), the schema stores `normalized_lookup_hmac =
HMAC-SHA256(index_subkey, normalized_form)` — a deterministic MAC that supports
exact-match uniqueness/dedup lookups (same normalized input always produces the
same HMAC) without ever storing anything readable. `index_subkey` is derived from
the workspace DEK via HKDF, kept distinct from the AES-256-GCM encryption subkey
(standard key-separation practice: never reuse one key for two different
cryptographic purposes). The same pattern applies to `PendingDecision`'s
`normalized_candidate` → `normalized_candidate_hmac`.

A blind index only supports **exact match**, not substring search. FR-TERM-002's
free-text dictionary search therefore decrypts the (at most 10,000) `Term` rows
into memory and filters in plaintext there — see "Performance impact" below for
why this stays well inside budget.

### Rationale — why this over the alternatives

| Option | Assessment |
|---|---|
| Unencrypted SQLite + restrictive filesystem permissions only | Rejected as the sole protection: permissions control *who can open the file*, not what's readable *once* it's opened by that same OS user (or copied off the device) — the requirement explicitly frames these values as sensitive at rest, which permissions alone do not address. Restrictive permissions are still applied underneath the encryption (see below) as defense in depth. |
| SQLCipher (whole-database encryption) | Rejected for this feature: it requires a SQLCipher-compatible native build of the SQLite driver across three target architectures (Windows x64, macOS x64/arm64), a real supply-chain and build-toolchain cost `better-sqlite3` (already chosen, research.md #1) does not have with its mainstream prebuilt binaries. It would also encrypt columns that do not need it (placeholder/prefix values), and does not, by itself, solve the "exact-match dedup without storing plaintext" problem any more simply than the blind-index approach above — the same normalization index question exists either way. |
| Application-level field encryption (chosen) | Encrypts only what's actually sensitive; uses zero new dependencies (`crypto` and `safeStorage` are both already part of the chosen stack); WAL/SHM files inherit the same protection automatically, since SQLite itself only ever sees ciphertext for these columns (see "WAL/SHM" below) — a benefit whole-file encryption also has, but without the native-binary cost. |

### Key lifecycle

**API note**: this section uses Electron's *asynchronous* `safeStorage` API —
`safeStorage.isAsyncEncryptionAvailable()`, `safeStorage.encryptStringAsync(plainText)`,
and `safeStorage.decryptStringAsync(encrypted)` — confirmed against Electron's
official documentation at planning time (2026-07-18). The synchronous
`encryptString`/`decryptString` pair also exists but is deliberately not used
here: it can block on OS keychain/DPAPI access, which would violate "must not
block application startup or the main event loop" below. Because the exact
method surface can still shift between Electron releases, **implementation MUST
re-verify these three method names and signatures against the pinned Electron
version's own type definitions (`electron.d.ts`) before relying on them**, and
add a small contract test (research.md #7) that calls all three against a real
Electron main-process test harness — not a mock — early in implementation, so
any drift is caught immediately rather than assumed.

- **Representation**: every DEK — the per-workspace DEK below and the
  registry-level DEK in research.md #13 — is a random 256-bit value
  (`crypto.randomBytes(32)`). Because `encryptStringAsync`/`decryptStringAsync`
  operate on strings, not raw bytes, the DEK is Base64-encoded
  (`rawDek.toString('base64')`) before being passed to `encryptStringAsync`, and
  the decrypted result is validated and decoded back
  (`Buffer.from(result, 'base64')`, asserting the decoded length is **exactly**
  32 bytes — anything else is treated as corruption / `WORKSPACE_KEY_UNAVAILABLE`,
  never silently truncated or padded) after unwrapping.
- **Creation**: when a workspace is created (`FR-WORKSPACE-001`), a fresh
  256-bit DEK is generated, Base64-encoded, and wrapped with
  `await safeStorage.encryptStringAsync(dekBase64)`; the returned `Buffer` is
  stored as-is on that workspace's registry row (`wrapped_dek`). Neither the raw
  DEK nor its Base64 form is ever written to disk.
- **Loading**: opening a workspace for any operation that needs plaintext access
  (translation, term/pending-decision reads or writes) calls
  `const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(wrapped_dek)`
  in the Electron **main** process only (the only process `safeStorage` is
  available in), decodes `result` from Base64 back to the 32-byte raw DEK, and
  derives its two subkeys (encryption, HMAC index) via HKDF. The unwrapped DEK
  and its derived subkeys live in memory only, for as long as the workspace
  stays open, and are discarded when the workspace is closed or the app exits.
  Being fully asynchronous and awaited off the synchronous call stack, this
  never blocks application startup or the main event loop, even if the
  underlying OS keychain/DPAPI call is momentarily slow — this is the concrete
  reason the async API is required here, not merely preferred.
- **Key-rotation / re-encryption indication**: if `shouldReEncrypt` is `true`
  (Electron signals the OS-backed wrapping key has rotated or a stronger one is
  now available), the application re-wraps immediately —
  `const rewrapped = await safeStorage.encryptStringAsync(result)` — and
  persists `rewrapped` as that row's new `wrapped_dek` before continuing to use
  the now-decoded DEK. This applies identically to the registry-level DEK
  (research.md #13). It changes nothing user-visible: it is transparent
  maintenance of the OS-level wrapping layer, not a rotation of the DEK itself
  (see "Rotation" below for that separate, not-currently-built operation). The
  exact handling MUST follow whatever `decryptStringAsync`'s documented return
  shape is for the pinned Electron version at implementation time — this
  document records the shape confirmed at planning time, not a guarantee it is
  frozen forever.
- **Wrapping** is platform-delegated: on macOS, `safeStorage` stores the wrapping
  key in Keychain, scoped to the signed application and the OS user account; on
  Windows, it uses DPAPI, scoped to the OS user account. Neither requires this
  application to manage a master key itself.
- **Rotation** (of the DEK itself — not the wrapping-key re-encryption above):
  not required by any current FR, so it is not built now — but the design does
  not block it: rotating a workspace's DEK is a well-defined operation (decrypt
  every row with the old DEK, generate a new DEK, re-encrypt, wrap the new DEK,
  replace the registry blob) that could be added later without changing the
  storage shape. This is a documented assumption, not a shipped feature
  (constitution Principle VII).

### Database opening & failure behavior

1. Read the workspace's `wrapped_dek` from `registry.sqlite`.
2. Call `await safeStorage.isAsyncEncryptionAvailable()`. If `false` (no usable
   OS-backed key store — e.g., a broken keychain, an unusual environment) the
   application refuses to create or open **any** workspace and shows a clear,
   blocking message explaining that secure local storage is unavailable. It
   never falls back to storing a key or sensitive values unprotected — Security
   by Default applies "without compromise."
3. Attempt `await safeStorage.decryptStringAsync(wrapped_dek)`, then Base64-decode
   and length-validate `result` (see "Representation" above). If the call
   rejects (corrupted blob, OS-side key no longer valid) or the decoded length
   is not exactly 32 bytes, that specific workspace becomes inaccessible with a
   `WORKSPACE_KEY_UNAVAILABLE` error (see "Key loss" below); other workspaces
   are unaffected, since each has its own DEK. If `shouldReEncrypt` is `true`,
   re-wrap and persist per "Key-rotation / re-encryption indication" above
   before proceeding.
4. Open the per-workspace SQLite file (`better-sqlite3`, WAL mode). Encrypted
   columns are decrypted lazily, row by row, as the domain layer reads them —
   never as a bulk "decrypt the whole file" step.

### Key loss

If the OS-protected key material becomes unavailable — the user resets their
keychain, moves the `userData` directory to a machine under a different OS user
account, or Windows DPAPI state tied to the profile is lost — `safeStorage`
cannot unwrap that workspace's DEK, and there is **no other copy or backdoor by
design**. The honest consequence: **that workspace's original values become
permanently unrecoverable.** The application must state this plainly to the user
rather than imply a recovery path exists, consistent with spec.md's existing
Assumption that no automatic backup/export is provided for this feature. If a
future backup/export feature is specified, it will need to address key export as
part of that design — out of scope here.

### Workspace deletion & key destruction — honest scope

Deleting a workspace (FR-WORKSPACE-005, and the crash-safe protocol in research
topic #12) sets the workspace's `wrapped_dek` to `NULL` as an explicit, early
step, then removes the per-workspace file and its `-wal`/`-shm` companions,
then removes the registry row. **This document deliberately does not describe
this as guaranteed cryptographic erasure.** What it actually provides:

- **Crash-safe logical deletion**: the five-step protocol (research.md #12) is
  idempotent and resumable, so a crash mid-deletion always converges to a fully
  deleted end state rather than leaving a half-deleted, inconsistent one.
- **Removal of live key references**: after step 3, this application retains no
  reference — wrapped or unwrapped — to the workspace's DEK anywhere it
  controls. It has removed the *only key it knows about* that could decrypt
  that workspace's ciphertext through this application's own code paths.
- **Deletion of the workspace database, WAL, and SHM files**: step 4 removes
  `<id>.sqlite`, `<id>.sqlite-wal`, and `<id>.sqlite-shm` via the OS's normal
  file-delete operation.
- **Best-effort reduction of recoverable application state**: taken together,
  these steps meaningfully shrink what a later attacker with filesystem or
  device access could recover through ordinary means.

What this does **not** guarantee:

- **No guarantee of secure physical deletion.** SQLite's rollback/WAL
  machinery, the host filesystem, filesystem snapshots (e.g., APFS snapshots,
  Windows Volume Shadow Copy), and any backup software running on the device
  may retain copies of prior page images — including pages that once held the
  now-deleted ciphertext — independent of anything this application does.
  Flash-storage wear-leveling and copy-on-write behavior on SSDs also mean
  "deleted" blocks are not guaranteed to be overwritten. This design makes no
  attempt to force any of that and cannot verify it did not happen.
- **No guarantee of cryptographic erasure.** Setting `wrapped_dek` to `NULL`
  (and later deleting the registry row) removes this application's *reference*
  to the wrapped key; it does not, by itself, prove the OS-level `safeStorage`
  wrapping key (the macOS Keychain item or Windows DPAPI-protected material)
  has been destroyed, nor that no other copy of the wrapped or unwrapped DEK,
  or of the ciphertext it protected, survives somewhere this application does
  not control (a prior WAL checkpoint, a filesystem snapshot, a backup, an SSD
  remnant, OS swap/hibernation files, or process memory not yet overwritten).
  Any of those could, in principle, still be combined with a surviving copy of
  the OS wrapping key to recover the data. This is stated plainly rather than
  implied away.

**Stronger cryptographic erasure is out of scope for this feature.** Achieving
an actual erasure guarantee would require a materially different design — for
example, a dedicated per-workspace entry in the OS key store (rather than one
shared `safeStorage` wrapping key reused across all workspaces' DEKs), so that
deleting *that specific OS-level key* is itself the erasure event, combined
with explicit best-effort overwrite-before-delete of the workspace file. No
current FR requires this level of guarantee; if a future specification does,
it should be designed and justified then, against that specification's actual
threat model, rather than partially built here.

### Threat model — honest limitations

This design protects against: a lost/stolen device, a different OS user account
on a shared machine, or a copied-off database file being opened elsewhere.

This design does **not** protect against a device that is already unlocked and
compromised while the legitimate user is logged in: `safeStorage`/Keychain/DPAPI
will unwrap the key for **any** process running as that authenticated OS user by
design — that is what those OS mechanisms are for. Malware or an attacker with
interactive or code-execution access to an already-unlocked session can access
the same data the legitimate application can. This limitation is stated here
plainly rather than implied away.

It also does **not** protect against physical recovery of deleted data by
someone with direct storage-media access after deletion — see "Workspace
deletion & key destruction — honest scope" above for exactly what deletion
does and does not guarantee.

### Performance impact (preserving FR-SCALE-001/002)

Encryption overhead applies only to the **dictionary** (≤ 10,000 short strings),
never to the 500,000-character editor input — original/sanitized/restored text
is never persisted at all (spec.md Assumptions), so it is never encrypted or
decrypted. AES-256-GCM on a handful of thousand short strings, and the equal
number of HMAC computations for the blind index, cost low single-digit
milliseconds in aggregate — negligible against the 2-second FR-SCALE-002 budget.
To avoid repeating this decrypt-on-every-call, the decrypted dictionary is cached
in memory as the versioned snapshot handed to the translation worker (research
topic #11), rebuilt only when the dictionary actually changes.

### Platform-appropriate application-data locations

- **macOS**: `~/Library/Application Support/<AppName>/` — Electron's default
  `app.getPath('userData')` already resolves here; no override needed.
- **Windows**: explicitly set `app.setPath('userData', ...)` to a path under
  `%LOCALAPPDATA%\<AppName>\`, **not** Electron's own default (which derives from
  `app.getPath('appData')`, i.e. `%APPDATA%`, the **roaming** profile path).
  Roaming profiles can be synchronized by domain policy to a network location —
  undesirable for data whose entire value proposition is "never leaves this
  device." This override is a deliberate, documented deviation from Electron's
  default.

### Filesystem permissions

- **macOS**: create the `userData` directory and every file in it with mode
  `0700`/`0600` (owner read/write/execute only) explicitly at creation time
  (`fs.mkdirSync(..., { mode: 0o700 })` and equivalent file-creation flags) —
  never rely on the OS default umask alone.
- **Windows**: rely on the default per-user-profile ACL inheritance under
  `%LOCALAPPDATA%`, which already restricts access to the owning account and
  Administrators; no custom ACL manipulation is added, since that would be real
  native-code complexity with no current requirement forcing it. The application
  performs a best-effort startup check that the directory is not unexpectedly
  world-readable and warns if so, without attempting to silently "fix" ACLs
  itself.

### Database, WAL, SHM, temporary-file, backup, and migration handling

- SQLite runs in **WAL mode** (research.md #1). Because encryption happens in
  the domain layer *above* the SQLite driver, the bytes SQLite itself ever
  writes — to the main file, the `-wal` file, or the `-shm` file — are already
  ciphertext for the encrypted columns. No separate WAL/SHM protection step is
  needed; this is an automatic consequence of field-level (rather than
  driver-level) encryption.
- No rollback-journal mode is used (WAL avoids it), so no `-journal` temp file
  is expected in normal operation.
- No automatic backup mechanism exists for this feature (spec.md Assumptions,
  unchanged). If a user manually copies a workspace file outside the app for
  their own backup, it remains encrypted at rest — a useful side effect, not a
  designed backup feature.
- Schema migrations run inside a single SQLite transaction against one
  workspace file at a time; migrations that do not touch encrypted columns
  never need the DEK. Only one schema version exists at this feature's MVP, so
  no encrypted-column migration path is needed yet.

### Preventing accidental Git inclusion

The application's real `userData` directory is never used by tests or local
development runs — those use a temporary directory created per test/dev-run and
torn down afterward, so no real (even synthetic-only) database file is ever
adjacent to the repository. The repository's `.gitignore` additionally excludes,
defensively: `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`, `*.sqlite-journal`, and
any local dev-data directory (e.g., `.dev-userdata/`) — belt-and-suspenders
against an accidental commit, consistent with constitution Principle VI's
absolute prohibition on committing local databases.

### Redaction rules for logs, errors, crash output, and diagnostics

No log line, thrown error, or diagnostic output may ever include: a decrypted
original value or candidate, the raw or wrapped DEK, a derived subkey, or a
nonce/ciphertext blob. Failures reference IDs and categories only — for example,
"decryption failed for termId `<id>` in workspace `<id>`," never the attempted
plaintext or the bytes involved. This operationalizes constitution Principle I's
existing logging restriction specifically for the encryption subsystem; it
applies equally to the worker thread introduced in research topic #11.

### Testing note

Every test and example — including encryption/decryption round-trip tests, key-
loss simulations, and the blind-index dedup tests — uses synthetic values only
(constitution Principle VI), the same as every other test in this project.

## 11. CPU-bound translation execution boundary (Node worker threads)

### Decision

Sanitize/restore matching (the Aho-Corasick pass over up to 500,000 characters
against up to 10,000 known terms, research.md #5) runs in a dedicated **Node
`worker_threads` Worker**, one per open workspace, never on the Electron main
thread or the renderer thread. The deterministic core itself stays
framework-independent TypeScript (constitution Principle V) — `worker_threads`
is a Node built-in, not an Electron or React dependency, so the domain layer's
algorithms (`domain/sanitizer`, `domain/restorer`, `domain/detectors`) remain
directly unit-testable with Vitest with no worker involved; only their
production call path routes through the worker.

### Rationale

FR-SCALE-002/SC-018 require sanitize/restore to complete within 2 seconds, and
FR-SCALE-003 requires the UI to stay responsive with visible feedback whenever an
operation is not instantaneous. A synchronous, single-threaded Aho-Corasick pass
at the full 500,000-character / 10,000-term ceiling is CPU-bound work that, if
run on Electron's main thread, would block **all** IPC handling and the
renderer's message pump for its duration — freezing the entire application, not
just the editor. Moving only the CPU-bound matching pass to a worker thread
keeps the main thread free to keep handling IPC (including a later, superseding
translation request) and keeps the renderer able to paint a progress indicator.

### Design

**Renderer responsibilities**:
- Debounce input changes per FR-EDITOR-002/003 (research.md #4) before sending a
  `translation:sanitize` / `translation:restore` request.
- Attach a **monotonically increasing `requestId`**, scoped per (workspace,
  direction) pair, generated by the renderer.
- On receiving a response, compare its `requestId` against the highest one seen
  so far for that (workspace, direction). If the response is not the latest, 
  **discard it** — this is what prevents a slow, superseded request from
  overwriting newer editor content (FR-EDITOR-007's no-feedback-loop guarantee
  extends naturally to this case).
- Show a visible processing indicator (FR-SCALE-003) if a request has not
  resolved within a short perceptual threshold; never block user input while
  waiting.

**Electron main process responsibilities** (persistence + orchestration, not
computation):
- IPC validation (Zod, research.md #3) and workspace resolution.
- SQLite CRUD for `Term`/`Placeholder`/`Prefix`/`PendingDecision` — these are
  single-row, sub-millisecond operations on at most 10,000 rows and are **not**
  CPU-bound, so they are justified to stay on the main thread rather than adding
  IPC-within-IPC complexity to move them to the worker too. What must never
  happen is repeated database access *inside* the hot matching loop itself — the
  worker never touches SQLite directly (see below).
- Maintaining a **dictionary version counter** per open workspace, incremented on
  any Term/Placeholder/Prefix mutation.
- Decrypting the current ALWAYS-term dictionary (research.md #10) into a plain,
  in-memory snapshot **only when the version changes**, and sending that
  snapshot to the workspace's worker via `postMessage`, tagged with its version
  number. A request against an up-to-date worker snapshot skips this step
  entirely.
- Creating the workspace's worker when the workspace is opened (or lazily, on
  first translation request); terminating it when the workspace is closed or the
  app exits.
- Detecting worker crashes (`'error'`/`'exit'` events): in-flight requests for
  that worker are failed back to the renderer with a translation error, and a
  fresh worker is created and re-seeded with the current dictionary snapshot so
  subsequent requests can proceed — this is the failure-recovery path.
- Enforcing **supersession, not preemptive cancellation**, for stale in-flight
  work: at most one translation request per (workspace, direction) is considered
  "current" at a time. If a new request arrives while an older one for the same
  (workspace, direction) is still running, the older one's eventual result is
  simply tagged as stale and dropped when it completes (the renderer would
  discard it anyway via `requestId`, so the main process does the same
  bookkeeping to avoid needless IPC traffic back to the renderer). True
  mid-computation preemption was considered and rejected as unnecessary
  complexity: Aho-Corasick is linear and the 500,000-character ceiling
  comfortably fits the 2-second budget, so no single job runs long enough to
  make preemption worth its complexity.

**Worker responsibilities** (pure computation, no persistence):
- Receive the decrypted dictionary snapshot (only on version change) and, per
  request, the input text plus direction.
- Build or reuse the Aho-Corasick automaton (sanitize) or the placeholder-token
  scanner (restore, research.md #8) from the current snapshot.
- Perform the matching/replacement pass and return the transformed text (plus
  `unresolvedPlaceholders` for restore) via `postMessage`.
- Never opens the SQLite file, never makes a network call, and never logs the
  plaintext dictionary, input, or output — only structural error information on
  failure (research topic #10's redaction rules apply here too).

### Tests

- **Unit** (Vitest): the domain algorithms are exercised directly, with
  synthetic inputs at the 500,000-character / 10,000-term ceiling, to verify
  correctness and measure raw execution time against the 2-second budget —
  without needing a real worker thread.
- **Integration/end-to-end** (Playwright): a test that sends a
  500,000-character synthetic input against a 10,000-term synthetic dictionary
  and asserts the **renderer stays responsive during the operation** — e.g., a
  concurrent UI interaction (typing in an unrelated field, an animation frame
  callback) continues to fire while translation is in flight. This is the
  property that actually proves "does not freeze the UI"; measuring only total
  completion time would not distinguish "fast because non-blocking" from "fast
  because it happened to finish before anyone noticed the freeze."
- A dedicated test simulates a worker crash mid-request and asserts the renderer
  receives a clear failure and a subsequent request succeeds against a
  freshly-recovered worker.

### Project structure impact

Adds `src/main/workers/translation-worker.ts` (the `worker_threads` entry point,
which wires `domain/sanitizer` and `domain/restorer` to `parentPort` messaging)
and a worker-lifecycle/version-tracking module under `src/main/persistence/` —
see the updated Project Structure in `plan.md`.

## 12. Crash-safe, idempotent workspace deletion protocol

### Decision

Workspace deletion (FR-WORKSPACE-005/006) is **not** described as a single
atomic transaction spanning the registry database and the per-workspace SQLite
file — no such single-transaction primitive exists across two independent
storage resources (a row in `registry.sqlite` and a separate file on disk). It is
instead a **five-step, idempotent, resumable protocol**, tracked by an explicit
`status` column (`ACTIVE | DELETING`) on the workspace's registry row, with a
**startup reconciliation pass** that completes any deletion interrupted by a
crash.

### Why this correction matters

The previous description ("registry row and file removed together,
transactionally") was misleading: if the process crashes between removing the
registry row and removing the file (or vice versa), the result is either an
orphaned file with no registry entry, or a registry entry pointing at a file that
no longer exists — neither of which "a transaction" can prevent when the two
resources are not the same transactional store.

### Protocol

1. **Mark deleting**: a single, real SQLite transaction against
   `registry.sqlite` sets the workspace's `status` to `DELETING`. From this
   instant, every IPC request scoped to this `workspaceId` (`translation:*`,
   `decisions:*`, `terms:*`, and `workspace:open`) is rejected with
   `WORKSPACE_DELETING` — this is what "prevention of new operations once
   deletion begins" means concretely. `workspace:list` omits or visibly disables
   workspaces in this state.
2. **Close resources**: the main process closes any open `better-sqlite3`
   connection to the workspace's file and terminates its translation worker
   (research topic #11), discarding its in-memory dictionary snapshot.
3. **Destroy the key** (remove the live key reference): the workspace's
   `wrapped_dek` column (research topic #10) is set to `NULL` — a single atomic
   update against `registry.sqlite`. From this instant, this application no
   longer retains any reference — wrapped or unwrapped — to that workspace's
   DEK, **independent of whether the next step succeeds**. This is a best-effort
   reduction of recoverable application state, not a guaranteed cryptographic-
   erasure claim — see research.md #10's "Workspace deletion & key destruction"
   for the honest scope of what this does and does not provide.
4. **Destroy the data** (logical deletion): delete the per-workspace file and its
   `-wal`/`-shm` companions. A missing file at this point (already deleted by a
   prior, interrupted attempt) is treated as success, not an error.
5. **Finalize**: delete the workspace's row from `registry.sqlite` entirely.

Every step is individually **idempotent**: re-running step 3 on an
already-`NULL` key is a no-op; re-running step 4 on an already-absent file
catches `ENOENT` and continues; re-running step 5 on an already-absent row is a
no-op. This is what makes the protocol safely resumable rather than needing
exactly-once execution.

### Startup reconciliation

On every application startup, before any workspace is opened, the main process
scans `registry.sqlite` for rows with `status = DELETING` and resumes the
protocol above from wherever it was interrupted, inferred from state:
- `wrapped_dek` still present → resume from step 2/3.
- `wrapped_dek` already `NULL`, file still present → resume from step 4.
- `wrapped_dek` already `NULL`, file already absent → resume from step 5.

### Missing and orphaned files

- **Registry row `ACTIVE`, file unexpectedly missing** (e.g., deleted outside
  the app): the next access attempt surfaces a clear "workspace data file
  missing" error rather than crashing; the user is offered the option to remove
  the now-meaningless registry entry (effectively finishing a deletion the user
  performed manually).
- **File present, no matching registry row** (a truly orphaned file — e.g., from
  before this reconciliation logic existed): left untouched and never
  auto-opened or listed. Silently auto-deleting an unrecognized file would be a
  surprising destructive action with no user awareness; a manual cleanup
  affordance is a reasonable future enhancement but is out of scope for this
  feature.

### Retry behavior

If any step fails (e.g., the file is locked by another process, a permission
error), the workspace simply remains in `DELETING` state; the next application
startup's reconciliation pass retries automatically, and the renderer may also
offer a manual "retry delete" action, which calls the same deletion entry point
against an already-`DELETING` workspace — treated as a resume, not a new
deletion.

### Filenames are never derived from user-provided names

Per-workspace files are always named from the internally generated workspace
`id` (a UUID), never from the user-supplied `name` (FR-WORKSPACE-001). This was
already the shape in `data-model.md` and is retained deliberately: it avoids
path-traversal or filesystem-unsafe characters in a user-chosen name, avoids
needing to rename files when a workspace is renamed (FR-WORKSPACE-002), and
avoids collisions between similarly named workspaces after any sanitization of
the name for filesystem use.

### Tests

An integration test harness simulates a crash **after each of the five steps**
(a test-only fault-injection hook, or literally terminating and restarting the
process under test) and asserts that running startup reconciliation afterward
always converges to a consistent end state: eventually zero registry row and
zero file for that workspace, with no intermediate state left dangling
regardless of which step the simulated crash occurred after.

### Project structure impact

Adds a `deletion-reconciler.ts` module under `src/main/persistence/` (the
protocol implementation and the startup reconciliation scan) — see the updated
Project Structure in `plan.md`.

## 13. Workspace name protection at rest

`Workspace.name` (spec.md FR-WORKSPACE-001) may itself be a real customer,
company, engagement, or project name — exactly the category of confidential
text this product exists to protect elsewhere (research.md #10). Leaving it
plaintext in `registry.sqlite` while `Term.original_value` is encrypted would
leave the single most identifying piece of data — "which real client is this
workspace for" — as the one thing readable in plain text by anyone with
filesystem access. This is not a new requirement; it hardens data spec.md
already requires this feature to persist (FR-WORKSPACE-001), the same
justification pattern as research.md #10.

### Decision

**A registry-level DEK**, separate from every per-workspace DEK, protects
`Workspace.name` with the identical pattern already established in research.md
#10: AES-256-GCM authenticated encryption for the value, an HKDF-derived HMAC
blind index for exact-match uniqueness, and `safeStorage`'s asynchronous API
(research.md #10) to wrap the raw key. This is the smallest design consistent
with the existing per-workspace key architecture — it reuses the same
primitives and the same key-separation discipline at one additional scope,
rather than inventing a second scheme.

A registry-level (rather than per-workspace) key is required because
uniqueness must be checked, and a name must be encrypted, **before** a
workspace — and therefore its own per-workspace DEK — exists yet.

### Design

- **Storage**: a new singleton `RegistryKey` table in `registry.sqlite` (see
  `data-model.md`) holding one row: the registry DEK, Base64-encoded and
  wrapped via `safeStorage.encryptStringAsync` (research.md #10's API and
  encoding rules apply identically here). Created on first application launch
  or first workspace creation, whichever comes first. It is never destroyed by
  any individual workspace's deletion — it protects the shared `Workspace.name`
  column across every row, not any one workspace's other data.
- **Subkey separation**: exactly as in research.md #10, the registry DEK is
  never used directly for two purposes — HKDF derives a distinct encryption
  subkey (AES-256-GCM, for `name_ciphertext`) and index subkey (HMAC-SHA256, for
  `normalized_name_hmac`) from the single registry DEK.
- **Uniqueness**: `Workspace.normalized_name_hmac = HMAC-SHA256(registry
  index_subkey, normalized_form)`, where `normalized_form` reuses the exact
  same case/diacritic/whitespace normalization already defined for prefixes and
  lookups (research.md #2, #8). This gives application-wide,
  normalization-aware uniqueness (spec.md Assumptions: names are unique
  application-wide) via a `UNIQUE` constraint on `normalized_name_hmac`, without
  ever storing a plaintext or folded-plaintext name.
- **Listing and renaming**: `workspace:list` decrypts every `ACTIVE` row's
  `name_ciphertext` with the registry DEK's encryption subkey to build its
  response (bounded by the number of workspaces a single local user actually
  creates — not the 10,000-term dictionary ceiling — so this stays trivially
  fast; no FR requires a specific workspace-count ceiling). `workspace:rename`
  computes the new name's `normalized_name_hmac`, re-checks uniqueness, and
  only then re-encrypts and updates both columns; the old ciphertext/HMAC are
  simply overwritten, since no historical-name retention is required by any FR.
- **Loading and failure behavior**: before any workspace can be created,
  opened, listed, or renamed, the registry DEK must be available. If
  `safeStorage.isAsyncEncryptionAvailable()` is `false`, or
  `decryptStringAsync` on the stored `RegistryKey.wrapped_dek` fails or yields
  a decoded value that is not exactly 32 bytes, the application refuses **all**
  workspace name operations — create, rename, list, open — with a clear,
  blocking `REGISTRY_KEY_UNAVAILABLE` error (`contracts/workspace.md`). This is
  a harder gate than a single workspace's `WORKSPACE_KEY_UNAVAILABLE`
  (research.md #10): the registry DEK gates the entire workspace list, not one
  workspace's content, so there is no partial-availability path to fall back
  to. It never falls back to plaintext names — Security by Default "without
  compromise."
- **Interaction with per-workspace DEKs**: fully independent keys serving
  fully independent purposes — the registry DEK exists exactly once per
  installation and only ever protects `Workspace.name`; each workspace's own
  `wrapped_dek` (research.md #10) exists once per workspace and only ever
  protects that workspace's `Term`/`PendingDecision` rows. Neither key can
  decrypt data protected by the other. Losing one workspace's DEK affects only
  that workspace's dictionary; it has no effect on the registry DEK or any
  workspace name, including that workspace's own name (which remains readable
  and renameable even if its dictionary content becomes inaccessible).
- **Migration and deletion implications**: deleting a workspace
  (research.md #12) removes its `Workspace` row — `name_ciphertext` and
  `normalized_name_hmac` included — as part of step 5, but never touches the
  shared `RegistryKey` row, which persists for every remaining workspace. There
  is no per-workspace migration step for name encryption, since the registry
  DEK is installation-scoped, not workspace-scoped, from the start.
- **No plaintext workspace names anywhere**: not in `registry.sqlite`, not in
  its `-wal`/`-shm` companions, not in logs, not in thrown errors or diagnostic
  output (research.md #10's redaction rules apply identically to
  `Workspace.name`), not in per-workspace filenames (already UUID-only,
  research.md #12), and not in command-line arguments — test and automation
  harnesses (Playwright, `npm` scripts) must never pass a workspace name as a
  process argument or set it as a process title, since either would leak it
  into the OS process list (`ps`, Task Manager) in plaintext, defeating the
  point of encrypting it everywhere else.

### Alternatives considered

- **Encrypt `name` with each workspace's own per-workspace DEK instead of a
  shared registry-level key.** Rejected: uniqueness must be checked, and a name
  must be readable, before a workspace exists — including before creation
  succeeds and before that workspace's own DEK is generated. A registry-scope
  key is required regardless of what encrypts the name; reusing it for the
  encryption itself avoids introducing a third key scheme.
- **Store each workspace name directly as an individual OS keychain
  entry** (one Keychain/DPAPI item per workspace, no SQLite column at all).
  Rejected: OS keychains are not designed for many small structured, queryable
  records; they offer no uniqueness/search primitive, and would likely surface
  workspace names in the OS's own keychain-management UI — arguably *worse*
  exposure than an encrypted SQLite row, and adds a second storage system for
  what is otherwise a one-column addition to an existing table.

### Tests

Unit tests (Vitest) cover: registry DEK creation/wrap/unwrap round-trip
(synthetic key material only, constitution Principle VI), blind-index
uniqueness (same normalized name is rejected as `DUPLICATE_NAME`, differently
cased/diacritic variants of the same name are also rejected), and a
`REGISTRY_KEY_UNAVAILABLE` simulation analogous to research.md #10's key-loss
test. An integration test opens `registry.sqlite` directly with a plain SQLite
connection after creating a synthetic-named workspace and asserts the name
does not appear anywhere in the file or its `-wal`/`-shm` companions in
plaintext or folded form (`quickstart.md`'s encryption sanity check).

### Project structure impact

`main/persistence/key-manager.ts` (research.md #10) is extended to also own
registry-DEK creation/wrap/unwrap, rather than adding a second file, since it
is already the *only* module allowed to call `safeStorage` — see the updated
Project Structure in `plan.md`.

## 14. Single-instance application lock

### Decision

The application acquires Electron's `app.requestSingleInstanceLock()` as the
**very first** action in the main process's startup sequence — before
`registry.sqlite` is opened, before any per-workspace file is opened, before
the registry DEK or any per-workspace DEK is unwrapped, before any
`worker_threads` translation worker is created, and before the startup
deletion-reconciliation pass (research.md #12) runs. If the call returns
`false`, this process is a second, redundant launch: it calls `app.quit()`
immediately and performs none of the steps above. If it returns `true`, this
process is the sole owner of the application's data for this `userData`
directory, and startup continues normally; it also registers an
`app.on('second-instance', ...)` handler that focuses (and un-minimizes, if
needed) its existing window whenever a later launch attempt is detected.

### Rationale

None of the concurrency guarantees this feature otherwise relies on —
per-workspace physical isolation (research.md #1), the crash-safe deletion
protocol's assumption that reconciliation runs against a consistent view
(research.md #12), or safe DEK unwrap/rewrap (research.md #10) — are designed
to tolerate **two independent OS processes** operating on the same
`userData` directory at once. Two concrete failure modes this prevents:

- **Concurrent deletion reconciliation**: if two processes both scan
  `registry.sqlite` for `DELETING` rows at startup, both could attempt the
  same deletion step on the same workspace simultaneously — most steps are
  individually idempotent (research.md #12), but idempotency was designed
  assuming *sequential* retries after a crash, not literally concurrent
  execution from two live processes racing the same SQLite writes.
- **Duplicate/racing key rewraps**: if `shouldReEncrypt` (research.md #10)
  fires in both processes for the same DEK at nearly the same time, both could
  independently re-wrap and write competing `wrapped_dek` values, and there is
  no defined "last write wins is safe" guarantee for that race today.

**Why SQLite WAL/busy-timeout is not the mechanism used for this**: WAL mode
safely lets multiple readers, and multiple writers via busy-timeout retries,
share one SQLite *file* — but that only makes individual SQL statements safe
to interleave. It does nothing to prevent two independent processes from each
unwrapping keys into their own separate memory, each running their own
translation worker pool, or each believing it alone is responsible for startup
reconciliation. The single-instance lock eliminates this entire class of
cross-process concurrency up front, rather than relying on SQLite-level
statement concurrency to make an already-hazardous situation merely safe at
the SQL level.

### Design

- **Acquisition order** (enforced, not just described): `requestSingleInstanceLock()`
  → (if `false`) `app.quit()` and stop → (if `true`) proceed to open
  `registry.sqlite`, unwrap the registry DEK, run startup deletion
  reconciliation (research.md #12), and only then create the main
  `BrowserWindow`. A second process that fails to acquire the lock never
  reaches any of these steps — it never opens SQLite, never calls
  `safeStorage`, never starts a worker, and never runs reconciliation.
- **Focus behavior**: the `second-instance` event handler on the surviving
  process focuses its existing window (restoring it if minimized), giving the
  user the expected "app is already open" experience rather than silence or a
  confusing second window.
- **Clean shutdown and abnormal termination**: the lock is process-lifetime-
  scoped and managed internally by Electron/the OS (a lockfile or named
  socket, depending on platform) — it is automatically released whenever the
  holding process exits, whether via clean shutdown, a crash, or a force-kill.
  No manual cleanup or stale-lock recovery logic is needed in this
  application's own code; this is a deliberate contrast with the crash-safe
  deletion protocol (research.md #12), which *does* need manual reconciliation
  because SQLite files, unlike this OS-level lock, are not process-lifetime-
  scoped.

### Tests

- An integration/end-to-end test (Playwright's Electron support, research.md
  #7) launches a first instance against a temporary `userData` directory,
  confirms it is running, then attempts to launch a second instance against
  the **same** directory. Assertions: the second process exits promptly and
  never creates a lock on its own; the first instance's window receives a
  focus/restore signal; no `registry.sqlite`/per-workspace file/WAL/SHM state
  changes are attributable to the second process (e.g., no new SQLite
  connection, no new worker thread spawned) — this is what actually proves the
  second process never touched persistence or keys, not merely that it exited
  quickly.
- A companion test force-terminates the first instance (simulating a crash,
  not a clean quit) and then launches a fresh instance against the same
  `userData` directory, asserting the new process acquires the lock normally
  and starts up without any stale-lock error — proving abnormal termination
  does not require manual lock cleanup.

### Project structure impact

`main/app-lifecycle.ts` gains the lock-acquisition step as its first
responsibility, ordered strictly before the SQLite/key/worker/reconciliation
steps it already owned — see the updated Project Structure in `plan.md`.
