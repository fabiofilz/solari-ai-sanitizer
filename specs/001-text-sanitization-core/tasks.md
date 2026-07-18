---

description: "Task list template for feature implementation"
---

# Tasks: Text Sanitization Core Workflow

**Input**: Design documents from `/specs/001-text-sanitization-core/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (workspace.md, translation.md, decisions.md, terms.md), quickstart.md — all present.

**Tests**: Included. Constitution Principle VI ("Test-First Traceability") requires automated coverage for every critical business rule and security requirement, written and confirmed to fail before the implementation is considered complete; research.md #7 fixes Vitest (unit + IPC contract tests) and Playwright's Electron support (end-to-end) as the testing strategy. Every test task in this document — including every Foundational-phase test — precedes the implementation task(s) it verifies.

**Organization**: Tasks are grouped by user story (spec.md priorities P1–P6) to enable independent implementation and testing of each story, after a Setup and Foundational phase that both the constitution's security requirements (encryption, IPC validation, single-instance lock, crash-safe deletion) and every story equally depend on.

**Remediation note (2026-07-18)**: This revision applies a full remediation pass against `/speckit-analyze` findings C1, C2, G1, G2, G3, G4, G5, F1, and G6 — see the end-of-file changelog for a summary of what changed and why.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US6)
- Exact file paths are included in every task description

## Path Conventions

Single-project Electron application per plan.md's Project Structure:
`src/domain/`, `src/main/`, `src/preload/`, `src/renderer/`, `tests/unit/`, `tests/contract/`, `tests/integration/`, `.github/workflows/` at the repository root.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization, toolchain configuration, and the CI quality-gate pipeline (constitution Principle VI)

- [ ] T001 Create the Electron + TypeScript + React project structure per plan.md's Project Structure (src/domain, src/main, src/preload, src/renderer subfolders; tests/unit, tests/contract, tests/integration)
- [ ] T002 Initialize package.json with pinned TypeScript 5.x and an exact-pinned Electron version (no `^`/`~` range) matching the Electron 43.1.1 / Node 24.18.0 planning baseline, flagged for re-verification at implementation time (plan.md Technical Context)
- [ ] T003 [P] Add and pin React, Monaco Editor, better-sqlite3, and Zod as production dependencies with `--save-exact` (research.md #1, #3, #4)
- [ ] T004 [P] Add and pin Vitest and Playwright (`@playwright/test` with Electron support) as dev dependencies with `--save-exact` (research.md #7)
- [ ] T005 [P] Configure tsconfig.json with strict mode and separate compile targets for src/main, src/preload, and src/renderer
- [ ] T006 [P] Configure ESLint and Prettier for the project
- [ ] T007 [P] Configure vitest.config.ts for domain-layer unit tests and IPC contract tests
- [ ] T008 [P] Configure playwright.config.ts for Electron end-to-end tests
- [ ] T009 [P] Add .gitignore entries for `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`, `*.sqlite-journal`, and any local dev-data directory (research.md #10 "Preventing accidental Git inclusion")
- [ ] T010 Implement a temporary per-test/per-dev-run userData directory helper so tests and `npm run dev` never touch the real userData path (research.md #10)
- [ ] T011 [P] Implement the GitHub Actions CI workflow (`.github/workflows/ci.yml`) with a **macOS + Windows job matrix** that runs, in order: a **specification-validation** step (re-running `.specify/scripts/bash/check-prerequisites.sh` plus a script asserting tasks.md has sequential, non-duplicate task IDs and that every `[Story]`-labeled task's cited FR/SC IDs exist in spec.md), a **Prettier format-check** step, an **ESLint** step, and a **`tsc --noEmit`** type-checking step across src/main, src/preload, and src/renderer — gating every pull request to main (constitution Principle VI required quality gates: specification validation, formatting, linting, type checking)
- [ ] T012 Extend the CI workflow (`.github/workflows/ci.yml`) with the **Vitest unit/contract suites** and the **Playwright e2e suite**, run as blocking steps on both matrix legs (constitution Principle VI "automated test suites" gate) (depends on T011)
- [ ] T013 Extend the CI workflow (`.github/workflows/ci.yml`) with a **dependency-vulnerability audit** step (`npm audit --audit-level=high`, or equivalent) governed by an explicit failure policy — the job MUST fail on any actionable (fixable) high/critical advisory and MUST NOT silently ignore or globally suppress audit failures; a vulnerability with no available fix may only be waived via a committed, reviewed allowlist entry naming the advisory ID, the justification, and an expiry date, after which the waiver must be re-justified or the job fails again — plus an **application build-verification** step that runs the Electron packaging/build command on both the macOS and Windows matrix legs and fails the job on any build error (constitution Principle VI "dependency audit" and "build verification for every supported platform" gates) (depends on T011)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Security, persistence, IPC, and process infrastructure that every user story depends on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

**Ordering note**: every test task below is written and confirmed to fail *before* its corresponding implementation task, per constitution Principle VI. The subsection order also now reflects real dependencies: the IPC schema/dispatch boundary (needed by every handler) is built before the first handlers that use it (workspace bootstrap); key management is built before both workspace bootstrap (which wraps a DEK) and the deletion protocol (which nulls one); the deletion protocol is built before the app-lifecycle module that runs it at startup.

### Encryption primitives

- [ ] T014 [P] Unit tests for AES-256-GCM round-trip correctness, HKDF subkey separation, and blind-index determinism using synthetic keys, written and confirmed to fail before any crypto primitive exists, in tests/unit/domain/crypto.test.ts (constitution Principle VI; research.md #10)
- [ ] T015 [P] Implement AES-256-GCM encrypt/decrypt primitives (nonce + ciphertext + auth tag) in src/domain/crypto/aes-gcm.ts, making T014's AES-GCM assertions pass (research.md #10)
- [ ] T016 [P] Implement HKDF subkey derivation producing a distinct encryption subkey and HMAC index subkey from one raw DEK in src/domain/crypto/hkdf.ts, making T014's HKDF assertions pass (research.md #10)
- [ ] T017 [P] Implement the HMAC-SHA256 blind-index primitive for deterministic exact-match lookups in src/domain/crypto/blind-index.ts, making T014's blind-index assertions pass (research.md #10)

### Persistence schema

- [ ] T018 [P] Define the registry.sqlite schema and migration for the RegistryKey and Workspace tables per data-model.md in src/main/persistence/registry-schema.ts
- [ ] T019 [P] Define the per-workspace sqlite schema and migration for the Prefix, Placeholder, Term, and PendingDecision tables per data-model.md in src/main/persistence/workspace-schema.ts
- [ ] T020 Implement SQLite connection management (better-sqlite3, WAL mode) for registry.sqlite and per-workspace files, including platform-appropriate userData paths (macOS default, Windows explicit `%LOCALAPPDATA%` override) and 0700/0600 permission creation on macOS, in src/main/persistence/db-connection.ts (research.md #1, #10) (depends on T018, T019)

### IPC validation boundary

- [ ] T021 [P] Contract tests validating the intended Zod request/response schema for every channel in all four namespaces (`workspace`, `translation`, `decisions`, `terms`) against representative valid/invalid payloads drawn directly from contracts/*.md, written and confirmed to fail before the schema modules exist, in tests/contract/ipc-schemas.test.ts (constitution Principle VI; research.md #7)
- [ ] T022 [P] Define Zod request/response schemas for the `workspace:*` channels per contracts/workspace.md in src/main/ipc/schemas/workspace.schema.ts, making T021's workspace assertions pass
- [ ] T023 [P] Define Zod request/response schemas for the `translation:*` channels, including the 500,000-character `INPUT_TOO_LARGE` ceiling, per contracts/translation.md in src/main/ipc/schemas/translation.schema.ts, making T021's translation assertions pass
- [ ] T024 [P] Define Zod request/response schemas for the `decisions:*` channels per contracts/decisions.md in src/main/ipc/schemas/decisions.schema.ts, making T021's decisions assertions pass
- [ ] T025 [P] Define Zod request/response schemas for the `terms:*` channels per contracts/terms.md in src/main/ipc/schemas/terms.schema.ts, making T021's terms assertions pass
- [ ] T026 Implement a shared IPC dispatch helper that validates every incoming payload against its Zod schema before invoking domain logic, and rejects any `workspaceId`-scoped request with `WORKSPACE_DELETING` while that workspace's registry status is `DELETING`, in src/main/ipc/dispatch.ts (constitution Principle V; data-model.md deletion state machine) (depends on T022-T025)

### Key management

- [ ] T027 [P] Unit tests for key-manager: wrap/unwrap round-trip, the `shouldReEncrypt` re-wrap path, and `WORKSPACE_KEY_UNAVAILABLE`/`REGISTRY_KEY_UNAVAILABLE` failure handling against a mocked `safeStorage`, written and confirmed to fail before key-manager.ts exists, in tests/unit/main/key-manager.test.ts (constitution Principle VI; research.md #10, #13)
- [ ] T028 Implement key-manager.ts: `safeStorage.isAsyncEncryptionAvailable()` gate, DEK wrap/unwrap via `safeStorage.encryptStringAsync`/`decryptStringAsync` with Base64 encode/decode and exact-32-byte length validation, and `shouldReEncrypt` re-wrap handling, for both the registry DEK and every per-workspace DEK, in src/main/persistence/key-manager.ts, making T027 pass (research.md #10, #13) — the only module allowed to call `safeStorage`
- [ ] T029 Add a startup check that verifies `safeStorage.isAsyncEncryptionAvailable`/`encryptStringAsync`/`decryptStringAsync` exist with the expected signatures against the pinned Electron version's own `electron.d.ts`, failing fast with a clear message otherwise (plan.md Technical Context; research.md #10) (depends on T028)

### Redaction

- [ ] T030 [P] Unit test for the redaction helper: assert log/error/diagnostic output never includes a decrypted value, raw/wrapped DEK, derived subkey, or nonce/ciphertext blob, referencing only IDs and categories, written and confirmed to fail before the helper exists, in tests/unit/main/redact.test.ts (constitution Principle I; research.md #10 redaction rules)
- [ ] T031 Implement a shared logging/error helper that redacts decrypted values, raw/wrapped DEKs, derived subkeys, and nonce/ciphertext blobs from every log line, thrown error, and diagnostic, referencing only IDs and categories, in src/main/logging/redact.ts, making T030 pass (research.md #10 redaction rules; constitution Principle I)

### Workspace bootstrap (create + open only — full CRUD is US5)

- [ ] T032 [P] Unit tests for domain/workspace create and open: name normalization + HMAC-based uniqueness enforcement, DEK generation/wrapping on create, and name-decrypt/DEK-unwrap on open, written and confirmed to fail before create.ts/open.ts exist, in tests/unit/domain/workspace/create-open.test.ts (FR-WORKSPACE-001/003; constitution Principle VI)
- [ ] T033 [P] Contract test for the `workspace:create` and `workspace:open` request/response shapes and error codes (`DUPLICATE_NAME`, `REGISTRY_KEY_UNAVAILABLE`, `NOT_FOUND`, `WORKSPACE_KEY_UNAVAILABLE`), written and confirmed to fail before the handlers exist, in tests/contract/workspace-bootstrap.test.ts (contracts/workspace.md; constitution Principle VI) — the only `workspace:*` channels needed before any user story can be exercised; `workspace:rename`/`list`/`delete` get their own contract test in US5 (T128)
- [ ] T034 Implement domain/workspace create: normalize and HMAC-check name uniqueness against the RegistryKey blind index, encrypt the name with the registry DEK, generate and wrap a fresh per-workspace DEK, insert the registry row, and create the empty per-workspace file, in src/domain/workspace/create.ts, making T032's create assertions pass (FR-WORKSPACE-001; data-model.md Workspace lifecycle) (depends on T015-T017, T028)
- [ ] T035 Implement domain/workspace open: decrypt `name_ciphertext`, unwrap the workspace's own `wrapped_dek`, and make the workspace's file the active connection, in src/domain/workspace/open.ts, making T032's open assertions pass (FR-WORKSPACE-003) (depends on T028)
- [ ] T036 Implement the `workspace:create` and `workspace:open` IPC handlers wiring T034/T035 through the T026 Zod-validated dispatch boundary, making T033 pass, in src/main/ipc/workspace-handlers.ts (remaining `workspace:*` channels are added in US5) (depends on T022, T026, T034, T035)
- [ ] T037 Implement the preload `contextBridge` API surface skeleton, exposed with `contextIsolation: true` and `nodeIntegration: false` as the sole bridge the renderer uses, and wire `workspace:create`/`workspace:open` into it; every subsequent user story adds its own channels to this same file, in src/preload/index.ts (constitution Principle V) (depends on T036)

### Crash-safe deletion protocol (engine only — wired into `workspace:delete` in US5)

- [ ] T038 [P] Integration test simulating a crash after each of the five deletion-protocol steps and asserting reconciliation always converges to a consistent end state, written and confirmed to fail before deletion-reconciler.ts exists, in tests/integration/deletion-crash-safety.spec.ts (constitution Principle VI; research.md #12 Tests)
- [ ] T039 Implement deletion-reconciler.ts: the five-step, idempotent, resumable crash-safe deletion protocol (mark DELETING → close resources → `wrapped_dek = NULL` → delete file + `-wal`/`-shm` → delete registry row), making T038's per-step assertions pass, in src/main/persistence/deletion-reconciler.ts (research.md #12) (depends on T028)
- [ ] T040 Implement the startup reconciliation scan that resumes any interrupted deletion from its inferred step (`wrapped_dek` present/null, file present/absent), making T038's remaining assertions pass, in src/main/persistence/deletion-reconciler.ts (research.md #12) (depends on T039)

### Single-instance lock and app lifecycle

- [ ] T041 [P] Integration test for single-instance enforcement: a second launch attempt never opens SQLite, never unwraps a key, never starts a worker, and the first instance's window is focused instead, written and confirmed to fail before app-lifecycle.ts exists, in tests/integration/single-instance.spec.ts (constitution Principle VI; research.md #14)
- [ ] T042 Implement app-lifecycle.ts: acquire `app.requestSingleInstanceLock()` as the first startup action; call `app.quit()` immediately if it returns `false`; otherwise open registry.sqlite, unwrap the registry DEK, run startup deletion reconciliation (T040), and only then create the main `BrowserWindow`; register a `second-instance` handler that focuses/restores the existing window, making T041 pass, in src/main/app-lifecycle.ts (research.md #14) (depends on T028, T040)

### Worker-thread infrastructure

- [ ] T043 [P] Unit test for worker crash recovery: simulate a worker `'error'`/`'exit'` event and assert in-flight requests fail cleanly and a freshly recreated worker is reseeded with the current dictionary snapshot, written and confirmed to fail before worker-manager.ts exists, in tests/unit/main/worker-manager.test.ts (constitution Principle VI; research.md #11)
- [ ] T044 Implement translation-worker.ts: the `worker_threads` entry point wiring domain/sanitizer and domain/restorer to `parentPort` messaging, building/reusing the matching structures from a versioned dictionary snapshot, in src/main/workers/translation-worker.ts (research.md #11)
- [ ] T045 Implement per-workspace worker orchestration: worker creation on workspace open/first request and termination on close/app exit, a dictionary version counter incremented on any Term/Placeholder/Prefix/PendingDecision mutation, decrypted-snapshot rebuilding and `postMessage` seeding only on version change, `requestId`-based supersession bookkeeping, crash detection with automatic worker recreation, and a push notification (an IPC event to the renderer) whenever the version counter changes, making T043 pass, in src/main/persistence/worker-manager.ts (research.md #11; the version-change push notification is the plumbing US3's reactive-recompute feature, T114, consumes) (depends on T044)

**Checkpoint**: Foundation ready — encryption, persistence, the Zod/dispatch boundary, key management, redaction, a bootstrap workspace, the deletion engine, the single-instance lock, and worker infrastructure all exist and are test-covered. User story implementation can now begin.

---

## Phase 3: User Story 1 - Sanitize confidential text before sharing it (Priority: P1) 🎯 MVP

**Goal**: Pasting original text into the left panel automatically produces sanitized text in the right panel — deterministic sensitive values are replaced with stable placeholders, and unflagged ambiguous business terms are left untouched.

**Independent Test**: Create one workspace, paste a block of text with known deterministic sensitive values and no prior dictionary entries, and confirm the sanitized output replaces every sensitive value consistently while leaving unrelated technical text and unflagged ambiguous terms unchanged.

### Tests for User Story 1

- [ ] T046 [P] [US1] Contract test for `translation:sanitize` request/response shape and the `INPUT_TOO_LARGE` error in tests/contract/translation-sanitize.test.ts (FR-SANITIZE-005; contracts/translation.md)
- [ ] T047 [P] [US1] Integration test: quickstart Scenario 1 — paste text with an email, an internal IP, and a JWT and confirm automatic sanitized placeholders in the right panel while `staging`/`PostgreSQL` and an unflagged company name remain unchanged, with no button click required, in tests/integration/us1-sanitize.spec.ts (FR-EDITOR-002, FR-SANITIZE-005/007; acceptance scenarios 1, 3, 4, 5; SC-001)

### Deterministic detectors (FR-SANITIZE-005)

- [ ] T048 [P] [US1] Implement the password/secret assignment-pattern detector in src/domain/detectors/secret.ts
- [ ] T049 [P] [US1] Unit tests for the password/secret detector in tests/unit/domain/detectors/secret.test.ts
- [ ] T050 [P] [US1] Implement the API-key/access-key detector in src/domain/detectors/api-key.ts
- [ ] T051 [P] [US1] Unit tests for the API-key/access-key detector in tests/unit/domain/detectors/api-key.test.ts
- [ ] T052 [P] [US1] Implement the bearer-token/JWT-shape detector in src/domain/detectors/jwt.ts
- [ ] T053 [P] [US1] Unit tests for the bearer-token/JWT detector in tests/unit/domain/detectors/jwt.test.ts
- [ ] T054 [P] [US1] Implement the private-key PEM-header detector in src/domain/detectors/private-key.ts
- [ ] T055 [P] [US1] Unit tests for the private-key PEM detector in tests/unit/domain/detectors/private-key.test.ts
- [ ] T056 [P] [US1] Implement the email-address detector in src/domain/detectors/email.ts
- [ ] T057 [P] [US1] Unit tests for the email detector in tests/unit/domain/detectors/email.test.ts
- [ ] T058 [P] [US1] Implement the phone-number detector in src/domain/detectors/phone.ts
- [ ] T059 [P] [US1] Unit tests for the phone detector in tests/unit/domain/detectors/phone.test.ts
- [ ] T060 [P] [US1] Implement the CPF/CNPJ detector with checksum validation in src/domain/detectors/cpf-cnpj.ts (research.md #6)
- [ ] T061 [P] [US1] Unit tests for the CPF/CNPJ detector, including valid and invalid checksums, in tests/unit/domain/detectors/cpf-cnpj.test.ts
- [ ] T062 [P] [US1] Implement the IPv4/IPv6 address detector in src/domain/detectors/ip-address.ts (research.md #6)
- [ ] T063 [P] [US1] Unit tests for the IPv4/IPv6 detector in tests/unit/domain/detectors/ip-address.test.ts
- [ ] T064 [P] [US1] Implement the URL/hostname detector for internal or customer resource identification in src/domain/detectors/url-hostname.ts
- [ ] T065 [P] [US1] Unit tests for the URL/hostname detector in tests/unit/domain/detectors/url-hostname.test.ts
- [ ] T066 [P] [US1] Implement the UUID detector in src/domain/detectors/uuid.ts
- [ ] T067 [P] [US1] Unit tests for the UUID detector in tests/unit/domain/detectors/uuid.test.ts
- [ ] T068 [P] [US1] Implement the cloud account/subscription/tenant/project/resource identifier detector in src/domain/detectors/cloud-identifier.ts
- [ ] T069 [P] [US1] Unit tests for the cloud identifier detector in tests/unit/domain/detectors/cloud-identifier.test.ts
- [ ] T070 [P] [US1] Implement the ARN detector in src/domain/detectors/arn.ts
- [ ] T071 [P] [US1] Unit tests for the ARN detector in tests/unit/domain/detectors/arn.test.ts
- [ ] T072 [P] [US1] Implement the database connection-string detector in src/domain/detectors/db-connection-string.ts
- [ ] T073 [P] [US1] Unit tests for the database connection-string detector in tests/unit/domain/detectors/db-connection-string.test.ts
- [ ] T074 [P] [US1] Implement the labeled business-identifier (customer/order/contract/employee `key = value` / `key: value`) detector in src/domain/detectors/labeled-identifier.ts
- [ ] T075 [P] [US1] Unit tests for the labeled business-identifier detector in tests/unit/domain/detectors/labeled-identifier.test.ts
- [ ] T076 [US1] Implement the ordinary-technology-name/generic-environment-label allowlist consulted by the sanitizer (FR-SANITIZE-007) in src/domain/detectors/technology-allowlist.ts
- [ ] T077 [P] [US1] Unit tests for the technology/environment allowlist in tests/unit/domain/detectors/technology-allowlist.test.ts (FR-SANITIZE-007; SC-009)

### Sanitizer core

- [ ] T078 [US1] Implement the Aho-Corasick automaton builder combining known ALWAYS-term matches and detector matches, with longest-match-at-a-start-position precedence (FR-SANITIZE-003), in src/domain/sanitizer/aho-corasick.ts (research.md #5; depends on T048-T077)
- [ ] T079 [US1] Implement sanitizer orchestration: lookup-before-allocate (FR-SANITIZE-001), the identical placeholder for every occurrence (FR-SANITIZE-002), exact preservation of non-matched text (FR-SANITIZE-004), and leaving NEVER-policy terms and undecided ambiguous terms unchanged (FR-SANITIZE-006, FR-DECISION-002), in src/domain/sanitizer/sanitize.ts (depends on T078)
- [ ] T080 [P] [US1] Unit tests for sanitizer orchestration: lookup-before-allocate, duplicate-occurrence consistency, longest-match precedence, exact text preservation, and NEVER/undecided-term pass-through, in tests/unit/domain/sanitizer.test.ts (FR-SANITIZE-001/002/006; SC-003, SC-010)

### Wiring

- [ ] T081 [US1] Implement the `translation:sanitize` IPC handler: validate via T023's schema through the T026 dispatch boundary, build/refresh the ALWAYS-term dictionary snapshot (decrypted via key-manager), dispatch to the workspace's translation worker, and return `{ requestId, sanitizedText }`, in src/main/ipc/translation-handlers.ts (depends on T023, T026, T044, T045, T079)
- [ ] T082 [US1] Wire `translation:sanitize` into the preload API surface in src/preload/index.ts (depends on T037, T081)

### Renderer

- [ ] T083 [US1] Implement the bidirectional editor shell with left (original) and right (sanitized) Monaco panels in src/renderer/editor/EditorPanels.tsx (FR-EDITOR-001; research.md #4)
- [ ] T084 [US1] Implement left-panel-to-right-panel automatic translation: debounced content-change trigger, a monotonically increasing per-(workspace, direction) `requestId`, the `translation:sanitize` call, and stale-response discarding on arrival, in src/renderer/editor/useSanitizeOnEdit.ts (FR-EDITOR-002/007; research.md #4, #11) (depends on T082, T083)
- [ ] T085 [P] [US1] Implement a visible processing-feedback indicator shown when a sanitize request has not resolved within a short perceptual threshold in src/renderer/editor/ProcessingIndicator.tsx (FR-SCALE-003)
- [ ] T086 [P] [US1] Integration test: process one synthetic document containing at least one representative value from **every** FR-SANITIZE-005 category (password/secret assignment, API/access key, bearer token/JWT, private-key PEM header, email, phone, CPF, CNPJ, IPv4, IPv6, URL/hostname, UUID, cloud identifier, ARN, database connection string, labeled business identifier) plus ordinary technology names and environment labels, through `translation:sanitize`, and verify every sensitive value is replaced and every technology/environment label is preserved in one combined pass, in tests/integration/us1-combined-detectors.spec.ts (FR-SANITIZE-005/007; SC-007) (depends on T081)

**Checkpoint**: User Story 1 is fully functional and independently testable — the MVP.

---

## Phase 4: User Story 2 - Restore sanitized text back to the original (Priority: P2)

**Goal**: Pasting sanitized text into the right panel automatically reconstructs the original text in the left panel, using only the active workspace's mappings.

**Independent Test**: Take sanitized output produced from User Story 1 (or any known placeholder), paste it into the right panel, and confirm the left panel reproduces the exact original text.

### Tests for User Story 2

- [ ] T087 [P] [US2] Contract test for `translation:restore` request/response shape, including `unresolvedPlaceholders`, in tests/contract/translation-restore.test.ts (contracts/translation.md)
- [ ] T088 [P] [US2] Integration test: quickstart Scenario 2 — paste Scenario 1's sanitized text into the right panel and confirm the left panel reconstructs the original exactly, and an unrelated placeholder-shaped string is left unchanged and reported as unresolved, in tests/integration/us2-restore.spec.ts (acceptance scenarios 3, 4)

### Implementation for User Story 2

- [ ] T089 [US2] Implement placeholder-token recognition: scan for `^[A-Z]+(?:_[A-Z]+)*_[0-9]+$` tokens at word boundaries and look each candidate token up against the active workspace's placeholder table in src/domain/restorer/placeholder-scanner.ts (research.md #8)
- [ ] T090 [US2] Implement restorer orchestration: resolve each recognized placeholder to its sole original value or designated principal (FR-ALIAS-003/004), leave an unmatched placeholder-shaped token unchanged and report it in `unresolvedPlaceholders`, and preserve all other text exactly, in src/domain/restorer/restore.ts (depends on T089)
- [ ] T091 [P] [US2] Unit tests for the placeholder scanner and restorer: single-value resolution, principal-value resolution, unresolved unmatched tokens, and exact non-placeholder text preservation, in tests/unit/domain/restorer.test.ts (FR-ALIAS-003/004; SC-006)
- [ ] T092 [US2] Implement the `translation:restore` IPC handler: validate via T023's schema through the T026 dispatch boundary, dispatch to the workspace's translation worker, and return `{ requestId, restoredText, unresolvedPlaceholders }`, in src/main/ipc/translation-handlers.ts (depends on T023, T026, T044, T045, T090)
- [ ] T093 [US2] Wire `translation:restore` into the preload API surface in src/preload/index.ts (depends on T037, T092)
- [ ] T094 [US2] Implement right-panel-to-left-panel automatic translation with the same debounce/`requestId`/no-feedback-loop rules as T084, treating any right-panel edit or paste (including a different sanitized document) as new input for restoration, and ensuring a programmatic update to the destination panel never re-triggers translation in either direction, in src/renderer/editor/useRestoreOnEdit.ts (FR-EDITOR-003/004/007) (depends on T093)

**Checkpoint**: User Stories 1 AND 2 both work independently — the full bidirectional loop is complete.

---

## Phase 5: User Story 3 - Flag an ambiguous term and make a lasting decision about it (Priority: P3)

**Goal**: Explicitly selecting a text span (or manually adding a term) creates a persisted pending decision; resolving it ALWAYS or NEVER applies automatically forever in that workspace until edited or removed. The already-open editor also reacts automatically to that decision, and pending decisions are durable and isolated from editor content.

**Independent Test**: Explicitly select a new ambiguous term in the original panel to create a pending decision, resolve it as ALWAYS or NEVER, then confirm that same term is applied automatically the next time it appears — in a new input, a new session, or after an application restart — without asking again.

### Tests for User Story 3

- [ ] T095 [P] [US3] Contract tests for `decisions:select-candidate`, `decisions:list`, `decisions:resolve-always`, `decisions:resolve-never`, `decisions:remove`, and `decisions:remove-all` in tests/contract/decisions.test.ts (contracts/decisions.md)
- [ ] T096 [P] [US3] Integration test: quickstart Scenario 3 — select an ambiguous term, resolve it ALWAYS with a suggested prefix, confirm the placeholder applies to every occurrence and persists across a relaunch, and confirm toggling to NEVER then back to ALWAYS reuses the same historical placeholder, in tests/integration/us3-decisions.spec.ts (acceptance scenarios 1, 2, 4, 5, 7, 10, 11; SC-004, SC-014)
- [ ] T097 [P] [US3] Integration test: pending-decision restart durability — create an unresolved pending decision via `decisions:select-candidate`, fully close and restart the application, then call `decisions:list` and confirm the same pending decision still appears exactly as it was (identical candidate/normalized form), without requiring the original text to be pasted again, in tests/integration/us3-pending-restart.spec.ts (FR-PENDING-001; acceptance scenario 9; SC-011)
- [ ] T098 [P] [US3] Integration test: editor-clearing isolation — create a pending decision, then clear/delete all content in both editor panels, and confirm `decisions:list` still returns the pending decision unchanged (clearing editor content never deletes a persisted pending decision), in tests/integration/us3-editor-clear-isolation.spec.ts (FR-PENDING-009)

### Prefix, placeholder, and term-policy domain logic

- [ ] T099 [P] [US3] Implement prefix normalization: uppercase, strip accents/diacritics, spaces/hyphens to underscores, collapse repeated underscores, trim leading/trailing underscores, and reject a result with no usable ASCII letters (FR-PREFIX-002/003; edge case) in src/domain/dictionary/prefix-normalize.ts
- [ ] T100 [P] [US3] Unit tests for prefix normalization, including the double-underscore and symbols-only rejection edge cases, in tests/unit/domain/dictionary/prefix-normalize.test.ts
- [ ] T101 [US3] Implement placeholder allocation: system-controlled monotonic `next_sequence` per prefix, never user-edited, never reused after removal, producing `PREFIX_N` (FR-PREFIX-001/004/005/006, SC-015) in src/domain/dictionary/placeholder-allocate.ts (depends on T099)
- [ ] T102 [P] [US3] Unit tests for placeholder allocation: sequence monotonicity, no reuse after removal, and uniqueness across terms, in tests/unit/domain/dictionary/placeholder-allocate.test.ts (SC-008, SC-015)
- [ ] T103 [US3] Implement Term policy lifecycle: ALWAYS/NEVER resolution, a policy edit taking effect immediately without re-prompting, `placeholder_id` retained permanently through any ALWAYS⇄NEVER toggle, and historical-placeholder reuse on NEVER→ALWAYS (FR-DECISION-001/003/004, FR-TERM-006) in src/domain/dictionary/term-lifecycle.ts (depends on T101)
- [ ] T104 [P] [US3] Unit tests for Term policy lifecycle: repeated toggling never allocates a new placeholder, and a term that has never been ALWAYS gets the normal new-prefix flow, in tests/unit/domain/dictionary/term-lifecycle.test.ts (SC-013)

### Pending-decision store

- [ ] T105 [P] [US3] Implement the pending-decision store: create-if-absent per unique normalized candidate, list, resolve (delegating to term-lifecycle), and remove (single/all), persisting only the candidate and the minimum review information, in src/domain/pending-decisions/store.ts (FR-DISCOVERY-001, FR-PENDING-001/002/005/006/008/009)
- [ ] T106 [P] [US3] Unit tests for the pending-decision store: one pending decision per normalized form regardless of case/spacing variants, removal never creates a policy, and a removed-then-reselected candidate creates a brand-new independent pending decision, in tests/unit/domain/pending-decisions/store.test.ts (SC-012)

### IPC handlers

- [ ] T107 [US3] Implement `decisions:select-candidate`, `decisions:list`, `decisions:resolve-never`, `decisions:remove`, and `decisions:remove-all` IPC handlers (with `CONFIRMATION_REQUIRED` enforcement on remove-all) in src/main/ipc/decisions-handlers.ts (FR-PENDING-003/005/006/007) (depends on T024, T026, T105)
- [ ] T108 [US3] Implement the `decisions:resolve-always` IPC handler (prefix-only path; alias-flow fields are wired in US4), returning `INVALID_PREFIX` on an unusable prefix, in src/main/ipc/decisions-handlers.ts (depends on T024, T026, T103, T107)
- [ ] T109 [US3] Wire `decisions:select-candidate`, `decisions:list`, `decisions:resolve-always`, `decisions:resolve-never`, `decisions:remove`, and `decisions:remove-all` into the preload API surface in src/preload/index.ts (depends on T037, T107, T108)

### Renderer

- [ ] T110 [US3] Implement explicit text-span selection in the original panel that calls `decisions:select-candidate` to flag a candidate (FR-DISCOVERY-001) in src/renderer/editor/SelectCandidate.tsx (depends on T109)
- [ ] T111 [US3] Implement the ALWAYS/NEVER resolution prompt: suggested/editable prefix or existing-prefix-category selection for ALWAYS, no further input for NEVER (FR-DECISION-002), in src/renderer/decisions/ResolveDecisionPrompt.tsx (depends on T108)
- [ ] T112 [US3] Implement the pending-decisions review panel (list, resolve, remove one, remove-all-with-confirmation) reachable during editing, visibly distinct from dictionary administration (FR-EDITOR-006, FR-PENDING-003/004/007), in src/renderer/decisions/PendingDecisionsPanel.tsx (depends on T109)

### Reactive recomputation (FR-SANITIZE-008)

- [ ] T113 [P] [US3] Integration test: reactive recomputation — with original text already sitting unchanged in the left panel, resolve a newly flagged pending decision to ALWAYS via `decisions:resolve-always` (no new paste or edit), and confirm the right panel automatically updates to reflect the new placeholder; also confirm the resulting destination-panel update does not itself trigger a further translation in either direction, in tests/integration/us3-reactive-recompute.spec.ts (FR-SANITIZE-008, FR-EDITOR-007)
- [ ] T114 [US3] Implement reactive recompute: the renderer subscribes to the dictionary-version push notification (T045) and re-issues `translation:sanitize`/`translation:restore` for the **current** editor content on the affected side whenever the version changes — without requiring a new user edit — reusing the same `requestId`/supersession and no-feedback-loop machinery as T084/T094, making T113 pass, in src/renderer/editor/useDictionaryVersionRecompute.ts (FR-SANITIZE-008, FR-EDITOR-007) (depends on T045, T084, T094, T108)

**Checkpoint**: User Stories 1-3 work independently — ambiguous terms can now enter and persist in the dictionary, the editor reacts to dictionary changes without a fresh paste, and pending decisions are durable and isolated from editor content. Note: T113/T114 introduce a real dependency of US3 on US1 (T084) and US2 (T094); the rest of US3 remains independent of US1/US2.

---

## Phase 6: User Story 4 - Confirm whether a new term is the same entity as an existing one (Priority: P4)

**Goal**: A newly flagged candidate that resembles an existing ALWAYS-mapped original value triggers an explicit same-entity/different-entity confirmation before any decision is saved.

**Independent Test**: First map one original value to a placeholder (per User Story 3), then introduce a textual variant of that same value and confirm the system asks the same-entity question, and that answering it either way produces the expected placeholder assignment.

### Tests for User Story 4

- [ ] T115 [P] [US4] Contract test for `decisions:check-similar` request/response shape in tests/contract/decisions-check-similar.test.ts (contracts/decisions.md)
- [ ] T116 [P] [US4] Integration test: quickstart Scenario 4 — flag a similar variant, confirm same-entity produces a principal-selection prompt, confirm different-entity produces a distinct placeholder regardless of similarity score, and confirm a NEVER-policy term (even with a historical placeholder) is never offered as a match, in tests/integration/us4-alias.spec.ts (acceptance scenarios 1, 2, 3, 6, 7, 8)

### Implementation for User Story 4

- [ ] T117 [US4] Implement the deterministic normalized edit-distance similarity comparison, run only against terms whose current policy is ALWAYS, never against another unresolved pending decision, and never against a NEVER-policy term, in src/domain/similarity/edit-distance.ts (research.md #2; FR-ALIAS-005/008; FR-PENDING-010)
- [ ] T118 [P] [US4] Unit tests for the similarity comparison: the "Synthetic Bank"/"Synthetic Bank SA" worked example, exclusion of NEVER-policy terms (including ones with a historical placeholder), and exclusion of other unresolved pending decisions, in tests/unit/domain/similarity.test.ts
- [ ] T119 [US4] Extend Term policy lifecycle (T103) with the alias flow: attaching a new original value to an existing ALWAYS placeholder on same-entity confirmation, requiring exactly one principal when a placeholder gains a second original value, and creating a distinct placeholder on different-entity confirmation, in src/domain/dictionary/term-lifecycle.ts (FR-ALIAS-001/002/004/006/007)
- [ ] T120 [P] [US4] Unit tests for the alias flow: same-entity attachment with required principal selection, different-entity distinct-placeholder creation, and `PRINCIPAL_REQUIRED` when a second alias is added without a principal, in tests/unit/domain/dictionary/alias-flow.test.ts
- [ ] T121 [US4] Implement the `decisions:check-similar` IPC handler wiring T117 in src/main/ipc/decisions-handlers.ts (depends on T024, T026, T117)
- [ ] T122 [US4] Extend the `decisions:resolve-always` IPC handler (T108) to accept `sameEntityAsTermId`/`principalTermId` and apply the alias flow (T119), returning `PRINCIPAL_REQUIRED` where applicable, in src/main/ipc/decisions-handlers.ts (depends on T108, T119)
- [ ] T123 [US4] Implement the `terms:set-principal` IPC handler for changing which original value is principal for a placeholder at any later time in src/main/ipc/terms-handlers.ts (FR-ALIAS-009) (depends on T025, T026)
- [ ] T124 [US4] Wire `decisions:check-similar` and `terms:set-principal` into the preload API surface in src/preload/index.ts (depends on T037, T121, T123)
- [ ] T125 [US4] Implement the same-entity/different-entity prompt showing the existing placeholder and an advisory-only similarity indicator (FR-ALIAS-008) in src/renderer/decisions/SimilarityPrompt.tsx (depends on T124)
- [ ] T126 [US4] Implement the principal-original selection UI shown only when a placeholder has two or more original values (FR-ALIAS-002/003) in src/renderer/decisions/PrincipalSelector.tsx (depends on T124)
- [ ] T127 [P] [US4] Integration test: full persistence restart coverage — in one workspace, create a mapping with an ALWAYS policy and a custom prefix, toggle it to NEVER and back to ALWAYS (exercising the sequence counter), create a second original value confirmed as the same entity (an alias) and designate a principal, then fully close and restart the application; confirm the mapping, policy, prefix, monotonic sequence counter, alias, and principal-original selection are all identical to before the restart, in tests/integration/us4-full-persistence-restart.spec.ts (FR-PERSIST-001/002; SC-002) (depends on T119, T122)

**Checkpoint**: User Stories 1-4 work independently — the dictionary's alias/principal rules are fully enforced, and the full set of persisted entities is proven to survive an application restart.

---

## Phase 7: User Story 5 - Work across multiple isolated workspaces (Priority: P5)

**Goal**: Full workspace lifecycle management (create, rename, open, list, delete), with a hard guarantee that nothing in one workspace ever leaks into another.

**Independent Test**: Create two workspaces, map the same original text to different placeholders in each, and confirm that sanitizing, restoring, or reviewing pending decisions in one workspace never reflects the other, and that renaming or deleting one workspace never affects the other.

### Tests for User Story 5

- [ ] T128 [P] [US5] Contract tests for `workspace:rename`, `workspace:list`, and `workspace:delete` request/response shapes and error codes in tests/contract/workspace.test.ts (`workspace:create`/`workspace:open` are already covered by the Foundational contract test, T033)
- [ ] T129 [P] [US5] Integration test: quickstart Scenario 5 — create two workspaces, map the same text to different placeholders in each, confirm no cross-workspace leakage on sanitize/restore, and confirm deleting one never affects the other, in tests/integration/us5-isolation.spec.ts (acceptance scenarios 1-3, 6; SC-005)
- [ ] T130 [P] [US5] Integration test: quickstart Scenario 5 crash-safety check — force-terminate the application after each of the five deletion-protocol steps and confirm startup reconciliation always converges to full deletion with no effect on other workspaces, in tests/integration/us5-deletion-crash-safety.spec.ts (acceptance scenario 4; research.md #12)

### Implementation for User Story 5

- [ ] T131 [US5] Implement domain/workspace rename: recompute `normalized_name_hmac`, re-check uniqueness, update only `name_ciphertext`/`normalized_name_hmac`, in src/domain/workspace/rename.ts (FR-WORKSPACE-002)
- [ ] T132 [US5] Implement domain/workspace list: read all `ACTIVE` registry rows and decrypt each name with the registry DEK in src/domain/workspace/list.ts (FR-WORKSPACE-004)
- [ ] T133 [US5] Implement domain/workspace delete: mark `DELETING` and invoke the deletion-reconciler protocol (T039) in src/domain/workspace/delete.ts (FR-WORKSPACE-005/006) (depends on T039)
- [ ] T134 [US5] Implement `workspace:rename`, `workspace:list`, and `workspace:delete` IPC handlers (with `CONFIRMATION_REQUIRED` enforcement on delete) in src/main/ipc/workspace-handlers.ts (depends on T022, T026, T131-T133)
- [ ] T135 [US5] Wire `workspace:rename`, `workspace:list`, and `workspace:delete` into the preload API surface in src/preload/index.ts (depends on T037, T134)
- [ ] T136 [US5] Implement the workspace list/switcher UI (create, open, inline rename) in src/renderer/workspace/WorkspaceList.tsx (depends on T135)
- [ ] T137 [US5] Implement the workspace-deletion confirmation dialog describing exactly what will be permanently removed (mappings, policies, prefixes, pending decisions, counters) before sending `confirm: true`, and ensure no editor/dictionary view keeps operating against a deleted workspace, in src/renderer/workspace/DeleteWorkspaceDialog.tsx (FR-WORKSPACE-005; acceptance scenario 5) (depends on T135)

**Checkpoint**: User Stories 1-5 work independently — the application now supports the full multi-workspace use case.

---

## Phase 8: User Story 6 - Administer the dictionary and pending decisions directly (Priority: P6)

**Goal**: A dedicated dictionary/pending-decisions administration view for searching, inspecting, adding, editing, and removing entries directly, separate from the translate/restore editor.

**Independent Test**: Open the dictionary view for a workspace with at least one existing term and one pending decision, search for the term, edit its policy, resolve the pending decision from its list, and confirm both changes take effect the next time matching text is sanitized — independent of pasting any text during the test itself.

### Tests for User Story 6

- [ ] T138 [P] [US6] Contract tests for `terms:search`, `terms:inspect`, `terms:list-prefixes`, `terms:add-always`, `terms:add-never`, `terms:edit`, and `terms:remove` in tests/contract/terms.test.ts (contracts/terms.md)
- [ ] T139 [P] [US6] Integration test: quickstart Scenario 6 — search the dictionary, create and resolve/remove pending decisions from the dedicated list independent of editor content, and remove all pending decisions with confirmation, in tests/integration/us6-dictionary-admin.spec.ts (acceptance scenarios 1, 7, 8, 9, 10)

### Implementation for User Story 6

- [ ] T140 [US6] Implement in-memory decrypt-and-filter search over original value, placeholder, prefix, and policy (bounded to 10,000 terms) in src/domain/dictionary/search.ts (FR-TERM-001/002; data-model.md "terms:search cannot be a plaintext LIKE query" note)
- [ ] T141 [P] [US6] Unit tests for dictionary search matching across original value, placeholder, prefix, and policy in tests/unit/domain/dictionary/search.test.ts
- [ ] T142 [US6] Implement term inspect (original value, policy, placeholder, and aliases/principal only when applicable) in src/domain/dictionary/inspect.ts (FR-TERM-005; FR-ALIAS-003)
- [ ] T143 [US6] Implement term removal: block with a required-impact disclosure when removal would detach a principal from remaining aliases, delete the Placeholder row when removing the sole remaining original value (never reissuing its `(prefix_id, sequence)`), and require confirmation, in src/domain/dictionary/remove.ts (FR-TERM-007, SC-015; edge cases)
- [ ] T144 [P] [US6] Unit tests for term removal: principal-detach blocking, placeholder deletion on last-alias removal, and sequence non-reuse, in tests/unit/domain/dictionary/remove.test.ts
- [ ] T145 [US6] Implement `terms:search`, `terms:inspect`, and `terms:list-prefixes` IPC handlers in src/main/ipc/terms-handlers.ts (depends on T025, T026, T140, T142)
- [ ] T146 [US6] Implement `terms:add-always` and `terms:add-never` IPC handlers reusing the same placeholder-allocation and alias rules as `decisions:resolve-always` in src/main/ipc/terms-handlers.ts (FR-TERM-003/004) (depends on T025, T026, T101, T119)
- [ ] T147 [US6] Implement the `terms:edit` IPC handler: policy changes take effect immediately without a new prompt and never clear `placeholder_id`; demoting a principal to NEVER never requires reassignment, in src/main/ipc/terms-handlers.ts (FR-TERM-006) (depends on T025, T026, T103)
- [ ] T148 [US6] Implement the `terms:remove` IPC handler returning `PRINCIPAL_REASSIGNMENT_REQUIRED` only when removal would actually detach a principal with aliases remaining, and `CONFIRMATION_REQUIRED` otherwise, in src/main/ipc/terms-handlers.ts (depends on T025, T026, T143)
- [ ] T149 [US6] Wire `terms:search`, `terms:inspect`, `terms:list-prefixes`, `terms:add-always`, `terms:add-never`, `terms:edit`, and `terms:remove` into the preload API surface in src/preload/index.ts (depends on T037, T145-T148)
- [ ] T150 [US6] Implement the dictionary administration view: search/filter, term inspection panel, and manual add-ALWAYS/add-NEVER forms in src/renderer/dictionary/DictionaryView.tsx (depends on T149)
- [ ] T151 [US6] Implement term edit and removal UI, including the removal-impact disclosure and required confirmation, in src/renderer/dictionary/TermEditor.tsx (depends on T149)
- [ ] T152 [US6] Implement the standalone pending-decisions administration view (reusing T112's panel logic) reachable independent of the editor, with a visible boundary between translating text and administering the dictionary (FR-EDITOR-006), in src/renderer/dictionary/PendingDecisionsAdmin.tsx (depends on T112)

**Checkpoint**: All six user stories are independently functional.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Scale, performance, and security guarantees that span every user story

- [ ] T153 [P] Performance test: sanitize/restore a synthetic 500,000-character input against a 10,000-term seeded dictionary and confirm completion within 2 seconds on the project's defined minimum supported hardware, in tests/integration/scale-performance.spec.ts (FR-SCALE-001/002; SC-016-018)
- [ ] T154 [P] Responsiveness test: while the 500,000-character sanitize above is in flight, confirm the renderer keeps responding to an unrelated interaction, proving the matching pass runs in the worker thread and not the main/renderer thread, in tests/integration/scale-responsiveness.spec.ts (FR-SCALE-003, SC-019; research.md #11)
- [ ] T155 [P] Debounce/supersession test: rapidly edit the left panel faster than the debounce interval and confirm only the last edit's result is ever shown, in tests/integration/debounce-supersession.spec.ts (research.md #11 `requestId` supersession)
- [ ] T156 [P] Encryption-at-rest sanity test: after sanitizing and resolving a synthetic company name as ALWAYS, inspect the workspace's `.sqlite` file (and its `-wal`/`-shm` companions) directly and confirm the value never appears in plaintext or an obviously-reversible normalized form, in tests/integration/encryption-sanity.spec.ts (research.md #10 Testing note; quickstart "Encryption sanity check")
- [ ] T157 [P] Registry name-encryption sanity test: create a workspace named after a synthetic company and confirm registry.sqlite (and its `-wal`/`-shm` companions) never contains the name in plaintext or obviously-reversible form, in tests/integration/registry-encryption-sanity.spec.ts (research.md #13)
- [ ] T158 [P] Key-loss simulation test: make `safeStorage` unable to unwrap a workspace's key and confirm `WORKSPACE_KEY_UNAVAILABLE` is reported cleanly with other workspaces unaffected; repeat for the registry key and confirm `REGISTRY_KEY_UNAVAILABLE` blocks all workspace creation/open/list/rename, in tests/integration/key-loss.spec.ts (research.md #10, #13)
- [ ] T159 [P] Filesystem-permissions check: confirm the userData directory and files are created with 0700/0600 on macOS, and that the Windows startup check warns on an unexpectedly world-readable directory, in tests/integration/filesystem-permissions.spec.ts (research.md #10)
- [ ] T160 [P] Integration test: dictionary-mutation isolation — snapshot every Term/Placeholder/Prefix/PendingDecision row (including sequence counters and principal selections) in a seeded workspace, perform an arbitrary sequence of `translation:sanitize` and `translation:restore` calls plus raw editor edits/clears/pastes with no explicit decision or dictionary-administration action, and confirm every row is byte-for-byte unchanged afterward, in tests/integration/dictionary-mutation-isolation.spec.ts (FR-EDITOR-005)
- [ ] T161 Run the full quickstart.md validation end-to-end against a built application and record any deviations directly in specs/001-text-sanitization-core/quickstart.md
- [ ] T162 [P] Add README/dev-setup documentation covering `npm run dev`, `npm test`, and `npm run test:e2e` per quickstart.md's Setup section

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately. Includes the CI quality-gate pipeline (T011-T013), which enforces every subsequent phase's tests once it exists.
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories. Internal order now follows real dependencies: crypto → schema → IPC schemas/dispatch → key management → redaction → workspace bootstrap (needs dispatch + key management) → preload skeleton → deletion protocol (needs key management) → single-instance/app-lifecycle (needs the deletion protocol, to run reconciliation at startup) → worker infrastructure. Includes a minimal workspace create/open bootstrap (T032-T037) because every story's independent test needs an active workspace to run against; full workspace management (rename/list/delete, isolation guarantees) is User Story 5.
- **User Stories (Phase 3-8)**: All depend on Foundational completion.
- **Polish (Phase 9)**: Depends on all six user stories being complete (several checks — scale, encryption sanity, key loss, dictionary-mutation isolation — exercise the full stack).

### User Story Dependencies

- **US1 (P1)**: Foundational only. No dependency on other stories.
- **US2 (P2)**: Foundational only. Independently testable against a known placeholder even before US3/US4 exist to generate one.
- **US3 (P3)**: Foundational only for its core decision/pending-decision flow. Its reactive-recompute feature (T113/T114) additionally depends on US1's `useSanitizeOnEdit` (T084) and US2's `useRestoreOnEdit` (T094) — a real, explicit dependency introduced by the G1 remediation, not present in the rest of the story.
- **US4 (P4)**: Builds on US3 — extends `term-lifecycle.ts` (T103→T119) and `decisions-handlers.ts` (T108→T122) with the alias flow. Per spec.md's own priority ordering, US4 is not meaningfully testable without an existing ALWAYS mapping from US3.
- **US5 (P5)**: Foundational's bootstrap (T032-T037) plus the deletion engine (T038-T040) already exist; US5 completes the `workspace:*` contract and adds the isolation/crash-safety test suite. Independent of US1-US4's domain logic.
- **US6 (P6)**: Builds on US3 (`placeholder-allocate.ts`) and US4 (`term-lifecycle.ts`'s alias flow) for `terms:add-always`/`terms:remove`'s shared rules, and reuses US3's pending-decision panel logic for its standalone admin view. Per spec.md, this story is explicitly "layered on top of the core translate/restore/decide loop."

### Within Each User Story (and Foundational)

- Every test task — including every Foundational test — is written and confirmed to fail before the implementation task(s) it verifies (constitution Principle VI).
- Domain modules before IPC handlers; IPC handlers before preload wiring; preload wiring before renderer UI.
- Story checkpoint reached only when its independent test (spec.md's per-story "Independent Test") passes.

### Parallel Opportunities

- All `[P]`-marked Setup tasks (T003-T009) can run in parallel; T011 must exist before T012/T013 extend the same CI file.
- Within Foundational, `[P]`-marked tasks in the same subsection can run in parallel (e.g., T014 alone, then T015-T017 together; T021 alone, then T022-T025 together); non-`[P]` tasks reflect a real file or data dependency on the task(s) immediately before them.
- All 16 detector implementation/test pairs in US1 (T048-T077) can run fully in parallel — each is an isolated file with no cross-detector dependency.
- Across stories: once Foundational is done, US1, US2, and US5 can be staffed in parallel immediately. US3 can start in parallel too for its core decision flow, but its T113/T114 reactive-recompute pair needs US1/US2's editor hooks first. US4 and US6 should wait for US3's `term-lifecycle.ts`/`decisions-handlers.ts` to exist to avoid merge conflicts on the same files.

---

## Parallel Example: User Story 1 detectors

```bash
# All 16 detector pairs are independent files — launch together:
Task: "Implement the email-address detector in src/domain/detectors/email.ts"
Task: "Unit tests for the email detector in tests/unit/domain/detectors/email.test.ts"
Task: "Implement the phone-number detector in src/domain/detectors/phone.ts"
Task: "Unit tests for the phone detector in tests/unit/domain/detectors/phone.test.ts"
Task: "Implement the CPF/CNPJ detector with checksum validation in src/domain/detectors/cpf-cnpj.ts"
# ...and so on for the remaining 11 detector pairs (T048-T077)
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (including the CI pipeline, T011-T013)
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories; includes the security/persistence/IPC backbone, entirely test-first)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: run quickstart.md Scenario 1 against the built app
5. Demo if ready — this alone proves the core value proposition ("turning confidential text into text safe to share")

