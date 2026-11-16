"""Shared helpers for the retrieval-index benchmarks.

Everything here is deliberately small and dependency-light: JSON results,
Docker lifecycle helpers, percentile maths, and corpus loaders.  No third-party
observability stack is required to reproduce the numbers.
"""

from __future__ import annotations

import json
import os
import re
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import orjson

RESULTS_DIR = Path(__file__).resolve().parent / "results"
DATA_ROOT = Path(os.environ.get("FDE_RET_DATA", "/tmp/fdesforce-retrieval-data"))


# --------------------------------------------------------------------------
# corpus
# --------------------------------------------------------------------------
def data_dir(dataset: str) -> Path:
    return DATA_ROOT / "datasets" / dataset


def load_corpus(dataset: str) -> dict[str, Any]:
    root = data_dir(dataset)
    entity_ids: list[str] = []
    types: list[str] = []
    tenants: list[str] = []
    gold: list[int] = []
    clusters: list[str] = []
    with (root / "nodes.jsonl").open("rb") as fh:
        for line in fh:
            row = orjson.loads(line)
            entity_ids.append(row["entity_id"])
            types.append(row["type"])
            tenants.append(row["tenant_id"])
            gold.append(row["gold"])
            clusters.append(row["cluster"])
    meta = orjson.loads((root / "meta.json").read_bytes())
    return {
        "root": root,
        "entity_ids": entity_ids,
        "types": types,
        "tenants": tenants,
        "gold": np.asarray(gold, dtype=np.int8),
        "clusters": clusters,
        "meta": meta,
    }


def iter_nodes(dataset: str):
    with (data_dir(dataset) / "nodes.jsonl").open("rb") as fh:
        for line in fh:
            yield orjson.loads(line)


def iter_edges(dataset: str):
    with (data_dir(dataset) / "edges.jsonl").open("rb") as fh:
        for line in fh:
            yield orjson.loads(line)


def load_embeddings(dataset: str) -> np.ndarray:
    return np.load(data_dir(dataset) / "embeddings.npy", mmap_mode="r")


def load_queries(dataset: str) -> list[dict]:
    return orjson.loads((data_dir(dataset) / "queries.json").read_bytes())


def queries_for_mode(queries: list[dict], mode: str) -> list[dict]:
    """Only queries that carry the field(s) the measured mode needs."""
    if mode == "keyword":
        return [q for q in queries if q.get("keyword")]
    if mode == "vector":
        return [q for q in queries if q.get("paraphrase")]
    return [q for q in queries if q.get("keyword") and q.get("paraphrase")]


# --------------------------------------------------------------------------
# statistics
# --------------------------------------------------------------------------
def pct(samples: Iterable[float], p: float) -> float:
    values = sorted(samples)
    if not values:
        return 0.0
    idx = min(len(values) - 1, int(round((len(values) - 1) * p)))
    return float(values[idx])


def latency_stats(samples: list[float]) -> dict[str, float]:
    if not samples:
        return {}
    return {
        "n": len(samples),
        "p50": round(pct(samples, 0.50), 3),
        "p95": round(pct(samples, 0.95), 3),
        "p99": round(pct(samples, 0.99), 3),
        "max": round(max(samples), 3),
        "mean": round(statistics.fmean(samples), 3),
        "qps": (
            round(1000.0 / statistics.fmean(samples), 1)
            if samples and statistics.fmean(samples) > 0
            else 0.0
        ),
        "p50_ms": round(pct(samples, 0.50), 3),
    }


def recall_at_k(returned: list[str], relevant: list[str], k: int = 10) -> float:
    if not relevant:
        return 0.0
    top = set(returned[:k])
    return len(top.intersection(relevant)) / float(len(relevant))


def mrr_at_k(returned: list[str], relevant: list[str], k: int = 10) -> float:
    wanted = set(relevant)
    for rank, entity_id in enumerate(returned[:k], start=1):
        if entity_id in wanted:
            return 1.0 / rank
    return 0.0


