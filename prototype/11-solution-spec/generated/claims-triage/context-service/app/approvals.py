# PROTOTYPE — generated skeleton.
# Source: docs/runtime-contract.md §8
from datetime import datetime, timedelta, timezone
from uuid import uuid4

_APPROVALS: dict[str, dict] = {}


def create(request: dict) -> dict:
    approval_id = f"appr_{uuid4().hex[:26].upper()}"
    approval = {
        "approval_id": approval_id,
        "run_id": request["run_id"],
        "capability_id": request["capability_id"],
        "proposed_action": request["proposed_action"],
        "status": "pending",
        "approver_roles": request.get("approver_roles", []),
        "expires_at": request.get(
            "expires_at",
            (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat(),
        ),
    }
    _APPROVALS[approval_id] = approval
    return approval


def decide(approval_id: str, request: dict) -> dict | None:
    approval = _APPROVALS.get(approval_id)
    if approval is None:
        return None
    if approval["status"] != "pending":
        return {**approval, "error": "approval_already_decided"}
    approval["status"] = "approved" if request.get("approved") else "rejected"
    approval["rationale"] = request.get("rationale", "")
    approval["decided_by"] = request.get("actor")
    return approval


def consume(approval_id: str) -> dict | None:
    approval = _APPROVALS.get(approval_id)
    if approval is None or approval["status"] != "approved":
        return None
    approval["status"] = "consumed"
    return approval


def list_pending() -> list[dict]:
    return [a for a in _APPROVALS.values() if a["status"] == "pending"]
