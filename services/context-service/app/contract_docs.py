"""The contract version, read from the two documents that state it (§10.1).

Both the generator (which embeds it in `app/generated/versions.py`) and the C1
case (which checks the documents agree) need this. One regex, because a reader
that accepted a pre-release suffix while the other rejected it would turn a
consistent contract into a false failure.
"""

from __future__ import annotations

import re

#: `contracts/README.md` — "Current minor: `1.4.0`".
CONTRACT_MINOR = re.compile(r"Current minor: `([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)`")
#: `docs/runtime-contract.md` — "契约版本：`fde.runtime/v1.4.0`".
NARRATIVE_MINOR = re.compile(r"契约版本：`fde\.runtime/v([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)`")


def contract_minor(readme: str) -> str | None:
    """The minor `contracts/README.md` states, or None when the sentence moved."""
    match = CONTRACT_MINOR.search(readme)
    return match.group(1) if match is not None else None


def narrative_minor(narrative: str) -> str | None:
    """The minor `docs/runtime-contract.md`'s header states."""
    match = NARRATIVE_MINOR.search(narrative)
    return match.group(1) if match is not None else None
