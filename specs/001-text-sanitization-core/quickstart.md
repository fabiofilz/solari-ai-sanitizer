# Quickstart: Validating the Text Sanitization Core Workflow

This guide describes how to prove the feature works end-to-end once
`/speckit-tasks` and implementation have produced a runnable application. It does
not contain implementation code — see `data-model.md` for entity shapes and
`contracts/*.md` for the exact IPC request/response schemas each step exercises.
All values below are synthetic (constitution Principle VI).

## Prerequisites

- Node.js (the LTS version bundled with the project's chosen Electron release —
  see `plan.md` Technical Context)
- Repository dependencies installed (`npm install`, once `package.json` exists
  from implementation)
- No network connection required — the entire scenario below must work fully
  offline (constitution Principle I; SC-007 of `spec.md`)

## Setup

```bash
npm run dev        # launches the Electron app in development mode
```

or, to validate without a UI:

```bash
npm test           # Vitest: domain-layer unit tests + IPC contract tests
npm run test:e2e   # Playwright: full user-story acceptance scenarios below
```

## Scenario 1 — Sanitize confidential text automatically (User Story 1, P1)

1. Launch the app with no existing workspaces. Create a workspace named
   `Client A` (`workspace:create`, `contracts/workspace.md`).
2. Paste the following into the left panel:
   ```
   Contact: ops@example-synthetic.test
   Internal host: 10.0.0.42
   Token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpc2lzYWZha2VzaWc
   Environment: staging, database: PostgreSQL
   ```
3. **Expected**: within the debounced update window, the right panel
   automatically shows the email, IP, and token replaced by stable placeholders,
   with `staging` and `PostgreSQL` left unchanged — no button click needed
   (`translation:sanitize`, FR-EDITOR-002, FR-SANITIZE-005/007, acceptance
   scenarios 1 and 3).
4. Paste a company name that has never been seen before (e.g., `Acme Synthetic
   Corp`) into the same panel. **Expected**: it is left unchanged in the
   sanitized output — the deterministic core never auto-flags it (acceptance
   scenario 4).

## Scenario 2 — Restore sanitized text (User Story 2, P2)

1. Copy the sanitized text produced in Scenario 1 and paste it into the right
   panel.
2. **Expected**: the left panel automatically reconstructs the original text
   exactly, including whitespace and line breaks (`translation:restore`,
   FR-EDITOR-003, acceptance scenario 4).
3. Manually type an unrelated placeholder-shaped string (e.g., `UNKNOWN_99`)
   into the right panel. **Expected**: it is left unchanged and reported in
   `unresolvedPlaceholders` (acceptance scenario 3).

## Scenario 3 — Flag and decide on an ambiguous term (User Story 3, P3)

1. In the left panel, select the text `Acme Synthetic Corp` and flag it as a
   candidate (`decisions:select-candidate`, FR-DISCOVERY-001).
2. Resolve the resulting pending decision as ALWAYS, accepting the suggested
   prefix (`decisions:resolve-always`). **Expected**: a placeholder like
   `ACME_SYNTHETIC_CORP_1` is generated and applied to every occurrence in the
   current input (acceptance scenarios 1–2, 5–6).
3. Close and relaunch the application. Paste text containing `Acme Synthetic
   Corp` again. **Expected**: it is sanitized automatically with no new prompt
   (acceptance scenario 4 — persistence across restart).
4. Edit the same term's policy to NEVER (`terms:edit`). **Expected**: future
   sanitization preserves it unchanged, but text sanitized before the edit
   (containing the old placeholder) still restores correctly (acceptance
   scenarios 7 and 10; `data-model.md` Term lifecycle).
5. Switch it back to ALWAYS. **Expected**: the same historical placeholder is
   reused — no new prefix prompt, no new sequence (acceptance scenario 11).

## Scenario 4 — Same entity vs. different entity (User Story 4, P4)

1. With `Synthetic Bank` already mapped to a placeholder (per Scenario 3's
   pattern), select `Synthetic Bank SA` as a new candidate.
