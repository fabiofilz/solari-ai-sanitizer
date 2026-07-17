# Architecture

AI Sanitizer is a local-first desktop system. Electron owns the window and process lifecycle; React and Monaco provide the UI; a bundled Python/FastAPI sidecar contains domain logic; SQLite stores isolated workspace dictionaries; Ollama is optional local assistance.

The renderer cannot access Node or the database directly. It uses a minimal preload bridge to the Electron main process and an authenticated loopback API. The backend rejects non-loopback clients and never logs request bodies.

Sanitization order is: saved NEVER decisions, saved mappings, deterministic detectors, optional local-AI suggestions, pending user decisions, then ordered replacement. Restoration uses only the active workspace and its sole or principal originals.

The application starts and stops child processes it owns. It does not stop an independently running Ollama service. See `specs/007-architecture.yaml` for the authoritative contract.
