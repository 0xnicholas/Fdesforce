"""Readiness aggregation: ready, degraded, not ready — and the reasons (§9.2, C15).

The endpoint test proves the process answers; this one proves the answer is
computed rather than hard-coded. C15 (ingest incomplete → `degraded`) is a later
ticket, but it plugs a probe in here, so the aggregation is tested as a pure
function over probe results.
"""

from __future__ import annotations

from app.readiness import Probe, ProbeResult, Readiness


class StubProbe:
    def __init__(self, name: str, result: ProbeResult) -> None:
        self._name = name
        self._result = result

    @property
    def name(self) -> str:
        return self._name

    def probe(self) -> ProbeResult:
        return self._result


def test_no_probes_means_ready() -> None:
    assert Readiness().evaluate().status == "ready"


def test_all_ok_probes_mean_ready_with_no_reasons() -> None:
    readiness = Readiness([StubProbe("graph", ProbeResult("ok")), StubProbe("audit", ProbeResult("ok"))])

    report = readiness.evaluate()

    assert report.status == "ready"
    assert report.reasons == ()


def test_one_degraded_probe_reports_degraded_with_its_reason() -> None:
    readiness = Readiness(
        [StubProbe("graph", ProbeResult("ok")), StubProbe("ingest", ProbeResult("degraded", "partial"))]
    )

    report = readiness.evaluate()

    assert report.status == "degraded"
    assert report.reasons == ("ingest: partial",)


def test_any_failed_probe_makes_the_process_not_ready() -> None:
    readiness = Readiness(
        [
            StubProbe("graph", ProbeResult("failed", "schema_mismatch")),
            StubProbe("ingest", ProbeResult("degraded", "partial")),
        ]
    )

    report = readiness.evaluate()

    assert report.status == "not_ready"
    assert report.not_ready is True
    # Every non-ok reason is reported: an operator fixing one and restarting into
    # the next would spend two outages on one diagnosis.
    assert report.reasons == ("graph: schema_mismatch", "ingest: partial")


def test_degraded_probe_without_a_reason_still_names_itself() -> None:
    readiness = Readiness([StubProbe("audit", ProbeResult("degraded"))])

    assert readiness.evaluate().reasons == ("audit: degraded",)


def test_probe_protocol_is_structural() -> None:
    """A probe is anything with a name and a probe(); no base class to inherit."""
    probe: Probe = StubProbe("graph", ProbeResult("ok"))
    assert probe.probe() == ProbeResult("ok")
