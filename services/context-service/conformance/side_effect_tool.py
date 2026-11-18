"""The synthetic side-effect Tool fixture C7 needs, and nothing else (§5, C7).

C7 — *record-before-act* — is an invariant of the runtime, not of context-service:
a Tool that has a side effect must not run unless its intent Decision is already
in the audit store. This slice cannot generate that Tool (the grammar refuses
side-effecting Tools until record-before-act lands, `runtime_grammar_unsupported`,
Slice 2), so the fixture here is the smallest thing with the same shape: a Tool
whose `invoke` writes its intent through the **real** `POST /v1/decisions` and
only calls its effect when that write is a 2xx.

It is not part of the Acme reference path — the fixture capability
(`synthetic-side-effect`) exists to answer one question, and the suite says so
(`contracts/conformance/cases.md` C7). The gate is the fixture's, but the refusal
it reacts to is the service's: a conflicting `decision_id` is the audit store's
own `409`, and an unreachable service is a real transport failure. A wrapper that
ignored either would let the effect through, which is what the case catches.

The effect is a line in a file, because "the customer system was written to" is
exactly what a side effect is and a file is the smallest observable version of it.
"""

from __future__ import annotations

import json
import secrets
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.canonical import canonical_json, sha256_digest

#: The service's intent-write seam: `(decision, idempotency key)` → `(status, body)`.
#: The case supplies it, so "the service is down" and "the service refused" are the
#: same call with a different answer.
IntentWriter = Callable[[Mapping[str, Any], str], tuple[int, str]]

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _ulid() -> str:
    """A ULID-shaped id, the way §4.2 spells `inv_<ULID>` / `dec_<ULID>`."""
    return "".join(secrets.choice(_CROCKFORD) for _ in range(26))


@dataclass(frozen=True)
class ToolInvocation:
    """One call of the fixture Tool: what it is about to do, and to whose evidence."""

    tenant_id: str
    run_id: str
    capability_id: str
    actor: Mapping[str, str]
    trace_id: str
    decision_id: str
    invocation_id: str
    tool_id: str = "fixture-claim-write"
    operation: str = "append-claim-decision"
    entity_id: str = "fde:acme:Claim:C-1001"

    @classmethod
    def fresh(cls, *, tenant_id: str, run_id: str, actor: Mapping[str, str], trace_id: str) -> ToolInvocation:
        return cls(
            tenant_id=tenant_id,
            run_id=run_id,
            capability_id="synthetic-side-effect",
            actor=actor,
            trace_id=trace_id,
            decision_id="dec_" + _ulid(),
            invocation_id="inv_" + _ulid(),
        )

    @property
    def input(self) -> dict[str, Any]:
        return {"claim_id": "C-1001", "decision": "approved"}

    def intent(self) -> dict[str, Any]:
        """The intent Decision the Tool must record before it acts."""
        document: dict[str, Any] = {
            "decision_id": self.decision_id,
            "run_id": self.run_id,
            "tenant_id": self.tenant_id,
            "capability_id": self.capability_id,
            "decision_type": "runtime",
            "phase": "intent",
            "status": "proposed",
            "invocation_id": self.invocation_id,
            "action": {
                "tool_id": self.tool_id,
                "operation": self.operation,
                "side_effects": "write",
            },
            "actor": dict(self.actor),
            "rationale": "the side-effect Tool is about to run; this is the record before the act",
            "input_digest": sha256_digest(canonical_json(self.input)),
            "evidence": [{"type": "graph_entity", "entity_id": self.entity_id}],
            "policy_evaluations": [
                {
                    "policy_id": "tool-allowlist",
                    "version": "1.0.0",
                    "outcome": "allow",
                    "enforcement_point": "tool.pre_invoke",
                    "evaluated_by": "mastra-app",
                }
            ],
            "model": {"provider": "mock", "model": "deterministic-triage"},
            "prompt_version": "document-triage@1.0.0",
            "trace_id": self.trace_id,
            "timestamp": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        }
        return document


@dataclass(frozen=True)
class ToolResult:
    """What one invocation did: whether the effect ran, and why it did or did not."""

    executed: bool
    intent_status: int | None
    intent_error: str | None
    invocation_id: str


class SideEffectTool:
    """`record-before-act`: the effect happens only after the intent is recorded."""

    def __init__(self, effects: Path) -> None:
        self.effects = effects

    def invoke(self, invocation: ToolInvocation, *, write_intent: IntentWriter) -> ToolResult:
        """Write the intent, then act — or refuse to act, leaving no effect behind."""
        key = secrets.token_hex(16)
        try:
            status, body = write_intent(invocation.intent(), key)
        except Exception as error:  # noqa: BLE001 - an unreachable store is a refusal, not a crash
            return ToolResult(
                executed=False,
                intent_status=None,
                intent_error=f"{type(error).__name__}: {error}",
                invocation_id=invocation.invocation_id,
            )

        if not 200 <= status < 300:
            return ToolResult(
                executed=False,
                intent_status=status,
                intent_error=f"the intent Decision was not recorded ({status}): {body[:300]}",
                invocation_id=invocation.invocation_id,
            )

        self._perform(invocation)
        return ToolResult(
            executed=True, intent_status=status, intent_error=None, invocation_id=invocation.invocation_id
        )

    def observed(self) -> list[dict[str, Any]]:
        """The effects the "customer system" recorded, in order."""
        if not self.effects.exists():
            return []
        return [json.loads(line) for line in self.effects.read_text(encoding="utf-8").splitlines() if line.strip()]

    def _perform(self, invocation: ToolInvocation) -> None:
        self.effects.parent.mkdir(parents=True, exist_ok=True)
        with self.effects.open("a", encoding="utf-8") as handle:
            handle.write(
                json.dumps(
                    {
                        "invocation_id": invocation.invocation_id,
                        "tool_id": invocation.tool_id,
                        "operation": invocation.operation,
                        "input": invocation.input,
                    },
                    sort_keys=True,
                )
                + "\n"
            )
