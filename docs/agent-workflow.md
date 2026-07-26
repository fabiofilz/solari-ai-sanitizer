# Local Multi-Agent Development Workflow

This document describes how coding agents working in this repository (Claude
Code, or any other agent capable of delegating to sub-agents) should use
delegated review, and when. It supplements `AGENTS.md` and `CLAUDE.md`; it
does not replace any Git, TDD, security, or task-scope rule defined there or
in `.specify/memory/constitution.md`.

## Principle: one writer, independent read-only reviewers

- The **orchestrator** — the main agent session the user is talking to — is
  the only agent authorized to modify repository files, run tests, stage
  changes, or run Git commands.
- **Reviewer subagents are read-only.** They can read files, search the
  repository, and report findings. They cannot edit files, run arbitrary
  shell commands, commit, push, merge, create or delete branches, or run any
  destructive command.
- Reviewer subagents never implement fixes. They report evidence; the
  orchestrator decides what to do with it.
- The orchestrator consolidates reviewer findings and corrects only
  confirmed defects within the explicitly requested task range — never
  beyond it.
- The user retains sole authority over commit, push, merge, and branch
  deletion, regardless of what any reviewer or the orchestrator concludes.

## The three project reviewers

Defined under `.claude/agents/`:

| Agent                    | Focus                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `specification-reviewer` | Maps requested tasks to spec.md/plan.md/tasks.md requirement IDs; flags contradictions, missing requirements, scope expansion; respects the constitution-first authority order. |
| `security-reviewer`      | Sensitive-data handling, workspace isolation, cryptographic/key-lifecycle boundaries, persistence ordering, path safety, Electron/IPC boundaries, logging, fail-open behavior.  |
| `test-reviewer`          | Genuine test-first ordering, requirement traceability, missing boundary/failure/cross-platform cases, vacuous or manufactured-red-state tests.                                  |

Each is configured with the narrowest read-only tool set this installed
Claude Code version supports (`tools: Read, Grep, Glob`) plus
`permissionMode: plan`, which blocks any mutating action even if attempted.
No reviewer has Edit, Write, or Bash access. See each agent file for its full
responsibilities and required report format (finding ID, severity,
authoritative rule, exact evidence with file/line, impact, recommended
in-scope correction, confidence).

No more than these three reviewers are used without the user's explicit
authorization for a given task.

## Orchestrator review packet

Reviewers have only `Read`, `Grep`, and `Glob`, plus `permissionMode: plan`.
They have no Bash, Git, Edit, Write, or Agent access, so they cannot
discover the current branch, compute a diff, check status, or run tests
themselves — and must not guess at any of it. The orchestrator (which does
have Git and Bash access) is responsible for determining this context first
and passing it explicitly in each reviewer's prompt:

- **The active feature directory** — e.g. `specs/001-text-sanitization-core`
  — determined by the orchestrator per `AGENTS.md`'s "Finding the active
  feature" section, not re-derived by the reviewer.
- **The requested task range** (e.g. "T038–T040").
- **The relevant changed-file list.**
- **The actual diff, or the exact set of files that must be reviewed.**
- **Relevant failing and passing test output**, whenever test evidence is
  part of the review (always for `test-reviewer`; for the others, whenever
  test output bears on the finding).

Reviewers do not run Git commands, obtain a Git diff themselves, or run
tests or validation commands. They assess only what the orchestrator
supplies in the packet above, plus whatever narrowly relevant repository
files they read directly through `Read`/`Grep`/`Glob` (e.g. the cited
spec.md/plan.md/tasks.md sections, or the test files under review). If a
reviewer needs part of the packet it wasn't given, it reports insufficient
context and stops rather than guessing.

**Auxiliary branches**: a branch such as
`chore/add-local-multi-agent-workflow` may have no matching
`specs/<branch-name>/` directory — the branch isn't itself a Spec Kit
feature branch. In that case the orchestrator may still supply a parent
feature directory (e.g. `specs/001-text-sanitization-core`) as the active
feature _only_ when the requested work or the user has explicitly
established that relationship for the current task. Otherwise, the
orchestrator stops and asks the user which feature is active rather than
guessing — the same rule `AGENTS.md`'s "Finding the active feature" section
already applies to itself, just enforced one level up before a reviewer is
ever invoked.