2. Resolve it and confirm same entity (`decisions:check-similar` then
   `decisions:resolve-always` with `sameEntityAsTermId`). **Expected**: you are
   prompted to choose the principal original between the two values (acceptance
   scenario 2; `PRINCIPAL_REQUIRED` in `contracts/decisions.md`).
3. Repeat with a clearly different company name and confirm different entity.
   **Expected**: a distinct placeholder is created regardless of any displayed
   similarity score (acceptance scenario 3).
4. With the two-alias placeholder from step 2 (principal = `Synthetic Bank`),
   edit the principal term's policy to NEVER via `terms:edit` (request:
   `{ workspaceId, termId, policy: "NEVER" }` — `terms:edit` has no
   principal-related field at all; changing a principal is a separate call,
   see step 5). **Expected**: the call succeeds with **no**
   `PRINCIPAL_REASSIGNMENT_REQUIRED` error (acceptance scenario 6–8;
   `contracts/terms.md`). Then:
   - Sanitize new text containing `Synthetic Bank`: it is left unchanged (NEVER
     is now active for future sanitization).
   - Restore previously sanitized text containing this placeholder: it still
     resolves to `Synthetic Bank` (the historical placeholder remains valid for
     restoration even though its principal's current policy is NEVER).
5. Now attempt `terms:remove` on that same term. **Expected**: this time the
   call *does* return `PRINCIPAL_REASSIGNMENT_REQUIRED`, since removal — unlike
   the policy edit in step 4 — would actually detach the principal while
   `Synthetic Bank SA` remains. `terms:remove` itself takes no replacement-
   principal parameter either: call `terms:set-principal`
   (`{ workspaceId, placeholderValue, principalTermId }`) to promote `Synthetic
   Bank SA` to principal first, then retry `terms:remove`. **Expected**: it now
   succeeds.

## Scenario 5 — Workspace isolation (User Story 5, P5)

1. Create a second workspace, `Client B`. Map the same original text (e.g.
   `Acme Synthetic Corp`) to a different placeholder than `Client A` produced.
2. Switch between workspaces and sanitize/restore the same input in each.
   **Expected**: each workspace only ever reflects its own mapping — never the
   other's (acceptance scenario 3; `data-model.md`'s one-file-per-workspace
   isolation).
3. Delete `Client B` after confirming the warning. **Expected**: its registry
   row and per-workspace file are both gone; `Client A` is completely unaffected
   (acceptance scenario 4).
