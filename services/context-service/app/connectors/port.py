"""The Connector port: how a Context Source produces records and typed operations.

Two callers, one seam (`docs/semantic-modeling.md` §5.1, `docs/runtime-adapter.md`
D6). Ingest calls `read()`; a Connector-backed Tool calls `invoke()` — through
context-service and never directly, which is why the credentials, the tenant and the
data permission stay on this side of the call.

| Method | Contract |
| --- | --- |
| `read(dataset, since)` | the source's records, and the watermark the next incremental run resumes from |
| `invoke(operation, arguments)` | one typed operation's result, and the classification of what it returned |

**Errors.** Four classes, because the callers act on them differently:

- `ConnectorUnavailable` — the source cannot be reached or its seed is unreadable.
  Ingest reports the source `failed` and keeps going (`docs/semantic-modeling.md`
  §6.3: a broken source does not stop the others); the operation endpoint answers
  `503 unavailable`, which is retryable.
- `OperationNotFound` / `RecordNotFound` — the caller named something that does not
  exist. Both are `404 not_found` on the wire, with `details.reason` saying which:
  a Tool asking for an operation its Connector never declared and a Tool asking for
  a claim that does not exist are both "no", but only one of them is retryable by
  nobody.
- `InvalidArguments` — the arguments do not satisfy the operation's input. The
  contract's `inputSchema` is what a Tool pins; v0 checks presence and type here
  because the Connector is the only side that knows what its operation needs.

Nothing in this module touches the network or a database: v0's only Connectors are
synthetic (`app.connectors.claims_db`, `app.connectors.documents`), standing in for
customer systems until a real Connector ships. A real one implements the same port
and changes nothing above it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol


class ConnectorError(RuntimeError):
    """A refusal that comes from the source rather than from the caller."""


class ConnectorUnavailable(ConnectorError):
    """The source cannot be read at all: a broken seed, an unreachable endpoint."""


class OperationNotFound(ConnectorError):
    """The Connector does not declare this operation."""


class RecordNotFound(ConnectorError):
    """The operation's argument names a record the source does not hold."""


class InvalidArguments(ConnectorError):
    """The arguments do not satisfy the operation's input contract."""


@dataclass(frozen=True)
class Record:
    """One row of one dataset, with the facts a mapping promotes into an entity.

    `key` is the record's own primary key value for its dataset. `values` is the row
    as the source presents it: the columns the mapping declares, plus — for a
    synthetic source — the pre-joined keys of the relations it satisfies (a real
    Connector would run the mapping's `join` instead; both land in `values`).
    """

    dataset: str
    key: str
    values: Mapping[str, Any]
    updated_at: str | None = None


@dataclass(frozen=True)
class Page:
    """One read: the records, and the watermark the next incremental run resumes from."""

    records: tuple[Record, ...] = ()
    watermark: str | None = None


@dataclass(frozen=True)
class OperationResult:
    """One typed operation's answer.

    `term` is the ontology class the result is *about* (`ic:Claim` for `lookupClaim`),
    which is what makes the permission baseline applicable to an answer that is not a
    graph entity: the caller's class scope decides whether the operation is served at
    all, and the response's classification is the baseline's for that class — or
    `restricted` when the baseline is silent (§7.1). It is **required**: an operation
    that cannot say what it is about cannot be gated, and an ungated answer is the one
    thing a typed operation may not be.

    `classification` is the Connector's own label for what it returned. It is carried
    for diagnostics and is *not* trusted over the baseline: a source that could classify
    itself out of a restriction would make the baseline advisory.
    """

    result: Mapping[str, Any]
    term: str
    classification: str | None = None


@dataclass(frozen=True)
class ConnectorDescription:
    """What a Connector declares about itself: its datasets and its typed operations."""

    id: str
    datasets: tuple[str, ...] = field(default_factory=tuple)
    operations: tuple[str, ...] = field(default_factory=tuple)


class Connector(Protocol):
    """The port. `app.connectors.claims_db` and `app.connectors.documents` implement it."""

    @property
    def id(self) -> str: ...

    @property
    def datasets(self) -> Sequence[str]: ...

    @property
    def operations(self) -> Sequence[str]: ...

    def read(self, dataset: str, *, since: str | None = None) -> Page: ...

    def invoke(self, operation: str, arguments: Mapping[str, Any]) -> OperationResult: ...
