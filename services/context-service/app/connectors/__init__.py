"""The Connectors a deployment can reach, and the one registry ingest and the API share.

A Connector is named by a Context Source (`connectorRef`) and by a Tool
(`connectorRef` + `operation`), so both the ingest job and the typed-operation
endpoint resolve the same id to the same implementation here, once. v0 registers the
two synthetic reference sources (`docs/semantic-modeling.md` §5.1); a real Connector
replaces one entry and nothing above it changes.

Registration is by seed file so a deployment can mount its own dataset over the
shipped one; an unreadable seed is refused at startup, not per request — a source
that cannot be read must not look like a source with no data, or every retrieval
would report a partial context it never tried to fill.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from app.connectors.claims_db import DEFAULT_SEED as CLAIMS_SEED
from app.connectors.claims_db import ClaimsDbConnector
from app.connectors.documents import DEFAULT_SEED as DOCUMENT_SEED
from app.connectors.documents import DocumentConnector
from app.connectors.port import Connector


class ConnectorNotFound(LookupError):
    """No Connector is registered under this id."""


class ConnectorRegistry:
    """`connectorRef` → the Connector that serves it."""

    def __init__(self, connectors: Sequence[Connector]) -> None:
        self._connectors = {connector.id: connector for connector in connectors}

    @classmethod
    def reference(
        cls,
        *,
        claims_seed: Path | None = None,
        documents_seed: Path | None = None,
    ) -> ConnectorRegistry:
        """The reference deployment's sources: claims-db and the document corpus."""
        return cls(
            [
                ClaimsDbConnector.from_seed(claims_seed or CLAIMS_SEED),
                DocumentConnector.from_seed(documents_seed or DOCUMENT_SEED),
            ]
        )

    def get(self, connector_id: str) -> Connector | None:
        return self._connectors.get(connector_id)

    def require(self, connector_id: str) -> Connector:
        """The Connector, or a refusal that names what this deployment does serve."""
        found = self.get(connector_id)
        if found is None:
            raise ConnectorNotFound(
                f"no Connector is registered as {connector_id!r}; this deployment serves "
                f"{', '.join(sorted(self._connectors))}"
            )
        return found

    def ids(self) -> Sequence[str]:
        return tuple(sorted(self._connectors))
