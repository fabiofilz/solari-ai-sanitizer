# Feature Specification: Text Sanitization Core Workflow

**Feature Branch**: `001-text-sanitization-core`

**Created**: 2026-07-18

**Status**: Draft

**Input**: User description (summarized): Provide a usable local core workflow in which a user creates an isolated workspace, maintains a persistent dictionary of sanitization decisions (ALWAYS/NEVER policies, prefixes, placeholders, aliases with one principal original), pastes original text to obtain sanitized text, and restores sanitized text back to the original using the same workspace dictionary. Results must stay consistent across documents, sessions, application restarts, and different days.

## Clarifications

### Session 2026-07-18

- Q: How do ambiguous business terms (company, customer, person, internal system, microservice, database, Kafka topic, project, internal product, and confidential business/IP names) enter the decision workflow, given that local and external AI are out of scope for this feature? → A: Only through explicit user selection of a text span in the original panel, or manual addition through dictionary administration. The deterministic core never scans text to discover such terms on its own. Once flagged either way, deterministic (non-AI) similarity comparison may suggest a resemblance to an existing original value.
- Q: Can two different entities ever end up sharing the same generated placeholder? → A: No. Placeholder generation always produces a distinct placeholder per term. Two original values may share one placeholder only when the user explicitly confirms they represent the same entity — the sole alias exception.
- Q: Does editing a saved ALWAYS/NEVER policy make the term eligible to be asked about again? → A: No. Editing a policy — including switching ALWAYS to NEVER or NEVER to ALWAYS — is saved and applied immediately and never triggers a new prompt. Only removing the saved term or decision makes the term unknown again and eligible for a fresh evaluation.
- Q: Do unresolved pending decisions survive an application restart, and can the user manage them directly? → A: Yes. Pending decisions are workspace-scoped and persist — storing only the candidate and the information needed to review it, never the source document or editor content — across restarts, sessions, and different days. The user can inspect, resolve, remove one, or remove all pending decisions for the active workspace; removing more than one at a time requires confirmation. Removal never creates a policy, and the same term may generate a brand-new pending decision if it is explicitly selected or manually added again later.
- Q: What determines the translation direction in the bidirectional editor, and can a programmatic update re-trigger translation? → A: The panel the user directly edited is the source for that translation. A resulting programmatic update applied to the other (destination) panel must never itself trigger a further translation, so the two panels can never loop.
- Q: When confirming an ALWAYS decision outside the alias flow, can the user directly pick an already-existing placeholder? → A: No. The user may accept the suggested prefix, edit it, or pick an existing prefix category already used in the workspace, but confirming always allocates a brand-new placeholder using the next sequence for that prefix. Reusing an existing placeholder is only possible through the alias flow, after the user explicitly confirms the new original value represents the same entity as the original values already associated with that placeholder.
- Q: When a term's policy changes between ALWAYS and NEVER, what happens to its placeholder? → A: A placeholder is permanent once generated for a term. Switching ALWAYS to NEVER keeps the placeholder mapping stored — inactive for future sanitization, but still active for restoring previously sanitized text. Switching back to ALWAYS reuses that same historical placeholder, with no new prefix prompt and no new sequence allocated. Only explicitly removing the term deletes its placeholder association, and that impact on historical restoration must be disclosed before the removal is confirmed. Placeholder sequence numbers are never recycled.
- Q: Does the bidirectional editor require an explicit action (a Sanitize/Restore/Apply button) to translate text, or does it update automatically? → A: Automatically, in both directions — directly editing the left panel updates the right panel, and directly editing the right panel updates the left panel, with no explicit action required. The directly-edited panel is the source of the translation, and a resulting programmatic update to the other panel never triggers a further translation. The exact update timing/interval and its implementation mechanism are left to the implementation plan.
- Q: How are two unresolved pending decisions that merely look similar to each other (but are not exact normalized duplicates) treated? → A: They remain fully independent — no automatic merge, no prompt to merge them, and no shared placeholder while both remain unresolved. Once one is resolved as ALWAYS and has a persisted placeholder, resolving the other may trigger the existing same-entity/different-entity alias flow against that persisted mapping. Alias matching targets only mappings whose current policy is ALWAYS: a pending candidate resolved directly as NEVER (having never been ALWAYS) has never received a placeholder, and any mapping whose current policy is NEVER is never an alias target — regardless of whether it retains a historical placeholder from an earlier ALWAYS decision. All comparisons stay scoped to the active workspace.
- Q: What minimum input size, dictionary size, and responsiveness must the feature support? → A: At minimum, one pasted input of up to 500,000 Unicode characters, one workspace dictionary of up to 10,000 saved terms (including aliases), deterministic sanitization/restoration completing within 2 seconds on the implementation plan's minimum supported hardware, and visible processing feedback whenever an operation is not instantaneous. The benchmark environment, debounce interval, and minimum supported hardware are implementation-plan concerns, not part of this specification.

### Session 2026-07-25

- Q: If the internal key that protects workspace names is later found to be unreadable (for example, after an application crash before the operating system finished persisting key material), may the system generate a replacement automatically? → A: Only when zero workspaces currently exist in the registry — in that case nothing is orphaned by a replacement, so the system replaces the key and continues. If any workspace already exists, whether active or in the middle of being deleted, the system must refuse and report the key as unavailable rather than risk generating a replacement that could no longer verify or manage an existing workspace's name; the previously stored (unreadable) key material is left untouched in that case.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Sanitize confidential text before sharing it (Priority: P1)

A user creates a workspace and pastes original text containing sensitive structured values (such as an email address, an API key, or an internal IP address) into the left panel. The system automatically replaces each recognized deterministic sensitive value with a consistent placeholder in the right panel. Ambiguous business terms (such as a company name) that have no saved decision and have not been explicitly flagged are left unchanged — the deterministic core does not attempt to discover them on its own.

**Why this priority**: This is the entire reason the product exists — turning confidential text into text that is safe to hand to a third party. Without this, there is no product.

