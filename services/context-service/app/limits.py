"""The numbers `runtime-info` publishes, and the ones retrieval enforces (§4.3, §7.2).

They live in one module because they are one promise. `GET /v1/runtime-info` tells a
caller the envelope it may plan against, and `/v1/context/retrieve` has to behave
inside it: a limit that is published but not enforced is a claim, not a contract.

Two groups:

- **Scale** — the embedded backend's interactive ceiling. Above it a retrieval is
  `degraded=true, reason=scale_limit` rather than silently slow (§4.3), and
  `/readyz` reports the same fact so an operator sees it before a caller does. The
  fix is the production index (`docs/research/retrieval-index-selection.md`), not a
  bigger JSON snapshot.
- **The hop cap v0 can honour** (§4.3) and **how many anchors `resolve` tries** from a
  query. The budget itself is not here: since #39 the recipe's `budget` stage is the
  ceiling (§6.2 makes it mandatory), and a caller may only tighten it.
"""

from __future__ import annotations

#: §4.3: the embedded backend's interactive ceiling (10k nodes / 50k edges).
EMBEDDED_MAX_NODES = 10_000
EMBEDDED_MAX_EDGES = 50_000

#: §7.2: a context call and a Run may not outlive these.
MAX_REQUEST_TIMEOUT_MS = 30_000
MAX_RUN_DEADLINE_MS = 1_800_000

#: What `runtime-info.limits` publishes.
LIMITS: dict[str, int] = {
    "max_nodes": EMBEDDED_MAX_NODES,
    "max_edges": EMBEDDED_MAX_EDGES,
    "max_request_timeout_ms": MAX_REQUEST_TIMEOUT_MS,
    "max_run_deadline_ms": MAX_RUN_DEADLINE_MS,
}

def over_ceiling(nodes: int, edges: int) -> bool:
    """Is this graph past the embedded backend's interactive ceiling (§4.3)?

    One predicate, two readers: the retrieval degrades (`scale_limit`) and `/readyz`
    reports it. Two copies of this comparison could disagree, and then a deployment
    would be "degraded" to its operator and fine to its callers (or the reverse).
    """
    return nodes > EMBEDDED_MAX_NODES or edges > EMBEDDED_MAX_EDGES


#: How deep v0 walks (§4.3: "词法 + 2-hop"). The contract lets a request ask for up to
#: 4; anything beyond what this backend supports is capped here and reported in
#: `budget_used.hops`, so the caller sees what was actually used rather than a silent
#: promise the backend cannot keep.
MAX_SUPPORTED_HOPS = 2

#: How many lexical matches `resolve` considers when the caller sent a query instead of
#: a `filters` key. The stage resolves *one* object (§6.2's `from: resolved`), so this
#: bounds the search rather than the answer: five candidates is enough to find the
#: entity a query names without turning the fallback into a second lexical stage.
MAX_ANCHORS = 5

#: Rough characters per token, for the `max_tokens` budget. Deliberately crude and
#: deliberately not a model tokenizer: the budget's job is to bound a prompt, and a
#: deterministic estimate that the caller can reason about beats a dependency. The
#: real renderer (#39) counts what it renders.
CHARS_PER_TOKEN = 4
