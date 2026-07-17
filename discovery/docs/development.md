# Development

The specification is authoritative. Read `SPEC.md`, all numbered specifications, and examples before implementation.

Expected implementation stack: Electron, React, TypeScript, Monaco Editor, Python, FastAPI, Pydantic, SQLAlchemy, SQLite, and optional Ollama. Pin dependencies and commit lockfiles.

Before submitting a change, run the specification validator, formatting, linting, TypeScript and Python type checks, unit/integration/end-to-end tests, dependency audit, and platform builds applicable to the change.

Use synthetic fixtures only. Core tests must run offline and must never call a public AI service.