**Independent Test**: Can be fully tested by creating one workspace, pasting a block of text with known deterministic sensitive values and no prior dictionary entries, and confirming the sanitized output replaces every sensitive value consistently while leaving unrelated technical text and unflagged ambiguous terms unchanged.

**Acceptance Scenarios**:

1. **Given** a newly created, empty workspace, **When** the user pastes text containing a valid email address, a private IPv4 address, and a JWT, **Then** each value is automatically replaced by a stable placeholder without the user being asked anything.
2. **Given** the same workspace, **When** the pasted text contains the same original value more than once, **Then** every occurrence is replaced by the exact same placeholder.
3. **Given** the same workspace, **When** the pasted text contains only ordinary technology names and generic environment labels (for example a database engine name and the word "staging") and no sensitive values, **Then** the sanitized output is unchanged from the original.
4. **Given** the same workspace, **When** the pasted text contains an ambiguous business term (for example a company name) that has no saved policy and has not been explicitly selected as a candidate, **Then** the sanitized output leaves that term unchanged, because the deterministic core does not automatically discover or classify ambiguous business terms (see User Story 3 for how the user flags it as a candidate).
5. **Given** the same workspace, **When** the user edits or pastes text into the left panel, **Then** the right panel updates automatically, without the user clicking a Sanitize, Apply, or equivalent explicit action.

---

### User Story 2 - Restore sanitized text back to the original (Priority: P2)

A user pastes previously sanitized text (or text they edited after a prior sanitization) into the right panel and the left panel is populated with the canonical original text, using only the mappings already known to the active workspace.

**Why this priority**: Restoring is the second half of the bidirectional promise. Without it, sanitization is a one-way, destructive operation and the user cannot recover the original content to act on a model's response.

**Independent Test**: Can be fully tested by taking sanitized output produced from User Story 1 (or any known placeholder), pasting it into the right panel, and confirming the left panel reproduces the exact original text.

**Acceptance Scenarios**:

1. **Given** a workspace where a placeholder has exactly one known original value, **When** that placeholder appears in text pasted into the right panel, **Then** the left panel shows the original value in that position.
2. **Given** a workspace where a placeholder has more than one original value on record, **When** that placeholder appears in restored text, **Then** it is replaced only with the principal original designated for that placeholder.
3. **Given** sanitized text that contains a placeholder-shaped string the active workspace has never generated, **When** the text is restored, **Then** that string is left unchanged and reported to the user as unresolved.
4. **Given** text pasted into the right panel, **When** it is restored, **Then** all text outside recognized placeholders is preserved exactly, including whitespace, punctuation, and line structure.
5. **Given** the same workspace, **When** the user edits or pastes text into the right panel, **Then** the left panel updates automatically, without the user clicking a Restore, Apply, or equivalent explicit action.

---

### User Story 3 - Flag an ambiguous term and make a lasting decision about it (Priority: P3)

Since the deterministic core does not discover ambiguous business terms on its own, the user explicitly selects a span of text in the original panel (or manually adds a term through dictionary administration) to flag it as a candidate. This creates a pending decision that persists in the active workspace — across sessions, restarts, and different days — until the user resolves it as ALWAYS (always sanitize this term, and pick a placeholder prefix) or NEVER (never sanitize this term, and never ask again in this workspace), or removes it. Once resolved, the decision applies automatically, forever, in that workspace, until it is explicitly edited or removed.

**Why this priority**: This is what makes the workflow "persistent and consistent" rather than a one-off text transform, and it is the only way an ambiguous term ever enters the dictionary from within the editor. It is the mechanism that prevents the user from being asked the same question every day.

**Independent Test**: Can be fully tested by explicitly selecting a new ambiguous term in the original panel to create a pending decision, resolving it as ALWAYS or NEVER, then confirming that same term is applied automatically the next time it appears — in a new input, a new session, or after an application restart — without asking again.

**Acceptance Scenarios**:

1. **Given** original text containing a term with no saved policy, **When** the user selects that text span in the original panel and flags it as a candidate, **Then** the system creates exactly one pending decision for its normalized form, covering every occurrence of that same normalized text in the current input.
2. **Given** a pending decision for a candidate, **When** the user chooses ALWAYS, **Then** the system requires a placeholder prefix — a suggested prefix the user accepts or edits, or an existing prefix category already used in the workspace — and confirming always allocates a brand-new, unique placeholder using the next sequence for that prefix; the user cannot directly select or reuse an existing placeholder through this flow.
3. **Given** a pending decision for a candidate, **When** the user chooses NEVER, **Then** the original text is preserved unchanged everywhere it occurs in the current input and the decision is saved.
4. **Given** a term with a saved ALWAYS or NEVER decision, **When** the same normalized term appears in a later document, a later session, or after an application restart, **Then** the system applies the saved decision automatically and does not ask again.
5. **Given** a user enters a prefix such as `" Nome Cliente_ "` when confirming an ALWAYS decision, **When** the system normalizes and confirms it, **Then** the resulting placeholder is `NOME_CLIENTE_1`, never `NOME_CLIENTE__1` or any form with a double underscore.
6. **Given** any confirmed ALWAYS decision, **When** the placeholder is generated, **Then** it is unique within the workspace — placeholder generation never independently produces the same value for two different terms.
7. **Given** a saved decision, **When** the user edits its policy (for example from ALWAYS to NEVER, or NEVER to ALWAYS), **Then** the new policy is saved and applied immediately, and the system does not ask about that term again.
8. **Given** a saved decision, **When** the user removes the saved term or decision entirely, **Then** the term becomes unknown and is eligible to be evaluated again the next time it is explicitly selected or manually added.
9. **Given** a pending decision that was not resolved before the application closed, **When** the application is reopened, **Then** the pending decision still appears exactly as it was, without requiring the original text to be pasted again.
10. **Given** a term with an existing ALWAYS placeholder, **When** the user switches its policy to NEVER, **Then** future sanitization preserves that term unchanged, the placeholder mapping remains stored, and previously sanitized text containing that placeholder can still be restored.
11. **Given** a term switched to NEVER that still has a historical placeholder from an earlier ALWAYS decision, **When** the user switches it back to ALWAYS, **Then** the system reuses that same historical placeholder without prompting for a new prefix or allocating a new sequence.
12. **Given** a term saved as NEVER that has never had a placeholder, **When** the user switches it to ALWAYS, **Then** the system prompts for a prefix and allocates a brand-new, unique placeholder using the next sequence, exactly as for any other new ALWAYS decision.
13. **Given** a term with a historical placeholder, **When** the user removes the term entirely instead of changing its policy, **Then** the system shows that previously sanitized text containing that placeholder will no longer be restorable, and requires explicit confirmation before completing the removal.

