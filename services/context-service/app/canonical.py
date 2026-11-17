"""Canonical JSON and SHA-256, defined once for everything that fingerprints a payload.

Two questions in this service are really "is this the same bytes?": the
`Idempotency-Key` middleware fingerprints a request body, and the audit chain
hashes a payload to link it to the previous entry. If each had its own idea of
canonical form, a retry could be a replay to one and a conflict to the other.

The form is JSON with sorted keys, no insignificant whitespace, UTF-8 preserved
rather than `\\u`-escaped, and no values JSON cannot carry (`NaN`/`Infinity`).
That is the subset of RFC 8785 the service's payloads need: every field in
`contracts/` is a string, boolean, integer, array or object — there are no floats
whose ECMAScript spelling would matter.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any


def canonical_json(value: Any) -> str:
    """`value` as the one text this service hashes and stores."""
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def sha256_digest(*parts: str | bytes) -> str:
    """`sha256:<hex>` over the parts, concatenated with no separator.

    `hash = SHA-256(prev_hash || canonical_json(payload))` (§6.4) is literally
    this call: the chain's previous hash is a 71-character string, so the
    concatenation is unambiguous without a delimiter.
    """
    hasher = hashlib.sha256()
    for part in parts:
        hasher.update(part.encode("utf-8") if isinstance(part, str) else part)
    return f"sha256:{hasher.hexdigest()}"
