# Implementation Plan: Text Sanitization Core Workflow

**Branch**: `001-text-sanitization-core` | **Date**: 2026-07-18 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-text-sanitization-core/spec.md`

## Summary

Deliver the local, deterministic core of Solari AI Sanitizer: isolated per-workspace
dictionaries; a bidirectional editor that automatically sanitizes original text and
restores sanitized text using only the active workspace's persisted mappings;
deterministic detection of structured sensitive values; an explicit-selection /
manual-add flow (never automatic semantic discovery) for ambiguous business terms
with persistent ALWAYS/NEVER decisions; prefix-based placeholder generation with
alias/principal-original support and permanent historical placeholders; persisted,
workspace-scoped pending decisions; and a dedicated dictionary/pending-decision
administration view.

Technical approach: a single-language Electron desktop application. Domain logic
(detectors, sanitizer, restorer, dictionary, prefix/placeholder allocation, alias
resolution, pending-decision store) lives in a framework-independent TypeScript
package with no Electron or React imports, run inside the Electron main process and
reachable from the sandboxed renderer only through a minimal, schema-validated IPC
boundary. Each workspace is physically isolated as its own SQLite database file.
No network access and no AI/local-model dependency are part of this feature. This
deliberately departs from the historical `discovery/` architecture, which paired
Electron with a separate Python/FastAPI sidecar in anticipation of a future
local-AI phase; that sidecar is deferred until a future local-AI feature
demonstrates a concrete requirement for it, and the domain layer's module
boundaries are kept clean enough that such an adapter could be added later
without moving the deterministic core out of TypeScript (research.md #9).

## Technical Context

**Language/Version**: TypeScript 5.x, running on the Node.js runtime bundled with
the pinned Electron release. **Planning baseline** (as of 2026-07-18): Electron
43.1.1, which bundles Node 24.18.0 — confirmed against Electron's own release
metadata at planning time. This is a baseline for design purposes only, not a
frozen version claim: implementation MUST verify and pin the exact Electron
version actually used (an exact `package.json` version, no `^`/`~` range) and
confirm the Node ABI it bundles before relying on any native-module or
Node-version-specific behavior (research.md #1, #10, #11).

**Implementation baseline** (as of 2026-07-19, Setup phase T002): pinned to
**Electron 43.1.0**, not the 43.1.1 planning baseline above. This is a
technical dependency-baseline correction, not a product requirement change:
43.1.1 was published within 7 days of the implementation date, and the
project's dependency-safety policy (global, non-negotiable) rejects installing
any package published in that window regardless of how minor the version
delta is. 43.1.0 was confirmed, by actually running it
(`process.versions.node`), to bundle the identical **Node 24.18.0** the
planning baseline already assumed — so this correction changes only the
Electron patch digit and affects no Node-ABI-dependent design decision in this
document or in research.md. `npm audit` reports zero vulnerabilities against
43.1.0. Re-verify 43.1.1 (or later) for adoption once it clears the
freshness window, if there is a concrete reason to move off 43.1.0.

**Primary Dependencies**: Electron (desktop shell + renderer sandboxing; its
built-in *asynchronous* `safeStorage` API — `isAsyncEncryptionAvailable()`,
`encryptStringAsync()`, `decryptStringAsync()` — for OS-backed key wrapping,
research.md #10 and #13; and its built-in `app.requestSingleInstanceLock()` for
single-instance enforcement, research.md #14), React (renderer UI), Monaco
Editor (bidirectional text panels — see research.md #4), better-sqlite3
(synchronous SQLite binding for Node — see research.md #1), Zod (IPC boundary
schema validation — see research.md #3), Node's built-in `crypto` module
(AES-256-GCM field encryption + HMAC blind indexing, research.md #10/#13) and
`worker_threads` (CPU-bound translation execution boundary, research.md #11) —
all built into Electron/Node, adding zero new dependencies. No Python/FastAPI
backend sidecar — deferred, see research.md #9. Deterministic
similarity/multi-pattern-matching approach resolved in research.md #2 and #5
without adding an AI/ML dependency. `better-sqlite3`, Playwright's Electron
support, `worker_threads`, and the `safeStorage` method names/signatures above
MUST be re-verified against the exact pinned Electron/Node ABI when
implementation begins (research.md #10) — none of them are assumed frozen from
this planning-time baseline.

**Storage**: SQLite (WAL mode), one database file per workspace (physical
isolation) plus a small top-level registry database for the workspace list — see
research.md #1. Reversible sensitive columns (`Term.original_value`,
`PendingDecision.candidate`) are AES-256-GCM-encrypted at rest with a
per-workspace key wrapped via OS-backed protection (macOS Keychain / Windows
DPAPI) — see research.md #10. `Workspace.name` is likewise AES-256-GCM-encrypted
at rest, using a separate, registry-level key (also `safeStorage`-wrapped)
rather than any per-workspace key, since a name must be readable and checked
for uniqueness before its own workspace — and per-workspace key — exists; see
research.md #13.

**Testing**: Vitest (domain-layer unit tests and IPC contract tests), Playwright's
Electron support (end-to-end acceptance tests driving full user stories) — see
research.md #7

**Target Platform**: Desktop — Windows 10/11 x64 and macOS 13+ (Apple Silicon and
Intel), fully offline-capable

**Project Type**: Single project, desktop application (Electron main process +
sandboxed renderer within one repository; no client/server network split — the
"backend" is the main process's domain layer, reachable only via IPC)

**Performance Goals**: Deterministic sanitize/restore of a qualifying input
completes within 2 seconds on the implementation's defined minimum supported
hardware (FR-SCALE-002, SC-018); automatic bidirectional updates after the user
pauses editing, not on every keystroke (FR-EDITOR-002/003); visible processing
feedback whenever an operation is not instantaneous (FR-SCALE-003)

**Constraints**: Fully offline (no outbound network in this feature); renderer
runs with `contextIsolation: true` and `nodeIntegration: false`, communicating with
domain logic only through a minimal preload-exposed, Zod-validated IPC API
(constitution Principle V); domain logic package has zero Electron/React
dependencies (constitution Principle V, "independent of any specific UI or
transport framework") — the one exception being that raw key material for
research.md #10's encryption is only ever unwrapped in the Electron main
process (`safeStorage` is main-process-only by design), while the actual
AES-256-GCM/HMAC operations remain plain, framework-independent functions in
`domain/crypto/`; CPU-bound sanitize/restore matching runs in a Node worker
thread, never on the main or renderer thread (research.md #11), so the UI stays
responsive per FR-SCALE-003; this application does not claim to defend against
an already-unlocked, compromised device (research.md #10's threat-model
statement); workspace deletion is crash-safe logical deletion, removal of live
key references, and best-effort reduction of recoverable state — **not** a
guaranteed cryptographic-erasure or secure-physical-deletion claim (research.md
#10, #12); exactly one instance of the application may run at a time against a
given `userData` directory, enforced by `app.requestSingleInstanceLock()`
acquired before any registry/workspace database is opened or any key is
unwrapped (research.md #14)

**Scale/Scope**: Single local user, one active workspace at a time; a single
pasted input of up to 500,000 Unicode characters; a single workspace dictionary of
up to 10,000 saved terms including aliases (FR-SCALE-001)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | Status | Notes |
|---|---|---|---|
| I | Local-First Privacy | PASS | No cloud backend; no outbound network calls anywhere in this feature (local AI is out of scope entirely — see spec Out of Scope); logs will carry only event metadata, never editor content, mappings, or key material (research.md #10's redaction rules); all cryptographic operations run locally. |
| II | Strict Workspace Isolation | PASS | One SQLite file per workspace, each with its **own** data-encryption key (research.md #10), makes cross-workspace lookup/allocation physically impossible rather than dependent on every query remembering a `WHERE workspace_id = ?` clause — see research.md #1. |
| III | Deterministic Core, Advisory Local AI | PASS | This feature has no AI component at all (deferred to a future phase, out of scope here); all detection, mapping lookup-before-allocation, and similarity comparison are deterministic — see research.md #2, #5, #6. |
| IV | Specification-First Development | PASS | This plan derives every design decision from a stable FR/SC ID in spec.md; data-model.md and contracts/ cite the FRs they satisfy. |
| V | Security by Default | PASS | Electron `contextIsolation`/`nodeIntegration` settings plus a minimal preload API give the required process isolation; all IPC payloads are Zod-validated and size-limited (`INPUT_TOO_LARGE`, untrusted-input rule); domain logic package is framework-independent so it can be hardened/tested independently of Electron or React; data at rest now goes beyond the constitution's floor of "least-privilege filesystem permissions" to authenticated encryption with OS-backed key protection, extended to workspace names via a separate registry-level key (research.md #10, #13); a single-instance application lock (research.md #14), acquired before any database or key access, prevents concurrent processes from racing key unwrap/rewrap or deletion reconciliation — see the justification note below for why none of this requires a specification change. |
| VI | Test-First Traceability | PASS | Vitest + Playwright, both fully offline; tests will reference FR IDs; only synthetic data anywhere in the repository, including encryption/key-loss and crash-safety test fixtures (research.md #10, #11, #12). |
| VII | Simplicity and Vertical Delivery | PASS | Single-language stack (TypeScript end-to-end) was chosen specifically to avoid building a second-language backend (e.g., a Python sidecar) that this feature does not need; no architectural complexity here is unjustified by a current FR. The sidecar is deferred, not rejected — see research.md #9 for why it can be revisited later without a rewrite. |

No violations — the Complexity Tracking table below is empty. Three substantial
additions were made to the Phase 0/1 design after initial review (encryption and
key management, a worker-thread execution boundary, and a crash-safe deletion
protocol); each is justified below rather than in a new Complexity Tracking row,
because none of them is complexity for a *new, unspecified* capability — each
hardens or correctly implements something spec.md **already** requires:

- **Encryption at rest** (research.md #10) protects `Term.original_value` and
  `PendingDecision.candidate`, both of which spec.md already requires this
  feature to persist (FR-PERSIST-001, FR-TERM-005, FR-PENDING-001/002) and which
  are, by the product's own stated purpose, confidential text. Leaving that
  already-required persisted data readable in plaintext would not add
  complexity — it would under-deliver on constitution Principle I for data the
  spec already commits to storing. This is compliance depth, not new scope.
- **The worker-thread execution boundary** (research.md #11) does not change
  *what* is computed — it changes *where* the already-required FR-SCALE-002/003
  computation runs, so the already-required responsiveness guarantee is actually
  met at the already-required 500,000-character / 10,000-term ceiling (FR-SCALE-001).
- **The crash-safe deletion protocol** (research.md #12) does not add a new
  capability beyond FR-WORKSPACE-005/006 — it corrects an inaccurate description
  of how that already-required deletion behaves under failure, which is a
  correctness fix, not new scope.
- **Workspace-name encryption** (research.md #13) protects `Workspace.name`,
  which spec.md already requires this feature to persist and keep unique
  (FR-WORKSPACE-001, spec Assumptions). A workspace name may itself be a real
  customer/company/engagement name — the same category of confidential text
  `Term.original_value` already gets encrypted for. Leaving it plaintext would
  under-deliver on constitution Principle I for data already committed to being
  stored; this is compliance depth reusing an already-established pattern
  (research.md #10), not a new capability.
- **The single-instance application lock** (research.md #14) does not add a new
  user-facing capability — it prevents a concurrency failure mode (two
  processes racing key unwrap/rewrap or deletion reconciliation against the
  same `userData` directory) that the already-required guarantees in
  research.md #10 and #12 silently assumed could not happen. Making that
  assumption explicit and enforced is a correctness fix for already-required
  behavior, not new scope.

No Complexity Tracking row is warranted because none of this is complexity
*beyond* what the current specification requires — it is complexity *required to
actually satisfy* what spec.md and the constitution already commit to.

**Post-Phase-1 re-check** (after `data-model.md`, `contracts/`, and `quickstart.md`
were generated): still PASS on all seven principles. Notably, Phase 1 design
*strengthened* two gates beyond their Phase 0 state rather than weakening them:
- **II (Strict Workspace Isolation)**: every IPC contract in `contracts/` takes an
  explicit `workspaceId` on every request instead of relying on main-process
  "current active workspace" state, removing an entire class of wrong-workspace
  bugs.
- **V (Security by Default)**: `contracts/translation.md` fixes the 500,000-
  character ceiling as an explicit `INPUT_TOO_LARGE` error condition, satisfying
  the "size-limited" half of the untrusted-IPC-input rule, not just "schema-
  validated."
- **VII (Simplicity)**: `data-model.md`'s "Modeling notes" section records three
  fields that were deliberately *not* added (timestamps/usage metadata, a `source`
  provenance field on Term) because no FR in spec.md requires them.

No new violations were introduced; the Complexity Tracking table remains empty.

**Second Phase-1 revision re-check** (encryption/key management, worker-thread
execution boundary, and crash-safe deletion protocol added after independent
review): still PASS on all seven principles; see the justification note above
Principle V/VII's rows for why none of this needed a new Complexity Tracking
entry. This revision also **corrected** two design defects rather than adding new
ones:
- `contracts/terms.md`'s `terms:edit` previously implied policy demotion to
  NEVER could require principal reassignment — contradicting `data-model.md`'s
  own (correct) constraint that `is_principal` is independent of `policy`. Fixed
  to match `data-model.md`; reassignment now applies only to `terms:remove`.
- `contracts/workspace.md`'s deletion description previously implied a single
  cross-resource transaction that cannot actually exist (a registry row and a
  separate file are not one transactional resource). Replaced with the five-step
  crash-safe protocol in research.md #12.

**Third Phase-1 revision re-check** (technical-accuracy pass, 2026-07-18): still
PASS on all seven principles. This revision **corrected** factual errors rather
than adding new scope:
- research.md #10 now specifies Electron's asynchronous `safeStorage` API —
  `isAsyncEncryptionAvailable()`, `encryptStringAsync()`,
  `decryptStringAsync()` — confirmed against Electron's official documentation
  at planning time, with a documented Base64 DEK-encoding step and an explicit
  requirement to re-verify the method surface against the pinned Electron
  version's own types before implementation relies on it (research.md #10).
- The prior revision's "cryptographic erasure" claim for workspace deletion
  overstated what setting `wrapped_dek` to `NULL` and deleting files actually
  guarantees. Corrected to an honest description — crash-safe logical deletion,
  removal of live key references, and best-effort reduction of recoverable
  state — with no claim of guaranteed cryptographic erasure or secure physical
  deletion (research.md #10, #12; `data-model.md`).
- `Workspace.name` was previously stored in plaintext in `registry.sqlite`
  despite being able to contain a real customer/company/engagement name.
  Added registry-level authenticated encryption plus a keyed blind index for
  uniqueness (research.md #13; `data-model.md`'s new `RegistryKey` table;
  `contracts/workspace.md`).
- No mechanism previously prevented two application processes from running
  concurrently against the same `userData` directory, which the encryption and
  deletion-reconciliation designs silently assumed could not happen. Added an
  explicit single-instance lock, acquired before any database or key access
  (research.md #14).
- The Technical Context's "currently Node 20 LTS" claim was stale/unsupported.
  Replaced with an explicit, dated planning baseline (Electron 43.1.1 / Node
  24.18.0) plus a requirement to verify and pin the exact version at
  implementation time — never assumed frozen from the planning date.

No new Complexity Tracking row is warranted — see the justification bullets
above the table for why each addition is compliance depth on an
already-required capability, not new scope. The Complexity Tracking table
remains empty.

**Fourth Phase-1 revision re-check** (constitution amendment 1.1.0,
2026-07-21): still PASS on all seven principles — Principle II now passes
**without reinterpretation**, rather than requiring one. This revision
corrects a wording gap between the constitution and the already-approved
design, not a design defect, and changes no implementation, task scope, or
product behavior:

- The previous constitution wording ("Deleting a workspace MUST remove its
  records transactionally...") conflicted with the already-approved
  cross-resource deletion design: no single atomic transaction can span
  `registry.sqlite`, a separate per-workspace SQLite file, and filesystem
  deletion (research.md #12). This plan's own "Second Phase-1 revision
  re-check" above had already corrected `contracts/workspace.md`'s wording to
  match that design, but the constitution's own Principle II text was not
  updated at that time — an oversight this revision closes.
- Constitution version 1.1.0 (`.specify/memory/constitution.md`) resolves the
  gap by restating Principle II's deletion guarantee as: an idempotent,
  resumable, crash-safe logical deletion protocol; rejection of new
  operations once deletion begins; the live wrapped-key reference removed
  before the database and companion files are deleted; convergence after
  interruption to full removal of both the registry row and the workspace
  files; explicit retention of real database transactions for mutations
  contained within one SQLite database; an explicit disclaimer that the
  application does not claim atomicity across independent databases and
  filesystem operations, nor guaranteed cryptographic erasure or secure
  physical deletion; and a continued requirement that product documentation
  disclose local-backup implications.
- Every registry-level SQLite mutation in the deletion protocol (mark
  `DELETING`, null `wrapped_dek`, delete the registry row) already runs as a
  single `better-sqlite3` statement against `registry.sqlite` — transactional
  guarantees within one database are unaffected and unweakened by this
  amendment.
- Cross-resource deletion (registry row + per-workspace file + `-wal`/`-shm`
  companions) uses the five-step idempotent, resumable, crash-safe protocol
  in research.md #12 and `src/main/persistence/deletion-reconciler.ts`
  (T039/T040) — unchanged by this amendment, since the design was already
  correct; only the constitution's description of what it guarantees was
  outdated.
- No implementation, task scope, or product behavior changed as part of this
  revision — this is a documentation/governance correction only.

No new Complexity Tracking row is warranted; the table remains empty.

## Project Structure

### Documentation (this feature)

```text
specs/001-text-sanitization-core/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md         # Phase 1 output (/speckit-plan command)
├── quickstart.md         # Phase 1 output (/speckit-plan command)
├── contracts/            # Phase 1 output (/speckit-plan command)
│   ├── workspace.md
│   ├── translation.md
│   ├── decisions.md
│   └── terms.md
└── tasks.md              # Phase 2 output (/speckit-tasks command - NOT created here)
```

### Source Code (repository root)

```text
src/
├── domain/                 # Framework-independent core logic (no Electron/React imports)
│   ├── workspace/           # create/rename/open/list/delete, registry access
│   ├── detectors/           # one module per FR-SANITIZE-005 structured-value category
│   ├── sanitizer/           # lookup-before-allocate, longest-match, recompute-on-change
│   ├── restorer/             # placeholder recognition, principal resolution, unresolved reporting
│   ├── dictionary/           # Term/Placeholder/Prefix/Alias logic (FR-PREFIX-*, FR-ALIAS-*, FR-TERM-*)
│   ├── pending-decisions/    # FR-PENDING-* store and lifecycle
│   ├── similarity/           # deterministic edit-distance comparison (research.md #2)
│   └── crypto/               # AES-256-GCM + HMAC blind-index primitives, given a raw key
│                              # (research.md #10) — pure functions, no Electron dependency,
│                              # so it is Vitest-testable with a synthetic test key
│
├── main/                    # Electron main process
│   ├── app-lifecycle.ts      # FIRST: acquires app.requestSingleInstanceLock()
│   │                          # (research.md #14) before anything below runs; then
│   │                          # window/process lifecycle; runs deletion reconciliation
│   │                          # at startup
│   ├── persistence/           # SQLite connection management per workspace, migrations
│   │   ├── key-manager.ts       # safeStorage async DEK wrap/unwrap for both the
│   │   │                        # per-workspace DEK (research.md #10) and the
│   │   │                        # registry-level DEK protecting Workspace.name
│   │   │                        # (research.md #13) — the only module allowed to
│   │   │                        # call safeStorage
│   │   └── deletion-reconciler.ts # crash-safe deletion protocol + startup reconciliation
│   │                              # (research.md #12)
│   ├── workers/                # worker_threads orchestration
│   │   └── translation-worker.ts  # worker entry point: message-transport/protocol
│   │                                # boundary (research.md #11); domain/sanitizer and
│   │                                # domain/restorer are wired into it once those
│   │                                # modules exist, not before (tasks.md T044/T079/T090)
│   └── ipc/                   # thin IPC handlers: validate (Zod) → call domain/ → respond
│
├── preload/                 # contextBridge-exposed minimal API surface (mirrors contracts/)
│
└── renderer/                # React UI
    ├── editor/                # bidirectional panels (Monaco wrappers), debounce logic,
    │                          # requestId supersession, processing-feedback indicator
    ├── decisions/             # pending-decision review UI, ALWAYS/NEVER + alias prompts
    ├── dictionary/             # dictionary administration view (Story 6)
    └── workspace/              # workspace create/rename/open/list/delete UI