## Risk-based routing

Before starting a requested task or task range, score it against these eight
factors (1 point each, if applicable):

1. Processes sensitive or confidential information.
2. Uses cryptography or key management.
3. Creates, changes, migrates, or deletes persisted data.
4. Crosses a security boundary (renderer/preload/IPC/main).
5. Has concurrent, asynchronous, crash-recovery, or ordering behavior.
6. Has meaningful macOS/Windows differences.
7. Implements several related business rules or edge cases.
8. A defect could pass ordinary happy-path tests and cause later damage.

**Routing by score:**

- **0–2 → SIMPLE**: the orchestrator implements directly. No subagent is
  used unless a concrete uncertainty appears during the work (e.g., an
  ambiguous requirement or a suspicious existing test) — at that point,
  escalate to TARGETED_REVIEW rather than guessing.
- **3–4 → TARGETED_REVIEW**: the orchestrator selects the one reviewer most
  relevant to the risk factors that scored (e.g., a persistence-ordering
  change routes to `security-reviewer`; an ambiguous requirement routes to
  `specification-reviewer`). Review happens before or after implementation,
  whichever fits the task.
- **5–8 → FULL_MULTI_AGENT**: all three reviewers run independently
  _before_ implementation (against the plan/diff-to-be), the orchestrator
  implements alone, then all three run again _after_ implementation
  (against the actual diff). The orchestrator consolidates findings and
  corrects only confirmed defects.

**Mandatory FULL_MULTI_AGENT regardless of score:**

- Cryptographic or key-lifecycle changes.
- Destructive deletion or crash-recovery logic.
- Persisted-data migrations.
- Workspace-isolation changes.
- Any change that could expose original or restored sensitive content.

Record the computed score and the selected mode at the start of the task (in
your working notes or the completion report) so the routing decision is
auditable.

## Why multi-agent, and why not more than needed

Running three independent reviewers reduces rework: a defect caught before
implementation is cheaper than one caught after, and a defect caught after
implementation is cheaper than one caught in production. Independent review
also surfaces disagreements a single reviewer (or the orchestrator marking
its own work) would not catch.

The cost is real: multi-agent review consumes more tokens per task than
direct implementation, and reviewer subagents cannot parallelize by editing
the same files — only the orchestrator edits, ever. For SIMPLE and most
TARGETED_REVIEW tasks, that cost isn't justified. Reserve FULL_MULTI_AGENT
for the risk profile above, not for every task "to be safe."

## Finding consolidation process

1. **Collect** each reviewer's findings independently — reviewers must not
   see each other's output before reporting, so their findings stay
   independent.
2. **Deduplicate** overlapping findings (the same underlying defect reported
   by more than one reviewer, or reported twice by the same reviewer across
   a pre- and post-implementation pass).
3. **Classify** each finding:
   - **CONFIRMED_DEFECT** — the orchestrator has verified the finding
     against the actual file/line cited and agrees it's a real defect
     within the requested scope.
   - **ALREADY_COVERED** — the finding describes something already handled
     elsewhere (e.g., a different task, an existing test) that the reviewer
     didn't have visibility into.
   - **OUT_OF_SCOPE** — real, but outside the explicitly requested task
     range. Report it; do not fix it as part of this task.
   - **OPTIONAL_IMPROVEMENT** — a genuine improvement, not required by any
     normative artifact. Report it; do not implement it unless asked.
   - **UNRESOLVED_CONFLICT** — the finding surfaces a genuine conflict
     between normative artifacts, or a reviewer and the specification
     disagree in a way the authority order doesn't resolve on its own.
4. **Only CONFIRMED_DEFECT findings may be corrected automatically**, and
   only within the requested task range.
