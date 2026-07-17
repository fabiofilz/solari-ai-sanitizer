#!/usr/bin/env python3
"""Validate AI Sanitizer specification syntax, IDs, and references."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
SPEC_DIR = ROOT / "specs"
EXAMPLE_DIR = ROOT / "examples"
ID_RE = re.compile(r"^(?:SPEC|PRD-PRINCIPLE|GOAL|NON-GOAL|CAP|SUCCESS|FR|BR|FLOW|UI|DATA-INV|ARCH-CONSTRAINT|SEC|THREAT|TEST-PROP|AC|EX)-[A-Z0-9-]+$")
REFERENCE_PREFIXES = ("FR-", "BR-", "SEC-", "DATA-INV-", "ARCH-CONSTRAINT-", "AC-")


def load_yaml(path: Path) -> Any:
    try:
        import yaml  # type: ignore
    except ImportError as exc:
        raise RuntimeError("PyYAML is required: python3 -m pip install pyyaml") from exc
    with path.open(encoding="utf-8") as stream:
        return yaml.safe_load(stream)


def walk(value: Any) -> Iterable[Any]:
    yield value
    if isinstance(value, dict):
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def main() -> int:
    errors: list[str] = []
    required_specs = [SPEC_DIR / f"{number:03d}-{name}.yaml" for number, name in [
        (1, "product"), (2, "functional-requirements"), (3, "business-rules"),
        (4, "user-flows"), (5, "ui"), (6, "data-model"), (7, "architecture"),
        (8, "local-ai"), (9, "security"), (10, "testing"), (11, "acceptance-tests")]]
    for path in required_specs:
        if not path.is_file() or path.stat().st_size == 0:
            errors.append(f"Missing or empty required specification: {path.relative_to(ROOT)}")

    documents: list[tuple[Path, Any]] = []
    for path in sorted([*SPEC_DIR.glob("*.yaml"), *EXAMPLE_DIR.glob("*.yaml")]):
        try:
            data = load_yaml(path)
            if data is None:
                errors.append(f"Empty YAML document: {path.relative_to(ROOT)}")
            else:
                documents.append((path, data))
        except Exception as exc:
            errors.append(f"Invalid YAML {path.relative_to(ROOT)}: {exc}")

    schema_path = ROOT / "schemas" / "specification.schema.json"
    try:
        json.loads(schema_path.read_text(encoding="utf-8"))
    except Exception as exc:
        errors.append(f"Invalid JSON schema: {exc}")

    definitions: dict[str, Path] = {}
    references: list[tuple[str, Path]] = []
    for path, data in documents:
        for node in walk(data):
            if isinstance(node, dict):
                identifier = node.get("id")
                if isinstance(identifier, str):
                    if not ID_RE.match(identifier):
                        errors.append(f"Invalid ID {identifier!r} in {path.relative_to(ROOT)}")
                    elif identifier in definitions:
                        errors.append(f"Duplicate ID {identifier}: {definitions[identifier].relative_to(ROOT)} and {path.relative_to(ROOT)}")
                    else:
                        definitions[identifier] = path
                for key in ("verifies", "rules", "mitigations"):
                    values = node.get(key, [])
                    if isinstance(values, list):
                        references.extend((value, path) for value in values if isinstance(value, str) and value.startswith(REFERENCE_PREFIXES))

    for reference, path in references:
        if reference not in definitions:
            errors.append(f"Broken reference {reference} in {path.relative_to(ROOT)}")

    if errors:
        print("Specification validation failed:")
        for error in errors:
            print(f"- {error}")
        return 1
    print(f"Specification validation passed: {len(documents)} YAML files, {len(definitions)} unique IDs, {len(references)} checked references.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
