<!--
SYNC IMPACT REPORT
==================
Version change: TEMPLATE (unratified) → 1.0.0 (first ratification)

Bump rationale: Initial ratification. The repository previously held an
unfilled constitution template and a draft body that was never formally
ratified. This is the first constitution the project owner has approved, so
versioning starts at 1.0.0, not as a continuation of the unratified draft.

Principles established (twelve draft principles consolidated into seven,
made self-contained, and decoupled from discovery/ as a runtime dependency):
  I.   Local-First Privacy
  II.  Strict Workspace Isolation
  III. Deterministic Core, Advisory Local AI
  IV.  Specification-First Development
  V.   Security by Default
  VI.  Test-First Traceability
  VII. Simplicity and Vertical Delivery

Sections added:
  "Authority Order" — establishes Constitution > Spec Kit feature
  specifications (specs/) > implementation plans > tasks > implementation
  and tests, and fixes discovery/ as historical migration input only.

Sections removed from the normative body (relative to the prior unratified
draft): direct discovery/ file paths, inline discovery rule-ID citations,
exact placeholder regexes, restoration algorithm detail, concrete UI
behavior, named delivery phases, detailed test-layer matrices, and stack
specifics that are not permanent architectural boundaries. These were either
generalized into durable principle language or dropped as implementation
detail that belongs in specs/ and plans, not the constitution.

Discovery rule IDs carried here only as migration provenance (the discovery
specs that originally informed each principle; discovery/ itself is not a
source of truth going forward):
  I.   PRD-PRINCIPLE-001, CAP-013, SUCCESS-007, ARCH-CONSTRAINT-001,
       SEC-NETWORK-001, SEC-LOCAL-001, SEC-LOG-001, SEC-SECRETS-001,
       SEC-TELEMETRY-001, SEC-UPDATE-001
  II.  BR-WORKSPACE-001, BR-WORKSPACE-002, BR-RESTORE-001, SUCCESS-002,
       SEC-DELETE-001, PRD-PRINCIPLE-004
  III. ARCH-CONSTRAINT-005, PRD-PRINCIPLE-005, PRD-PRINCIPLE-007, BR-AI-001,
       BR-SIMILARITY-001, SEC-PROMPT-001, BR-LIFECYCLE-001, BR-DETECTION-001,
       BR-DETECTION-002, BR-DETECTION-003, BR-MAPPING-001, PRD-PRINCIPLE-002
  IV.  PRD-PRINCIPLE-003
  V.   SEC-RENDERER-001, ARCH-CONSTRAINT-002, SEC-IPC-001, SEC-NETWORK-001,
       SEC-NETWORK-002, SEC-SUPPLY-001, ARCH-CONSTRAINT-003,
       SEC-DATABASE-001, SEC-DATABASE-002, SEC-EXPORT-001,
       ARCH-CONSTRAINT-004
  VI.  SPEC-TESTING (principles, prohibited practices, quality gates),
       TEST-PROP-001..006, SEC-TESTDATA-001
  VII. SPEC-PRODUCT (phase ordering), NON-GOAL-006, NON-GOAL-007,
       BR-PERSIST-001

Templates reviewed:
  ✅ .specify/templates/plan-template.md  — Constitution Check gate is
     generic and still aligns with all seven principles
  ✅ .specify/templates/spec-template.md  — requirements format aligns with
     specification-first principle
  ✅ .specify/templates/tasks-template.md — phases align with incremental
     delivery and test-first principles

Pre-ratification corrections applied to the first-draft body (version stays
1.0.0 — this constitution has not yet had its first commit or ratification):
  - Principle IV: corrected the behavioral-change sequence to match
    Principle VI's test-first requirement — automated tests are now written
    and confirmed failing before implementation, not after.
  - Authority Order: replaced the ambiguous "lower-numbered/higher-numbered"
    wording with explicit precedence language — a lower-precedence artifact
    MUST NOT override a higher-precedence artifact, and conflicts are
    resolved by correcting the lower-precedence artifact, not by
    reinterpreting the higher-precedence one.

Deferred TODOs: none

================================================================================
AMENDMENT: 1.0.1 → 1.1.0 (2026-07-21)
================================================================================
Version change: 1.0.1 → 1.1.0 (MINOR — materially expands and clarifies an
existing normative guarantee; does not remove or redefine Strict Workspace
Isolation, or any other principle, in a backward-incompatible way).