5. **UNRESOLVED_CONFLICT stops affected implementation** and is reported to
   the user — do not silently pick a side, even if reviewer consensus
   points one way. Reviewer consensus does not override an authoritative
   specification; if all three reviewers agree on something the spec
   contradicts, the spec still governs and the conflict is still reported,
   not resolved by vote.
6. **OUT_OF_SCOPE and OPTIONAL_IMPROVEMENT items are reported but not
   implemented** — they belong in the completion report, not in the diff.

## Token-efficiency rules

- Reviewers receive only the relevant files and diff for the task at hand —
  never "read the whole repository first."
- Reviewers must not read the entire repository without a concrete, stated
  reason tied to the task.
- Low-risk (SIMPLE) tasks do not use subagents at all.
- Pre-implementation and post-implementation review passes must not repeat
  identical analysis — the post-implementation pass focuses on the actual
  diff, not on re-reviewing the plan again.
- The orchestrator reuses a reviewer's findings directly rather than asking
  another agent to summarize or re-derive them.
- No more than the three reviewers defined here are invoked without the
  user's explicit authorization for that specific task.

## Model selection for reviewers

Each reviewer's frontmatter now pins an explicit `model`, `effort`, and
`maxTurns` rather than leaving any of them implicit:

| Agent                    | model  | effort | maxTurns |
| ------------------------ | ------ | ------ | -------- |
| `specification-reviewer` | sonnet | medium | 10       |
| `security-reviewer`      | sonnet | high   | 12       |
| `test-reviewer`          | sonnet | medium | 10       |

**Why `model: sonnet` is explicit, not inherited.** An explicit alias
prevents a reviewer from silently inheriting whatever model the orchestrator
happens to be running as — Opus, Fable, or any other higher-consumption
model — when the orchestrator session itself is on one of those for
unrelated reasons. Reviewer consumption should be predictable and decoupled
from the orchestrator's own model choice.

**Why `security-reviewer` gets `effort: high`.** It covers cryptographic
boundaries, key lifecycle, destructive deletion, persistence ordering,
workspace isolation, and sensitive-data exposure — the categories this
project already treats as mandatory `FULL_MULTI_AGENT` regardless of score.
That risk profile justifies the higher reasoning effort.

**Why `specification-reviewer` and `test-reviewer` get `effort: medium`.**
Both require careful reasoning against normative artifacts and test
evidence, but their findings are not inherently security-critical the way
`security-reviewer`'s are, so they do not currently justify `high` effort.

**Why `maxTurns` is bounded (10/12).** These limits cap runaway reviewer
loops and keep per-review consumption predictable. They are not a
correctness guarantee — a reviewer that needs more turns to finish a
narrowly-scoped review should get a narrower packet, not a higher limit as
a first resort.

**The orchestrator is unaffected.** These settings apply only to the three
reviewer subagents. The orchestrator (main session) remains free to run on
whatever model or effort level the user has selected for it; nothing here
changes the main session's own model.

**Why not `fable`.** `fable` is not selected for these agents because, for
this account, it currently requires usage credits to invoke — not something
to spend by default on every read-only review.

**Why not `opus` (for now).** `opus` is not fixed as the default reviewer
model. A future explicit change could route a narrowly scoped, exceptional
review to `opus` if it becomes available without unwanted usage-credit
charges — that would be a deliberate, scoped decision at the time, not an
implicit default.

**Why not `haiku`.** `haiku` is not selected at this stage because these
reviewers are expected to catch subtle requirement, security, and
test-quality defects — the kind of nuanced judgment this project's
model-selection guidance reserves for a stronger model, not the
simple/repetitive classification work `haiku` is suited for.

**Token efficiency still comes primarily from routing, not model choice.**
Explicit model/effort/turn settings bound per-invocation consumption, but
the larger lever remains risk-based routing: no reviewers for `SIMPLE` work,
one reviewer for `TARGETED_REVIEW`, narrowly-scoped review packets, and
avoiding duplicated pre-/post-implementation analysis. None of the settings
above guarantee a specific token count or monetary cost — they bound and
make consumption more predictable, not billed-cost-exact.
