"""JSON Schema validation shared by the service and the conformance runner.

`contracts/` is the validator: the generated Pydantic models are a typed *view*
of the same documents, not a second set of rules. The runtime validates every
request body against the real schema before a handler sees it (`app.contract`),
and the runner validates the contract's own examples with the same machinery
(C1), so a rule cannot hold in one place and be missing in the other.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from jsonschema import Draft202012Validator
from referencing import Registry, Resource


def build_registry(documents: Mapping[str, Mapping[str, Any]]) -> Registry[Any]:
    """A registry keyed by each document's `$id`, so cross-file `$ref`s resolve."""
    registry: Registry[Any] = Registry()
    for name, document in documents.items():
        identifier = document.get("$id")
        if not isinstance(identifier, str):
            raise TypeError(f"schema document {name} has no $id; cross-file $refs would not resolve")
        registry = registry.with_resource(identifier, Resource.from_contents(document))
    return registry


def validator_for(
    registry: Registry[Any],
    documents: Mapping[str, Mapping[str, Any]],
    file: str,
    pointer: str = "",
) -> Draft202012Validator:
    """A validator for `file` (or `file` + `#/$defs/Name`) that can follow `$ref`s."""
    try:
        document = documents[file]
    except KeyError as cause:
        raise KeyError(f"no such schema document {file!r}; known: {', '.join(sorted(documents))}") from cause
    return Draft202012Validator({"$ref": f"{document['$id']}#{pointer}"}, registry=registry)


def problems(validator: Draft202012Validator, instance: Any) -> list[str]:
    """Every violation, in a stable order, each with its JSON path."""
    errors = sorted(validator.iter_errors(instance), key=lambda error: (error.json_path, error.message))
    return [f"{error.json_path}: {error.message}" for error in errors]
