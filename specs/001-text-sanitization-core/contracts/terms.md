# IPC Contract: Dictionary (Term) Administration

Channels under the `terms:*` namespace. Covers Story 6 (search, inspect, add,
edit, remove) and the parts of the alias/prefix rules that are administered
directly rather than through the pending-decision flow.

**Shared error**: every channel below also returns `WORKSPACE_DELETING` if the
target workspace's registry status is `DELETING` (research.md #12) —
`workspaceId`-scoped operations are refused once deletion begins, consistent
with `translation.md` and `decisions.md`.

`terms:search`/`terms:inspect` decrypt `original_value` in memory to serve
their responses; `original_value` is never returned or logged as ciphertext,
and search cannot use a database-level `LIKE` query because of the blind-index
design in `data-model.md` — see research.md #10.

## `terms:search`

- **Request**: `{ workspaceId: string, query: string }`
- **Response**:
  ```
  {
    terms: Array<{
      id: string, originalValue: string, policy: "ALWAYS" | "NEVER",
      placeholderValue?: string, isPrincipal?: boolean, aliasCount?: number
    }>
  }
  ```
- **Satisfies**: FR-TERM-001/002 — matches against original value, placeholder,
  prefix, and policy.

## `terms:inspect`

- **Request**: `{ workspaceId: string, termId: string }`
- **Response**:
  ```
  {
    id: string, originalValue: string, policy: "ALWAYS" | "NEVER",
    placeholder?: { value: string, prefixValue: string },
    aliases?: Array<{ termId: string, originalValue: string, isPrincipal: boolean }>
  }
  ```
- **Satisfies**: FR-TERM-005 — `aliases` is present only when the placeholder has
  more than one original value (FR-ALIAS-003: no principal concept shown for a
  single-value placeholder).

## `terms:list-prefixes`

- **Request**: `{ workspaceId: string }`
- **Response**: `{ prefixes: string[] }`
- **Satisfies**: FR-PREFIX-001 — the set of normalized prefix values already used
  in this workspace, offered as the "select an existing prefix category" option.

## `terms:add-always`

- **Request**: `{ workspaceId: string, originalValue: string, prefix?: string, sameEntityAsTermId?: string, principalTermId?: string }`
- **Response**: `{ termId: string, placeholderValue: string }`
- **Errors**: `INVALID_PREFIX`, `PRINCIPAL_REQUIRED`
- **Satisfies**: FR-TERM-003 — manual entry point into the dictionary, bypassing
  the pending-decision flow entirely; same placeholder-allocation and alias rules
  as `decisions:resolve-always`.

## `terms:add-never`

- **Request**: `{ workspaceId: string, originalValue: string }`
- **Response**: `{ termId: string }`
- **Satisfies**: FR-TERM-004.

## `terms:edit`

- **Request**: `{ workspaceId: string, termId: string, originalValue?: string, policy?: "ALWAYS" | "NEVER" }`
- **Response**: `{ termId: string }`
- **Errors**: `NOT_FOUND`, `WORKSPACE_DELETING`
- **Satisfies**: FR-TERM-006 — a policy change between ALWAYS and NEVER takes
  effect immediately, never re-triggers a prompt, and never clears
  `placeholder_id`. **Demoting the current principal of a multi-original
  placeholder to NEVER never requires principal reassignment** — sanitization
  becomes inactive for that term, but it remains the principal for restoration
  purposes (`data-model.md`'s Term constraints; historical placeholder
  restoration remains valid under NEVER, research.md #10) until the user
  explicitly reassigns it (`terms:set-principal`) or removes it (`terms:remove`,
  which *does* require reassignment first — see below). Editing `originalValue`
  changes future recognition only (spec Assumptions — no retroactive effect on
  already-shared sanitized text).

## `terms:set-principal`

- **Request**: `{ workspaceId: string, placeholderValue: string, principalTermId: string }`
- **Response**: `{ placeholderValue: string, principalTermId: string }`
- **Satisfies**: FR-ALIAS-009 — changing which original value is principal for a
  placeholder, independent of any particular alias's current policy (including
  reassigning away from a term whose policy is currently NEVER, or reassigning
  *to* one).

## `terms:remove`

- **Request**: `{ workspaceId: string, termId: string, confirm: true }`
- **Response**: `{ removedId: string, placeholderDeleted: boolean }`
- **Errors**: `CONFIRMATION_REQUIRED`; `PRINCIPAL_REASSIGNMENT_REQUIRED` —
  returned **only** when `termId` is currently the principal of a placeholder
  that would still have other original values remaining after this removal (i.e.
  removal would detach the principal while aliases remain). The renderer must
  first call `terms:set-principal` to designate a replacement among the
  remaining aliases, then retry the removal. Removing a non-principal alias, or
  the sole remaining original value of a placeholder (which also deletes the
  placeholder), never triggers this error — reassignment is required only when
  an operation would actually remove or detach the principal, never merely
  because a policy changed.
- **Satisfies**: FR-TERM-007 — the renderer must have shown the removal's impact
  (including that previously sanitized text containing this term's placeholder
  will no longer be restorable, if this was its only remaining original value)
  before sending `confirm: true`.
