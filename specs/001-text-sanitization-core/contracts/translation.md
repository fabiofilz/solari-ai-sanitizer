# IPC Contract: Bidirectional Translation

Channels under the `translation:*` namespace. Both channels are pure
transformations against one workspace's persisted dictionary — neither one ever
creates a pending decision (that only ever happens through
`decisions:select-candidate`, see `decisions.md`), consistent with
FR-SANITIZE-006: the deterministic core never automatically discovers ambiguous
business terms.

Both channels enforce the FR-SCALE-001 input-size ceiling and are expected to
complete within the FR-SCALE-002 / SC-018 budget; the renderer is responsible for
debouncing calls per FR-EDITOR-002/003/007 (see research.md #4) so this channel is
not invoked on every keystroke.

**Request shape addition**: both channels also take a renderer-generated,
monotonically increasing `requestId: number`, scoped per (workspace, direction).
The main process performs the actual matching pass in a dedicated worker thread,
never on the main or renderer thread (research.md #11), so large inputs never
freeze the UI. If a newer request for the same (workspace, direction) arrives
before an older one finishes, the older one's eventual result is discarded
(supersession, not preemption — research.md #11) and never delivered to the
renderer; the renderer additionally re-checks `requestId` on arrival as a second
safeguard against a stale result overwriting newer editor content.

**Shared error**: both channels return `WORKSPACE_DELETING` if the target
workspace's registry status is `DELETING` (research.md #12).

## `translation:sanitize`

- **Request**: `{ workspaceId: string, requestId: number, originalText: string }`
  - `originalText` MUST be ≤ 500,000 Unicode characters (FR-SCALE-001).
- **Response**: `{ requestId: number, sanitizedText: string }`
- **Errors**: `WORKSPACE_NOT_FOUND`, `WORKSPACE_DELETING`, `INPUT_TOO_LARGE`,
  `TRANSLATION_WORKER_FAILED` (the worker crashed mid-request — research.md #11;
  a fresh worker is started automatically and the *next* request will succeed)
- **Behavior**:
  - Deterministic structured values are replaced automatically (FR-SANITIZE-005).
  - Every original value with an existing ALWAYS mapping is replaced with its
    placeholder; a term whose current policy is NEVER is left unchanged
    (FR-SANITIZE-001/002/FR-DECISION-002).
  - Ambiguous terms with no saved decision and no prior explicit selection are
    left unchanged — this channel never flags or prompts about them
    (FR-SANITIZE-006).
  - Longer known original values are matched before shorter overlapping ones
    (FR-SANITIZE-003); all other text is preserved exactly (FR-SANITIZE-004).

## `translation:restore`

- **Request**: `{ workspaceId: string, requestId: number, sanitizedText: string }`
  - `sanitizedText` MUST be ≤ 500,000 Unicode characters (FR-SCALE-001).
- **Response**: `{ requestId: number, restoredText: string, unresolvedPlaceholders: string[] }`
- **Errors**: `WORKSPACE_NOT_FOUND`, `WORKSPACE_DELETING`, `INPUT_TOO_LARGE`,
  `TRANSLATION_WORKER_FAILED`
- **Behavior**:
  - Each recognized placeholder token (research.md #8) resolves to its sole
    original value, or its designated principal if it has more than one
    (FR-ALIAS-003/004).
  - A placeholder-shaped token with no match in this workspace is left unchanged
    and reported in `unresolvedPlaceholders` (User Story 2, acceptance scenario
    3); this channel never searches another workspace to resolve it.
  - All text outside recognized placeholders is preserved exactly (User Story 2,
    acceptance scenario 4).