---

### User Story 4 - Confirm whether a new term is the same entity as an existing one (Priority: P4)

After a candidate has been explicitly selected in the original panel or manually added through dictionary administration, deterministic similarity comparison may show that it resembles an original value already mapped in the workspace, along with an advisory similarity indicator. The user explicitly confirms whether it is the same real-world entity (in which case it becomes an additional original value sharing the existing placeholder, and the user is asked which original value is the principal one) or a different entity (in which case a distinct placeholder is created — two different entities are never allowed to share one).

**Why this priority**: Without this, minor variations of the same name (for example with or without a legal suffix) would silently create redundant placeholders, breaking the "consistent" guarantee. It builds on User Story 3's decision flow, so it is ordered after it.

**Independent Test**: Can be fully tested by first mapping one original value to a placeholder (per User Story 3), then introducing a textual variant of that same value and confirming the system asks the same-entity question, and that answering it either way produces the expected placeholder assignment.

**Acceptance Scenarios**:

1. **Given** a workspace where "Synthetic Bank" already maps to a placeholder, **When** the text "Synthetic Bank SA" is explicitly selected and flagged as a candidate, and it is found to be similar, **Then** the user sees the existing placeholder and an advisory similarity indicator before deciding.
2. **Given** that same prompt, **When** the user confirms it is the same entity, **Then** "Synthetic Bank SA" becomes an additional original value for the existing placeholder and the user is asked to pick exactly one of the two values as the principal original.
3. **Given** that same prompt, **When** the user instead confirms it is a different entity, **Then** a distinct placeholder is created for "Synthetic Bank SA" regardless of how high the displayed similarity indicator was — different entities are never allowed to share a placeholder.
4. **Given** a placeholder that already has two or more original values, **When** the user changes which one is principal, **Then** future restorations of that placeholder use the newly designated principal original.
5. **Given** a placeholder with only one original value, **When** the dictionary is inspected, **Then** no principal-original selection is shown or required for it.
6. **Given** two unresolved pending decisions whose candidates are merely similar but do not share the same normalized value, **When** neither has been resolved yet, **Then** the system does not merge them, does not prompt the user to merge them, and does not assign them a shared placeholder — they remain fully independent.
7. **Given** one pending decision already resolved as ALWAYS with a persisted placeholder, **When** a second, similar pending decision is resolved, **Then** the same-entity/different-entity alias flow may trigger against that persisted placeholder, exactly as it would for any other explicitly selected or manually added candidate.
8. **Given** a pending decision resolved as NEVER, **When** a different term resembling it is later flagged as a candidate, **Then** the NEVER term is never offered as a similarity/alias match, because alias matching targets only mappings whose current policy is ALWAYS — a pending candidate resolved directly as NEVER has never received a placeholder in the first place.

---

### User Story 5 - Work across multiple isolated workspaces (Priority: P5)

A user creates, renames, opens, lists, and deletes workspaces, and confirms that mappings, decisions, pending decisions, counters, and content created in one workspace never appear, leak, or influence behavior in another workspace.

**Why this priority**: Multiple isolated contexts (different clients, projects, or engagements) are a stated goal, but a single working workspace is enough to deliver and validate User Stories 1–4. This story extends the product to the multi-context use case.

**Independent Test**: Can be fully tested by creating two workspaces, mapping the same original text to different placeholders in each, and confirming that sanitizing, restoring, or reviewing pending decisions in one workspace never reflects the other workspace's data, and that renaming or deleting one workspace never affects the other.

**Acceptance Scenarios**:

1. **Given** no existing workspaces, **When** the user creates a workspace with a name, **Then** it becomes available to open and appears in the workspace list.
2. **Given** an existing workspace, **When** the user renames it, **Then** its mappings, policies, prefixes, counters, and pending decisions are unchanged.
3. **Given** two workspaces where the same original text maps to different placeholders, **When** either workspace sanitizes or restores text, **Then** only its own mappings are used and the other workspace's mapping is never applied, suggested, or exposed.
4. **Given** a workspace with existing mappings and pending decisions, **When** the user deletes it after confirming an explicit warning describing what will be removed, **Then** the workspace and all of its mappings, decisions, pending decisions, and counters are permanently removed.
5. **Given** a workspace that is currently open, **When** it is deleted, **Then** the application leaves no editor or dictionary view operating against the deleted workspace.
6. **Given** two workspaces where only one has a pending decision for a given term, **When** pending decisions are inspected or resolved, **Then** only the active workspace's own pending decisions are shown or affected — never the other workspace's.

---

### User Story 6 - Administer the dictionary and pending decisions directly (Priority: P6)

Separately from pasting and translating text, the user opens a dedicated view of the active workspace's dictionary and pending decisions: searching or filtering terms, inspecting a term's original value, placeholder, policy, and (when applicable) its aliases and principal original; adding, editing, or removing entries directly; and reviewing, resolving, or removing pending decisions.

**Why this priority**: This is an administrative convenience layered on top of the core translate/restore/decide loop (Stories 1–4). The product is usable without it, since decisions can be made inline, but direct dictionary and pending-decision control is necessary for correcting mistakes and auditing what the workspace has learned.

**Independent Test**: Can be fully tested by opening the dictionary view for a workspace with at least one existing term and one pending decision, searching for the term, editing its policy, resolving the pending decision from its list, and confirming both changes take effect the next time matching text is sanitized — independent of pasting any text during the test itself.

