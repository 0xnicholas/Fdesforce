"""The approval resource: one state machine, and every move is a Decision (§8, C8).

`docs/runtime-contract.md` §8.1 fixes five statuses and §8.2 says what each *is*:

| Status | Meaning | Evidence |
| --- | --- | --- |
| `pending` | waiting for an approver in `approver_roles` | the request Decision (`phase=approval`, `status=proposed`) |
| `approved` / `rejected` | the approval Decision is in the audit store | `status=succeeded` / `status=denied` |
| `expired` | `expires_at` passed with no decision | `status=cancelled`, written by the service |
| `consumed` | the runtime resumed and must not use it again | the approval Decision it already has |

Everything else follows from three rules:

- **One resource, one writer.** The row lives on the audit volume beside the
  Decisions that move it, and a transition is one transaction:
  `AuditStore.write()` carries the append and the row update together, so a
  committed status always has its Decision and a refused one has neither.
- **A repeat is not a second decision.** `create` is idempotent on
  `(tenant_id, Idempotency-Key)` — recorded on disk, because a restart must not
  mint a second approval for one retried request (§3.5) — and `decide` remembers
  the key that decided, so the same key and payload answers with the decision
  that was made while any other key is `409 approval_already_decided`.
- **Expiry is a state, not a timer race.** A pending approval past `expires_at`
  is expired the next time anything looks at it — the sweeper, a list, a decide,
  a consume — so a decision cannot land after the deadline just because the
  background pass has not run yet.

Two things this slice deliberately does **not** do. Self-approval is denied
unconditionally: §8.3 lets a Policy allow it, and there is no Policy engine before
Slice 2, so the default is the whole rule. And nothing here suspends or resumes a
workflow: `consume` records that the runtime is done with the approval, and the
run state machine that waits on it belongs to Slice 2 (C16–C25).

An approval that names another tenant *or another Run* is not found rather than
refused, the same way a Decision and a Retrieval Snapshot already behave: whether
it exists elsewhere is not a caller's business.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import datetime
from typing import Any, Literal

from app.audit import AuditStore, AuditTransaction
from app.canonical import canonical_json
from app.clock import isoformat_z, parse_timestamp, utc_now
from app.contract import violations
from app.errors import FdeError
from app.idempotency import fingerprint_of
from app.ids import new_approval_id, new_decision_id
from app.wire import SchemaRef

logger = logging.getLogger("fde.context_service.approvals")

ApprovalStatus = Literal["pending", "approved", "rejected", "expired", "consumed"]

#: The statuses an approval never leaves. `consumed` is terminal because §8.1
#: says a consumed approval is not usable again; it just is not a *decision*.
TERMINAL: frozenset[str] = frozenset({"approved", "rejected", "expired", "consumed"})

#: The Decision status that records each approval outcome. The Decision vocabulary
#: has no "approved"/"expired": an approval is a decision *about* an action, so
#: approval is `succeeded`, rejection is `denied`, and expiry is `cancelled` (nobody
#: decided). The approval resource keeps the §8.1 words; the chain keeps its own.
OUTCOME_STATUS: Mapping[str, str] = {
    "approved": "succeeded",
    "rejected": "denied",
    "expired": "cancelled",
}

#: What the service signs an expiry Decision as. There is no caller: the approval
#: ran out of time, and the platform is the only actor that observed it.
SYSTEM_ACTOR: Mapping[str, str] = {"type": "system", "id": "context-service"}

DECISION_REQUEST = SchemaRef("decision.schema.json", "/$defs/DecisionRequest")

#: The columns every read selects, in one place so a column cannot be added to the
#: schema and forgotten by one of the queries.
_COLUMNS = (
    "approval_id, tenant_id, run_id, capability_id, status, request, created_at, expires_at, "
    "decided_at, request_decision_id, request_provenance_id, decided_decision_id, "
    "decided_provenance_id, request_key, request_fingerprint, decide_key, decide_fingerprint"
)


@dataclass(frozen=True)
class ApprovalRecord:
    """One approval resource, as the audit volume holds it.

    `request` is the caller's `ApprovalCreateRequest` (proposed action, requester,
    approver roles, evidence, policy refs) — stored whole, because it is what the
    wire document repeats and what the Decisions must keep saying years later.
    """

    approval_id: str
    tenant_id: str
    run_id: str
    capability_id: str
    status: ApprovalStatus
    request: Mapping[str, Any]
    created_at: str
    expires_at: str
    decided_at: str | None
    request_decision_id: str
    request_provenance_id: str
    decided_decision_id: str | None
    decided_provenance_id: str | None
    request_key: str
    request_fingerprint: str
    decide_key: str | None
    decide_fingerprint: str | None

    @property
    def terminal(self) -> bool:
        return self.status in TERMINAL

    @property
    def outcome(self) -> Literal["approved", "rejected"] | None:
        """The decision this approval records, for `ApprovalDecisionResponse`."""
        if self.status in ("approved", "consumed"):
            return "approved"
        if self.status == "rejected":
            return "rejected"
        return None

    def due_at(self, now: datetime) -> bool:
        """Whether this approval's `expires_at` has passed, by the service's clock."""
        return not self.terminal and parse_timestamp(self.expires_at) <= now

    def wire(self) -> dict[str, Any]:
        """The contract's `Approval`, with the Decision that names the current state.

        While pending that is the request Decision; once decided (or expired) it is
        the Decision that ended it — which is what an approval-gated intent cites as
        `ApprovalEvidence` (C21).
        """
        document: dict[str, Any] = {
            "approval_id": self.approval_id,
            "run_id": self.run_id,
            "tenant_id": self.tenant_id,
            "capability_id": self.capability_id,
            "status": self.status,
            "proposed_action": self.request["proposed_action"],
            "requested_by": self.request["requested_by"],
            "approver_roles": self.request["approver_roles"],
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "decision_id": self.decided_decision_id or self.request_decision_id,
            "provenance_id": self.decided_provenance_id or self.request_provenance_id,
        }
        if self.decided_at is not None:
            document["decided_at"] = self.decided_at
        for field in ("evidence", "policy_refs"):
            if self.request.get(field):
                document[field] = self.request[field]
        return document


@dataclass(frozen=True)
class ApprovalWrite:
    """The result of a transition. `created=False` is a replay, not a second write."""

    record: ApprovalRecord
    created: bool


@dataclass(frozen=True)
class ApprovalPage:
    """One page of the approval queue, and the cursor that continues it."""

    items: tuple[ApprovalRecord, ...]
    next_cursor: str | None

    def wire(self) -> dict[str, Any]:
        document: dict[str, Any] = {"items": [record.wire() for record in self.items]}
        if self.next_cursor is not None:
            document["next_cursor"] = self.next_cursor
        return document


class ApprovalStore:
    """The approval state machine over one audit volume."""

    def __init__(self, store: AuditStore, *, now: Callable[[], datetime] | None = None) -> None:
        self._store = store
        self._now = now if now is not None else utc_now

    # -- create -----------------------------------------------------------

    def create(
        self,
        request: Mapping[str, Any],
        *,
        tenant_id: str,
        key: str,
        trace_id: str,
    ) -> ApprovalWrite:
        """Create a `pending` approval, or replay the one this key already made.

        The idempotency key is stored on the row, scoped by tenant, because the
        middleware's record is in memory: after a restart the retry must still answer
        with the original `approval_id` rather than mint a second request and a
        second audit entry (§3.5).
        """
        if parse_timestamp(str(request["expires_at"])) <= self._now():
            raise FdeError(
                "validation_failed",
                "`expires_at` is not in the future, so this approval could never be decided; "
                "an expiry is what ends a pending request, not what it starts as",
                details={"reason": "expires_at_not_future"},
            )
        fingerprint = fingerprint_of(request)

        with self._store.write() as writes:
            existing = writes.fetchone(
                "SELECT " + _COLUMNS + " FROM approval WHERE tenant_id = ? AND request_key = ?",
                (tenant_id, key),
            )
            if existing is not None:
                record = _record(existing)
                if record.request_fingerprint != fingerprint:
                    raise FdeError(
                        "idempotency_conflict",
                        "this Idempotency-Key already created an approval with a different request; "
                        "a key names one write, so a different request needs a new key",
                        details={"reason": "idempotency_conflict"},
                    )
                return ApprovalWrite(record=record, created=False)

            record = ApprovalRecord(
                approval_id=new_approval_id(),
                tenant_id=tenant_id,
                run_id=str(request["run_id"]),
                capability_id=str(request["capability_id"]),
                status="pending",
                request=dict(request),
                created_at=isoformat_z(self._now()),
                expires_at=str(request["expires_at"]),
                decided_at=None,
                request_decision_id=new_decision_id(),
                request_provenance_id="",  # filled from the append below
                decided_decision_id=None,
                decided_provenance_id=None,
                request_key=key,
                request_fingerprint=fingerprint,
                decide_key=None,
                decide_fingerprint=None,
            )
            appended = writes.append(request_decision(record, trace_id=trace_id))
            record = replace(record, request_provenance_id=appended.entry.provenance_id)
            _insert(writes, record)
            return ApprovalWrite(record=record, created=True)

    # -- read -------------------------------------------------------------

    def approval(self, approval_id: str, *, tenant_id: str, run_id: str | None = None) -> ApprovalRecord | None:
        """The approval this tenant — and this Run, when given — can see (§8.3)."""
        with self._store.write() as writes:
            record = _load(writes, approval_id, tenant_id=tenant_id, run_id=run_id)
            if record is None:
                return None
            return self._expire_if_due(writes, record)

    # -- decide -----------------------------------------------------------

    def decide(
        self,
        approval_id: str,
        *,
        tenant_id: str,
        run_id: str,
        request: Mapping[str, Any],
        actor: Mapping[str, str],
        roles: Sequence[str],
        trace_id: str,
        key: str,
    ) -> ApprovalWrite:
        """Approve or reject a pending approval, or replay the decision this key made.

        Three refusals are deliberately distinct, because a client acts on them
        differently: a replay (`created=False`) is the same decision; a *different*
        key after the resource is terminal is `409 approval_already_decided`; and a
        caller whose own request this is, or whose roles do not name an approver, is
        `403` with no transition at all.
        """
        fingerprint = fingerprint_of(request)
        # The read expires a pending approval whose deadline passed, so a decide at
        # 12:00:01 for a 12:00:00 deadline is refused by the same rule the sweeper
        # applies — not by whichever pass happened to run first.
        record = self.approval(approval_id, tenant_id=tenant_id, run_id=run_id)
        if record is None:
            raise _not_found(approval_id)
        if record.terminal:
            return _settled(record, key=key, fingerprint=fingerprint)

        _require_may_decide(record, actor=actor, roles=roles)
        status: Literal["approved", "rejected"] = "approved" if request["approved"] else "rejected"
        decided_at = isoformat_z(self._now())

        with self._store.write() as writes:
            current = _load(writes, approval_id, tenant_id=tenant_id, run_id=run_id)
            if current is None:
                raise _not_found(approval_id)
            if current.due_at(self._now()):
                current = self._expire_if_due(writes, current)
            if current.terminal or current.status != "pending":
                return _settled(current, key=key, fingerprint=fingerprint)
            return _settle(
                writes,
                current,
                status=status,
                actor=actor,
                rationale=str(request["rationale"]),
                trace_id=trace_id,
                timestamp=decided_at,
                key=key,
                fingerprint=fingerprint,
            )

    # -- consume ----------------------------------------------------------

    def consume(self, approval_id: str, *, tenant_id: str, run_id: str) -> ApprovalRecord:
        """Mark an approved approval `consumed`: the runtime resumed and used it.

        Idempotent by state, not by key: consuming a consumed approval answers with
        the same resource (§8.1 — it is not usable again either way), because the
        retry §8.2 describes is a lost response, not a second decision. A pending,
        rejected or expired approval is a `409` state conflict and is not touched.
        """
        record = self.approval(approval_id, tenant_id=tenant_id, run_id=run_id)
        if record is None:
            raise _not_found(approval_id)
        if record.status == "consumed":
            return record
        if record.status != "approved":
            raise _not_approved(record)

        with self._store.write() as writes:
            current = _load(writes, approval_id, tenant_id=tenant_id, run_id=run_id)
            if current is None:
                raise _not_found(approval_id)
            if current.status == "consumed":
                return current
            if current.status != "approved":
                raise _not_approved(current)
            consumed = replace(current, status="consumed")
            _update(writes, consumed, expected="approved")
            return consumed

    # -- expiry -----------------------------------------------------------

    def expire_due(self, *, tenant_id: str | None = None) -> tuple[ApprovalRecord, ...]:
        """Expire every pending approval whose deadline has passed, one Decision each.

        The sweeper (and any caller that wants the queue honest without reading it)
        commits the transitions here; the lazy path in `approval` is the same
        `_expire_if_due`, so a sweep and a decide cannot disagree about a deadline.
        """
        with self._store.write() as writes:
            return self._expire_due_rows(writes, tenant_id)

    def _expire_due_rows(self, writes: AuditTransaction, tenant_id: str | None) -> tuple[ApprovalRecord, ...]:
        query = "SELECT " + _COLUMNS + " FROM approval WHERE status = 'pending'"
        parameters: tuple[Any, ...] = ()
        if tenant_id is not None:
            query += " AND tenant_id = ?"
            parameters = (tenant_id,)
        records = [_record(row) for row in writes.fetchall(query, parameters)]
        now = self._now()
        return tuple(self._expire_if_due(writes, record) for record in records if record.due_at(now))

    def _expire_if_due(self, writes: AuditTransaction, record: ApprovalRecord) -> ApprovalRecord:
        """Turn a pending approval past its deadline into `expired`, inside this transaction.

        The transition is the state, not a separate timer: whichever caller looks
        first — a decide, a consume, a list page or the sweeper — applies the same
        expiry, and the `WHERE status = 'pending'` guard makes a second look a no-op.
        """
        if not record.due_at(self._now()):
            return record
        document = entered_decision(
            record,
            status="expired",
            actor=SYSTEM_ACTOR,
            rationale=f"the approval expired at {record.expires_at} before anyone decided.",
            trace_id=expiry_trace(record.approval_id),
            timestamp=record.expires_at,
        )
        appended = writes.append(document)
        expired = replace(
            record,
            status="expired",
            decided_at=record.expires_at,
            decided_decision_id=str(document["decision_id"]),
            decided_provenance_id=appended.entry.provenance_id,
        )
        _update(writes, expired, expected=record.status)
        return expired

    # -- list -------------------------------------------------------------

    def approvals(
        self,
        *,
        tenant_id: str,
        status: str | None = None,
        run_id: str | None = None,
        capability_id: str | None = None,
        limit: int,
        cursor: str | None = None,
    ) -> ApprovalPage:
        """One page of the tenant's approval queue, newest first.

        The cursor is the last approval's id, not an offset: a row inserted while a
        reviewer pages does not shift the next page, and an id that does not name a
        row in this tenant is a `422` rather than a silently empty page.
        """
        with self._store.write() as writes:
            self._expire_due_rows(writes, tenant_id)
            query = "SELECT " + _COLUMNS + " FROM approval WHERE tenant_id = ?"
            parameters: list[Any] = [tenant_id]
            for column, value in (("status", status), ("run_id", run_id), ("capability_id", capability_id)):
                if value is not None:
                    query += f" AND {column} = ?"
                    parameters.append(value)
            if cursor is not None:
                anchor = writes.fetchone(
                    "SELECT " + _COLUMNS + " FROM approval WHERE approval_id = ? AND tenant_id = ?",
                    (cursor, tenant_id),
                )
                if anchor is None:
                    raise FdeError(
                        "validation_failed",
                        "`cursor` does not name an approval in this tenant; a page starts after one that was issued",
                        details={"reason": "invalid_cursor"},
                    )
                query += " AND (created_at < ? OR (created_at = ? AND approval_id < ?))"
                parameters.extend([str(anchor["created_at"]), str(anchor["created_at"]), str(anchor["approval_id"])])
            query += " ORDER BY created_at DESC, approval_id DESC LIMIT ?"
            parameters.append(limit + 1)
            rows = writes.fetchall(query, parameters)
            records = tuple(_record(row) for row in rows[:limit])
            next_cursor = records[-1].approval_id if len(rows) > limit else None
            return ApprovalPage(items=records, next_cursor=next_cursor)

def _settle(
    writes: AuditTransaction,
    record: ApprovalRecord,
    *,
    status: Literal["approved", "rejected"],
    actor: Mapping[str, str],
    rationale: str,
    trace_id: str,
    timestamp: str,
    key: str,
    fingerprint: str,
) -> ApprovalWrite:
    """Append the approval Decision and move the row, in this one transaction."""
    document = entered_decision(
        record,
        status=status,
        actor=actor,
        rationale=rationale,
        trace_id=trace_id,
        timestamp=timestamp,
    )
    appended = writes.append(document)
    decided = replace(
        record,
        status=status,
        decided_at=timestamp,
        decided_decision_id=str(document["decision_id"]),
        decided_provenance_id=appended.entry.provenance_id,
        decide_key=key,
        decide_fingerprint=fingerprint,
    )
    _update(writes, decided, expected="pending")
    return ApprovalWrite(record=decided, created=True)


def _settled(record: ApprovalRecord, *, key: str, fingerprint: str) -> ApprovalWrite:
    """A decide on a terminal approval: the same key replays, any other key is refused."""
    if record.decide_key is not None and record.decide_key == key:
        if record.decide_fingerprint != fingerprint:
            raise FdeError(
                "idempotency_conflict",
                "this Idempotency-Key already decided this approval with a different payload; "
                "a key names one write, so a different decision needs a new approval",
                details={"reason": "idempotency_conflict"},
            )
        return ApprovalWrite(record=record, created=False)
    raise FdeError(
        "approval_already_decided",
        f"approval {record.approval_id} is {record.status}; an approval is decided once, "
        "and a repeat with the key that decided it is the replay rather than a new decision",
        details={"reason": "approval_already_decided", "status": record.status},
    )


def _require_may_decide(record: ApprovalRecord, *, actor: Mapping[str, str], roles: Sequence[str]) -> None:
    """§8.3: a declared approver, and never the requester themself.

    The self-approval rule is the default and, in this slice, the whole rule: §8.3
    lets a Policy allow self-approval *and record why*, and there is no Policy engine
    to ask before Slice 2. Denying is the fail-closed half of that sentence.
    """
    requester = record.request["requested_by"]
    if (actor.get("type"), actor.get("id")) == (requester.get("type"), requester.get("id")):
        raise FdeError(
            "forbidden",
            "the requester cannot approve their own request; §8.3 denies self-approval by default "
            "and a Policy that allows it arrives with the Policy engine",
            details={"reason": "self_approval_denied", "approval_id": record.approval_id},
        )
    declared = set(record.request["approver_roles"])
    if not declared.intersection(roles):
        raise FdeError(
            "forbidden",
            f"approval {record.approval_id} may be decided by {', '.join(sorted(declared))}; "
            "this ExecutionContext carries none of those business roles",
            details={
                "reason": "approver_role_required",
                "approver_roles": sorted(declared),
            },
        )


def _not_found(approval_id: str) -> FdeError:
    return FdeError(
        "not_found",
        f"no approval {approval_id!r} is visible to this tenant and Run",
        details={"reason": "approval_not_found"},
    )


def _not_approved(record: ApprovalRecord) -> FdeError:
    return FdeError(
        "conflict",
        f"approval {record.approval_id} is {record.status}; only an approved approval can be consumed",
        details={"reason": "approval_not_approved", "status": record.status},
    )


# ---------------------------------------------------------------------------
# The service-minted Decisions
# ---------------------------------------------------------------------------


def request_decision(record: ApprovalRecord, *, trace_id: str) -> dict[str, Any]:
    """The Decision that records an approval request (§8.2 step 2)."""
    action = record.request["proposed_action"]
    rationale = f"approval requested for {action['tool']}"
    if action.get("operation"):
        rationale += f" ({action['operation']})"
    document: dict[str, Any] = {
        "decision_id": record.request_decision_id,
        "run_id": record.run_id,
        "tenant_id": record.tenant_id,
        "capability_id": record.capability_id,
        "decision_type": "approval",
        "phase": "approval",
        "status": "proposed",
        "actor": dict(record.request["requested_by"]),
        "rationale": rationale + " before it runs.",
        "input_digest": action["input_digest"],
        "trace_id": trace_id,
        "timestamp": record.created_at,
    }
    if record.request.get("evidence"):
        document["evidence"] = record.request["evidence"]
    _require_contract(document)
    return document


def entered_decision(
    record: ApprovalRecord,
    *,
    status: Literal["approved", "rejected", "expired"],
    actor: Mapping[str, str],
    rationale: str,
    trace_id: str,
    timestamp: str,
) -> dict[str, Any]:
    """The Decision that moves an approval out of `pending` (§8.2 step 5)."""
    document: dict[str, Any] = {
        "decision_id": new_decision_id(),
        "run_id": record.run_id,
        "tenant_id": record.tenant_id,
        "capability_id": record.capability_id,
        "decision_type": "approval",
        "phase": "approval",
        "status": OUTCOME_STATUS[status],
        "actor": dict(actor),
        "rationale": rationale,
        "input_digest": record.request["proposed_action"]["input_digest"],
        "trace_id": trace_id,
        "timestamp": timestamp,
    }
    if record.request.get("evidence"):
        document["evidence"] = record.request["evidence"]
    _require_contract(document)
    return document


def expiry_trace(approval_id: str) -> str:
    """The trace an expiry Decision carries.

    Nobody called: there is no caller trace to repeat. A deterministic id derived
    from the approval keeps the Decision's payload stable if the same transition is
    ever retried, and gives an operator one string to search for every expiry of
    that approval.
    """
    return hashlib.sha256(f"fde.approval.expired:{approval_id}".encode()).hexdigest()[:32]


def _require_contract(document: Mapping[str, Any]) -> None:
    """Refuse to write a service-minted Decision the served contract would not accept."""
    problems = violations(dict(document), DECISION_REQUEST)
    if problems:
        raise RuntimeError(
            "the service built a Decision that contracts/schemas/decision.schema.json refuses; "
            f"this is a bug in app.approvals: {'; '.join(problems)}"
        )


# ---------------------------------------------------------------------------
# The row
# ---------------------------------------------------------------------------


def _load(
    writes: AuditTransaction,
    approval_id: str,
    *,
    tenant_id: str,
    run_id: str | None = None,
) -> ApprovalRecord | None:
    """The row this tenant (and Run) may see, as the record the state machine reads."""
    query = "SELECT " + _COLUMNS + " FROM approval WHERE approval_id = ? AND tenant_id = ?"
    parameters: list[Any] = [approval_id, tenant_id]
    if run_id is not None:
        query += " AND run_id = ?"
        parameters.append(run_id)
    row = writes.fetchone(query, parameters)
    return None if row is None else _record(row)


def _insert(writes: AuditTransaction, record: ApprovalRecord) -> None:
    writes.execute(
        "INSERT INTO approval (" + _COLUMNS + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            record.approval_id,
            record.tenant_id,
            record.run_id,
            record.capability_id,
            record.status,
            canonical_json(dict(record.request)),
            record.created_at,
            record.expires_at,
            record.decided_at,
            record.request_decision_id,
            record.request_provenance_id,
            record.decided_decision_id,
            record.decided_provenance_id,
            record.request_key,
            record.request_fingerprint,
            record.decide_key,
            record.decide_fingerprint,
        ),
    )


def _update(writes: AuditTransaction, record: ApprovalRecord, *, expected: str) -> None:
    """Write the row, guarded by the status this transition started from.

    The service is single-writer (§4.3), so the guard is a defence against a bug,
    not against a peer: a transition that raced another would rather roll back than
    overwrite a decision it did not make.
    """
    changed = writes.execute(
        "UPDATE approval SET status = ?, decided_at = ?, decided_decision_id = ?, decided_provenance_id = ?, "
        "decide_key = ?, decide_fingerprint = ? WHERE approval_id = ? AND status = ?",
        (
            record.status,
            record.decided_at,
            record.decided_decision_id,
            record.decided_provenance_id,
            record.decide_key,
            record.decide_fingerprint,
            record.approval_id,
            expected,
        ),
    ).rowcount
    if changed != 1:
        raise RuntimeError(
            f"approval {record.approval_id} moved while its own transaction held it; "
            "no transition may overwrite a decision it did not make"
        )


def _record(row: Mapping[str, Any]) -> ApprovalRecord:
    request = json.loads(str(row["request"]))
    if not isinstance(request, dict):
        raise RuntimeError("an approval row's request is not a JSON object; this row was not written by this service")
    return ApprovalRecord(
        approval_id=str(row["approval_id"]),
        tenant_id=str(row["tenant_id"]),
        run_id=str(row["run_id"]),
        capability_id=str(row["capability_id"]),
        status=str(row["status"]),  # type: ignore[arg-type]
        request=request,
        created_at=str(row["created_at"]),
        expires_at=str(row["expires_at"]),
        decided_at=None if row["decided_at"] is None else str(row["decided_at"]),
        request_decision_id=str(row["request_decision_id"]),
        request_provenance_id=str(row["request_provenance_id"]),
        decided_decision_id=None if row["decided_decision_id"] is None else str(row["decided_decision_id"]),
        decided_provenance_id=None if row["decided_provenance_id"] is None else str(row["decided_provenance_id"]),
        request_key=str(row["request_key"]),
        request_fingerprint=str(row["request_fingerprint"]),
        decide_key=None if row["decide_key"] is None else str(row["decide_key"]),
        decide_fingerprint=None if row["decide_fingerprint"] is None else str(row["decide_fingerprint"]),
    )


#: How often the background pass expires overdue approvals. Expiry is also applied
#: lazily on every read, so this is the bound on how long an approval can sit
#: `pending` past its deadline with nobody looking — not the rule that ends it.
SWEEP_INTERVAL_SECONDS = 5.0


class ApprovalSweeper:
    """`ApprovalStore.expire_due` on a timer, started and stopped with the process.

    Without it, an expired approval would stay `pending` until someone read it —
    which is invisible in the wire (a decide or a list expires it first) but wrong
    for anyone watching the table. A failed pass is logged and retried: a busy disk
    is not an outcome to record in the audit chain.
    """

    def __init__(self, store: ApprovalStore, *, interval_seconds: float = SWEEP_INTERVAL_SECONDS) -> None:
        self.store = store
        self.interval_seconds = interval_seconds
        self._stopped = asyncio.Event()

    async def run(self) -> None:
        """Expire now, then every `interval_seconds` until `stop()`."""
        while not self._stopped.is_set():
            try:
                await asyncio.to_thread(self.store.expire_due)
            except Exception:  # noqa: BLE001 - a transient pass failure is not a state change
                logger.exception("approval expiry sweep failed; the next pass will try again")
            try:
                await asyncio.wait_for(self._stopped.wait(), timeout=self.interval_seconds)
            except TimeoutError:
                continue

    async def stop(self) -> None:
        """Ask `run()` to finish after the pass in flight."""
        self._stopped.set()