### Incremental Delivery

1. Setup + Foundational → foundation ready (CI gates, encryption, persistence, IPC, worker infra, single-instance lock, crash-safe deletion engine, bootstrap workspace)
2. Add US1 (sanitize) → validate against quickstart Scenario 1 and the combined-category sample (T086) → MVP demo
3. Add US2 (restore) → validate against quickstart Scenario 2 → the bidirectional loop is complete
4. Add US3 (flag/decide) → validate against quickstart Scenario 3, the pending-decision restart test (T097), the editor-clear isolation test (T098), and the reactive-recompute test (T113) → ambiguous terms now enter the dictionary and the editor reacts to dictionary changes
5. Add US4 (same/different entity) → validate against quickstart Scenario 4 and the full-persistence restart test (T127) → alias correctness and cross-entity persistence guaranteed
6. Add US5 (multi-workspace) → validate against quickstart Scenario 5 (including the crash-safety sub-scenario) → full isolation guaranteed
7. Add US6 (dictionary admin) → validate against quickstart Scenario 6 → administrative convenience complete
8. Phase 9 → run the Scale check, Encryption sanity check, and dictionary-mutation-isolation (T160) sections, plus the single-instance enforcement check

### Parallel Team Strategy

With multiple developers, after Foundational completes:
- Developer A: US1 → US2 (shares the editor/worker wiring pattern)
- Developer B: US3 → US4 (shares `term-lifecycle.ts`/`decisions-handlers.ts`); needs A's T084/T094 before starting US3's T113/T114
- Developer C: US5 (workspace management, largely file-isolated from A/B)
- US6 is best picked up by whichever of A/B/C finishes first, since it depends on US3/US4's dictionary logic already existing

