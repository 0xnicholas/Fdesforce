"""The request seam: `contracts/` is the validator (`#35`).

Every operation that takes a body declares its schema in
`contracts/context-service-v1.openapi.yaml`; `scripts/generate.py` copies that
into `app.generated.api`. A handler reads its body through `read_json_body`,
which resolves the operation from the route FastAPI matched — so nothing is
hand-copied and a route the contract does not describe cannot validate.

Validation is JSON Schema 2020-12, not Pydantic: the conditional rules in
`decision.schema.json` (an intent needs evidence, an outcome needs a parent) are
part of the contract, and a validator that skipped them would accept a Decision
the audit store must refuse.
"""

from __future__ import annotations

import json
from functools import cache
from typing import Any

from jsonschema import Draft202012Validator
from referencing import Registry
from starlette.requests import Request

from app.errors import FdeError
from app.generated.api import OPERATIONS_BY_ROUTE
from app.generated.schemas import SCHEMAS
from app.schema_registry import build_registry, problems, validator_for
from app.wire import Operation, SchemaRef

_REGISTRY: Registry[Any] = build_registry(SCHEMAS)


@cache
def validator(file: str, pointer: str = "") -> Draft202012Validator:
    """The validator for one schema document (or one `$defs` entry of it)."""
    return validator_for(_REGISTRY, SCHEMAS, file, pointer)


def violations(instance: Any, schema: SchemaRef) -> list[str]:
    """Every way `instance` violates `schema`, each with its JSON path."""
    return problems(validator(schema.file, schema.pointer), instance)


def operation_for(request: Request) -> Operation:
    """The contract operation the matched route serves."""
    path = getattr(request.scope.get("route"), "path", request.url.path)
    operation = OPERATIONS_BY_ROUTE.get((request.method, str(path)))
    if operation is None:
        raise RuntimeError(
            f"{request.method} {path} is not in contracts/context-service-v1.openapi.yaml; "
            "the route surface and the operation table disagree"
        )
    return operation


def parse_json_body(raw: bytes) -> Any:
    """Bytes → JSON, with a 400 that names the position instead of a 500."""
    if raw.strip() == b"":
        raise FdeError("invalid_request", "the request body is empty; this operation requires a JSON object")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as error:
        raise FdeError(
            "invalid_request",
            "the request body is not valid JSON",
            details={"line": error.lineno, "column": error.colno, "position": error.pos},
        ) from error


def validate_body(request: Request, instance: Any) -> None:
    operation = operation_for(request)
    if operation.request is None:
        raise RuntimeError(f"{operation.operation_id} declares no request body")
    found = violations(instance, operation.request)
    if found:
        raise FdeError(
            "validation_failed",
            f"the request body does not satisfy {operation.request.file}#{operation.request.pointer}",
            details={"errors": found},
        )


async def read_json_body(request: Request) -> Any:
    """Read, parse and validate this request's body against its operation's schema."""
    instance = parse_json_body(await request.body())
    validate_body(request, instance)
    return instance
