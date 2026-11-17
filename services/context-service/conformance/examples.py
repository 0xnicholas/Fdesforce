"""The examples `docs/runtime-contract.md` promises, and the schema that owns each.

C1 says every request/response example in the contract docs validates against its
schema. "Its schema" is not guessable: the examples are anonymous JSON blocks, and
"validates against *some* schema" would pass a retrieve response that had been
mistaken for a decision. So an example carries a marker:

    <!-- schema: contracts/schemas/retrieval.schema.json#/$defs/RetrieveRequest -->
    ```json
    { ... }
    ```

The runner requires a marker on every ```json fence. A new example without one
fails C1 rather than silently going unchecked — the whole reason the marker lives
next to the example instead of in a manifest is that a manifest rots silently.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

MARKER = re.compile(r"^<!--\s*schema:\s*(\S+)\s*-->$")
JSON_FENCE = re.compile(r"^```json\s*$")


@dataclass(frozen=True)
class Example:
    """One fenced JSON example and the schema reference it must satisfy."""

    source: Path
    line: int
    schema: str
    instance: object

    @property
    def label(self) -> str:
        return f"{self.source}:{self.line}"


@dataclass(frozen=True)
class Unmarked:
    """A ```json fence with no schema marker: C1 cannot decide what it is."""

    source: Path
    line: int


@dataclass(frozen=True)
class Broken:
    source: Path
    line: int
    detail: str


@dataclass(frozen=True)
class ParsedExamples:
    examples: tuple[Example, ...]
    unmarked: tuple[Unmarked, ...]
    broken: tuple[Broken, ...]


def _marker_before(lines: list[str], fence: int) -> str | None:
    """The marker comment immediately above a fence, ignoring blank lines."""
    index = fence - 1
    while index >= 0 and lines[index].strip() == "":
        index -= 1
    if index < 0:
        return None
    match = MARKER.match(lines[index].strip())
    return match.group(1) if match is not None else None


def parse_examples(path: Path) -> ParsedExamples:
    """Every fenced JSON example in `path`, with its marker and its line number."""
    lines = path.read_text(encoding="utf-8").splitlines()
    examples: list[Example] = []
    unmarked: list[Unmarked] = []
    broken: list[Broken] = []

    index = 0
    while index < len(lines):
        if JSON_FENCE.match(lines[index]):
            block_start = index + 1
            block_end = block_start
            while block_end < len(lines) and lines[block_end].strip() != "```":
                block_end += 1
            marker = _marker_before(lines, index)
            if marker is None:
                unmarked.append(Unmarked(source=path, line=index + 1))
            else:
                block = "\n".join(lines[block_start:block_end])
                try:
                    instance = json.loads(block)
                except json.JSONDecodeError as error:
                    broken.append(Broken(source=path, line=block_start, detail=f"not valid JSON: {error}"))
                else:
                    examples.append(Example(source=path, line=index + 1, schema=marker, instance=instance))
            index = block_end + 1
            continue
        index += 1

    return ParsedExamples(examples=tuple(examples), unmarked=tuple(unmarked), broken=tuple(broken))
