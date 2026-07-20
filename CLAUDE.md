# Claude Code Instructions for This Repository

Claude Code must read and follow **`AGENTS.md`** in this repository — the
file at the root of this repository (`./AGENTS.md` relative to the
repository root), not `/AGENTS.md` at the operating system filesystem root.
It is the full repository-level instruction set (authority order, how to
find the active feature under `specs/`, required reading, test-first rules,
scope discipline, privacy/security rules, Git discipline, and the required
completion-report format). This file only adds Claude-specific notes on top
of it.

Same pointers as `AGENTS.md`: the highest-authority document is
`.specify/memory/constitution.md`; the active feature's Spec Kit artifacts
(`spec.md`, `plan.md`, `tasks.md`, and related design docs) live under
`specs/<current-branch-name>/`, determined from the current Git branch —
see `AGENTS.md` for exactly how.

## How this file relates to your global instructions

Your global `~/.claude/CLAUDE.md` remains active and must always be
followed. This repository-level `CLAUDE.md` (the one at the root of this
repository) adds project-specific instructions; it does not replace,
disable, weaken, or ignore your global instructions. When both apply
without conflict, follow both. If they conflict, stop and report the
conflict instead of silently choosing one.

## Critical workflow constraints (repeated from `AGENTS.md`)

- Never invent, weaken, or silently reinterpret a requirement.
- Never silently resolve a conflict between normative artifacts (the
  constitution, spec, plan/design artifacts, and tasks) — surface it
  instead. Existing implementation and tests are derived, not normative:
  when they lag behind a normative artifact, update them as part of the
  authorized task rather than treating the gap as a conflict to stop over.
- Use genuine test-first ordering when required: specification and
  plan/tasks confirmed first, then a real failing test against the real
  working tree, then implementation, then a real passing re-run of the
  focused test and the regression suite. Never fake the red state by hiding
  or moving files.
- Implement only the explicitly requested task(s); leave every later task
  untouched.
- Keep all sensitive processing and data local; never log or surface
  original text, sanitized/restored text, customer data, secrets, keys,
  subkeys, nonces, ciphertext, or plaintext mappings.
- Use only synthetic data in tests and examples.
- Never commit or push without the user's explicit authorization for that
  specific action.
- Always provide the completion report `AGENTS.md` requires.

For everything else — required reading order, full authority order, Git
discipline detail, validation expectations — see `AGENTS.md` (repository
root). This file does not duplicate it.
