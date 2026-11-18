"""The approval resource: one state machine over the audit volume (§8.1–8.3, C8).

The seam is `app.approvals` over a real audit store: the statuses, the Decision
each transition appends, and the durability a restart has to keep. The wire — a
contract-valid `Approval`, the 403/409 a caller sees — is
`tests/test_approvals_http.py`'s; the conformance cases drive the same resource
through the served surface.

The assertions read the *chain* (`AuditStore.decision`) rather than the table,
because an approval's evidence is the Decision, not the row: the row can be
rebuilt from the request, and a Decision cannot be un-written.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from app.approvals import ApprovalStore, ApprovalSweeper, expiry_trace
from app.audit import AuditStore
from app.errors import FdeError

TENANT = "acme"
OTHER_TENANT = "globex"
RUN = "run_01ARZ3NDEKTSV4RRFFQ69G5FAV"
OTHER_RUN = "run_01ARZ3NDEKTSV4RRFFQ69G5FB0"
REQUESTER = {"type": "service", "id": "mastra-app"}
APPROVER = {"type": "user", "id": "u-supervisor"}
APPROVER_ROLE = "claims-supervisor"
TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"
KEY = "approval-key-0123456789"
DECIDE_KEY = "decide-key-0123456789"
NOW = datetime(2026, 1, 6, 12, 0, 0, tzinfo=UTC)


class Clock:
    """The one clock the store under test reads, so expiry is a decision not a wait."""

    def __init__(self, moment: datetime = NOW) -> None:
        self.moment = moment

    def __call__(self) -> datetime:
        return self.moment


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def path(tmp_path: Path) -> Path:
    return tmp_path / "audit" / "audit.sqlite"


@pytest.fixture
def store(path: Path, clock: Clock) -> Iterator[AuditStore]:
    with AuditStore(path, now=clock).migrate() as opened:
        yield opened


@pytest.fixture
def approvals(store: AuditStore, clock: Clock) -> ApprovalStore:
    return ApprovalStore(store, now=clock)


def create_request(**overrides: Any) -> dict[str, Any]:
    """A contract-valid `ApprovalCreateRequest`, with knobs for the case at hand."""
    document: dict[str, Any] = {
        "run_id": RUN,
        "capability_id": "document-triage",
        "proposed_action": {
            "tool": "claim-decision",
            "operation": "recordDecision",
            "input_digest": "sha256:" + "a" * 64,
            "summary": "Mark claim C-1001 as approved.",
        },
        "requested_by": dict(REQUESTER),
        "approver_roles": [APPROVER_ROLE],
        "expires_at": "2026-01-07T12:00:00.000Z",
        "evidence": [{"type": "graph_entity", "entity_id": "fde:acme:Claim:C-1001"}],
        "policy_refs": ["claims-approval-threshold@1.0.0"],
    }
    document.update(overrides)
    return document


def decide_request(*, approved: bool = True, rationale: str = "The claim matches the policy.") -> dict[str, Any]:
    return {"approved": approved, "rationale": rationale, "actor": dict(APPROVER)}


def approve(
    approvals: ApprovalStore,
    approval_id: str,
    *,
    tenant_id: str = TENANT,
    run_id: str = RUN,
    approved: bool = True,
    key: str = DECIDE_KEY,
    roles: tuple[str, ...] = (APPROVER_ROLE,),
) -> Any:
    return approvals.decide(
        approval_id,
        tenant_id=tenant_id,
        run_id=run_id,
        request=decide_request(approved=approved),
        actor=APPROVER,
        roles=roles,
        trace_id=TRACE,
        key=key,
    )


# ---------------------------------------------------------------------------
# create: a pending resource and the request Decision that justifies it
# ---------------------------------------------------------------------------


def test_a_create_answers_pending_and_writes_the_request_decision(
    approvals: ApprovalStore, store: AuditStore
) -> None:
    created = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)
    record = created.record

    assert created.created is True
    assert record.status == "pending"
    assert record.approval_id.startswith("appr_")
    assert (record.tenant_id, record.run_id) == (TENANT, RUN)
    assert record.decided_at is None

    entry = store.decision(record.request_decision_id, tenant_id=TENANT)
    assert entry is not None
    decision = entry.decision
    assert decision["decision_type"] == "approval"
    assert decision["phase"] == "approval"
    assert decision["status"] == "proposed"
    assert decision["trace_id"] == TRACE
    assert decision["run_id"] == RUN
    assert decision["input_digest"] == create_request()["proposed_action"]["input_digest"]
    assert decision["evidence"] == create_request()["evidence"]
    assert decision["actor"] == REQUESTER


def test_the_wire_document_is_the_request_with_the_state_the_row_holds(approvals: ApprovalStore) -> None:
    created = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)

    document = created.record.wire()

    assert document["approval_id"] == created.record.approval_id
    assert document["status"] == "pending"
    assert document["decision_id"] == created.record.request_decision_id
    assert document["provenance_id"] == created.record.request_provenance_id
    assert document["proposed_action"] == create_request()["proposed_action"]
    assert document["requested_by"] == REQUESTER
    assert document["approver_roles"] == [APPROVER_ROLE]
    assert document["evidence"] == create_request()["evidence"]
    assert document["policy_refs"] == create_request()["policy_refs"]
    assert "decided_at" not in document


def test_the_same_key_and_request_returns_the_original_approval(approvals: ApprovalStore, store: AuditStore) -> None:
    first = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)
    replay = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)

    assert replay.created is False
    assert replay.record.approval_id == first.record.approval_id
    assert replay.record.request_decision_id == first.record.request_decision_id
    assert len(store) == 1, "a retried create must not append a second audit entry"


def test_a_reused_key_with_a_different_request_is_a_conflict(approvals: ApprovalStore, store: AuditStore) -> None:
    approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)
    other = create_request(run_id=OTHER_RUN)

    with pytest.raises(FdeError) as refused:
        approvals.create(other, tenant_id=TENANT, key=KEY, trace_id=TRACE)

    assert refused.value.code == "idempotency_conflict"
    assert len(store) == 1


def test_the_key_is_scoped_to_the_tenant(approvals: ApprovalStore) -> None:
    acme = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)
    globex = approvals.create(create_request(), tenant_id=OTHER_TENANT, key=KEY, trace_id=TRACE)

    assert globex.created is True
    assert globex.record.approval_id != acme.record.approval_id


def test_a_create_survives_a_reopen(path: Path) -> None:
    """§3.5: a restart must not turn one create into two approvals (or two Decisions)."""
    with AuditStore(path, now=lambda: NOW).migrate() as first:
        original = ApprovalStore(first, now=lambda: NOW).create(
            create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE
        )

    with AuditStore(path, now=lambda: NOW) as reopened:
        replay = ApprovalStore(reopened, now=lambda: NOW).create(
            create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE
        )

        assert replay.created is False
        assert replay.record.approval_id == original.record.approval_id
        assert len(reopened) == 1


def test_an_approval_that_expires_before_it_is_requested_is_refused(approvals: ApprovalStore) -> None:
    with pytest.raises(FdeError) as refused:
        approvals.create(
            create_request(expires_at="2026-01-01T00:00:00.000Z"),
            tenant_id=TENANT,
            key=KEY,
            trace_id=TRACE,
        )

    assert refused.value.code == "validation_failed"
    assert refused.value.details["reason"] == "expires_at_not_future"


# ---------------------------------------------------------------------------
# decide: pending → approved/rejected, and the idempotency around it
# ---------------------------------------------------------------------------


def test_a_decide_approves_and_writes_the_approval_decision(approvals: ApprovalStore, store: AuditStore) -> None:
    created = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)

    decided = approve(approvals, created.record.approval_id)

    assert decided.created is True
    record = decided.record
    assert record.status == "approved"
    assert record.decided_at == "2026-01-06T12:00:00.000Z"

    entry = store.decision(record.decided_decision_id, tenant_id=TENANT)
    assert entry is not None
    decision = entry.decision
    assert decision["decision_type"] == "approval"
    assert decision["phase"] == "approval"
    assert decision["status"] == "succeeded"
    assert decision["actor"] == APPROVER
    assert decision["rationale"] == decide_request()["rationale"]
    assert decision["trace_id"] == TRACE
    assert decision["run_id"] == RUN

    document = record.wire()
    assert document["status"] == "approved"
    assert document["decided_at"] == record.decided_at
    assert document["decision_id"] == record.decided_decision_id
    assert document["provenance_id"] == record.decided_provenance_id


def test_a_rejection_is_a_denied_decision(approvals: ApprovalStore, store: AuditStore) -> None:
    created = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)

    decided = approve(approvals, created.record.approval_id, approved=False)

    assert decided.record.status == "rejected"
    assert decided.record.outcome == "rejected"
    entry = store.decision(decided.record.decided_decision_id, tenant_id=TENANT)
    assert entry.decision["status"] == "denied"


def test_the_same_key_and_decision_replays_the_original_result(approvals: ApprovalStore, store: AuditStore) -> None:
    created = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)
    original = approve(approvals, created.record.approval_id)

    replay = approve(approvals, created.record.approval_id)

    assert replay.created is False
    assert replay.record.decided_decision_id == original.record.decided_decision_id
    assert replay.record.decided_provenance_id == original.record.decided_provenance_id
    assert replay.record.decided_at == original.record.decided_at
    assert len(store) == 2, "the replay must not append a second approval Decision"


def test_a_second_decision_with_another_key_is_already_decided(approvals: ApprovalStore) -> None:
    created = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)
    approve(approvals, created.record.approval_id)

    with pytest.raises(FdeError) as refused:
        approve(approvals, created.record.approval_id, key="another-decide-key-0123456789", approved=False)

    assert refused.value.code == "approval_already_decided"
    assert refused.value.details["reason"] == "approval_already_decided"


def test_the_same_key_with_a_different_decision_is_a_conflict(approvals: ApprovalStore) -> None:
    created = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)
    approve(approvals, created.record.approval_id)

    with pytest.raises(FdeError) as refused:
        approve(approvals, created.record.approval_id, approved=False)

    assert refused.value.code == "idempotency_conflict"


def test_the_requester_cannot_approve_their_own_request(approvals: ApprovalStore, store: AuditStore) -> None:
    created = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)

    with pytest.raises(FdeError) as refused:
        approvals.decide(
            created.record.approval_id,
            tenant_id=TENANT,
            run_id=RUN,
            request={**decide_request(), "actor": dict(REQUESTER)},
            actor=REQUESTER,
            roles=(APPROVER_ROLE,),
            trace_id=TRACE,
            key=DECIDE_KEY,
        )

    assert refused.value.code == "forbidden"
    assert refused.value.details["reason"] == "self_approval_denied"
    assert approvals.approval(created.record.approval_id, tenant_id=TENANT).status == "pending"
    assert len(store) == 1


def test_an_approver_without_a_declared_role_is_refused(approvals: ApprovalStore, store: AuditStore) -> None:
    created = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)

    with pytest.raises(FdeError) as refused:
        approve(approvals, created.record.approval_id, roles=("auditor",))

    assert refused.value.code == "forbidden"
    assert refused.value.details["reason"] == "approver_role_required"
    assert approvals.approval(created.record.approval_id, tenant_id=TENANT).status == "pending"
    assert len(store) == 1


def test_another_tenant_cannot_decide_an_approval(approvals: ApprovalStore) -> None:
    created = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)

    with pytest.raises(FdeError) as refused:
        approve(approvals, created.record.approval_id, tenant_id=OTHER_TENANT)

    assert refused.value.code == "not_found"


def test_another_run_cannot_decide_an_approval(approvals: ApprovalStore) -> None:
    """The resource is Run-scoped (§5.1): a token for another Run cannot see it."""
    created = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)

    with pytest.raises(FdeError) as refused:
        approve(approvals, created.record.approval_id, run_id=OTHER_RUN)

    assert refused.value.code == "not_found"


def test_an_unknown_approval_cannot_be_decided(approvals: ApprovalStore) -> None:
    with pytest.raises(FdeError) as refused:
        approve(approvals, "appr_01ARZ3NDEKTSV4RRFFQ69G5FAV")

    assert refused.value.code == "not_found"


# ---------------------------------------------------------------------------
# consume: approved → consumed, and the replay the runtime relies on (§8.2 step 6)
# ---------------------------------------------------------------------------


def test_consume_marks_an_approved_approval_consumed(approvals: ApprovalStore) -> None:
    created = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)
    approved = approve(approvals, created.record.approval_id)

    consumed = approvals.consume(created.record.approval_id, tenant_id=TENANT, run_id=RUN)

    assert consumed.status == "consumed"
    assert consumed.decided_decision_id == approved.record.decided_decision_id
    assert consumed.wire()["status"] == "consumed"
    assert consumed.wire()["decision_id"] == approved.record.decided_decision_id
    assert approvals.approval(created.record.approval_id, tenant_id=TENANT).status == "consumed"


def test_consume_is_idempotent(approvals: ApprovalStore, store: AuditStore) -> None:
    """C8: a retried consume answers with the consumed approval, never an error."""
    created = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)
    approve(approvals, created.record.approval_id)

    first = approvals.consume(created.record.approval_id, tenant_id=TENANT, run_id=RUN)
    second = approvals.consume(created.record.approval_id, tenant_id=TENANT, run_id=RUN)

    assert (first.status, second.status) == ("consumed", "consumed")
    assert len(store) == 2, "consuming is not a decision, so it appends nothing"


def test_consume_refuses_an_approval_that_was_not_approved(approvals: ApprovalStore) -> None:
    created = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)

    with pytest.raises(FdeError) as refused:
        approvals.consume(created.record.approval_id, tenant_id=TENANT, run_id=RUN)

    assert refused.value.code == "conflict"
    assert refused.value.details["reason"] == "approval_not_approved"
    assert approvals.approval(created.record.approval_id, tenant_id=TENANT).status == "pending"


def test_consume_refuses_a_rejected_approval(approvals: ApprovalStore) -> None:
    created = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)
    approve(approvals, created.record.approval_id, approved=False)

    with pytest.raises(FdeError) as refused:
        approvals.consume(created.record.approval_id, tenant_id=TENANT, run_id=RUN)

    assert refused.value.code == "conflict"
    assert approvals.approval(created.record.approval_id, tenant_id=TENANT).status == "rejected"


def test_consume_refuses_an_expired_approval(approvals: ApprovalStore, clock: Clock) -> None:
    created = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)
    clock.moment += timedelta(days=2)

    with pytest.raises(FdeError) as refused:
        approvals.consume(created.record.approval_id, tenant_id=TENANT, run_id=RUN)

    assert refused.value.code == "conflict"
    assert approvals.approval(created.record.approval_id, tenant_id=TENANT).status == "expired"


# ---------------------------------------------------------------------------
# expiry: a state the clock decides, not a timer that races the deadline
# ---------------------------------------------------------------------------


def test_an_overdue_approval_expires_when_it_is_looked_at(
    approvals: ApprovalStore, store: AuditStore, clock: Clock
) -> None:
    created = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)
    clock.moment += timedelta(days=2)

    record = approvals.approval(created.record.approval_id, tenant_id=TENANT)

    assert record is not None and record.status == "expired"
    assert record.decided_at == created.record.expires_at
    entry = store.decision(record.decided_decision_id, tenant_id=TENANT)
    assert entry is not None
    decision = entry.decision
    assert decision["decision_type"] == "approval"
    assert decision["status"] == "cancelled"
    assert decision["actor"] == {"type": "system", "id": "context-service"}
    assert decision["trace_id"] == expiry_trace(record.approval_id)
    assert decision["timestamp"] == created.record.expires_at


def test_an_expired_approval_cannot_be_decided(approvals: ApprovalStore, store: AuditStore, clock: Clock) -> None:
    created = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)
    clock.moment += timedelta(days=2)

    with pytest.raises(FdeError) as refused:
        approve(approvals, created.record.approval_id)

    assert refused.value.code == "approval_already_decided"
    assert refused.value.details["status"] == "expired"
    assert approvals.approval(created.record.approval_id, tenant_id=TENANT).status == "expired"
    assert len(store) == 2, "the request and the expiry, and no decision after the deadline"


def test_expiry_is_written_once_across_sweeps(approvals: ApprovalStore, store: AuditStore, clock: Clock) -> None:
    created = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)
    clock.moment += timedelta(days=2)

    first = approvals.expire_due()
    second = approvals.expire_due()

    assert [record.approval_id for record in first] == [created.record.approval_id]
    assert second == ()
    assert len(store) == 2


def test_the_sweeper_only_touches_due_approvals(approvals: ApprovalStore, clock: Clock) -> None:
    due = approvals.create(
        create_request(expires_at="2026-01-06T13:00:00.000Z"),
        tenant_id=TENANT,
        key=KEY,
        trace_id=TRACE,
    )
    later = approvals.create(
        create_request(run_id=OTHER_RUN, expires_at="2026-01-08T12:00:00.000Z"),
        tenant_id=TENANT,
        key="another-key-0123456789",
        trace_id=TRACE,
    )
    clock.moment += timedelta(hours=2)

    expired = approvals.expire_due()

    assert [record.approval_id for record in expired] == [due.record.approval_id]
    assert approvals.approval(later.record.approval_id, tenant_id=TENANT).status == "pending"


def test_the_sweeper_can_be_scoped_to_one_tenant(
    approvals: ApprovalStore, store: AuditStore, clock: Clock
) -> None:
    acme = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)
    approvals.create(create_request(), tenant_id=OTHER_TENANT, key=KEY, trace_id=TRACE)
    clock.moment += timedelta(days=2)

    expired = approvals.expire_due(tenant_id=TENANT)

    assert [record.approval_id for record in expired] == [acme.record.approval_id]
    # Two request Decisions and one expiry: the other tenant's pending approval was
    # not touched by a sweep it was not part of. (Reading it back would expire it —
    # the lazy path is deliberate — so the chain is what this asserts on.)
    assert len(store) == 3


# ---------------------------------------------------------------------------
# list: the queue a human's tool reads
# ---------------------------------------------------------------------------


def test_the_list_is_newest_first_and_filtered(approvals: ApprovalStore) -> None:
    first = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)
    second = approvals.create(
        create_request(run_id=OTHER_RUN),
        tenant_id=TENANT,
        key="second-key-0123456789",
        trace_id=TRACE,
    )
    approve(approvals, first.record.approval_id)

    page = approvals.approvals(tenant_id=TENANT)

    assert [item.approval_id for item in page.items] == [second.record.approval_id, first.record.approval_id]
    assert page.next_cursor is None
    assert [item.approval_id for item in approvals.approvals(tenant_id=TENANT, status="approved").items] == [
        first.record.approval_id
    ]
    assert [item.approval_id for item in approvals.approvals(tenant_id=TENANT, run_id=OTHER_RUN).items] == [
        second.record.approval_id
    ]
    assert approvals.approvals(tenant_id=OTHER_TENANT).items == ()


def test_the_cursor_paginates_without_repeating_an_approval(approvals: ApprovalStore) -> None:
    created = [
        approvals.create(create_request(), tenant_id=TENANT, key=f"page-key-{index:04d}", trace_id=TRACE)
        for index in range(5)
    ]
    seen: list[str] = []
    cursor: str | None = None
    while True:
        page = approvals.approvals(tenant_id=TENANT, limit=2, cursor=cursor)
        seen.extend(item.approval_id for item in page.items)
        cursor = page.next_cursor
        if cursor is None:
            break

    assert sorted(seen) == sorted(record.record.approval_id for record in created)
    assert len(seen) == len(set(seen))


def test_an_unknown_cursor_is_a_validation_failure(approvals: ApprovalStore) -> None:
    with pytest.raises(FdeError) as refused:
        approvals.approvals(tenant_id=TENANT, cursor="appr_01ARZ3NDEKTSV4RRFFQ69G5FAV")

    assert refused.value.code == "validation_failed"
    assert refused.value.details["reason"] == "invalid_cursor"


def test_a_list_expires_overdue_approvals_before_it_answers(approvals: ApprovalStore, clock: Clock) -> None:
    created = approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)
    clock.moment += timedelta(days=2)

    page = approvals.approvals(tenant_id=TENANT, status="pending")

    assert page.items == ()
    expired = approvals.approvals(tenant_id=TENANT, status="expired")
    assert [item.approval_id for item in expired.items] == [created.record.approval_id]


def test_the_sweeper_expires_on_its_own_clock(approvals: ApprovalStore, store: AuditStore, clock: Clock) -> None:
    """The background pass is what expires a queue nobody is reading."""
    approvals.create(create_request(), tenant_id=TENANT, key=KEY, trace_id=TRACE)
    clock.moment += timedelta(days=2)
    sweeper = ApprovalSweeper(approvals, interval_seconds=0.01)

    async def until_expired() -> None:
        task = asyncio.create_task(sweeper.run())
        try:
            for _ in range(500):
                if len(store) == 2:
                    return
                await asyncio.sleep(0.01)
        finally:
            await sweeper.stop()
            await task
        raise AssertionError("the sweeper did not expire the overdue approval")

    asyncio.run(asyncio.wait_for(until_expired(), timeout=10))

    assert len(store) == 2, "the request Decision and the expiry, and no lazy read to do it"