tests/
├── unit/                    # domain/ logic (incl. crypto/), no Electron, references FR IDs
├── contract/                # IPC channel schema tests against contracts/*.md
└── integration/              # Playwright end-to-end: one suite per user story (P1–P6), plus
                               # dedicated suites for worker-thread responsiveness (research.md
                               # #11) and deletion crash-safety (research.md #12)
```

**Structure Decision**: Single-project Electron application as laid out above. The
`domain/` package (including the new `crypto/` module) has no dependency on
`main/`, `preload/`, or `renderer/`, so it can be unit-tested in complete
isolation and hardened independently, satisfying constitution Principle V.
`main/persistence/key-manager.ts` is the *only* module that calls `safeStorage`
(the OS-backed key wrap/unwrap boundary, covering both the registry-level DEK
and every per-workspace DEK); `main/workers/translation-worker.ts` is the *only*
place CPU-bound matching runs; `main/ipc/` is the only place request payloads
are validated and dispatched into `domain/`; `preload/` is the only bridge the
sandboxed `renderer/` ever talks to; `main/app-lifecycle.ts`'s single-instance
lock acquisition (research.md #14) is the first thing that runs, strictly
before any of the above touch a database, a key, or a worker.

## Complexity Tracking

No Constitution Check violations — this table is intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
