# PROTOTYPE — generated skeleton.
# Source: customer/context-packages/acme-claims-context/recipes/claims-context.yaml
# GAP: the generated service needs a stable, typed representation of every
# stage. The Recipe schema exists only as documentation; this module only
# validates that the file is present and returns a canned item.
import hashlib
import json
from pathlib import Path

import yaml

from . import settings


def _recipe() -> dict:
    path = settings.CONFIG_DIR / "recipe.claims-context.yaml"
    return yaml.safe_load(path.read_text())


def retrieve(request: dict) -> dict:
    _recipe()
    claim_id = (request.get("filters") or {}).get("claim_id", "unknown")
    item = {
        "entity_id": f"fde:acme:Claim:{claim_id}",
        "type": "Claim",
        "content": f"Claim {claim_id} is open. Amount: 120000 EUR.",
        "score": 0.92,
        "source_ref": f"claims-db://public.claims/{claim_id}",
        "version": "1",
        "provenance_id": "prov_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "metadata": {
            "freshness": "fresh",
            "classification": "confidential",
            "conflict": False,
        },
    }
    snapshot = hashlib.sha256(json.dumps(item, sort_keys=True).encode()).hexdigest()
    return {
        "retrieval_id": "ret_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "items": [item],
        "degraded": False,
        "trace_id": request.get("trace_id", "0" * 32),
        "snapshot_digest": f"sha256:{snapshot}",
        "budget_used": {"nodes": 1, "tokens": 20, "hops": 0},
        "index": "graph",
    }
