"""The synthetic `claims-db` Connector: the reference structured source.

A stand-in for Acme's claims database (`examples/spec/acme/customer/connectors/
claims-db.yaml`) until a real Connector exists. It serves the datasets the package's
mappings declare and one typed operation, `lookupClaim`, whose argument and output
are exactly what `claims-lookup` pins in its JSON Schemas
(`examples/spec/acme/claims-triage/files/schemas/claims-lookup.*.json`).

The seed is a JSON file, not a database: the point of a *reference* source is that a
deployment, an ingest and a retrieval can run end to end with nothing to provision.
The seed is part of the image (`app/connectors/seed/`), so it cannot be missing at
runtime. `from_path` is how a test proves an unreadable seed is `unavailable` rather
than empty — "the source is broken" and "the source has no claims" are different
answers to a triage question — and it is where a real deployment would point a dataset
mounted from outside the image once the topology binds one.

Two values in a record are not columns of a customer system:

- `updated_at`, the watermark the `incremental` mode resumes from;
- the pre-joined relation keys (`ic:hasPolicy` → `["P-2001"]`). A SQL Connector
  would execute the mapping's `join` to produce them; a synthetic source carries
  them, and both arrive in `Record.values` under the relation's predicate.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from app.connectors.port import (
    ConnectorUnavailable,
    InvalidArguments,
    OperationNotFound,
    OperationResult,
    Page,
    Record,
    RecordNotFound,
)

#: The seed shipped with the image (the topology mounts the package, not the dataset).
DEFAULT_SEED = Path(__file__).resolve().parent / "seed" / "claims-db.json"

#: The class a `lookupClaim` result is about, and how a source that is not the
#: permission baseline classifies it. The baseline (`permissions.yaml`) wins when it
#: classifies the class; this is the source's own opinion for when it does not.
LOOKUP_TERM = "ic:Claim"
LOOKUP_CLASSIFICATION = "confidential"

#: `lookupClaim`'s argument, as the Tool's input schema declares it.
_LOOKUP_ARGUMENT = "claimId"


class ClaimsDbConnector:
    """`public.*` datasets and the `lookupClaim` typed operation."""

    id = "claims-db"

    def __init__(self, datasets: Mapping[str, Sequence[Mapping[str, Any]]]) -> None:
        self._datasets = {
            name: tuple(
                Record(
                    dataset=name,
                    key=str(row["key"]),
                    values={key: value for key, value in row.items() if key not in ("key", "updated_at")},
                    updated_at=str(row["updated_at"]) if row.get("updated_at") is not None else None,
                )
                for row in rows
            )
            for name, rows in datasets.items()
        }

    @classmethod
    def from_seed(cls, path: Path | None = None) -> ClaimsDbConnector:
        return cls.from_path(DEFAULT_SEED if path is None else path)

    @classmethod
    def from_path(cls, path: Path) -> ClaimsDbConnector:
        """Read a seed file, or report the source `unavailable` — never an empty page."""
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except OSError as error:
            raise ConnectorUnavailable(f"the claims-db seed at {path} cannot be read: {error.strerror}") from error
        except json.JSONDecodeError as error:
            raise ConnectorUnavailable(f"the claims-db seed at {path} is not valid JSON: {error}") from error
        datasets = document.get("datasets") if isinstance(document, Mapping) else None
        if not isinstance(datasets, Mapping) or not datasets:
            raise ConnectorUnavailable(f"the claims-db seed at {path} declares no `datasets`")
        for name, rows in datasets.items():
            if not isinstance(rows, list) or any(not isinstance(row, Mapping) or "key" not in row for row in rows):
                raise ConnectorUnavailable(f"the claims-db seed at {path}: dataset {name!r} needs rows with a `key`")
        return cls(datasets)

    @property
    def datasets(self) -> Sequence[str]:
        return tuple(sorted(self._datasets))

    @property
    def operations(self) -> Sequence[str]:
        return ("lookupClaim",)

    def read(self, dataset: str, *, since: str | None = None) -> Page:
        """The dataset's records, or only those newer than `since` (the watermark)."""
        rows = self._datasets.get(dataset)
        if rows is None:
            raise ConnectorUnavailable(
                f"claims-db serves {', '.join(self.datasets)}; {dataset!r} is not one of them"
            )
        if since is None:
            return Page(records=rows, watermark=_watermark(rows))
        newer = tuple(row for row in rows if row.updated_at is not None and row.updated_at > since)
        return Page(records=newer, watermark=_watermark(rows) if newer else since)

    def invoke(self, operation: str, arguments: Mapping[str, Any]) -> OperationResult:
        if operation != "lookupClaim":
            raise OperationNotFound(
                f"claims-db declares {', '.join(self.operations)}; {operation!r} is not one of them"
            )
        claim_id = arguments.get(_LOOKUP_ARGUMENT)
        if not isinstance(claim_id, str) or not claim_id:
            raise InvalidArguments(f"lookupClaim takes `{_LOOKUP_ARGUMENT}`: a non-empty string")
        claim = next((record for record in self._datasets["public.claims"] if record.key == claim_id), None)
        if claim is None:
            raise RecordNotFound(f"claims-db holds no claim {claim_id!r}")
        return OperationResult(
            result={
                "claimId": claim.key,
                "policyNumber": str(claim.values["policy_number"]),
                "customerId": str(claim.values["customer_id"]),
                "amount": claim.values["amount"],
                "status": str(claim.values["status"]),
            },
            term=LOOKUP_TERM,
            classification=LOOKUP_CLASSIFICATION,
        )


def _watermark(rows: Sequence[Record]) -> str | None:
    """The newest `updated_at` in the dataset — what the next incremental run resumes from.

    `max()` over the ISO 8601 strings, not over parsed timestamps: the watermark is a
    string the source produced, and re-serializing it would change a value a job
    resumes from for no reason.
    """
    stamps = [row.updated_at for row in rows if row.updated_at is not None]
    return max(stamps) if stamps else None
