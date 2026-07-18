# IPC Contract: Ambiguous-Term Discovery, Decisions, and Pending Decisions

Channels under the `decisions:*` namespace. Covers explicit candidate selection
(FR-DISCOVERY-001), resolving ALWAYS/NEVER (FR-DECISION-001/002), the
same-entity/different-entity alias flow (FR-ALIAS-005/006/007), and persisted
pending-decision management (FR-PENDING-001 through FR-PENDING-010).

**Shared error**: every channel below also returns `WORKSPACE_DELETING` if the
target workspace's registry status is `DELETING` (research.md #12).

`candidate`/`normalizedCandidate` values are decrypted in memory to serve these
responses and are never logged or returned as ciphertext (research.md #10).

## `decisions:select-candidate`

- **Request**: `{ workspaceId: string, text: string }`
- **Response**: `{ pendingDecisionId: string, normalizedCandidate: string, isNew: boolean }`
- **Satisfies**: FR-DISCOVERY-001 — the *only* entry point (besides
  `terms:add-always` / `terms:add-never`, see `terms.md`) by which an ambiguous
  business term enters the decision workflow. If a pending decision for this
  normalized text already exists, `isNew: false` and the existing one is
  returned rather than creating a duplicate (FR-SANITIZE-006).

## `decisions:list`

- **Request**: `{ workspaceId: string }`
- **Response**: `{ pendingDecisions: Array<{ id: string, candidate: string, normalizedCandidate: string }> }`
- **Satisfies**: FR-PENDING-003 — independent of whatever text is currently in
  the editor panels; this list survives application restarts (FR-PENDING-001).

## `decisions:check-similar`

- **Request**: `{ workspaceId: string, pendingDecisionId: string }`
- **Response**: `{ suggestion: null | { termId: string, originalValue: string, placeholderValue: string, confidence: number } }`
- **Satisfies**: FR-ALIAS-005/008 — the deterministic similarity check
  (research.md #2), run only against terms whose *current* policy is ALWAYS.
  Never compares against another still-unresolved pending decision
  (FR-PENDING-010) and never against a term whose current policy is NEVER, even
  if it retains a historical placeholder. `confidence` is advisory only and is
  never used to merge terms automatically (FR-ALIAS-008).

## `decisions:resolve-always`

- **Request**:
  ```
  {
    workspaceId: string,
    pendingDecisionId: string,
    // exactly one of:
    prefix?: string,                 // new or edited prefix (FR-PREFIX-001)
    sameEntityAsTermId?: string,      // alias flow: user confirmed same entity (FR-ALIAS-006)
    principalTermId?: string          // required only if this creates a 2nd+ alias (FR-ALIAS-002)
  }
  ```
- **Response**: `{ termId: string, placeholderValue: string }`
- **Errors**: `INVALID_PREFIX` (normalizes to no usable ASCII letters — edge
  case), `PRINCIPAL_REQUIRED` (placeholder would have ≥2 original values and no
  principal was designated)
- **Satisfies**: FR-DECISION-002, FR-PREFIX-001/005/006 (allocates a brand-new
  placeholder unless `sameEntityAsTermId` is provided, in which case it reuses
  that term's existing placeholder per the alias flow — FR-ALIAS-006/007), and
  removes the resolved pending decision.

## `decisions:resolve-never`

- **Request**: `{ workspaceId: string, pendingDecisionId: string }`
- **Response**: `{ termId: string }`
- **Satisfies**: FR-DECISION-002 (NEVER path — no further input required, no
  placeholder allocated); removes the resolved pending decision.

## `decisions:remove`

- **Request**: `{ workspaceId: string, pendingDecisionId: string }`
- **Response**: `{ removedId: string }`
- **Satisfies**: FR-PENDING-005 — no confirmation required for a single removal;
  creates no ALWAYS/NEVER policy (FR-PENDING-008).

## `decisions:remove-all`

- **Request**: `{ workspaceId: string, confirm: true }`
- **Response**: `{ removedCount: number }`
- **Errors**: `CONFIRMATION_REQUIRED`
- **Satisfies**: FR-PENDING-006/007 — bulk removal always requires the renderer
  to have obtained explicit confirmation first.
