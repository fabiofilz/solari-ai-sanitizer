# Contributing

Solari AI Sanitizer follows Specification-Driven Development.

## Required workflow

Before changing application behavior:

1. Read `SPEC.md`.
2. Identify affected requirement IDs.
3. Update the relevant files under `specs/`.
4. Update acceptance tests and examples.
5. Validate the specification.
6. Implement the smallest complete change.
7. Update automated tests and documentation.
8. Run all project checks.

Run `python3 scripts/validate_specs.py` to validate the specification.

## Pull requests

A pull request must describe:

- Specification rules added or changed
- Affected rule IDs
- Implementation impact
- Database migration impact
- Security and privacy impact
- Tests and validation commands executed

## Test data

Only synthetic data may be used in source code, fixtures, examples, screenshots and documentation.

## Requirement IDs

Requirement IDs are permanent.

Do not reuse an ID that was removed. New requirements receive new IDs.