def rrf(ranked_lists: list[list[str]], k: int = 60, limit: int = 50) -> list[str]:
    scores: dict[str, float] = {}
    for ranked in ranked_lists:
        for rank, entity_id in enumerate(ranked, start=1):
            scores[entity_id] = scores.get(entity_id, 0.0) + 1.0 / (k + rank)
    return [item for item, _ in sorted(scores.items(), key=lambda kv: -kv[1])[:limit]]


# --------------------------------------------------------------------------
# docker
# --------------------------------------------------------------------------
def sh(cmd: list[str] | str, check: bool = True, timeout: int | None = None) -> str:
    result = subprocess.run(
        cmd if isinstance(cmd, list) else ["bash", "-lc", cmd],
        capture_output=True,
        text=True,
        check=False,
        timeout=timeout,
    )
    if check and result.returncode != 0:
        raise RuntimeError(
            f"command failed ({result.returncode}): {cmd}\n{result.stdout}\n{result.stderr}"
        )
    return result.stdout.strip()


def docker_rm(name: str, remove_volume: bool = False) -> None:
    subprocess.run(["docker", "rm", "-f", name], capture_output=True, text=True)
    if remove_volume:
        subprocess.run(["docker", "volume", "rm", "-f", name], capture_output=True, text=True)


def docker_exists(name: str) -> bool:
    out = sh(["docker", "ps", "-a", "--filter", f"name=^/{name}$", "--format", "{{.Names}}"], check=False)
    return out.strip() == name


def docker_running(name: str) -> bool:
    out = sh(["docker", "ps", "--filter", f"name=^/{name}$", "--format", "{{.Names}}"], check=False)
    return out.strip() == name


def docker_start(
    name: str,
    image: str,
    ports: dict[str, str] | None = None,
    env: dict[str, str] | None = None,
    memory: str = "4g",
    volume: str | None = None,
    command: str | None = None,
    health_path: str | None = None,
    timeout: int = 180,
    shm_size: str | None = None,
) -> dict[str, Any]:
    """Start a container from a clean state and wait for readiness."""
    docker_rm(name)
    if volume:
        subprocess.run(["docker", "volume", "rm", "-f", volume], capture_output=True, text=True)
    args = ["docker", "run", "-d", "--name", name, "--memory", memory]
    if shm_size:
        args += ["--shm-size", shm_size]
    for host, container in (ports or {}).items():
        args += ["-p", f"{host}:{container}"]
    for key, value in (env or {}).items():
        args += ["-e", f"{key}={value}"]
    if volume:
        args += ["-v", f"{volume}:{volume_path_for(image)}"]
    args.append(image)
    if command:
        args += ["sh", "-lc", command]
    started = time.perf_counter()
    sh(args)
    ready_s = wait_ready(name, image, health_path, timeout)
    return {"container": name, "image": image, "start_s": round(time.perf_counter() - started, 3),
            "ready_s": round(ready_s, 3), "memory_limit": memory, "ports": ports or {}}


def volume_path_for(image: str) -> str:
    if image.startswith("neo4j"):
        return "/data"
    if image.startswith("qdrant"):
        return "/qdrant/storage"
    if image.startswith("pgvector") or image.startswith("postgres"):
        return "/var/lib/postgresql/data"
    return "/data"