**Acceptance Scenarios**:

1. **Given** an active workspace with saved terms, **When** the user opens the dictionary view, **Then** they can search by original value, placeholder, prefix, or policy and see matching results.
2. **Given** a term shown in the dictionary view, **When** the user inspects it, **Then** its original value, placeholder (if any), policy, and — only when it has more than one original value — its aliases and principal original are all visible.
3. **Given** the dictionary view, **When** the user adds a new ALWAYS or NEVER entry manually, **Then** it behaves identically to a term learned through the sanitization flow, including preventing future prompts for that term.
4. **Given** an existing term, **When** the user changes its policy between ALWAYS and NEVER, **Then** the change is saved and takes effect immediately, without a new prompt being generated for that term.
5. **Given** an existing term, **When** the user removes it, **Then** the system shows the impact of the removal (for example, that a placeholder will no longer be recognized) and requires explicit confirmation before the removal is committed.
6. **Given** the dictionary view and the translation editors, **When** the user interacts with either, **Then** it is always visually and behaviorally clear which one they are using — editing pasted text never silently changes saved dictionary entries or pending decisions, and administering the dictionary never silently rewrites unrelated text sitting in the editors.
7. **Given** the active workspace has one or more pending decisions, **When** the user opens the pending-decisions list, **Then** every persisted pending decision is shown, independent of whatever text currently sits in the editor panels.
8. **Given** a pending decision shown in that list, **When** the user resolves it as ALWAYS or NEVER, **Then** it is saved exactly as if it had been resolved inline while sanitizing text.
9. **Given** a pending decision the user no longer wants to track, **When** the user removes it individually, **Then** it disappears from the list and no ALWAYS or NEVER policy is created for it.
10. **Given** more than one pending decision in the active workspace, **When** the user chooses to remove all of them in one action, **Then** the system requires an explicit confirmation before the removal completes, after which the workspace has zero pending decisions.

---

### Edge Cases

- What happens when one known original value is a prefix of another known original value (for example "Synthetic Bank" and "Synthetic Bank SA")? The longer, more specific original value must be matched first so the shorter one does not swallow part of it.
- What happens when pasted original text already contains a string shaped like a placeholder (for example literal text that happens to look like `TOKEN_7`) but no such mapping exists? It must be left unchanged during sanitization; placeholder-pattern recognition applies only when restoring text, and only for placeholders the active workspace actually generated.
- What happens when the user submits a prefix for an ALWAYS decision that normalizes to nothing usable (for example a string made only of symbols or diacritics with no ASCII letters)? The confirmation must be rejected with feedback, and no placeholder may be generated.
- What happens when a term that is the principal original for a multi-original placeholder has its policy edited from ALWAYS to NEVER? The edit applies immediately: the term is no longer matched during future sanitization, but its historical placeholder association is preserved (not deleted), so it may remain the principal for restoration and may be switched back to ALWAYS later without generating a new placeholder.
- What happens when a term that is the principal original for a multi-original placeholder is removed entirely? A replacement principal must be established among the remaining original values before the removal can complete, or the removal is blocked until the user designates one.
- What happens when the user removes the only remaining original value associated with a placeholder (no aliases left)? The placeholder becomes permanently unresolvable for restoration going forward; this consequence must be disclosed before the removal is confirmed.
- What happens when a term is toggled between ALWAYS and NEVER more than once? Every toggle back to ALWAYS reuses the same historical placeholder — no new prefix prompt occurs and no new sequence is ever allocated for that term.
- What happens when the user selects an existing prefix category (instead of typing a new one) while confirming an ALWAYS decision? A brand-new placeholder is still generated using the next sequence for that prefix; selecting an existing prefix category never reuses a specific existing placeholder value — only the alias flow can do that.
- What happens when the same ambiguous candidate is selected multiple times, or appears many times in one input, in different letter case or with extra internal spacing? All variants that normalize to the same lookup value are treated as one candidate, generating a single pending decision, not one per variant.
- What happens when the user tries to rename a workspace to a name that already belongs to another workspace? The rename is rejected and the user is asked for a different name, since workspace names are unique.
- What happens when sanitized text pasted into the right panel contains a placeholder that belongs to a different, non-active workspace? It is left unchanged and reported as unresolved; the system never searches another workspace to resolve it.
- What happens when both editor panels are cleared? Cleared editor content never deletes or alters any saved mapping, policy, prefix, counter, or persisted pending decision.
- What happens when a pending decision is left unresolved and the application is closed? It persists exactly as created and is available to review and resolve (or remove) in a later session, without the original text needing to be pasted again.
- What happens when the user removes a pending decision instead of resolving it? No ALWAYS or NEVER policy is created; the term remains unknown, and explicitly selecting or manually adding the same text again later may create a brand-new, independent pending decision.
- What happens when a programmatic update to one panel (caused by a translation from the other panel) could itself be treated as new input? It must not trigger a further translation — only a direct user edit or paste initiates a new translation, so the two panels can never loop.
- What happens when two different, still-unresolved pending decisions happen to look similar to each other? They remain fully independent — no automatic merge, no merge prompt, and no shared placeholder — until at least one is resolved to ALWAYS, at which point resolving the other may trigger the same-entity/different-entity alias flow against the now-persisted placeholder.
- What happens when a pending decision is resolved as NEVER and a different term resembling it is later flagged? The NEVER term is never offered as a similarity/alias match. Alias matching targets only mappings whose current policy is ALWAYS: a pending candidate resolved directly as NEVER has never received a placeholder, and this exclusion applies equally to a term that was previously ALWAYS and later switched to NEVER — even though that term retains its historical placeholder for restoration, it is not offered as an alias target while its current policy remains NEVER.
- What happens when the internal key protecting workspace names cannot be read back after an interrupted shutdown? If no workspace has been created yet, the system replaces it automatically and continues; if any workspace already exists, including one still being deleted, the system refuses every workspace operation and reports the key as unavailable rather than silently generating a replacement that would orphan an already-named workspace.

