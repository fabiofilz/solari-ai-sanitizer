# AI Sanitizer

A local-first desktop application that sanitizes sensitive information before text is shared with a public Large Language Model.

AI Sanitizer preserves useful technical context while replacing customer identities, credentials, personal data, infrastructure identifiers and workspace-defined confidential terms.

It can also translate sanitized text back to canonical original values using a persistent workspace-specific dictionary.

## Why this project exists

Architects, developers and consultants frequently need assistance from online AI tools without exposing confidential information.

Manual replacement is slow and inconsistent. The same company, system or identifier may receive different placeholders across documents or days, causing the LLM to interpret them as different entities.

AI Sanitizer solves this through persistent and isolated translation dictionaries.

## Core capabilities

- Desktop application for Windows and macOS
- Original text on the left and sanitized text on the right
- Bidirectional sanitization and restoration
- Isolated workspaces for different customers or contexts
- Persistent `ALWAYS` and `NEVER` decisions
- Deterministic detection of structured sensitive information
- Optional local AI for ambiguous-term suggestions
- Similarity confidence and alias resolution
- Multiple original values sharing one placeholder
- Canonical original selection for restoration
- Configurable placeholder prefixes
- Searchable term-management screen
- Local SQLite persistence
- No cloud backend
- No transmission of original content to external AI services

## Example

Original text:

    Synthetic Bank SA uses account 123456789012.
    Contact: alex@example.test

Sanitized text:

    COMPANY_1 uses account AWS_ACCOUNT_1.
    Contact: EMAIL_1

If `Synthetic Bank` and `Synthetic Bank SA` refer to the same entity, both may map to `COMPANY_1`. One is selected as the canonical value used during restoration.

## Specification-Driven Development

The specification is the source of truth.

Application behavior is defined under `specs/`. Executable scenarios are stored under `examples/`.

Code, tests and documentation must be updated from the specification rather than becoming independent sources of product behavior.

Start with:

- `SPEC.md`
- `AGENTS.md` for Codex and other coding agents
- `CLAUDE.md` for Claude Code

## Validate the specification

Run `python3 scripts/validate_specs.py` from the repository root.

## Generate the application

After reviewing the specification, request this from Codex or Claude Code:

> Read AGENTS.md or CLAUDE.md, SPEC.md, every file under specs/, and every scenario under examples/. Validate the specification and report contradictions. If it is consistent, implement the complete application and its automated tests exactly as specified. Do not invent product behavior.

## Security

Only synthetic data belongs in this repository.

Never commit original documents, customer information, real mappings, local databases, secrets, local model files or sensitive logs.

See `SECURITY.md`.

## Project status

Specification version: `0.1.0`

Status: Draft, ready for implementation review.

## License

MIT