def _http_ok(url: str) -> bool:
    out = sh(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", url], check=False)
    return out.strip() in {"200", "204"}


def wait_ready(name: str, image: str, health_path: str | None, timeout: int = 180) -> float:
    started = time.perf_counter()
    deadline = started + timeout
    while time.perf_counter() < deadline:
        if not docker_running(name):
            logs = sh(["docker", "logs", "--tail", "40", name], check=False)
            raise RuntimeError(f"{name} exited during startup:\n{logs}")
        if image.startswith("neo4j"):
            out = sh(
                ["docker", "exec", name, "cypher-shell", "-u", "neo4j", "-p", os.environ.get("NEO4J_PASSWORD", "testpass123"), "RETURN 1"],
                check=False,
            )
            if "1" in out:
                return time.perf_counter() - started
        elif image.startswith("qdrant"):
            if _http_ok("http://localhost:6333/healthz") or _http_ok("http://localhost:6333/"):
                return time.perf_counter() - started
        elif image.startswith("pgvector") or image.startswith("postgres"):
            out = sh(["docker", "exec", name, "pg_isready", "-U", "postgres"], check=False)
            if "accepting connections" in out:
                return time.perf_counter() - started
        else:
            if health_path and _http_ok(health_path):
                return time.perf_counter() - started
        time.sleep(1.0)
    logs = sh(["docker", "logs", "--tail", "60", name], check=False)
    raise TimeoutError(f"{name} not ready after {timeout}s:\n{logs}")


def container_mem_mb(name: str) -> float:
    out = sh(["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", name], check=False)
    if not out:
        return 0.0
    used = out.split("/")[0].strip()
    match = re.match(r"([0-9.]+)\s*([KMG]i?B)", used)
    if not match:
        return 0.0
    value = float(match.group(1))
    unit = match.group(2)
    factor = {"B": 1 / 1024 / 1024, "KiB": 1 / 1024, "MiB": 1, "GiB": 1024,
              "KB": 1 / 1024, "MB": 1, "GB": 1024}.get(unit, 1)
    return round(value * factor, 1)


class MemorySampler:
    def __init__(self, name: str, interval: float = 1.0):
        self.name = name
        self.interval = interval
        self.samples: list[float] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.samples.append(container_mem_mb(self.name))
            except Exception:
                pass
            self._stop.wait(self.interval)

    def __enter__(self) -> "MemorySampler":
        self._thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self._stop.set()
        self._thread.join(timeout=5)

    @property
    def peak_mb(self) -> float:
        return round(max(self.samples) if self.samples else 0.0, 1)

    @property
    def idle_mb(self) -> float:
        return round(self.samples[-1] if self.samples else 0.0, 1)


def container_disk_mb(name: str, paths: list[str]) -> dict[str, float]:
    result: dict[str, float] = {}
    for path in paths:
        out = sh(["docker", "exec", name, "du", "-sm", path], check=False)
        if out:
            try:
                result[path] = float(out.split()[0])
            except (ValueError, IndexError):
                result[path] = 0.0
    result["total"] = round(sum(v for k, v in result.items() if k != "total"), 1)
    return result


def wait_docker_healthy(name: str, timeout: int = 120) -> float:
    started = time.perf_counter()
    while time.perf_counter() - started < timeout:
        out = sh(["docker", "inspect", "-f", "{{.State.Health.Status}}", name], check=False)
        if out.strip() == "healthy":
            return time.perf_counter() - started
        time.sleep(1.0)
    return -1.0


# --------------------------------------------------------------------------
# environment / results
# --------------------------------------------------------------------------
def package_versions() -> dict[str, str]:
    import importlib.metadata as md

    wanted = ["semantica", "fastembed", "neo4j", "qdrant-client", "psycopg", "numpy", "pgvector", "faiss-cpu"]
    out = {}
    for name in wanted:
        try:
            out[name] = md.version(name)
        except md.PackageNotFoundError:
            out[name] = "not installed"
    return out


def host_meta() -> dict[str, Any]:
    return {
        "platform": sys.platform,
        "macos": sh(["sw_vers", "-productVersion"], check=False),
        "cpu": sh(["sysctl", "-n", "machdep.cpu.brand_string"], check=False),
        "ncpu": sh(["sysctl", "-n", "hw.ncpu"], check=False),
        "mem_gb": round(int(sh(["sysctl", "-n", "hw.memsize"], check=False) or 0) / 1024**3, 1),
        "docker": sh(["docker", "info", "--format", "{{.ServerVersion}} cpus={{.NCPU}} mem={{.MemTotal}}"], check=False),
        "python": sys.version.split()[0],
        "packages": package_versions(),
    }


def image_digest(image: str) -> str:
    out = sh(["docker", "inspect", "-f", "{{index .RepoDigests 0}}", image], check=False)
    return out.strip()


def write_result(filename: str, payload: dict[str, Any]) -> Path:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    path = RESULTS_DIR / filename
    payload.setdefault("generated_at", time.strftime("%Y-%m-%dT%H:%M:%S%z"))
    path.write_bytes(orjson.dumps(payload, option=orjson.OPT_INDENT_2))
    print(f"wrote {path}", flush=True)
    return path


def json_print(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, indent=2, ensure_ascii=False), flush=True)
