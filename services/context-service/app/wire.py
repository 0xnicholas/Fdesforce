"""The small hand-written support the generated models build on.

Nothing here is a wire *type*: the types come from `contracts/` (see
`scripts/generate.py`). These are the two things a generated module cannot
declare about itself — the base class every generated model extends, and the
validators for JSON Schema keywords Pydantic spells differently.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Annotated, Any

from pydantic import AfterValidator, BaseModel, ConfigDict


class WireModel(BaseModel):
    """The base of every generated wire model.

    `extra='forbid'` is the default because the contract's objects are closed
    (`additionalProperties: false`); a generated model for an open object
    overrides it explicitly, so an open shape is a visible decision rather than a
    default nobody read.
    """

    model_config = ConfigDict(extra="forbid")


def ensure_rfc3339(value: str) -> str:
    """Validate `format: date-time` without coercing the wire string.

    A `datetime` field would re-serialize to a different offset/precision and
    change a digest computed over the payload; a string that has been checked is
    both truthful and byte-stable.
    """
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as cause:
        raise ValueError(f"{value!r} is not an RFC 3339 timestamp") from cause
    if parsed.tzinfo is None:
        raise ValueError(f"{value!r} is not an RFC 3339 timestamp: it carries no offset")
    return value


Rfc3339 = Annotated[str, AfterValidator(ensure_rfc3339)]

_PATTERNS: dict[str, re.Pattern[str]] = {}


def check_key_pattern(value: dict[str, Any], *, pattern: str) -> dict[str, Any]:
    """JSON Schema `propertyNames.pattern` for a map-shaped object.

    `pattern` in JSON Schema is an unanchored search, not a full match; using
    `search` here keeps the model and the schema validator agreeing.
    """
    compiled = _PATTERNS.get(pattern)
    if compiled is None:
        compiled = re.compile(pattern)
        _PATTERNS[pattern] = compiled
    for key in value:
        if compiled.search(key) is None:
            raise ValueError(f"{key!r} does not match {pattern!r}")
    return value


# ---------------------------------------------------------------------------
# The operation table (`app/generated/api.py`)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SchemaRef:
    """A named schema inside `contracts/schemas/`: `file` + `#/$defs/Name`."""

    file: str
    pointer: str = ""

    def __str__(self) -> str:
        return f"{self.file}#{self.pointer}"


@dataclass(frozen=True)
class Operation:
    """One operation of `contracts/context-service-v1.openapi.yaml`."""

    method: str
    path: str
    operation_id: str
    #: Whether the operation requires an `ExecutionContext` (`security` applies).
    auth: bool
    #: Whether the contract requires a `traceparent` header on this operation.
    traceparent: bool
    #: Whether the contract requires an `Idempotency-Key` header.
    idempotency_key: bool
    #: The scope the caller's `ExecutionContext.scopes` must contain, from the
    #: contract's `x-fde-required-scope`. `None` only on an unauthenticated operation.
    required_scope: str | None
    #: The issuer kind allowed to call this operation (`x-fde-issuer`): `runtime`
    #: (`fde://<deployment_id>`) or `jobs` (`fde://<deployment_id>/jobs`).
    issuer: str | None
    #: Whether the call acts for one Run, so the token must carry `run_id` (§5.1).
    run_scoped: bool
    #: The body schema the runtime validates against, if the operation takes one.
    request: SchemaRef | None
    success_status: int
    #: The status a replay answers with (§3.5): the operation's own 200 response
    #: when the contract declares one, otherwise its success status.
    replay_status: int
    #: The 2xx response schema: a named schema or an inline one, never both.
    response_ref: SchemaRef | None
    response_inline: Mapping[str, Any] | None = field(default=None)