## Requirements *(mandatory)*

### Functional Requirements

#### Workspace management

- **FR-WORKSPACE-001**: The system MUST allow the user to create a new workspace identified by a unique name.
- **FR-WORKSPACE-002**: The system MUST allow the user to rename an existing workspace without altering its mappings, policies, prefixes, counters, or pending decisions.
- **FR-WORKSPACE-003**: The system MUST allow the user to open any existing workspace and make it the active workspace for sanitizing, restoring, and dictionary administration.
- **FR-WORKSPACE-004**: The system MUST allow the user to list all existing workspaces.
- **FR-WORKSPACE-005**: The system MUST allow the user to delete a workspace only after an explicit confirmation that describes what will be permanently removed, including its mappings, policies, prefixes, pending decisions, and counters.
- **FR-WORKSPACE-006**: The system MUST keep every mapping, policy, prefix, sequence counter, alias, principal-original selection, and pending decision scoped to exactly one workspace, with no lookup, suggestion, restoration, or identifier allocation ever crossing into another workspace.
- **FR-WORKSPACE-007**: If the internal key that protects every workspace name becomes unreadable (for example, following an interrupted application shutdown) and the system cannot recover it, the system MUST replace it automatically and continue only when zero workspaces currently exist, since no workspace name is protected by an unreadable key in that case. If one or more workspaces already exist — including a workspace currently being deleted — the system MUST NOT replace that key automatically; it MUST refuse to create, open, list, or rename any workspace and report that the required internal key is unavailable, leaving the existing unreadable key material unchanged, until the underlying issue is resolved outside this feature.

#### Bidirectional editing

- **FR-EDITOR-001**: The system MUST present original text on the left and sanitized text on the right within the same view.
- **FR-EDITOR-002**: The system MUST automatically transform text entered or pasted into the left (original) panel into sanitized text shown in the right panel — without requiring the user to click a Sanitize, Apply, or equivalent explicit action — using only the active workspace's deterministic detectors and previously decided terms; text that matches no deterministic pattern and no existing decision remains unchanged unless separately flagged (see FR-DISCOVERY-001). The exact update timing/interval is an implementation detail left to the implementation plan.
- **FR-EDITOR-003**: The system MUST automatically transform text entered or pasted into the right (sanitized) panel into restored text shown in the left panel — without requiring the user to click a Restore, Apply, or equivalent explicit action — using only the active workspace's dictionary. The exact update timing/interval is an implementation detail left to the implementation plan.
- **FR-EDITOR-004**: The system MUST allow the user to freely edit sanitized text in the right panel (including pasting a different sanitized document) and treat it as new input for restoration.
- **FR-EDITOR-005**: The system MUST NOT change any saved policy, mapping, prefix, alias, principal-original selection, or persisted pending decision merely because the user edited or pasted arbitrary text into either panel; such changes only occur through an explicit decision, an explicit candidate selection, or an explicit dictionary or pending-decision administration action.
- **FR-EDITOR-006**: The system MUST keep the act of translating text (sanitize/restore) and the act of administering the dictionary and pending decisions (Story 6) visibly and behaviorally distinct; explicit candidate selection (FR-DISCOVERY-001) and explicit dictionary/pending-decision administration actions are the only ways to create or change an ambiguous-term policy or pending decision.
- **FR-EDITOR-007**: The panel the user directly edited MUST be treated as the source for the current translation direction; a programmatic update applied to the resulting destination panel MUST NOT itself trigger a further translation in either direction, so no feedback loop can occur between the two panels.

#### Sanitization behavior

- **FR-SANITIZE-001**: The system MUST look up an existing mapping for a recognized original value before ever allocating a new placeholder for it.
- **FR-SANITIZE-002**: The system MUST replace every occurrence of the same recognized original value within a single input with the exact same placeholder.
- **FR-SANITIZE-003**: When a longer known original value contains a shorter known original value as a substring, the system MUST match the longer value first.
- **FR-SANITIZE-004**: The system MUST preserve all text outside matched original values exactly, including whitespace, punctuation, line breaks, and surrounding non-sensitive content.
- **FR-SANITIZE-005**: The system MUST automatically sanitize a deterministic sensitive value recognized with an unambiguous, valid pattern without asking the user a question. In scope for this feature: passwords and secret values in common assignment formats, API keys and access keys, bearer tokens and JWTs, private keys, email addresses, phone numbers, CPF and CNPJ values, IPv4 and IPv6 addresses, URLs and hostnames identifying internal or customer resources, UUIDs, cloud account/subscription/tenant/project/resource identifiers, ARNs, database connection strings, and labeled business identifiers such as customer, order, contract, or employee fields (for example `customerId = 9485734`).
- **FR-SANITIZE-006**: The system MUST NOT automatically scan or classify input text to discover ambiguous business terms (company, customer, person, internal system, microservice, database, Kafka topic, project, internal product, or confidential business/intellectual-property names). A term in one of these categories enters the decision flow only through explicit user selection in the original panel (FR-DISCOVERY-001) or manual addition through dictionary administration (FR-TERM-003, FR-TERM-004). Once flagged this way, the system MUST generate exactly one pending decision per unique normalized candidate, not one per occurrence of that same text in the current input.
- **FR-SANITIZE-007**: The system MUST leave ordinary technology names and generic environment labels (for example, common platform, language, or database technology names, and labels such as production, stage, UAT, test, and development) unchanged, unless the same text also matches a separately detected sensitive value or an explicit ALWAYS mapping applies to it.
- **FR-SANITIZE-008**: The system MUST recompute sanitized output whenever a mapping, policy, prefix, alias, or principal-original selection affecting the current input changes.

#### Ambiguous term discovery

- **FR-DISCOVERY-001**: The system MUST allow the user to explicitly select a span of text in the original panel and flag it as a candidate ambiguous term, which creates exactly one pending decision for its normalized form (or is recognized as the same candidate if a pending decision for that normalized form already exists).

#### Decisions and policies

