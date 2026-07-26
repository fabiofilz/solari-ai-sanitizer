# Phase 1 Data Model: Text Sanitization Core Workflow

Storage shape follows research.md #1: one registry database for the workspace
list, and one fully independent SQLite file per workspace. Because each
workspace's data lives in its own file, **no table below carries a `workspace_id`
column** — the file itself is the isolation boundary, which is the strongest
possible form of FR-WORKSPACE-006's "never crosses into another workspace" rule.

Every field is traced to the requirement that needs it. Per constitution
Principle VII ("MUST NOT retain data... that no current specification requires"),
this model deliberately omits anything not backed by an FR — see "Modeling notes"
at the end.

## Registry database (`registry.sqlite`)

### RegistryKey

A singleton row holding the registry-level data-encryption key that protects
`Workspace.name` (research.md #13) — a separate key from any per-workspace DEK,
since a workspace's name must be readable and checked for uniqueness before
that workspace, and its own DEK, exist.

| Field | Type | Rule |
|---|---|---|
| id | PK, fixed = 1 | Singleton — exactly one row, created on first application launch or first workspace creation, whichever comes first |
| wrapped_dek | blob | The registry's 256-bit data-encryption key, Base64-encoded then wrapped via `safeStorage.encryptStringAsync` (research.md #10, #13) — never stored unwrapped. Not destroyed by any individual workspace's deletion; persists for the lifetime of the installation. If this row's wrapped value later becomes unrecoverable (e.g. the confirmed Windows crash-restart timing defect, research.md #13), `getOrCreateRegistryDek` (the startup/create-path entry point only) MAY replace it in place via one recheck-then-update transaction, but **only** when the `Workspace` table below contains zero rows (FR-WORKSPACE-007, SC-020) — never when any row exists, `ACTIVE` or `DELETING`. `loadExistingRegistryDek` (open/list/rename) never performs this replacement, even when `Workspace` is empty |

### Workspace

| Field | Type | Rule |
|---|---|---|
| id | uuid, PK | Internally generated; filenames are derived from this, **never** from `name` (research.md #12 — avoids path-traversal/unsafe characters and file renames on FR-WORKSPACE-002) |
| name_ciphertext | blob | `name`, AES-256-GCM-encrypted with the **registry** DEK's encryption subkey (research.md #13) — a workspace name may itself be a real customer/company/engagement name, so it is reversible sensitive data exactly like `Term.original_value`, never stored in plaintext |
| normalized_name_hmac | blob, unique | Blind index: `HMAC-SHA256(registry index_subkey, normalized_form)`, reusing the same case/diacritic/whitespace normalization already defined for prefixes and lookups (research.md #2, #8). Enforces FR-WORKSPACE-001's application-wide uniqueness (spec Assumptions) without ever storing a plaintext or folded-plaintext name |
| status | enum: `ACTIVE` \| `DELETING` | Deletion tombstone state (research.md #12). While `DELETING`, every IPC request scoped to this workspace is rejected with `WORKSPACE_DELETING`, and it is omitted or disabled in `workspace:list` |
| wrapped_dek | blob, nullable | The workspace's **own** 256-bit data-encryption key (protecting `Term`/`PendingDecision` rows in the per-workspace file — a distinct key, for a distinct purpose, from `RegistryKey.wrapped_dek` above), Base64-encoded then wrapped via `safeStorage.encryptStringAsync` — never stored unwrapped (research.md #10). Set at creation; set to `NULL` as the key-destruction step of deletion (research.md #12) — see research.md #10's "Workspace deletion & key destruction" for the honest scope of what this does and does not guarantee |

**Relationships**: 1:1 with a per-workspace database file at
`<userData>/workspaces/<id>.sqlite`. Every `Workspace` row shares the single
`RegistryKey` row for name encryption; each `Workspace` row has its own,
independent `wrapped_dek` for its per-workspace file's contents.

**Lifecycle**:
- **Create** (FR-WORKSPACE-001) → compute `normalized_name_hmac` for the
  requested name and reject with `DUPLICATE_NAME` if a row with that HMAC
  already exists; else encrypt `name` with the registry DEK's encryption
  subkey, generate and wrap a fresh per-workspace `wrapped_dek`, and insert the
  registry row (`status = ACTIVE`) + create a new empty per-workspace file.
  Refuses with `REGISTRY_KEY_UNAVAILABLE` if the registry DEK cannot be
  created/unwrapped (research.md #13), checked before either key is generated
  — unless the existing registry DEK is unrecoverable **and** zero `Workspace`
  rows currently exist, in which case a replacement registry DEK is generated
  and persisted automatically instead of failing closed (FR-WORKSPACE-007,
  SC-020; research.md #13's crash-recovery exception). This exception never
  applies once any `Workspace` row exists, regardless of `status`.
- **Rename** (FR-WORKSPACE-002) → recompute `normalized_name_hmac` for the new
  name, re-check uniqueness, then update `name_ciphertext`/`normalized_name_hmac`
  only; the per-workspace file, its contents, and its own `wrapped_dek` are
  untouched.
- **Open** (FR-WORKSPACE-003) → refuses immediately with `WORKSPACE_DELETING`
  if `status = DELETING`; else decrypts `name_ciphertext` (registry DEK) and
  unwraps this workspace's own `wrapped_dek` (failing with
  `WORKSPACE_KEY_UNAVAILABLE` if that specific workspace's key material is
  lost — research topic #10), and validates that the per-workspace file can
  itself be opened, closing it again afterward. Per `contracts/workspace.md`'s
  design note, this does not create or retain any server-side "active
  workspace" connection or state — every other channel
  (`translation`/`decisions`/`terms`) resolves `workspaceId` directly on each
  request instead.
- **List** (FR-WORKSPACE-004) → read all `ACTIVE` registry rows and decrypt each
  `name_ciphertext` with the registry DEK's encryption subkey to build the
  response.
- **Delete** (FR-WORKSPACE-005) → the five-step crash-safe protocol in
  research.md #12 (mark `DELETING` → close resources → destroy this workspace's
  own `wrapped_dek` → destroy the file → delete the registry row, including its
  `name_ciphertext`/`normalized_name_hmac`), **not** a single cross-resource
  transaction. Cascades every table below, including pending decisions
  (FR-WORKSPACE-006), because the entire file that contains them is destroyed.
  The shared `RegistryKey` row is **not** touched by any individual workspace's
  deletion.

## Per-workspace database (`<workspace-id>.sqlite`)

### Prefix

| Field | Type | Rule |
|---|---|---|
| id | PK | — |
| value | text, unique | Normalized uppercase-letters-and-underscores form (FR-PREFIX-002/003) |
| next_sequence | integer ≥ 1 | System-controlled only, never user-edited (FR-PREFIX-004); monotonic, never decreases or recycles a used number (SC-015) |

### Placeholder

| Field | Type | Rule |
|---|---|---|
| id | PK | — |
| prefix_id | FK → Prefix | — |
| sequence | integer | The value of `Prefix.next_sequence` at allocation time |
| rendered_value | text, unique | `${prefix.value}_${sequence}`, exactly one underscore before the sequence (FR-PREFIX-005); never duplicated (FR-PREFIX-006) |

**Lifecycle**: Allocated once, when a Term is first confirmed ALWAYS and no
existing Placeholder is being reused via the alias flow (FR-PREFIX-001). Once
allocated, a Placeholder is **permanent** — it survives every later ALWAYS/NEVER
toggle of any Term referencing it (FR-TERM-006) — and is deleted only when the
last Term referencing it is fully removed (FR-TERM-007), after which its
`(prefix_id, sequence)` pair is never reissued (SC-015).

### Term

The central entity — one row per known original value.

| Field | Type | Rule |
|---|---|---|
| id | PK | — |
| original_value_ciphertext | blob | `original_value`, AES-256-GCM-encrypted with the workspace's DEK (nonce + ciphertext + auth tag) — reversible sensitive data, never stored in plaintext (research.md #10) |
| normalized_lookup_hmac | blob, unique | Blind index: `HMAC-SHA256(index_subkey, normalized_form)`, replacing a plaintext normalized column that would otherwise leak the same sensitive value in folded form. Supports exact-match dedup so re-encountering the same normalized term never re-prompts (FR-DECISION-003); does **not** support substring search (see `terms:search` behavior note) |
| policy | enum: `ALWAYS` \| `NEVER` | FR-DECISION-001 — exactly these two values, nothing else; plaintext (not reversible to a sensitive value) |
| placeholder_id | nullable FK → Placeholder | Null only for a term that has **never** been ALWAYS. Once set (on first ALWAYS confirmation), it is retained forever, including through any later switch to NEVER (FR-TERM-006); plaintext, not sensitive |
| is_principal | nullable boolean | See constraints below; plaintext, not sensitive |

`original_value` is decrypted into memory only while the workspace is open and
only for as long as an operation needs it (dictionary-snapshot build for
translation, `terms:search`/`terms:inspect` responses); it is never written back
to disk in plaintext.

**Constraints** (all traced to spec rules):

- `policy = NEVER AND placeholder_id IS NULL` → this term has never been ALWAYS
  (FR-TERM-006's "never had a placeholder" case; also the normal shape of a
  pending decision resolved directly as NEVER).
- `policy = NEVER AND placeholder_id IS NOT NULL` → a historical placeholder from
  an earlier ALWAYS decision is retained: inactive for future sanitization and
  never offered as a similarity/alias target (corrected FR-ALIAS-005), but still
  active for restoring previously sanitized text (FR-TERM-006).
- `is_principal IS NULL` whenever `placeholder_id` has exactly one Term
  referencing it (FR-ALIAS-003 — no principal selection is shown or required).
- Exactly one Term with `is_principal = true` whenever two or more Terms share
  the same `placeholder_id` (FR-ALIAS-002).
- `is_principal` is independent of `policy` — a Term may remain the principal for
  restoration purposes after its own policy switches to NEVER. **Changing a
  term's policy to NEVER never requires principal reassignment merely because
  sanitization becomes disabled for it**; historical placeholder restoration
  remains valid under NEVER (research.md #10's key-lifecycle notes). A
  replacement principal is required only when an operation would actually
  **remove** the principal Term or **detach** it from the shared placeholder
  while other aliases remain — i.e., at removal time (see lifecycle below), never
  at policy-edit time. (`contracts/terms.md`'s `terms:edit` previously described
  this incorrectly and has been corrected.)

**Lifecycle / state transitions**:

```
   (unknown / does not exist)
        │
        ├─ resolved ALWAYS (FR-DISCOVERY-001 flow, or FR-TERM-003 manual add,
        │   or first deterministic-detector match) ──► allocates a new
        │   Placeholder (FR-PREFIX-001), unless the alias flow (FR-ALIAS-006)
        │   attaches it to an existing one instead
        │
        └─ resolved NEVER (FR-DISCOVERY-001 flow, or FR-TERM-004 manual add)
            ──► placeholder_id stays null

Term(ALWAYS) ⇄ Term(NEVER)   [FR-TERM-006 edit, reversible any number of times;
                               placeholder_id, once set, is never cleared or
                               reallocated by a toggle]

Term(any) ──► removed (FR-TERM-007)
  - if sole Term referencing its placeholder_id: Placeholder row is deleted too,
    and its (prefix_id, sequence) is never reissued (SC-015)
  - if it was the principal among ≥2 aliased Terms: a replacement principal must
    be chosen among the remainder before removal completes (edge case)
```

### PendingDecision

| Field | Type | Rule |
|---|---|---|
| id | PK | — |
| candidate_ciphertext | blob | `candidate`, AES-256-GCM-encrypted with the workspace's DEK — the flagged text is itself sensitive (research.md #10) |
| normalized_candidate_hmac | blob, unique | Blind index, same construction as `Term.normalized_lookup_hmac`: one pending decision per unique normalized candidate (FR-SANITIZE-006 / FR-DISCOVERY-001) without storing a readable normalized form |

No other field is persisted: not the source document, not surrounding editor
content, not an occurrence count from the input that produced it — FR-PENDING-002
requires retaining only the candidate and the minimum information needed to
review and resolve it.

**Lifecycle**:
- **Created** via explicit selection in the original panel (FR-DISCOVERY-001).
- **Resolved** as ALWAYS or NEVER, from the editor flow or the pending-decisions
  list (FR-PENDING-004) → converts into a Term as described above; the
  PendingDecision row is deleted.
- **Removed** individually (FR-PENDING-005) or all at once with confirmation
  (FR-PENDING-006/007) → row deleted, **no** Term is created (FR-PENDING-008).
- Whether resolved or removed, the same `normalized_candidate` may produce a
  brand-new, independent PendingDecision later if the text is explicitly selected
  or manually added again (FR-PENDING-008 edge case).
- Survives application restart, later sessions, and different days, scoped to
  this workspace file only (FR-PENDING-001).

## Relationships summary

```
Workspace (registry.sqlite, incl. status + wrapped_dek)  1───1  <workspace-id>.sqlite (file)

within one workspace file:

Prefix  1───*  Placeholder  1───*  Term   (0, 1, or many Terms per Placeholder;
                                            exactly one is_principal=true once ≥2)
                                            [original_value encrypted; everything
                                             else in Term/Placeholder/Prefix plaintext]

PendingDecision  (independent — no foreign key to Term/Placeholder; resolving one
                  creates a new Term row rather than linking to this one)
                  [candidate encrypted]
```

## Workspace deletion state machine

`Workspace.status` implements the crash-safe protocol from research.md #12 as an
explicit state machine, not an implicit side effect of a single transaction:

```
ACTIVE ──(workspace:delete, confirm: true)──► DELETING
  │                                              │
  │                                    step 2: close SQLite handle + worker
  │                                    step 3: wrapped_dek ← NULL  (removes this
  │                                            app's live key reference — best-
  │                                            effort, not a guaranteed erasure
  │                                            claim; see research.md #10)
  │                                    step 4: delete <id>.sqlite (+ -wal/-shm)
  │                                    step 5: delete registry row
  │                                              │
  ▼                                              ▼
(rejects all workspaceId-scoped requests    (workspace no longer exists —
 with WORKSPACE_DELETING while in this       registry row absent, file absent)
 state; workspace:open also refuses it)

Interrupted at any step ──► resumed by startup reconciliation, inferring the
                             next step from (wrapped_dek IS NULL?, file exists?)
```

While `status = DELETING`, `translation:*`, `decisions:*`, and `terms:*` requests
for that `workspaceId` are rejected with `WORKSPACE_DELETING` — the same error
code is shared across all four contract files for consistency.

## Modeling notes (why some "obvious" fields are absent)

- **No `workspace_id` column anywhere in the per-workspace schema.** The file
  itself is the workspace boundary (research.md #1) — the strongest available
  form of the isolation FR-WORKSPACE-006 requires.
- **No timestamps or usage metadata** (`created_at`, `updated_at`,
  `last_used_at`, `usage_count`) on any entity. No FR in spec.md requires
  displaying, sorting by, or otherwise depending on them; per constitution
  Principle VII, data with no current specification requirement is not retained.
  (Such fields appeared as "should"-priority items in the historical `discovery/`
  material but were intentionally not carried into spec.md — see spec.md's own
  Assumptions/Out of Scope sections.) If a future spec change requests them
  (e.g., "show last-used date"), add the column then.
- **No `source` provenance field on Term** (e.g., "came from a detector vs. an
  explicit selection vs. manual entry"). No FR's *runtime* behavior depends on
  knowing how an existing Term originated — FR-SANITIZE-001/002 treat "a
  recognized original value" uniformly regardless of origin. The rule that the
  system must never *automatically scan for* ambiguous business terms
  (FR-SANITIZE-006) is enforced by which code path runs during sanitization, not
  by a stored flag on the resulting Term.
- **No plaintext `normalized_lookup`/`normalized_candidate` columns.** Both were
  replaced with HMAC-based blind indexes (research.md #10) once
  `original_value`/`candidate` were recognized as reversible sensitive data: a
  normalized, case/diacritic-folded copy of a sensitive value is still that
  sensitive value in almost-original form, so storing it in plaintext would have
  quietly defeated the point of encrypting the column next to it.
- **`terms:search` (FR-TERM-002) cannot be a plaintext SQL `LIKE` query anymore.**
  Because `original_value` is encrypted and its blind index only supports exact
  match, free-text search decrypts the workspace's Term rows (bounded to 10,000,
  FR-SCALE-001) into memory and filters there. See research.md #10's
  "Performance impact" for why this stays well within budget.
- **`RegistryKey` is a singleton table, not a column bolted onto some existing
  row.** A registry-scope key is needed before any `Workspace` row exists (to
  check name uniqueness and encrypt the very first name), so it cannot live on
  a `Workspace` row; a dedicated one-row table is the smallest shape that
  expresses "exactly one key, scoped to the whole registry" (research.md #13),
  without introducing a second file or a key-value config table for a single
  value.
