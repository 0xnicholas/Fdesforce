"""The audit volume is a startup requirement, not a runtime surprise (§6.4).

A service that booted without a writable audit store would accept Decisions and
then fail every write — a runtime that is up but cannot keep the evidence it
exists to keep. `create_app` therefore opens the store in the lifespan, and an
unopenable volume stops the process before it serves a request.

The harness turns a child that exits before `/healthz` into a `RuntimeError` with
the log tail, so this test asserts the fail-closed direction without reaching into
the app.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from conformance.harness import ServiceProcess


def test_a_process_whose_audit_volume_cannot_be_opened_refuses_to_start(tmp_path: Path) -> None:
    blocker = tmp_path / "audit-is-a-file"
    blocker.write_text("not a directory", encoding="utf-8")

    with pytest.raises(RuntimeError, match="exited"):
        ServiceProcess.start(env={"AUDIT_PATH": str(blocker / "audit.sqlite")})


def test_a_process_on_an_unmigrated_audit_volume_refuses_to_start() -> None:
    """The startup order is a gate, not a convention (§9.2).

    The topology waits for `migrate` to exit 0 (`dependsOn: [migrate]`); this is
    the other half of that promise. If the service were willing to create its own
    schema, a volume nothing had migrated would still reach a serving process, and
    the job's exit code would gate nothing.
    """
    with pytest.raises(RuntimeError, match="exited") as refused:
        ServiceProcess.start(migrate=False)

    assert "app.migrate" in str(refused.value), (
        "a refusal must name the job that prepares the volume, or an operator has a dead process and no next step"
    )
