# Solari AI Sanitizer Specification

Solari AI Sanitizer follows Specification-Driven Development.

The YAML files under `specs/` are the authoritative product contract. Application code, database migrations, automated tests and user documentation are derived from that contract.

## Required reading order

1. `specs/001-product.yaml`
2. `specs/002-functional-requirements.yaml`
3. `specs/003-business-rules.yaml`
4. `specs/004-user-flows.yaml`
5. `specs/005-ui.yaml`
6. `specs/006-data-model.yaml`
7. `specs/007-architecture.yaml`
8. `specs/008-local-ai.yaml`
9. `specs/009-security.yaml`
10. `specs/010-testing.yaml`
11. `specs/011-acceptance-tests.yaml`
12. All scenarios under `examples/`

## Authority and precedence

Use this precedence when interpreting the specification:

1. Security requirements
2. Explicit business rules
3. Functional requirements
4. User flows and UI behavior
5. Acceptance tests and examples
6. Architecture constraints
7. Existing implementation and tests

Acceptance tests and examples clarify rules but cannot override explicit requirements.

Existing code is an implementation of the specification and never overrides it.

## Conflicts and ambiguities

When authoritative rules conflict:

1. Stop work on the affected behavior.
2. Identify all conflicting rule IDs.
3. Report the conflict.
4. Wait for the specification to be corrected.

Do not silently select an interpretation or invent missing product behavior.

## Change protocol

Behavioral changes must follow this order:

1. Update the specification.
2. Update acceptance tests and examples.
3. Update implementation.
4. Update automated tests.
5. Update documentation.
6. Run all validation checks.

Every rule has a stable ID. Removed IDs must never be reused.

## Validation

Run `python3 scripts/validate_specs.py` from the repository root.

The validator checks YAML and JSON syntax, required files, duplicated rule IDs and broken rule references.

## Core invariant

Original text, restored text, mappings and prompts sent to the local AI remain on the user's device.

The application preserves useful technical context and removes only information that is sensitive by deterministic rule or explicit workspace decision.
