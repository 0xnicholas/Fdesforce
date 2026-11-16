import json
import os
import random
import resource
import time

from semantica.context.context_graph import ContextGraph

random.seed(42)
N = 10_000
E = 50_000
graph = ContextGraph(advanced_analytics=False)

started = time.perf_counter()
for i in range(N):
    graph.add_node(
        f"bench:n:{i}",
        ["Policy", "Order", "Customer"][i % 3],
        content=f"bench entity {i} refund policy region {i % 17}",
        tenant_id="bench",
        source=f"bench/doc/{i % 100}",
    )
build_nodes = time.perf_counter() - started

started = time.perf_counter()
for i in range(E):
    a = random.randrange(N)
    b = random.randrange(N)
    if a == b:
        b = (b + 1) % N
    graph.add_edge(f"bench:n:{a}", f"bench:n:{b}", "RELATED", weight=0.5 + (i % 5) / 10)
build_edges = time.perf_counter() - started

query_samples = []
for _ in range(1000):
    t = time.perf_counter()
    graph.query("refund policy region 3", limit=5)
    query_samples.append((time.perf_counter() - t) * 1000)

neighbor_samples = []
for _ in range(500):
    anchor = f"bench:n:{random.randrange(N)}"
    t = time.perf_counter()
    graph.get_neighbors(anchor, hops=2, limit=100)
    neighbor_samples.append((time.perf_counter() - t) * 1000)

path = os.path.join(os.environ.get("SPIKE_DATA_DIR", "/tmp/fdesforce-spike-5/data"), "bench-graph.json")
started = time.perf_counter()
graph.save_to_file(path)
save_s = time.perf_counter() - started
size_mb = os.path.getsize(path) / (1024 * 1024)

started = time.perf_counter()
graph2 = ContextGraph(advanced_analytics=False)
graph2.load_from_file(path)
load_s = time.perf_counter() - started

started = time.perf_counter()
for i in range(2000):
    graph.record_decision(
        category="bench",
        scenario=f"bench decision {i}",
        reasoning="refund policy applies",
        outcome="approve",
        confidence=0.9,
        entities=[f"bench:n:{i}"],
        decision_maker="bench-agent",
        metadata={"tenant_id": "bench"},
    )
decision_2k_s = time.perf_counter() - started

def pct(xs, p):
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(len(xs) * p))], 3)

print(json.dumps({
    "nodes": N,
    "edges": E,
    "build_nodes_s": round(build_nodes, 3),
    "build_edges_s": round(build_edges, 3),
    "query_p50_ms": pct(query_samples, 0.5),
    "query_p95_ms": pct(query_samples, 0.95),
    "neighbors_2hop_p50_ms": pct(neighbor_samples, 0.5),
    "neighbors_2hop_p95_ms": pct(neighbor_samples, 0.95),
    "save_s": round(save_s, 3),
    "save_mb": round(size_mb, 2),
    "load_s": round(load_s, 3),
    "record_2k_decisions_s": round(decision_2k_s, 3),
    "rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 * 1024), 1),
    "graph_after_decisions": graph.get_graph_summary(),
}, indent=2))