- **FR-DECISION-001**: The system MUST support exactly two persistent policies for an ambiguous term: ALWAYS (always sanitize it) and NEVER (never sanitize it, and never ask about it again in that workspace). No temporary or "this time only" decision may be offered.
- **FR-DECISION-002**: Choosing ALWAYS for a candidate MUST require the user to confirm a placeholder prefix — newly entered/suggested, or an existing prefix category already used in the workspace (see FR-PREFIX-001; this is never a direct selection of an existing placeholder) — before the decision is saved; choosing NEVER MUST require no further input and MUST preserve the original text unchanged.
- **FR-DECISION-003**: Once a policy is saved for a normalized term in a workspace, the system MUST NOT ask about that same normalized term again in that workspace unless the saved term or decision is subsequently removed. Editing a saved policy (for example switching ALWAYS to NEVER, or NEVER to ALWAYS) MUST take effect immediately and MUST NOT generate a new prompt.
- **FR-DECISION-004**: Removing a saved term or decision MUST make the corresponding term unknown, eligible to be newly evaluated the next time it is explicitly selected or manually added. Editing a saved policy MUST NOT have this effect — it only changes which policy applies going forward.

#### Placeholders and prefixes

- **FR-PREFIX-001**: When confirming an ALWAYS decision outside the alias flow, the system MUST suggest a placeholder prefix and MUST allow the user to either accept it, edit it, or select an existing prefix category already used in the workspace. In every case, confirming the decision MUST allocate a new, unique placeholder using the next workspace-scoped sequence for that prefix; the user MUST NOT directly select or reuse an existing placeholder through this flow. Reusing an existing placeholder is only possible through the alias flow (FR-ALIAS-001), after the user explicitly confirms the new original value represents the same entity as the original values already associated with that placeholder.
- **FR-PREFIX-002**: A confirmed prefix MUST contain only uppercase ASCII letters separated by single internal underscores.
- **FR-PREFIX-003**: Before validating a prefix, the system MUST normalize it by converting letters to uppercase, removing accents/diacritics, converting spaces and hyphens to underscores, collapsing repeated underscores into one, and removing leading and trailing underscores.
- **FR-PREFIX-004**: The user MUST NOT be able to enter or edit the numeric sequence directly; the system alone controls it, only ever incrementing to the next unused sequence for a given prefix. Once allocated to a placeholder, a sequence number MUST NOT be reused or recycled for that prefix in that workspace, even after the associated term or placeholder is removed.
- **FR-PREFIX-005**: The system MUST generate placeholders in the exact form `PREFIX_N`, where `PREFIX` is the normalized prefix and `N` is the system-controlled sequence, joined by exactly one underscore (for example, generating `NOME_CLIENTE_1`, never `NOME_CLIENTE__1`).
- **FR-PREFIX-006**: Placeholder generation MUST never independently produce the same placeholder value for two different terms. The only way multiple terms ever share one placeholder value is by deliberately reusing an existing placeholder through the alias flow (FR-ALIAS-001) after explicit user confirmation — never through independent generation, and never for two terms confirmed to be different entities.

#### Aliases and principal originals

- **FR-ALIAS-001**: By default, every distinct term (original value) MUST receive its own distinct placeholder; two different entities MUST NOT share a placeholder. The system MUST allow more than one original value to share the same placeholder only after the user explicitly confirms they represent the same real-world entity — this is the only way two original values may ever share one placeholder.
- **FR-ALIAS-002**: Whenever a placeholder has more than one associated original value, the system MUST require exactly one of them to be designated as the principal original.
- **FR-ALIAS-003**: Whenever a placeholder has exactly one associated original value, that value MUST be used implicitly for restoration and no principal-original selection is required or shown.
- **FR-ALIAS-004**: Restoring a placeholder with multiple original values MUST always produce its designated principal original.
- **FR-ALIAS-005**: When a candidate that has been explicitly selected (FR-DISCOVERY-001) or manually added (FR-TERM-003, FR-TERM-004) may represent an original value already mapped to a placeholder whose current policy is ALWAYS, the system MUST ask the user whether it is the same entity or a different entity before saving any decision about it. This comparison never occurs between two still-unresolved pending decisions (see FR-PENDING-010), and never targets a term whose current policy is NEVER — regardless of whether that term retains a historical placeholder from an earlier ALWAYS decision, alias matching targets only mappings whose current policy is ALWAYS.
- **FR-ALIAS-006**: Confirming the same entity MUST associate the new value with the existing placeholder and MUST prompt the user to choose which original value becomes principal.
- **FR-ALIAS-007**: Confirming a different entity MUST result in a distinct placeholder for the new value.
- **FR-ALIAS-008**: Any similarity or confidence indicator shown to the user MUST be advisory only; the system MUST NOT merge two original values into the same placeholder based on confidence alone, without explicit user confirmation.
- **FR-ALIAS-009**: The system MUST allow the user to change which original value is designated principal for a placeholder at any later time.

#### Term (dictionary) management

- **FR-TERM-001**: The system MUST provide a dictionary view scoped to the active workspace where terms can be searched.
- **FR-TERM-002**: Search MUST match against original values, placeholders, prefixes, and policies.
- **FR-TERM-003**: The system MUST allow the user to manually add an ALWAYS mapping.
- **FR-TERM-004**: The system MUST allow the user to manually add a NEVER decision.
- **FR-TERM-005**: The system MUST allow the user to inspect a term's original value, placeholder (when applicable), policy, and — only when applicable — its aliases and principal original.
- **FR-TERM-006**: The system MUST allow the user to edit a term's original value and policy, subject to the constraints in the Decisions and Aliases requirements above. Editing a term's policy between ALWAYS and NEVER takes effect immediately and MUST NOT cause the term to be treated as unknown or generate a new prompt. Switching a term from ALWAYS to NEVER MUST preserve its original text unchanged in future sanitization while keeping its existing placeholder mapping stored — inactive for future sanitization, but still usable to restore previously sanitized text that contains that placeholder. Switching a term from NEVER to ALWAYS MUST reuse that same historical placeholder, without prompting for a new prefix or allocating a new sequence, if the term has ever had one; if the term has never had a placeholder, the system MUST follow the normal ALWAYS confirmation flow (FR-PREFIX-001), prompting for a prefix and allocating a new, unique placeholder.
- **FR-TERM-007**: The system MUST allow the user to remove a term after showing the impact of the removal — including that any previously sanitized text containing its placeholder will no longer be restorable once the removal completes — and requiring explicit confirmation before the removal is committed. Removal is a distinct operation from a policy edit: only removal deletes the term's placeholder association; a policy edit to NEVER never does.

