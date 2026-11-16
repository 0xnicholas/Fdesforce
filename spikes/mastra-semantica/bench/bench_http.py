import json
import statistics
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8011"
TENANT = "acme"
ACTOR = "bench"
TRACE = "tr-bench"


def call(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method="GET" if body is None else "POST",
        headers={
            "content-type": "application/json",
            "x-tenant-id": TENANT,
            "x-trace-id": TRACE,
            "x-actor": ACTOR,
        },
    )
    started = time.perf_counter()
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read())
    return (time.perf_counter() - started) * 1000, payload


def summary(name, samples):
    samples = sorted(samples)
    pick = lambda p: samples[min(len(samples) - 1, int(len(samples) * p))]
    return {
        "name": name,
        "n": len(samples),
        "p50_ms": round(statistics.median(samples), 2),
        "p95_ms": round(pick(0.95), 2),
        "p99_ms": round(pick(0.99), 2),
        "max_ms": round(samples[-1], 2),
        "server_reported_p50_ms": None,
    }


results = {"retrieve": [], "decision": [], "provenance": []}
server_latency = {"retrieve": [], "decision": [], "provenance": []}

for _ in range(200):
    ms, payload = call("/v1/context/retrieve", {"query": "premium refund policy", "max_hops": 2, "top_k": 5})
    results["retrieve"].append(ms)
    server_latency["retrieve"].append(payload.get("latency_ms"))

evidence = ["acme:policy:refund", "acme:policy:premium", "acme:order:1001", "acme:customer:42"]
decision_ids = []
for i in range(50):
    ms, payload = call("/v1/decisions", {
        "category": "bench_refund",
        "scenario": f"Bench refund scenario {i}",
        "reasoning": "Premium window covers the request.",
        "outcome": "approve_refund",
        "confidence": 0.9,
        "entities": evidence,
        "evidence_ids": evidence,
        "metadata": {"bench": True},
    })
    results["decision"].append(ms)
    server_latency["decision"].append(payload.get("latency_ms"))
    decision_ids.append(payload["decision_id"])

for _ in range(100):
    ms, payload = call(f"/v1/provenance/{decision_ids[0]}")
    results["provenance"].append(ms)
    server_latency["provenance"].append(payload.get("latency_ms"))

out = []
for name, samples in results.items():
    item = summary(name, samples)
    item["server_reported_p50_ms"] = round(statistics.median(server_latency[name]), 2)
    out.append(item)

print(json.dumps(out, indent=2))
