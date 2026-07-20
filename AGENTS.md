# Repository Agent Instructions

These instructions apply to the entire repository, for every coding agent
working in it (Codex, Claude Code, or any other).

## Authority order

Normative artifacts, highest authority first:

1. `.specify/memory/constitution.md` — the highest-authority document in this
   repository. It governs every other artifact.
2. The active feature's specification (`spec.md`).
3. The active feature's implementation plan and supporting design artifacts
   (`plan.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`).
4. The active feature's task list (`tasks.md`).

A lower-precedence normative artifact must never override a higher-precedence
one. If two normative artifacts (1-4 above) genuinely conflict with each
other, stop and report the conflict — quote the exact conflicting passages,
or cite the exact requirement/task IDs involved — instead of silently
picking one.

Existing implementation and tests are **derived artifacts, not normative
authorities**. They are expected to converge toward whatever the normative
artifacts above require, not the other way around:

- If implementation or tests conflict with a higher-authority normative
  artifact, update the implementation or tests as part of the authorized
  task. That is not a conflict between normative artifacts, so it is not a
  reason to stop.
- Do not stop merely because existing code does not yet implement a
  specification or task; that gap is normally the entire reason the
  implementation work was requested in the first place.

`discovery/` remains historical product-discovery material: useful
background context, but **not authoritative**. Where it conflicts with the
constitution or a current Spec Kit feature artifact under `specs/`, the
constitution or the current artifact governs, not `discovery/`.

## Finding the active feature

This repository can contain more than one feature over time — never assume
today's feature is permanent. Determine the active one like this:

1. Run `git branch --show-current` (or check which branch you are on).
2. The active feature's directory is `specs/<branch-name>/`, where
   `<branch-name>` matches the current branch exactly (Spec Kit's feature
   branches are named after their feature directory, e.g. branch
   `001-text-sanitization-core` → `specs/001-text-sanitization-core/`). At
   the time of writing, `001-text-sanitization-core` is the only feature in
   this repository and is used here only as an example — do not hardcode it.
3. If the current branch does not correspond to a directory under `specs/`,
   or you are on a shared branch (e.g. `main`), ask which feature is active
   before proceeding, rather than guessing.

## Required reading before making changes

Before implementing or modifying anything, read, in this order:

1. `.specify/memory/constitution.md`
2. The active feature's `spec.md`
3. The active feature's `plan.md`
4. The active feature's `tasks.md`
5. Whichever of `research.md`, `data-model.md`, `quickstart.md`,
   `contracts/`, and any `checklists/` are relevant to the requested work
6. The existing implementation and tests already covering the area you're
   about to touch

## Specification-first and test-first workflow

A change to defined product behavior follows this order:

1. Update or confirm the specification.
2. Update or confirm the plan and tasks.
3. Write the required failing test and run it against the actual current
   working tree — confirm it fails because the requested behavior is
   missing or incorrect, and capture and report the real failure, not a
   predicted one. (Required whenever the constitution's Test-First
   Traceability principle applies, or a task says so explicitly.)
4. Implement the smallest complete change that addresses it.
5. Run the focused test and the regression suite, and confirm both pass.
6. Update documentation where required.

Do not invent, weaken, or silently reinterpret a requirement. Do not resolve
an ambiguity by picking a convenient interpretation — surface it. Do not
implement first and then remove, hide, rename, move, or back up files to
simulate a red test — the red state in step 3 must be observed against the
real, unmodified working tree.

## Scope discipline

Implement only the explicitly requested task or task range. Leave every
later task untouched — do not start, partially implement, or "helpfully"
get ahead on work that wasn't asked for.

## Privacy and security

- All sensitive processing stays local. Preserve complete workspace
  isolation — no lookup, suggestion, or data flow may cross from one
  workspace into another.
- Never log, expose, or include in an error message or diagnostic: original
  text, sanitized or restored text, customer data, credentials or secrets,
  raw or wrapped encryption keys, derived subkeys, nonces, ciphertext,
  plaintext mappings, or sensitive validation payloads. Errors and logs may
  reference IDs and categories only.
- Use only synthetic data in tests, fixtures, examples, documentation, and
  screenshots. Never real customer, employer, or personal data.

## Task tracking

Update a task's checkbox in `tasks.md` only after its implementation and all
required validation are complete — never before, never speculatively.

## Validation

Run every validation command relevant to the change (format, lint, type
check, unit/contract/integration tests, build, package, audit, spec
validation, etc., as applicable to what changed). Never claim a command
passed if it was not actually executed.

## Git discipline

Do not commit, push, merge, force-push, rewrite history, delete branches,
change tags, run any other destructive Git operation, or discard the user's
changes — unless the user has explicitly authorized that specific action in
the current request. Authorization for one such action does not carry over
to future requests.

## Completion reports

Every completion report includes:

- Tasks completed.
- Requirement IDs affected (FR-*/SC-* or equivalent).
- Files created, modified, or removed.
- Initial failing-test evidence, when TDD applied.
- A short implementation summary.
- Checks executed and their actual results.
- Remaining risks, warnings, skipped checks, or unverified platforms.
- Confirmation that later/out-of-scope tasks were left untouched.
- Git actions performed, or confirmation that none were performed.

---

This file stays concise and operational by design — it does not restate
detailed product requirements. Those live in `specs/<feature>/spec.md` and
the rest of that feature's Spec Kit artifacts.
