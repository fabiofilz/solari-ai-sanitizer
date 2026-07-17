# Specification workflow

1. Describe a behavior change by editing the appropriate `specs/*.yaml` rule.
2. Keep existing IDs stable; add a new ID for a new rule and never reuse removed IDs.
3. Update acceptance tests and synthetic examples.
4. Run `python3 scripts/validate_specs.py`.
5. Ask the coding agent to identify affected components before implementation.
6. Update code, database migrations, automated tests, and user documentation together.
7. Record the specification version used by each application release.

If rules conflict, do not let an agent guess. Correct the specification first.