---

## Notes

- `[P]` tasks = different files, no dependencies.
- `[Story]` label maps task to specific user story for traceability; Setup, Foundational, and Polish tasks carry no story label by design.
- Every FR/SC/research.md ID referenced in a task description is there so the task is checkable against spec.md/research.md without re-deriving intent.
- Every test task — in Foundational and in every user story — is written and confirmed failing before its corresponding implementation task, per constitution Principle VI.
- Commit after each task or logical group.
- Stop at any checkpoint to validate a story independently before continuing.
- Avoid: vague tasks, same-file conflicts inside a `[P]` group, and cross-story dependencies that break independent testability beyond the ones explicitly documented above (US3→US1/US2 for reactive recompute; US4→US3; US6→US3/US4).

---

## Remediation Changelog (2026-07-18)

Applied against `/speckit-analyze` findings, in full:

- **C1** (Foundational test-after-implementation ordering): the entire Foundational phase was reordered so every test task precedes its implementation; the `workspace:create`/`workspace:open` contract test (T033) and a new domain-level unit test (T032) now exist in Foundational, before any story depends on those channels; the IPC schema/dispatch boundary (T021-T026) was moved earlier so workspace-bootstrap handlers (T036) have a real dependency to build on, fixing a latent ordering bug the original document also had.
- **C2** (missing quality gates): added T011-T013 — a GitHub Actions macOS+Windows matrix covering specification validation, formatting, linting, `tsc --noEmit`, test suites, a dependency audit with an explicit non-silent failure/waiver policy, and build verification on both platforms.
- **G1** (reactive recomputation): added T113 (test) and T114 (implementation) in US3, plus a version-change push notification added to T045 in Foundational; explicitly preserves the no-feedback-loop rule (FR-EDITOR-007).
- **G2** (translation must not mutate dictionary state): added T160 in Polish.
- **G3** (pending-decision restart durability): added T097 in US3.
- **G4** (editor-clearing isolation): added T098 in US3.
- **G5** (complete persistence coverage): added T127 in US4, covering mappings, policies, prefixes, sequence counters, aliases, and principal selections across a restart.
- **G6** (combined deterministic sample): added T086 in US1.
- **F1** (quickstart.md contract inconsistency): corrected — see quickstart.md's own Scenario 4, step 4.
- Implicit citations improved where practical: FR-EDITOR-004 (T094), FR-PENDING-003/004/007 (T107, T112), FR-PERSIST-001/002 (T127), FR-ALIAS-004 (T119).

Task count: 149 → **162**. All IDs T001-T162 are sequential with no duplicates or gaps (verified after editing).

### Traceability-only pass (follow-up, same date)

Added explicit SC-* citations to existing tests that already substantively verify each success criterion — no new tasks, no reordering, no ID changes. All 19 success criteria now have at least one explicit task citation:

- SC-001 → T047; SC-002 → T127; SC-003 → T080; SC-004 → T096; SC-005 → T129; SC-006 → T091; SC-007 → T086; SC-008 → T102; SC-009 → T077; SC-010 → T080; SC-011 → T097; SC-012 → T106; SC-013 → T104; SC-014 → T096; SC-015 → T101, T102; SC-016/017/018 → T153; SC-019 → T154.

Task count unchanged at **162**.
