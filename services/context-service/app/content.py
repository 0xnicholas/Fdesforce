"""How an entity's `content` is rendered, in one place, deterministically.

A `RetrievalItem.content` is what the model reads and what the Retrieval Snapshot's
`content_digest` covers (§4.1), so the same facts must render to the same bytes
every time — at ingest, after a rebuild, and again after the `mask` stage has
replaced a value. Two renderers would make "the same retrieval" depend on which
stage produced it.

The shape is deliberately plain text rather than JSON: `content` is a prompt
fragment, and a model reads `Claim C-1001: amount 12000, status review` more
reliably than a serialized object. Fields are sorted by name so a mapping's
declaration order cannot change a digest, and an absent property is absent from the
line rather than `null`.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any


def render(type_name: str, key: str, properties: Mapping[str, Any]) -> str:
    """`Claim C-1001: amount 12000, status review` — type, key, then sorted facts."""
    facts = ", ".join(
        f"{name} {_value(value)}" for name, value in sorted(properties.items()) if value is not None
    )
    return f"{type_name} {key}: {facts}" if facts else f"{type_name} {key}"


def _value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return json.dumps(value)
    return str(value)