#### Pending decision management

- **FR-PENDING-001**: The system MUST persist each pending decision — scoped to the workspace in which it was created — so that it remains available to the user across application restarts, later sessions, and different days, until it is resolved or removed.
- **FR-PENDING-002**: The system MUST NOT persist the pasted document, surrounding editor content, or other document history as a side effect of a candidate becoming a pending decision; only the candidate and the information needed to review and resolve it are retained.
- **FR-PENDING-003**: The system MUST allow the user to inspect the list of pending decisions for the active workspace at any time, independent of the text currently in the editor panels.
- **FR-PENDING-004**: The system MUST allow the user to resolve any listed pending decision as ALWAYS or NEVER directly from that list, applying the same rules as resolving it inline (FR-DECISION-001, FR-DECISION-002).
- **FR-PENDING-005**: The system MUST allow the user to remove a single pending decision manually.
- **FR-PENDING-006**: The system MUST allow the user to remove all pending decisions in the active workspace through one explicit action.
- **FR-PENDING-007**: The system MUST require explicit confirmation before completing a pending-decision removal that affects more than one pending decision, including the remove-all action; removing a single pending decision does not require this confirmation.
- **FR-PENDING-008**: Removing a pending decision MUST NOT create or imply any ALWAYS or NEVER policy for that term. If the same term is later explicitly selected (FR-DISCOVERY-001) or manually added (FR-TERM-003, FR-TERM-004), the system MAY generate a new, independent pending decision for it.
- **FR-PENDING-009**: Deleting or clearing editor content MUST NOT delete any persisted pending decision.
- **FR-PENDING-010**: Two unresolved pending decisions that are merely similar, but do not share the same normalized candidate value, MUST remain fully independent: the system MUST NOT automatically merge them, MUST NOT prompt the user to merge them, and MUST NOT assign them a shared placeholder while both remain unresolved. The same-entity/different-entity comparison (FR-ALIAS-005) only ever applies once one of them has been resolved to ALWAYS and therefore has a persisted placeholder; a mapping whose current policy is NEVER is never treated as a similarity or alias target, regardless of whether it retains a historical placeholder from an earlier ALWAYS decision. All such comparisons remain scoped to the active workspace (FR-WORKSPACE-006).

#### Persistence

- **FR-PERSIST-001**: The system MUST persist each workspace's mappings, policies, prefixes, sequence counters, aliases, principal-original selections, and pending decisions so that they remain identical after the application is closed and reopened, across sessions and across different days.
- **FR-PERSIST-002**: Reopening a workspace MUST reuse the exact same placeholder previously generated for any original value already mapped in that workspace, rather than generating a new one.

#### Scale and responsiveness

- **FR-SCALE-001**: The system MUST support, at minimum, a single pasted input of up to 500,000 Unicode characters and a single workspace dictionary of up to 10,000 saved terms (including aliases), without failure or data loss.
- **FR-SCALE-002**: Deterministic sanitization or restoration of a qualifying input MUST complete within 2 seconds on the minimum supported hardware defined by the implementation plan.
- **FR-SCALE-003**: When a sanitize or restore operation is not effectively instantaneous, the system MUST remain responsive and MUST show the user visible feedback that processing is underway, rather than appearing frozen or unresponsive.

### Key Entities