4. **Crash-safety check** (research.md #12): create a third workspace, `Client
   C`, and force-terminate the application immediately after `workspace:delete`
   is called for it but before the process would normally exit cleanly (e.g., kill
   the process in a test harness right after the IPC call returns
   `{status: "DELETING"}`). Relaunch the application. **Expected**: startup
   reconciliation completes the deletion automatically — `Client C` has no
   registry row and no per-workspace file, with no manual intervention needed,
   and no other workspace is affected. Repeat, forcing the kill after each of the
   five protocol steps in research.md #12, and confirm the same convergent
   end-state every time.

## Scenario 6 — Dictionary and pending-decision administration (User Story 6, P6)

1. Open the dictionary view for `Client A` and search for `Acme` (`terms:search`).
   **Expected**: the matching term is shown with its policy and placeholder
   (acceptance scenario 1).
2. Create a new pending decision (Scenario 3, step 1) but do not resolve it. Open
   the pending-decisions list (`decisions:list`). **Expected**: it appears there
   independent of the editor panels' current contents (acceptance scenario 7).
3. Remove it individually (`decisions:remove`). **Expected**: no ALWAYS/NEVER
   policy is created for it (acceptance scenario 9).
4. Create two more pending decisions and remove all of them in one action
   (`decisions:remove-all`). **Expected**: a confirmation is required first, and
   the workspace has zero pending decisions afterward (acceptance scenario 10).

## Scale check (FR-SCALE-001/002/003, SC-016–019)

- Paste a synthetic 500,000-character document and confirm sanitize/restore
  completes within 2 seconds on the project's minimum supported hardware (see
  `plan.md`), with visible processing feedback if it takes any perceptible time.
- Seed a workspace with 10,000 synthetic terms (including aliases) and confirm
  `terms:search` and `translation:sanitize` both continue to behave correctly.
- **Responsiveness check** (research.md #11): while the 500,000-character
  sanitize above is in flight, confirm the renderer keeps responding to an
  unrelated interaction (e.g., typing in the workspace-rename field, or
  observing that UI animations keep running) rather than freezing — this is
  what actually proves the matching pass is running in the worker thread and
  not on the main/renderer thread; completing within 2 seconds alone would not
  distinguish that from a blocking call that merely finished quickly.
- Rapidly edit the left panel several times in succession (faster than the
  debounce interval) and confirm only the result for the *last* edit is ever
  shown — an earlier, superseded translation must never overwrite the newer
  text (research.md #11's `requestId` supersession).

## Encryption sanity check (research.md #10, #13)

- After sanitizing text containing a synthetic company name flagged and
  resolved as ALWAYS, close the application and inspect the workspace's
  `<id>.sqlite` file directly with a plain SQLite browser (not through the
  app). **Expected**: the synthetic company name does **not** appear anywhere
  in the file, including its `-wal`/`-shm` companions, in plaintext or in an
  obviously-reversible normalized form — only ciphertext blobs for
  `original_value_ciphertext` and an opaque HMAC for `normalized_lookup_hmac`.
  The placeholder value (e.g., `ACME_SYNTHETIC_CORP_1`) *is* expected to appear
  in plaintext — it is not sensitive.
- Create a workspace named after a synthetic company (e.g., `Acme Synthetic
  Corp`) and open `registry.sqlite` directly (not through the app).
  **Expected**: the workspace name does not appear anywhere in the file,
  including its `-wal`/`-shm` companions, in plaintext or in an
  obviously-reversible normalized form — only a ciphertext blob
  (`name_ciphertext`) and an opaque HMAC (`normalized_name_hmac`) (research.md
  #13). The workspace `id` (UUID) and its per-workspace filename *are* expected
  to appear in plaintext — they are not sensitive (research.md #12).
- Simulate OS-protected key loss (e.g., run the app under a different OS user
  account pointed at the same `userData` directory, or otherwise make
  `safeStorage` unable to unwrap the stored key). **Expected**: the application
  clearly reports that this workspace's key material is unavailable
  (`WORKSPACE_KEY_UNAVAILABLE`) rather than silently failing or falling back to
  an unencrypted path; other workspaces (with their own, independent keys)
  remain unaffected. Simulate the same loss for the **registry** key
  specifically (e.g., corrupt the `RegistryKey` row). **Expected**:
  `REGISTRY_KEY_UNAVAILABLE` is reported and **no** workspace can be created,
  opened, listed, or renamed until it is resolved — this is a harder gate than
  a single workspace's key loss, since the registry key protects every
  workspace's name (research.md #13).
- **Deletion honesty check**: after deleting a workspace (Scenario 5, step 3),
  confirm only that its registry row and per-workspace file are gone. This
  scenario does **not** attempt to prove secure physical erasure of underlying
  storage — the design explicitly makes no such guarantee (research.md #10's
  "Workspace deletion & key destruction").

## Single-instance enforcement check (research.md #14)

- With the application already running, attempt to launch a second instance
  against the same `userData` directory (e.g., open the app a second time from
  its installed shortcut, or run the packaged executable a second time from a
  terminal). **Expected**: the second process exits immediately; it never
  opens `registry.sqlite` or any per-workspace file, never unwraps any key,
  and never starts a translation worker or runs startup deletion
  reconciliation. The **first** instance's existing window is focused/brought
  to the foreground instead of a second window appearing.
- Force-terminate the application (simulating a crash, not a clean quit), then
  relaunch. **Expected**: the new process starts normally and acquires the
  lock without error — abnormal termination does not leave a stale lock that
  blocks the next honest launch.
