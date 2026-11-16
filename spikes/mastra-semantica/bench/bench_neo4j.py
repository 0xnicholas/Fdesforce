import json
import random
import time
import warnings

from semantica.graph_store import Neo4jStore

warnings.filterwarnings("ignore")
random.seed(7)
store = Neo4jStore(
    uri="bolt://localhost:7687",
    user="neo4j",
    password="testpass",
    database="neo4j",
)
store.execute_query("MATCH (n) DETACH DELETE n")

n = 500
created = []
started = time.perf_counter()
for i in range(n):
    node = store.create_node(
        labels=["Entity"],
        properties={"entity_id": f"neo:n:{i}", "tenant_id": "bench", "name": f"entity {i}"},
    )
    created.append(node["id"])
create_nodes_s = time.perf_counter() - started

started = time.perf_counter()
for i in range(1000):
    a = random.choice(created)
    b = random.choice(created)
    if a == b:
        continue
    store.create_relationship(a, b, "RELATED", {"tenant_id": "bench"})
create_rels_s = time.perf_counter() - started

samples = []
for _ in range(100):
    anchor = random.choice(created)
    t = time.perf_counter()
    store.get_neighbors(anchor, depth=1)
    samples.append((time.perf_counter() - t) * 1000)

stats = store.get_stats()
sample_id = created[0]
sample_node = store.get_node(sample_id)
store.close()

def pct(xs, p):
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(len(xs) * p))], 2)

print(json.dumps({
    "nodes": n,
    "relationships": 1000,
    "create_nodes_s": round(create_nodes_s, 3),
    "create_relationships_s": round(create_rels_s, 3),
    "get_neighbors_p50_ms": pct(samples, 0.5),
    "get_neighbors_p95_ms": pct(samples, 0.95),
    "stats": stats,
    "id_type": type(sample_id).__name__,
    "sample_node": sample_node,
    "note": "Neo4jStore identifies nodes by Neo4j internal integer id; entity_id is just a property.",
}, indent=2))
