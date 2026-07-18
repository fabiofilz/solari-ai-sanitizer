# Solari AI Sanitizer — Claude Code Instructions

Before planning or changing application behavior, read:

1. `SPEC.md`
2. Every file under `specs/`
3. Every relevant scenario under `examples/`
4. Existing implementation and automated tests

The specification is authoritative. Existing code is derived from it.

## Mandatory behavior

- Never invent, weaken or silently reinterpret requirements.
- Report conflicting rule IDs before implementing affected behavior.
- Update the specification first when behavior changes.
- Update implementation, tests and documentation together.
- Keep original and restored text, mappings and local-AI prompts on the device.
- Preserve complete workspace isolation.
- Use only synthetic data in source code, fixtures, tests, examples and screenshots.
- Reference requirement IDs in automated tests where practical.
- Run specification validation and all implementation checks.
- Report rules implemented, files changed, checks executed and unresolved issues.

## Safety

Never commit secrets, credentials, customer information, original documents, mapping databases, local model files or sensitive logs.

Never rewrite Git history or perform destructive Git operations without explicit authorization.
