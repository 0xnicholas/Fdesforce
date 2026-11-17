"""The ops surface: liveness and readiness are different answers (§9.2).

`/healthz` says the process is alive. `/readyz` says it can serve — and may say
`degraded` while it still can. Neither requires an `ExecutionContext`, because a
probe has no user behind it.
"""

from __future__ import annotations

from conformance.harness import ServiceProcess


def test_healthz_reports_alive_without_authentication(service: ServiceProcess) -> None:
    response = service.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_readyz_reports_ready_and_why(service: ServiceProcess) -> None:
    response = service.get("/readyz")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    # `reasons` is required even when empty: an operator reads the same field
    # whether the answer is ready, degraded, or not ready (§9.2).
    assert body["reasons"] == []


def test_healthz_and_readyz_are_not_the_same_endpoint(service: ServiceProcess) -> None:
    """They answer different questions; a service that aliased them would lie."""
    assert service.get("/healthz").json() != service.get("/readyz").json()
