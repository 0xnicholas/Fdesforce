"""The ops surface: liveness and readiness are different answers (§9.2).

`/healthz` says the process is alive. `/readyz` says it can serve — and may say
`degraded` while it still can. Neither requires an `ExecutionContext`, because a probe
has no user behind it.

The readiness transition owns its process rather than using the shared one: the answer
changes when the ingest job runs, so a test that borrowed a process another module had
already ingested into would be asserting on its neighbour's setup.
"""

from __future__ import annotations

import pytest

from conformance.harness import ServiceProcess


@pytest.fixture(scope="module")
def fresh() -> ServiceProcess:
    with ServiceProcess.start() as process:
        yield process


def test_healthz_reports_alive_without_authentication(service: ServiceProcess) -> None:
    response = service.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_readyz_reports_degraded_until_the_ingest_job_has_run(fresh: ServiceProcess) -> None:
    """§9.2: ingest does not block readiness, so a fresh volume is `degraded`, not `not_ready`.

    The process can serve — it has a graph, an audit store and a frozen package — and the
    answer it gives until the job runs is `partial`, which is exactly what the probe says.
    """
    response = fresh.get("/readyz")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "degraded"
    assert any(reason.startswith("ingest: not_started") for reason in body["reasons"]), body["reasons"]
    assert not any(reason.startswith("graph:") for reason in body["reasons"]), body["reasons"]


def test_readyz_reports_ready_and_why(fresh: ServiceProcess) -> None:
    """Once the package is materialized, the same endpoint says `ready` with no reasons."""
    job = fresh.ingest()
    assert job.status_code == 200, job.text

    response = fresh.get("/readyz")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    # `reasons` is required even when empty: an operator reads the same field
    # whether the answer is ready, degraded, or not ready (§9.2).
    assert body["reasons"] == []


def test_healthz_and_readyz_are_not_the_same_endpoint(service: ServiceProcess) -> None:
    """They answer different questions; a service that aliased them would lie."""
    assert service.get("/healthz").json() != service.get("/readyz").json()
