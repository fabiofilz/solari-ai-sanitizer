# IPC Contract: Workspace Management

Channels exposed by the preload bridge under the `workspace:*` namespace. All
requests are Zod-validated in the main process before any domain logic runs
(constitution Principle V; research.md #3).

**Design note**: every other contract file (`translation.md`, `decisions.md`,
`terms.md`) takes an explicit `workspaceId` on *every* request rather than
relying on hidden "currently active workspace" state in the main process. Given
`workspaceId`, the main process always resolves directly to that workspace's
SQLite file — this removes an entire class of "wrong workspace" bugs (e.g., a
stale open workspace after a rename or a second window) and gives the strongest
possible reading of FR-WORKSPACE-006. "Opening" a workspace (below) is therefore
a renderer-side UI concern (which workspace's editor/dictionary view is shown),
not a main-process state change.

**Name confidentiality note**: `Workspace.name` may itself be a real customer,
company, engagement, or project name and is encrypted at rest with a
registry-level key, separate from any per-workspace key (research.md #13;
`data-model.md`'s `RegistryKey`/`Workspace` tables). Every channel below that
returns or accepts `name` decrypts/encrypts it in the main process only; `name`
values are never logged, and `DUPLICATE_NAME` matching is performed against a
keyed blind index (`normalized_name_hmac`), never a plaintext comparison.

**Process note**: exactly one instance of the application may run at a time per
`userData` directory (`app.requestSingleInstanceLock()`, research.md #14),
acquired before `registry.sqlite` is ever opened. A second launch attempt never
reaches the IPC layer at all — none of the channels below are reachable from a
redundant second process.

## `workspace:list`

- **Request**: `{}`
- **Response**: `{ workspaces: Array<{ id: string, name: string }> }`
- **Errors**: `REGISTRY_KEY_UNAVAILABLE` — the registry DEK protecting
  workspace names could not be unwrapped (research.md #13); no workspace can be
  listed until this is resolved, since decrypting every `ACTIVE` row's name is
  required to build this response
- **Satisfies**: FR-WORKSPACE-004

## `workspace:create`

- **Request**: `{ name: string }`
- **Response**: `{ id: string, name: string }`
- **Errors**: `DUPLICATE_NAME` — the requested name's normalized blind index
  (`normalized_name_hmac`) already matches an existing workspace (spec
  Assumptions: names are unique application-wide, case/diacritic/whitespace-
  normalization-aware); `REGISTRY_KEY_UNAVAILABLE` — the registry DEK could not
  be created or unwrapped, checked before either the name or the new
  workspace's own `wrapped_dek` is generated (research.md #13). **Exception**
  (FR-WORKSPACE-007, SC-020): if an existing registry DEK cannot be unwrapped
  but zero workspace rows currently exist anywhere in the registry, this call
  transparently replaces the unrecoverable key and proceeds instead of
  returning `REGISTRY_KEY_UNAVAILABLE` — there is no persisted workspace name
  the replacement could orphan. The moment one or more workspace rows exist
  (`ACTIVE` or `DELETING`), this exception no longer applies and the call
  fails closed with `REGISTRY_KEY_UNAVAILABLE` exactly as before, without
  mutating the existing (unrecoverable) key record.
- **Satisfies**: FR-WORKSPACE-001, FR-WORKSPACE-007

## `workspace:rename`

- **Request**: `{ id: string, newName: string }`
- **Response**: `{ id: string, name: string }`
- **Errors**: `NOT_FOUND`, `DUPLICATE_NAME`, `REGISTRY_KEY_UNAVAILABLE`
- **Satisfies**: FR-WORKSPACE-002 — only the registry row's `name_ciphertext`/
  `normalized_name_hmac` change; mappings, policies, prefixes, counters,
  pending decisions, and the workspace's own `wrapped_dek` in the per-workspace
  file are untouched.

## `workspace:open`

- **Request**: `{ id: string }`
- **Response**: `{ id: string, name: string }`
- **Errors**: `NOT_FOUND` — either no registry row exists for the requested
  workspace id, or the registry row exists but its expected per-workspace
  SQLite file is missing; in both cases `workspace:open` MUST fail with
  `NOT_FOUND` and MUST NOT create a replacement per-workspace database file.
  `REGISTRY_KEY_UNAVAILABLE` (name could not be decrypted — research.md #13),
  `WORKSPACE_KEY_UNAVAILABLE` (this workspace's own `wrapped_dek` could not be
  unwrapped — research.md #10; other workspaces are unaffected)
- **Satisfies**: FR-WORKSPACE-003 — confirms the workspace exists and is usable;
  does not mutate any server-side "active workspace" state (see design note
  above).

## `workspace:delete`

- **Request**: `{ id: string, confirm: true }`
- **Response**: `{ status: "DELETING" | "DELETED" }`
- **Errors**: `NOT_FOUND`, `CONFIRMATION_REQUIRED` — the renderer must have shown
  the user what will be permanently removed (mappings, policies, prefixes,
  pending decisions, counters) before sending `confirm: true`
- **Satisfies**: FR-WORKSPACE-005/006, via the **crash-safe, five-step deletion
  protocol** in research.md #12 and `data-model.md`'s "Workspace deletion state
  machine" — **not** a single transaction spanning the registry and the
  per-workspace file, since no such cross-resource atomic primitive exists. This
  call marks the workspace `DELETING` (rejecting every further
  `workspaceId`-scoped request with `WORKSPACE_DELETING`, including from
  `translation.md`, `decisions.md`, and `terms.md`) and then runs the remaining
  steps (close resources → destroy the wrapped key → destroy the file → delete
  the registry row). If the steps complete before this call returns, the
  response is `{ status: "DELETED" }`; if the app is closed or crashes mid-way,
  the response the renderer already received was `{ status: "DELETING" }`, and
  the next application startup's reconciliation pass (research.md #12) finishes
  the remaining steps automatically. This is crash-safe **logical** deletion
  and removal of this application's live key reference — it is **not** a
  guaranteed cryptographic-erasure or secure-physical-deletion claim (see
  research.md #10's "Workspace deletion & key destruction" for the honest
  scope). The workspace never becomes usable again
  either way, and a repeated `workspace:delete` call against an already-
  `DELETING` workspace is treated as a resume, not a new deletion.

## `workspace:list`, `workspace:open` note

Both additionally exclude/refuse a workspace whose registry `status` is
`DELETING` (research.md #12) — `workspace:list` omits it, and `workspace:open`
returns `WORKSPACE_DELETING`.
