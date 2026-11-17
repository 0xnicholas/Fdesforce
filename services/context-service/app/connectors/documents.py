"""The synthetic `sharepoint-claims` Connector: the reference document source.

The other half of the Acme package's context: the policy documents a triage agent
cites (`examples/semantic/acme/context-sources/sharepoint-claims.yaml`). A real
Connector would list the mapping's `paths`, parse and extract with a model; v0 has
neither a SharePoint client nor an extractor, so the reference source serves a seed
corpus that is already chunked — "the extraction ran, here is what it produced" —
and the mapping's `chunking.strategy: heading` is the rule the seed was chunked by.

Each chunk is one record: its `path` and `etag` fill the citation template
(`sharepoint://{path}` at `{etag}`), its `heading` names the section it came from,
and its `text` is what a retrieval returns as content. `key` is the chunk's identity
inside the source — the path with `:` separators, since `fde:<tenant>:<type>:<key>`
allows `[A-Za-z0-9._~:-]` and not `/` (§4.2) — so a rebuild produces the same
`entity_id` for the same section of the same document.

`paths` in the mapping says which documents a *real* source should list; this one
serves its whole corpus, which is the same thing when the corpus is the seed.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from app.connectors.port import ConnectorUnavailable, OperationNotFound, Page, Record

DEFAULT_SEED = Path(__file__).resolve().parent / "seed" / "documents.json"

_HEADING = re.compile(r"^(?P<hashes>#{1,6})\s+(?P<title>.+)$")


class DocumentConnector:
    """The `sharepoint-claims` corpus, chunked by heading."""

    id = "sharepoint-claims"

    def __init__(self, dataset: str, documents: Sequence[Mapping[str, Any]]) -> None:
        self._dataset = dataset
        self._records = tuple(
            record for document in documents for record in _chunks(dataset, document)
        )

    @classmethod
    def from_seed(cls, path: Path | None = None) -> DocumentConnector:
        return cls.from_path(DEFAULT_SEED if path is None else path)

    @classmethod
    def from_path(cls, path: Path) -> DocumentConnector:
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except OSError as error:
            raise ConnectorUnavailable(f"the document seed at {path} cannot be read: {error.strerror}") from error
        except json.JSONDecodeError as error:
            raise ConnectorUnavailable(f"the document seed at {path} is not valid JSON: {error}") from error
        if not isinstance(document, Mapping) or not isinstance(document.get("documents"), list):
            raise ConnectorUnavailable(f"the document seed at {path} declares no `documents`")
        for entry in document["documents"]:
            if not isinstance(entry, Mapping) or not {"path", "etag", "body"} <= set(entry):
                raise ConnectorUnavailable(f"the document seed at {path}: a document needs `path`, `etag` and `body`")
        return cls(str(document.get("dataset") or "sites/claims"), document["documents"])

    @property
    def datasets(self) -> Sequence[str]:
        return (self._dataset,)

    @property
    def operations(self) -> Sequence[str]:
        """No typed operations: a document source is read by the lexical stage, not called."""
        return ()

    def read(self, dataset: str, *, since: str | None = None) -> Page:
        if dataset != self._dataset:
            raise ConnectorUnavailable(f"this source serves {self._dataset!r}, not {dataset!r}")
        if since is None:
            return Page(records=self._records, watermark=_watermark(self._records))
        newer = tuple(record for record in self._records if record.updated_at is not None and record.updated_at > since)
        return Page(records=newer, watermark=_watermark(self._records) if newer else since)

    def invoke(self, operation: str, arguments: Mapping[str, Any]) -> Any:
        raise OperationNotFound(
            f"{self.id} declares no typed operations; a document source is retrieved, never called"
        )


def _chunks(dataset: str, document: Mapping[str, Any]) -> list[Record]:
    """One record per heading section, in document order."""
    path = str(document["path"])
    updated_at = str(document["updated_at"]) if document.get("updated_at") is not None else None
    chunks: list[Record] = []
    heading: str | None = None
    body: list[str] = []

    def flush() -> None:
        if heading is None:
            return
        chunks.append(
            Record(
                dataset=dataset,
                key=f"{path.replace('/', '.')}:{_slug(heading)}",
                values={
                    "path": path,
                    "etag": str(document["etag"]),
                    "heading": heading,
                    "text": "\n".join(line for line in body if line.strip()).strip(),
                },
                updated_at=updated_at,
            )
        )

    for line in str(document["body"]).splitlines():
        matched = _HEADING.match(line)
        if matched is not None:
            flush()
            heading, body = matched.group("title").strip(), []
            continue
        body.append(line)
    flush()
    return chunks


def _slug(heading: str) -> str:
    """`Premium customers` → `premium-customers`: the id-safe half of a chunk's key."""
    slug = re.sub(r"[^a-z0-9]+", "-", heading.casefold()).strip("-")
    return slug or "section"


def _watermark(records: Sequence[Record]) -> str | None:
    stamps = [record.updated_at for record in records if record.updated_at is not None]
    return max(stamps) if stamps else None
