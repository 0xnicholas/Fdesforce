"""Examples embedded in the machine-readable contract (the second half of C1).

Markers cover the narrative docs (`conformance/examples.py`); the schemas and
OpenAPI documents carry their own examples as JSON Schema `example`/`examples`
keywords and OpenAPI Media Type / Parameter `example`/`examples` fields. C1 says
*every* example validates, so these are checked against the schema that contains
them — a schema's `example` against the node it annotates, an OpenAPI example
against its sibling `schema`.

There are none today. The check exists so the first one added cannot be wrong.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from app.schema_registry import problems

from .documents import ContractDocuments

OPENAPI_DOCUMENTS = ("context-service-v1.openapi.yaml", "runtime-api-v1.openapi.yaml")


def _escape(part: str) -> str:
    return part.replace("~", "~0").replace("/", "~1")


def _example_values(node: Mapping[str, Any]) -> Iterator[tuple[str, Any]]:
    """The `example` / `examples` entries of an OpenAPI object."""
    if "example" in node:
        yield "example", node["example"]
    examples = node.get("examples")
    if isinstance(examples, dict):
        for name, entry in examples.items():
            if isinstance(entry, dict) and "value" in entry:
                yield f"examples.{name}", entry["value"]


def _record(failures: list[str], label: str, found: list[str]) -> None:
    failures.extend(f"{label}: {problem}" for problem in found)


def _schema_embedded(
    node: Any,
    pointer: str,
    name: str,
    documents: ContractDocuments,
    failures: list[str],
) -> None:
    if isinstance(node, dict):
        validator = documents.validator(f"{name}#{pointer}")
        if "example" in node:
            _record(failures, f"contracts/schemas/{name}#{pointer} example", problems(validator, node["example"]))
        examples = node.get("examples")
        if isinstance(examples, list):
            for index, value in enumerate(examples):
                _record(
                    failures,
                    f"contracts/schemas/{name}#{pointer} examples[{index}]",
                    problems(validator, value),
                )
        for key, value in node.items():
            if key in {"example", "examples"}:
                continue
            _schema_embedded(value, f"{pointer}/{_escape(key)}", name, documents, failures)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            _schema_embedded(value, f"{pointer}/{index}", name, documents, failures)


def _openapi_validator(schema: Any, documents: ContractDocuments) -> Draft202012Validator:
    reference = schema.get("$ref") if isinstance(schema, dict) else None
    if isinstance(reference, str) and reference.startswith("./schemas/"):
        file, _, pointer = reference.partition("#")
        return documents.validator(f"{Path(file).name}#{pointer}")
    return Draft202012Validator(schema, registry=documents.registry)


def _openapi_embedded(node: Any, path: str, name: str, documents: ContractDocuments, failures: list[str]) -> None:
    if isinstance(node, dict):
        schema = node.get("schema")
        if isinstance(schema, dict) and ("example" in node or "examples" in node):
            # Media Type Objects and Parameter Objects both carry the example next
            # to the schema it must satisfy.
            validator = _openapi_validator(schema, documents)
            for where, value in _example_values(node):
                _record(failures, f"contracts/{name}:{path}/{where}", problems(validator, value))
        for key, value in node.items():
            if key in {"example", "examples"}:
                continue
            _openapi_embedded(value, f"{path}/{_escape(key)}", name, documents, failures)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            _openapi_embedded(value, f"{path}/{index}", name, documents, failures)


def embedded_example_failures(documents: ContractDocuments) -> list[str]:
    """Every embedded example that does not satisfy the schema around it."""
    failures: list[str] = []
    for name, document in documents.schemas.items():
        _schema_embedded(document, "", name, documents, failures)
    for name in OPENAPI_DOCUMENTS:
        document = documents.openapi(name)
        _openapi_embedded(document, "", name, documents, failures)
    return failures
