"""Readiness as a registry of probes, not a boolean (§9.2).

`/readyz` answers two different questions at once: can this process serve, and if
so, is anything degraded? A single "ready" flag cannot say `degraded=true,
reason=partial` (C15) without a reason, and a later ticket's check (the graph is
loaded, the audit store is writable, ingest has finished) must be able to join
without editing the endpoint.

The aggregation is a pure function over probe results, which is the seam its test
uses. The endpoint is the only thing that talks HTTP.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal, Protocol

ProbeStatus = Literal["ok", "degraded", "failed"]
ReadinessStatus = Literal["ready", "degraded", "not_ready"]


@dataclass(frozen=True)
class ProbeResult:
    """What one probe found, and — unless it is fine — why."""

    status: ProbeStatus
    reason: str | None = None


class Probe(Protocol):
    """A named readiness check the service can join at startup."""

    @property
    def name(self) -> str: ...

    def probe(self) -> ProbeResult: ...


@dataclass(frozen=True)
class ReadinessReport:
    """One evaluation of every probe."""

    status: ReadinessStatus
    reasons: tuple[str, ...]

    @property
    def not_ready(self) -> bool:
        return self.status == "not_ready"


def _join(name: str, result: ProbeResult) -> str:
    """`<probe>: <reason>` — the shape an operator reads (§9.2, runtime-adapter §9.3)."""
    reason = result.reason or result.status
    return f"{name}: {reason}"


class Readiness:
    """The probes this process runs for `/readyz`."""

    def __init__(self, probes: Sequence[Probe] = ()) -> None:
        self._probes = tuple(probes)

    def evaluate(self) -> ReadinessReport:
        results = [(probe.name, probe.probe()) for probe in self._probes]

        # A failing probe makes the process unserviceable; a degraded one is a
        # reason to report `degraded`, not to refuse traffic. Both are listed so
        # the operator sees every reason in one answer, not the first.
        failed = [_join(name, result) for name, result in results if result.status == "failed"]
        degraded = [_join(name, result) for name, result in results if result.status == "degraded"]

        if failed:
            return ReadinessReport(status="not_ready", reasons=tuple(failed + degraded))
        if degraded:
            return ReadinessReport(status="degraded", reasons=tuple(degraded))
        return ReadinessReport(status="ready", reasons=())
