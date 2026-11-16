#!/usr/bin/env python3
"""Deterministic synthetic FDE corpus for retrieval benchmarks.

Ground truth
------------
Every concept in ``concepts.py`` owns exactly ten gold nodes.  A keyword query
is the concept's lexical anchor (all terms are required by the lexical engines);
a paraphrase query is a synonym rewrite that avoids the anchor; a hybrid query
uses the anchor for lexical recall and the paraphrase for vector recall, merged
with reciprocal-rank fusion.  Relevant IDs are the ten gold node IDs, so
recall@10 is directly comparable across backends.

Gold nodes are scattered uniformly through the corpus, while background nodes
share FDE vocabulary but never contain a full concept anchor.  A fraction of
background nodes carry one anchor token to create partial-match lexical noise.

Usage:
    python generate_dataset.py --nodes 100000 --edges-per-node 5 \
        --out /tmp/fdesforce-retrieval-data/datasets/100k --seed 42
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import time
from collections import defaultdict
from pathlib import Path

import orjson

from concepts import CONCEPTS

TYPES = [
    "Policy",
    "Claim",
    "Customer",
    "Contract",
    "Document",
    "Product",
    "Incident",
    "Agent",
    "Workflow",
]

REGIONS = ["us-east", "us-west", "eu-central", "uk-south", "apac-south"]
GENERIC_TOPICS = [
    "claims",
    "payments",
    "kyc",
    "lending",
    "contracts",
    "privacy",
    "operations",
    "security",
    "support",
    "software",
    "hr",
    "compliance",
    "vendor",
    "agent",
]
CUSTOMERS = [
    "Acme Health",
    "Northwind Bank",
    "Globex Manufacturing",
    "Initech Retail",
    "Umbrella Logistics",
    "Stark Utilities",
    "Wayne Insurance",
    "Wonka Foods",
]
OWNERS = [
    "a.jensen",
    "m.okafor",
    "s.iyer",
    "l.zhang",
    "r.martin",
    "k.novak",
    "d.silva",
    "p.kowalski",
]
FIELDS = ["status", "owner", "coverage", "renewal date", "risk rating", "region"]
VERBS = [
    "reviewed",
    "approved",
    "escalated",
    "reconciled",
    "archived",
    "reopened",
    "reassigned",
]
NOUNS = [
    "onboarding packet",
    "renewal checklist",
    "exception memo",
    "control evidence",
    "service review",
    "audit sample",
    "remediation ticket",
    "policy digest",
]
EDGE_TYPES = {
    "Policy": ["covers", "appliesTo", "documents"],
    "Claim": ["hasPolicy", "mentions", "assignedTo"],
    "Customer": ["owns", "hasContract", "relatesTo"],
    "Contract": ["binds", "documents", "relatesTo"],
    "Document": ["mentions", "documents", "relatesTo"],
    "Product": ["coveredBy", "relatesTo"],
    "Incident": ["affects", "causedBy", "handledBy"],
    "Agent": ["handledBy", "assignedTo", "escalatesTo"],
    "Workflow": ["includes", "triggers", "escalatesTo"],
}

CONCEPT_KEYS = {c["key"] for c in CONCEPTS}
for c in CONCEPTS:
    if c["near"] not in CONCEPT_KEYS:
        raise ValueError(f"unknown near concept {c['near']} for {c['key']}")

ANCHOR_TOKENS = sorted(
    {
        token
        for c in CONCEPTS
        for token in c["phrase"].split()
        if len(token) > 4 and token not in {"premium"}
    }
)


def stable_entity_id(tenant: str, node_type: str, key: str) -> str:
    return f"fde:{tenant}:{node_type}:{key}"


def node_key(node_type: str, index: int) -> str:
    prefix = {
        "Policy": "POL",
        "Claim": "CLM",
        "Customer": "CUS",
        "Contract": "CTR",
        "Document": "DOC",
        "Product": "PRD",
        "Incident": "INC",
        "Agent": "AGT",
        "Workflow": "WFL",
    }[node_type]
    return f"{prefix}-{index:08d}"


def gold_text(concept: dict, idx: int, region: str, version: str) -> str:
    return (
        f"{concept['phrase'].capitalize()}. The {concept['role']} must "
        f"{concept['action']} within {concept['timeframe']} for "
        f"{concept['segment']} cases. This {concept['doc_type']} records the "
        f"decision evidence and requires {concept['approver']} sign-off when the "
        f"case is outside standard limits. Region {region}; version {version}; "
        f"case sequence {idx:06d}."
    )


def background_text(
    rng: random.Random, node_type: str, idx: int, topic: str, tenant: str
) -> str:
    customer = rng.choice(CUSTOMERS)
    owner = rng.choice(OWNERS)
    field = rng.choice(FIELDS)
    verb = rng.choice(VERBS)
    noun = rng.choice(NOUNS)
    region = rng.choice(REGIONS)
    ref = hashlib.sha1(f"{tenant}:{node_type}:{idx}".encode()).hexdigest()[:10]
    noise = ""
    if rng.random() < 0.30:
        noise = f" Related note: {rng.choice(ANCHOR_TOKENS)} follow-up required."
    return (
        f"{node_type} {noun} for {customer} ({region}). {owner} {verb} the "
        f"{field} on reference {ref}. Topic {topic}; source system {rng.choice(['crm', 'erp', 'itsm', 'dms'])}; "
        f"record {idx:08d}.{noise}"
    )


def build(args: argparse.Namespace) -> dict:
    rng = random.Random(args.seed)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    n = args.nodes
    per_node = args.edges_per_node
    if n < len(CONCEPTS) * 10:
        raise SystemExit("node count must be >= 10 * number of concepts")

    gold_positions = sorted(rng.sample(range(n), len(CONCEPTS) * 10))
    gold_assignment: dict[int, tuple[dict, int]] = {}
    cursor = 0
    cluster_gold_ids: dict[str, list[str]] = {c["key"]: [] for c in CONCEPTS}
    for concept in CONCEPTS:
        for idx in range(10):
            pos = gold_positions[cursor]
            cursor += 1
            gold_assignment[pos] = (concept, idx)

    node_rows: list[dict] = []
    type_pools: dict[str, list[int]] = {t: [] for t in TYPES}
    topic_pools: dict[str, list[int]] = defaultdict(list)
    start = time.perf_counter()
    with (out / "nodes.jsonl").open("wb") as fh:
        for i in range(n):
            if i in gold_assignment:
                concept, gidx = gold_assignment[i]
                node_type = TYPES[(i + CONCEPTS.index(concept)) % len(TYPES)]
                tenant = "acme"
                topic = concept["domain"]
                version = str(1 + (i % 5))
                region = REGIONS[i % len(REGIONS)]
                key = node_key(node_type, i)
                entity_id = stable_entity_id(tenant, node_type, key)
                row = {
                    "id": i,
                    "entity_id": entity_id,
                    "type": node_type,
                    "name": f"{concept['noun'].title()} {node_type} {gidx + 1}",
                    "text": gold_text(concept, gidx, region, version),
                    "topic": topic,
                    "tenant_id": tenant,
                    "version": version,
                    "region": region,
                    "cluster": concept["key"],
                    "gold": 1,
                }
                cluster_gold_ids[concept["key"]].append(entity_id)
            else:
                node_type = TYPES[i % len(TYPES)]
                tenant = "globex" if i % 20 == 0 else "acme"
                topic = GENERIC_TOPICS[i % len(GENERIC_TOPICS)]
                version = str(1 + (i % 5))
                region = REGIONS[(i * 3) % len(REGIONS)]
                key = node_key(node_type, i)
                entity_id = stable_entity_id(tenant, node_type, key)
                row = {
                    "id": i,
                    "entity_id": entity_id,
                    "type": node_type,
                    "name": f"{node_type} record {i:08d}",
                    "text": background_text(rng, node_type, i, topic, tenant),
                    "topic": topic,
                    "tenant_id": tenant,
                    "version": version,
                    "region": region,
                    "cluster": "",
                    "gold": 0,
                }
            node_rows.append(row)
            type_pools[node_type].append(i)
            topic_pools[topic].append(i)
            fh.write(orjson.dumps(row, option=orjson.OPT_APPEND_NEWLINE))
    nodes_s = time.perf_counter() - start

    # Edges: five per node, mostly local to type/topic so two-hop expansion is useful.
    edge_start = time.perf_counter()
    edge_count = 0
    cluster_gold_positions = {
        key: [p for p, (c, _) in gold_assignment.items() if c["key"] == key]
        for key in cluster_gold_ids
    }
    with (out / "edges.jsonl").open("wb") as fh:
        for i, row in enumerate(node_rows):
            targets: set[int] = set()
            node_type = row["type"]
            if row["cluster"]:
                siblings = [p for p in cluster_gold_positions[row["cluster"]] if p != i]
                rng.shuffle(siblings)
                targets.update(siblings[:2])
            same_type = type_pools[node_type]
            for _ in range(4):
                if len(targets) >= per_node:
                    break
                if same_type and rng.random() < 0.8:
                    candidates = same_type
                elif topic_pools[row["topic"]]:
                    candidates = topic_pools[row["topic"]]
                else:
                    candidates = range(n)
                target = rng.choice(candidates)
                if target != i:
                    targets.add(target)
            # Fill deterministically if random choices collided.
            offset = 1
            while len(targets) < per_node:
                target = (i + offset * 7919) % n
                if target != i:
                    targets.add(target)
                offset += 1
            for target in sorted(targets):
                edge_type = rng.choice(EDGE_TYPES[node_type])
                fh.write(
                    orjson.dumps(
                        {
                            "src": i,
                            "dst": target,
                            "type": edge_type,
                            "tenant_id": row["tenant_id"],
                        },
                        option=orjson.OPT_APPEND_NEWLINE,
                    )
                )
                edge_count += 1
    edges_s = time.perf_counter() - edge_start

    queries: list[dict] = []
    for concept in CONCEPTS:
        relevant = sorted(cluster_gold_ids[concept["key"]])
        queries.append(
            {
                "qid": f"kw-{concept['key']}",
                "kind": "keyword",
                "query": concept["phrase"],
                "keyword": concept["phrase"],
                "paraphrase": None,
                "tenant_id": "acme",
                "cluster": concept["key"],
                "relevant": relevant,
            }
        )
        queries.append(
            {
                "qid": f"pp-{concept['key']}",
                "kind": "paraphrase",
                "query": concept["paraphrase"],
                "keyword": None,
                "paraphrase": concept["paraphrase"],
                "tenant_id": "acme",
                "cluster": concept["key"],
                "relevant": relevant,
            }
        )
        queries.append(
            {
                "qid": f"hy-{concept['key']}",
                "kind": "hybrid",
                "query": f"{concept['phrase']} / {concept['paraphrase']}",
                "keyword": concept["phrase"],
                "paraphrase": concept["paraphrase"],
                "tenant_id": "acme",
                "cluster": concept["key"],
                "relevant": relevant,
            }
        )

    with (out / "queries.json").open("wb") as fh:
        fh.write(orjson.dumps(queries, option=orjson.OPT_INDENT_2))

    meta = {
        "seed": args.seed,
        "nodes": n,
        "edges": edge_count,
        "edges_per_node": per_node,
        "gold_nodes": len(CONCEPTS) * 10,
        "concepts": len(CONCEPTS),
        "queries": len(queries),
        "types": TYPES,
        "tenants": {"acme": sum(1 for r in node_rows if r["tenant_id"] == "acme"),
                    "globex": sum(1 for r in node_rows if r["tenant_id"] == "globex")},
        "nodes_build_s": round(nodes_s, 3),
        "edges_build_s": round(edges_s, 3),
        "nodes_file_mb": round((out / "nodes.jsonl").stat().st_size / 1024 / 1024, 2),
        "edges_file_mb": round((out / "edges.jsonl").stat().st_size / 1024 / 1024, 2),
        "ground_truth": "10 gold nodes per concept; recall@10 over the gold set",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    with (out / "meta.json").open("wb") as fh:
        fh.write(orjson.dumps(meta, option=orjson.OPT_INDENT_2))
    return meta


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--nodes", type=int, required=True)
    parser.add_argument("--edges-per-node", type=int, default=5)
    parser.add_argument("--out", required=True)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    meta = build(args)
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
