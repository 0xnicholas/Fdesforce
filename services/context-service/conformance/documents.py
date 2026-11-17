"""The contract as the runner reads it: documents on disk, not the service's copy.

C1 validates the examples *in the repository* against the schemas *in the
repository*. Reading the service's generated copies would let a stale or edited
copy validate the examples it was generated from, which is the one failure mode
the case exists to catch.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator
from referencing import Registry

from app.schema_registry import build_registry, problems, validator_for

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMAS_DIR = REPO_ROOT / "contracts" / "schemas"
CONTRACTS_DIR = REPO_ROOT / "contracts"


class ContractDocuments:
    """The checked-in `contracts/`: schemas, the OpenAPI documents and a registry."""

    def __init__(self, root: Path = REPO_ROOT) -> None:
        self.root = root
        schemas_dir = root / "contracts" / "schemas"
        self.schemas: dict[str, dict[str, Any]] = {
            path.name: json.loads(path.read_text(encoding="utf-8"))
            for path in sorted(schemas_dir.glob("*.json"))
        }
        self.registry: Registry[Any] = build_registry(self.schemas)

    # -- schemas ----------------------------------------------------------

    def validator(self, reference: str) -> Draft202012Validator:
        """A validator for `file.schema.json` or `file.schema.json#/$defs/Name`."""
        file, _, pointer = reference.partition("#")
        name = file.removeprefix("contracts/schemas/").removeprefix("schemas/")
        return validator_for(self.registry, self.schemas, name, pointer)

    def problems(self, instance: Any, reference: str) -> list[str]:
        """Every violation of `reference`, or an empty list."""
        return problems(self.validator(reference), instance)

    def require(self, instance: Any, reference: str, label: str) -> None:
        """Raise an `AssertionError` naming the example when it does not validate."""
        found = self.problems(instance, reference)
        if found:
            joined = "\n  ".join(found)
            raise AssertionError(f"{label} does not validate against {reference}:\n  {joined}")

    # -- OpenAPI ----------------------------------------------------------

    def openapi(self, name: str = "context-service-v1.openapi.yaml") -> dict[str, Any]:
        document = yaml.safe_load((CONTRACTS_DIR / name).read_text(encoding="utf-8"))
        if not isinstance(document, dict):
            raise TypeError(f"contracts/{name} is not an OpenAPI document")
        return document