Amended: Principle II (Strict Workspace Isolation) — the workspace-deletion
bullet only. The rest of Principle II (cross-workspace lookup/allocation
prohibition, per-workspace mapping isolation) is unchanged.

Previous text:
  "Deleting a workspace MUST remove its records transactionally and report
  any implications for local backups."

Replacement text:
  "Deleting a workspace MUST use an idempotent, resumable, crash-safe
  logical deletion protocol. Once deletion begins, new operations for that
  workspace MUST be rejected. The protocol MUST remove the workspace's live
  wrapped-key reference before deleting its database and companion files,
  and MUST converge after interruption to removal of both the registry row
  and the workspace files. Mutations contained within one SQLite database
  MUST use real database transactions, but the application MUST NOT claim
  atomicity across independent databases and filesystem operations. Product
  documentation MUST disclose local-backup implications and MUST NOT claim
  guaranteed cryptographic erasure or secure physical deletion."

Rationale: a single atomic transaction cannot span registry.sqlite, a
separate per-workspace SQLite file, and filesystem deletion — no such
cross-resource atomic primitive exists
(specs/001-text-sanitization-core/research.md #12). Independent multi-agent
review of tasks T038–T040 (the crash-safe deletion-reconciler implementation)
surfaced that the literal word "transactionally" in the previous Principle II
text conflicted with this already-approved cross-resource deletion design
(research.md #12's five-step idempotent, resumable, crash-safe protocol;
data-model.md's workspace deletion state machine) — a conflict this project's
own plan.md had already worked around by correcting `contracts/workspace.md`'s
wording (see plan.md's "Second Phase-1 revision re-check"), but had not yet
resolved at the constitution level itself. This amendment closes that gap by
replacing an unachievable cross-resource-atomicity promise with the guarantee
the design actually provides and already implements:
  - Transactional guarantees are RETAINED, unweakened, for mutations
    contained within one SQLite database (registry.sqlite or a single
    per-workspace file) — nothing here loosens single-database transaction
    guarantees.
  - Cross-resource deletion (registry row + per-workspace file + `-wal`/
    `-shm` companions) is idempotent, resumable, and crash-safe, converging
    to full removal after any interruption, but is NOT claimed to be atomic
    across those independent resources.
  - No claim of guaranteed cryptographic erasure or secure physical deletion
    is introduced or implied — research.md #10's "Workspace deletion & key
    destruction — honest scope" already disclaimed this; the constitution
    now states it explicitly rather than leaving the disclaimer only in a
    lower-precedence design document.
  - The pre-existing "report any implications for local backups" obligation
    is retained, restated as an explicit product-documentation disclosure
    requirement rather than dropped.

Dependent feature artifacts reviewed: specs/001-text-sanitization-core/
plan.md's Constitution Check section (Principle II re-check — updated, see
plan.md's "Fourth Phase-1 revision re-check"), research.md #12, data-model.md's
"Workspace deletion state machine", and contracts/workspace.md's
`workspace:delete` section. No changes were needed to research.md,
data-model.md, or contracts/workspace.md — they already describe exactly the
protocol this amendment now recognizes as constitutionally sufficient without
reinterpretation.

Templates reviewed (re-inspected for this amendment specifically):
  ✅ .specify/templates/plan-template.md  — no "transactionally"/cross-resource
     atomicity language present; Constitution Check gate remains generic;
     no change needed.
  ✅ .specify/templates/spec-template.md  — no workspace-deletion or
     transactional-guarantee language present; no change needed.
  ✅ .specify/templates/tasks-template.md — no workspace-deletion or
     transactional-guarantee language present; no change needed.
  ✅ .specify/templates/constitution-template.md — fully generic placeholder
     principle headers only, no project-specific deletion wording; no change
     needed.
  ✅ .specify/templates/checklist-template.md — no relevant language present;
     no change needed.

Deferred TODOs: none
================================================================================
-->

# Solari AI Sanitizer Constitution

## Core Principles

### I. Local-First Privacy

The application MUST be fully functional without internet access once it and
any optional local-model components are installed. No cloud backend is
permitted for core functionality.

- Original text, restored text, sanitization mappings, and any prompts sent
  to a local AI model MUST remain on the user's device at all times.
- External network access is denied by default. No feature may open an
  outbound connection except a user-configured loopback address for a local
  AI runtime.
- Logs MUST contain only event metadata and opaque identifiers — never
  editor content, original values, placeholder-to-original pairs, secrets,
  or local-AI prompts.
- Remote analytics, telemetry, crash reporting, and update checks MUST NOT
  include workspace identifiers, editor content, mappings, document paths,
  or any other user-identifiable content. This prohibition applies to every
  channel, present or future; adding any external data reporting requires an
  explicit specification change that preserves this constraint by design.

**Rationale**: The product's value proposition is processing confidential
professional content without involving remote services. A single
unintended data-transmission regression destroys user trust irreversibly —
this is a hard boundary, not a preference.

### II. Strict Workspace Isolation

Every policy, mapping, counter, alias, and setting belongs to exactly one
workspace.

- Cross-workspace lookup, suggestion, restoration, and identifier allocation
  are forbidden. Restoration uses only the active workspace; unknown
  placeholders remain unchanged and are reported, never resolved by
  searching other workspaces.
- Two workspaces may map the same original value differently without any
  data leaking between them.
- Deleting a workspace MUST use an idempotent, resumable, crash-safe logical
  deletion protocol. Once deletion begins, new operations for that workspace
  MUST be rejected. The protocol MUST remove the workspace's live
  wrapped-key reference before deleting its database and companion files,
  and MUST converge after interruption to removal of both the registry row
  and the workspace files. Mutations contained within one SQLite database
  MUST use real database transactions, but the application MUST NOT claim
  atomicity across independent databases and filesystem operations. Product
  documentation MUST disclose local-backup implications and MUST NOT claim
  guaranteed cryptographic erasure or secure physical deletion.

**Rationale**: Users create workspaces to isolate contexts, such as
different clients or engagements. Any cross-workspace data flow is both a
correctness defect and a confidentiality breach.

### III. Deterministic Core, Advisory Local AI

Sanitization and restoration MUST be fully deterministic and functional
without a local LLM. Local AI is an optional, advisory enhancement — never a
requirement for core functionality.

- Deterministic detection and mapping logic runs first and produces
  consistent output independent of any language model. Mapping lookup
  always precedes new allocation, so an existing mapping is reused before a
  new one is created.
- Ambiguous cases that lack a saved policy require an explicit user
  decision; the application MUST NOT guess.
- Local AI may suggest candidates or matches but MUST NOT persist policy,
  alias, merge, delete, or other irreversible decisions without explicit
  user confirmation. Similarity or confidence scores are advisory and never
  trigger automatic merging.
- Local-model output is treated as untrusted data: prompt injection MUST NOT
  be able to invoke application actions.
- The application starts and stops only the local AI processes it owns; it
  MUST NOT stop an independently running service.

**Rationale**: Professionals rely on consistent, repeatable output. The user
holds final authority over irreversible decisions, and deterministic
behavior cannot depend on the availability or mood of a model.

### IV. Specification-First Development

Spec Kit feature specifications are the authoritative product contract for
their feature. Code, data-model changes, automated tests, and documentation
are derived from an approved specification — never the reverse.

- Behavioral changes MUST update the specification first, then the
  implementation plan and tasks, then automated tests written and confirmed
  failing, then implementation, then documentation.
- Every normative rule has a stable identifier. Removed identifiers MUST NOT
  be reused.
- When authoritative rules conflict, work on the affected behavior MUST
  stop; the conflict MUST be reported and resolved in the specification
  before implementation resumes.
- Contributors and agents MUST NOT invent, weaken, or silently reinterpret
  requirements. Ambiguities are resolved by updating the specification, not
  by choosing a convenient interpretation.

**Rationale**: A divergence between specification and code produces a
product nobody specified. Specification-first keeps intent traceable across
contributors and over time.

### V. Security by Default

Security requirements take precedence over convenience and MUST be
implemented without compromise.

- Any process that renders or handles untrusted or sensitive content MUST
  run with least privilege and process isolation, communicating with
  trusted application logic only through a minimal, validated boundary.
- All inputs crossing a process, IPC, or API boundary MUST be
  schema-validated, size-limited, and treated as untrusted.
- Any local backend service MUST reject non-loopback clients and bind only
  to a loopback address; redirects away from a loopback endpoint MUST be
  rejected.
- All dependencies MUST use pinned versions with committed lockfiles, and
  automated vulnerability checks are mandatory.
- Data at rest MUST be stored with least-privilege filesystem permissions
  where the platform supports it. Exports and backups carry the same
  sensitivity as the original data.
- Core domain logic MUST remain independent of any specific UI or transport
  framework, so each layer can be hardened independently.

**Rationale**: Desktop applications with elevated privileges and access to
confidential content are high-value targets. Defense-in-depth across process
isolation, input validation, and supply-chain controls limits blast radius
at every boundary.

### VI. Test-First Traceability

Every critical business rule and security requirement MUST have automated
test coverage, written before the implementation is considered complete, and
MUST reference the requirement it verifies so coverage can be audited
against the specification.

- Tests are written to fail, confirmed to fail, then implementation is
  written to make them pass.
- Required quality gates MUST pass before any merge to a protected branch,
  including at minimum: specification validation, formatting and linting,
  type checking, automated test suites, dependency audit, and build
  verification for every supported platform.
- Repository content, tests, fixtures, screenshots, and documentation MUST
  contain only synthetic data. Real customer or employer names, real
  documents, real sanitization mappings, personal data, credentials, private
  keys, local databases, model weights, or logs containing user content MUST
  NEVER be committed. A violation is a critical security incident, not a
  style issue.
- Core automated tests MUST run offline and MUST NOT call any public AI
  service.

**Rationale**: Business and security rules are the contract with the user.
Writing tests first ensures the contract is understood before code is
written, and traceable coverage proves the contract is honoured and stays
honoured as the code evolves.

### VII. Simplicity and Vertical Delivery

Complexity MUST be justified. Features are delivered as independently
testable and demonstrable vertical slices, in the priority order the
product specification establishes.

- Each increment MUST be independently demonstrable and deployable, and a
  later increment MUST NOT block an earlier one.
- Architectural complexity beyond what the current specifications require
  MUST be explicitly justified in a specification change before it is
  built.
- The application MUST NOT retain data, history, or derived structures that
  no current specification requires.

**Rationale**: Incremental delivery lets each slice be validated before the
next is built. Unrequired complexity creates attack surface, test burden,
and maintenance cost without user benefit.

## Authority Order

When artifacts disagree, the following precedence resolves the conflict,
highest first:

1. This constitution.
2. Spec Kit feature specifications under `specs/`.
3. Implementation plans.
4. Tasks.
5. Implementation and tests.

A lower-precedence artifact MUST NOT override a higher-precedence artifact.
Conflicts are resolved by correcting the lower-precedence artifact, not by
reinterpreting the higher-precedence artifact.

The `discovery/` directory holds the historical product, business-rule,
architecture, security, and testing material used to originate this project.
It is migration input only: it MUST NOT be treated as a permanent source of
truth, MUST NOT be a runtime dependency of the application or its build, and
MUST NOT be cited as authority once the corresponding behavior is captured
in a Spec Kit feature specification under `specs/`. Where this constitution
or a specification under `specs/` differs from `discovery/`, the constitution
or `specs/` governs.

## Governance

This constitution supersedes all other development practices.

**Amendment procedure**:

1. Identify which principle or section changes and why.
2. Propose the amendment with the new text and its rationale.
3. Determine the version bump:
   - **MAJOR**: A principle is removed, redefined in a backward-incompatible
     way, or the governance structure changes in a way that invalidates
     prior compliance.
   - **MINOR**: A new principle or section is added, or existing guidance is
     materially expanded.
   - **PATCH**: Clarifications, wording improvements, or typo fixes with no
     semantic change.
4. Update all dependent templates under `.specify/templates/` and verify
   consistency with any other agent runtime guidance files in the
   repository.
5. Obtain explicit approval from the project owner before merging.

**Compliance review**:

Every pull request MUST verify that changes conform to all seven
principles. The plan template's Constitution Check gate MUST be satisfied
before Phase 0 research begins and re-checked after Phase 1 design is
complete. Violations require documented justification.

**Versioning policy**: Semantic versioning as defined above. The version
line at the bottom of this file is the single authoritative version record.

**Version**: 1.1.0 | **Ratified**: 2026-07-17 | **Last Amended**: 2026-07-21