- **Workspace**: An isolated context (for example, one client or one project) with its own name, dictionary, prefixes, sequence counters, and pending decisions. Nothing about a workspace's dictionary or pending decisions is visible or usable from any other workspace.
- **Original Value**: The real, sensitive or ambiguous text recognized or manually registered within a workspace.
- **Term**: A workspace-scoped record pairing one original value with a policy (ALWAYS or NEVER). A term ever confirmed as ALWAYS retains its placeholder association permanently, even after later switching to NEVER; a term that has never been ALWAYS has no placeholder. A NEVER policy is inactive for future sanitization but, when a placeholder exists, remains active for restoration.
- **Placeholder**: The generated replacement value shown in sanitized text, in the form `PREFIX_N`, unique within its workspace; reused across multiple original values only through the explicit alias flow (FR-ALIAS-001), never through independent generation. Once generated, a placeholder persists for the life of its term(s) regardless of later ALWAYS/NEVER policy toggles, and is deleted only when its term is explicitly removed (FR-TERM-007).
- **Prefix**: The user-confirmed, normalized, uppercase label (letters and internal underscores only) that the system combines with a system-controlled sequence to form a placeholder.
- **Alias / Principal Original**: When a placeholder has more than one original value attached (because the user confirmed they are the same entity), exactly one of those original values is designated the principal original used whenever that placeholder is restored. Two different entities are never permitted to share a placeholder.
- **Pending Decision**: A workspace-scoped, persisted candidate term — created only through explicit user selection in the original panel or manual addition through dictionary administration — that awaits an ALWAYS or NEVER decision. It persists across sessions, restarts, and different days until resolved or removed; it represents every occurrence of its normalized form encountered when it was flagged, and its removal never creates a policy.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can go from creating a new workspace to viewing sanitized output for pasted text in under 2 minutes with no prior setup.
- **SC-002**: Reopening a workspace after a full application restart reproduces the identical placeholder for 100% of previously mapped original values — zero placeholders are regenerated or changed.
- **SC-003**: Within a single pasted document, 100% of occurrences of one recognized original value receive the same placeholder.
- **SC-004**: A term saved with a NEVER policy produces zero repeated prompts for that same term across at least 10 subsequent sanitization operations in the same workspace, including after an application restart.
- **SC-005**: Across paired test scenarios using two workspaces with conflicting mappings for the same original text, 100% of sanitize and restore operations reflect only the active workspace's own mapping.
- **SC-006**: For 100% of placeholders that have more than one original value on record, restoration produces exactly the designated principal original, with no ambiguous or multiple outputs.
- **SC-007**: Across a representative synthetic sample covering every deterministic sensitive-value category listed in this specification, 100% are sanitized automatically without requiring a manual decision.
- **SC-008**: Across all placeholders generated within one workspace, zero duplicate placeholder values are ever independently generated for two different terms; deliberate alias reuse of an existing placeholder, confirmed explicitly by the user, is not counted as a duplicate.
- **SC-009**: Across a representative synthetic sample of ordinary technology names and generic environment labels with no explicit ALWAYS mapping, zero are altered by sanitization.
- **SC-010**: Across a representative synthetic sample of ambiguous business terms with no saved decision and no explicit user selection, zero are altered, flagged, or prompted about automatically by the system.
- **SC-011**: A pending decision created in one session remains available, unchanged, for the user to resolve or remove in a later session or after a full application restart, in 100% of verification runs.
- **SC-012**: Removing a pending decision never results in a saved ALWAYS or NEVER policy for that term, verified across 100% of removal test cases.
- **SC-013**: Across test cases that toggle a term's policy between ALWAYS and NEVER any number of times, the term's placeholder value is identical before and after every toggle — zero new placeholders are ever generated for the same term through toggling.
- **SC-014**: Previously sanitized text containing a placeholder remains restorable in 100% of verification runs even after the underlying term's policy is switched to NEVER, as long as the term itself has not been removed.
- **SC-015**: After a term or placeholder is removed, its sequence number is never reused for a new placeholder under the same prefix in that workspace, verified across 100% of removal-then-reallocation test cases.
- **SC-016**: A single pasted input of 500,000 Unicode characters is sanitized or restored without failure or data loss, verified across representative test inputs at that scale.
- **SC-017**: A workspace dictionary containing 10,000 saved terms (including aliases) continues to support correct lookup, search, sanitization, and restoration without failure.
- **SC-018**: Deterministic sanitization or restoration of a qualifying input completes within 2 seconds on the minimum supported hardware defined by the implementation plan, verified across representative benchmark runs.
- **SC-019**: In 100% of test cases where a sanitize or restore operation is not instantaneous, the user sees visible processing feedback rather than an unresponsive interface.
- **SC-020**: Across test cases exercising an unreadable internal registry-protection key: when zero workspaces exist, automatic replacement succeeds and the affected operation completes in 100% of runs; when one or more workspaces exist (in any combination of active and mid-deletion), 100% of runs are refused with the internal-key-unavailable outcome and no replacement occurs; and in 100% of runs where replacement cannot complete (for example, because generating the replacement itself fails), the previously stored key record is preserved unchanged.

## Assumptions

- Because local or remote AI assistance is out of scope for this feature, the similarity indicator used when a candidate that has been explicitly selected or manually added may match an existing original value (User Story 4) is produced by deterministic text comparison (for example, normalized/fuzzy string matching) — not by any language model or automatic semantic scanning of unstructured text — consistent with the constitution's requirement that the deterministic core function fully without AI.
- Workspace names are unique across the whole application; a duplicate name is rejected at creation or rename time.
- Deleting a workspace is a permanent local operation for this feature; no automatic backup, export, or undo is provided (workspace export/import/duplication is explicitly deferred — see Out of Scope).
- Content typed or pasted into the original, sanitized, or restored panels is not automatically retained between application sessions; only the workspace's persisted dictionary and pending decisions (terms, placeholders, prefixes, policies, sequence counters, and pending candidates) persist.
- Editing a term's stored original value changes what the system recognizes going forward only; text already sanitized or restored and shared elsewhere before the edit is not retroactively changed.
- Renaming an already-confirmed prefix or placeholder, and merging or splitting placeholders that already have separate identities, are not required for this feature (see Out of Scope).
- This feature addresses a single local user operating one workspace at a time; concurrent multi-user access to the same workspace is not addressed here.
- Pending decisions have no automatic expiration or age-based cleanup in this feature; they remain until the user resolves or removes them.
- The precise update-timing mechanism for automatic bidirectional translation (for example, real-time per keystroke versus a brief pause after input) and its exact interval are implementation details left to the implementation plan; this specification requires only that translation occurs automatically without an explicit user action (FR-EDITOR-002, FR-EDITOR-003) and without triggering a feedback loop (FR-EDITOR-007).
- The benchmark environment, minimum supported hardware, and specific technical strategy for meeting the scale and responsiveness targets (FR-SCALE-001 through FR-SCALE-003) are defined by the implementation plan, not this specification.

## Out of Scope

The following are explicitly excluded from this feature and are candidates for later, separately specified work:

- Integration with any external or public large language model, and running or managing a local LLM (for example, an Ollama-based runtime).
- Automatic semantic entity classification or automatic discovery of ambiguous business terms from unstructured text, and automatic alias merging based on confidence alone (confidence remains advisory only, per FR-ALIAS-008). Ambiguous terms always enter the decision flow through explicit user selection (FR-DISCOVERY-001) or manual dictionary addition (FR-TERM-003, FR-TERM-004) — never automatic discovery.
- Workspace duplication, and workspace export/import or backup transfer between devices.
- Importing or exporting files (including PDF or DOCX processing); this feature works only with text pasted directly into the editor panels.
- Cloud synchronization of any workspace data.
- User accounts, authentication, or collaboration between multiple users on the same workspace.
- Knowledge graphs, document-history retention, or version history of previously pasted text.
- A command-line interface, IDE extension, or local public API.
- Packaging, distribution, or selection of implementation technologies (programming languages, frameworks, databases, or desktop application platform) — these belong to the implementation plan, not this specification.
- Merging or splitting already-established placeholders after the fact, and renaming a prefix or placeholder once confirmed.
