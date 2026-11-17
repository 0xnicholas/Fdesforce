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

Validation is also where the body meets the identity. A body may describe the
caller (`tenant_id`, `actor`, `requested_by`, `run_id`, `trace_id`, and
`RetrieveRequest.subject`); it may not name a different one. That check runs after
the schema check, so a malformed body is still a `422` and a body that contradicts
the token is a `403` — never a write under a borrowed name.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping
from functools import cache
from typing import Any

from jsonschema import Draft202012Validator
from referencing import Registry
from starlette.requests import Request

from app.errors import FdeError, forbidden
from app.generated.api import OPERATIONS, OPERATIONS_BY_ROUTE
from app.generated.schemas import SCHEMAS
from app.identity import identity_of
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


_PATH_PARAMETER = re.compile(r"\{([a-z_]+)\}")


def _path_pattern(template: str) -> re.Pattern[str]:
    """One path template as a matcher: literals escaped, `{param}` = one segment."""
    parts: list[str] = []
    cursor = 0
    for parameter in _PATH_PARAMETER.finditer(template):
        parts.append(re.escape(template[cursor : parameter.start()]))
        parts.append(r"[^/]+")
        cursor = parameter.end()
    parts.append(re.escape(template[cursor:]))
    return re.compile("".join(parts))


class OperationIndex:
    """`(method, concrete path)` → operation, for the request edge.

    A middleware runs before the router, so `scope["route"]` does not exist yet.
    This index answers the same question from the generated table instead of
    waiting for the router — and `tests/test_routes.py` proves the two agree for
    every operation, so the edge cannot guard a route the router does not serve
    (or miss one it does).
    """

    def __init__(self, operations: Iterable[Operation]) -> None:
        self._routes = [
            (operation.method.upper(), _path_pattern(operation.path), operation) for operation in operations
        ]

    def match(self, method: str, path: str) -> Operation | None:
        for candidate_method, pattern, operation in self._routes:
            if candidate_method == method.upper() and pattern.fullmatch(path):
                return operation
        return None

    def __len__(self) -> int:
        return len(self._routes)


OPERATION_INDEX = OperationIndex(OPERATIONS)


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


#: Body fields that assert an identity, and the `ExecutionContext` claim each must
#: repeat (§5.3). A client may describe the caller; it may not *name* a different
#: one — that is the whole difference between a parameter and an identity.
BODY_IDENTITY_FIELDS: Mapping[str, str] = {
    "tenant_id": "tenant_id",
    "deployment_id": "deployment_id",
    "solution_id": "solution_id",
    "trace_id": "trace_id",
    "run_id": "run_id",
}

#: Actor-shaped fields: compared by `(type, id)`, because `display` is cosmetic.
BODY_ACTOR_FIELDS = ("actor", "requested_by")

#: `RetrieveRequest.subject` is a *hint*, not a credential (§3.3): it tells the
#: recipe who the retrieval is for, and it may not be someone else. `roles` and
#: `scopes` on it are recipe filters — data permissions — so only the identity is
#: bound, and the token's own roles/scopes remain the authority.
BODY_SUBJECT_FIELD = "subject"


def bind_identity(request: Request, instance: Any) -> None:
    """Refuse a body that asserts an identity the verified token does not carry.

    `DecisionRequest.actor`, `ApprovalCreateRequest.requested_by` and
    `ApprovalDecisionRequest.actor` are the contract's own words for "who is
    doing this"; a token that says otherwise means the caller is not who the body
    claims, so the request is refused instead of written under a borrowed name.
    """
    identity = identity_of(request)
    if not isinstance(instance, Mapping):
        return

    for field, claim in BODY_IDENTITY_FIELDS.items():
        if field not in instance:
            continue
        expected = getattr(identity.context, claim)
        if expected is None:
            raise forbidden(
                "body_identity_mismatch",
                f"`{field}` in the body asserts an identity this ExecutionContext does not carry",
                field=field,
            )
        if instance[field] != expected:
            raise forbidden(
                "body_identity_mismatch",
                f"`{field}` in the body does not match the ExecutionContext; "
                "identity is signed, not passed",
                field=field,
            )

    actor = identity.context.actor
    for field in BODY_ACTOR_FIELDS:
        if field in instance and _actor_of(instance[field]) != (actor.type, actor.id):
            raise forbidden(
                "body_identity_mismatch",
                f"`{field}` in the body is not the actor this ExecutionContext asserts",
                field=field,
            )

    if BODY_SUBJECT_FIELD in instance:
        subject = instance[BODY_SUBJECT_FIELD]
        asserted = _actor_of(subject)
        if asserted != (actor.type, identity.context.sub):
            raise forbidden(
                "body_identity_mismatch",
                "`subject` in the body is not the caller this ExecutionContext asserts; "
                "a retrieval may hint at the caller, not at someone else (§3.3)",
                field=BODY_SUBJECT_FIELD,
            )


def _actor_of(value: Any) -> tuple[Any, Any]:
    return (value.get("type"), value.get("id")) if isinstance(value, Mapping) else (None, None)


async def read_json_body(request: Request) -> Any:
    """Read, parse, validate and bind this request's body."""
    instance = parse_json_body(await request.body())
    validate_body(request, instance)
    bind_identity(request, instance)
    return instance
