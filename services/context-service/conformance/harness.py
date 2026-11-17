"""The conformance harness (`contracts/conformance/cases.md` C1–C15).

Every case runs against a **real context-service process** over real HTTP: the
runner spawns `uvicorn --factory app.main:create_app` in a child process, waits for `/healthz`,
and talks to it with an ordinary HTTP client. Nothing imports the app, because a
case that reached into the app could pass while the served surface was wrong.

The harness also mints `ExecutionContext` tokens with **real ES256 keys** — one
key pair per issuer (`mastra-app` and `fde-jobs`), exactly as `fde install keys`
generates them (§5.4) — so the identity cases send what a deployment sends.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import tempfile
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Self

import httpx

from conformance.identity import TOKEN_TTL_SECONDS, Issuer, generate_issuers, mint

SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVICE_ROOT.parents[1]

#: A valid `DeploymentId` (§4.2). The issuer names derive from it, so every token
#: this harness mints is scoped to the same deployment a bundle would have.
DEPLOYMENT_ID = "dep_01ARZ3NDEKTSV4RRFFQ69G5FAV"

#: The Acme reference tenant (`platform/templates/solution/fde-solution`).
TENANT_ID = "acme"
SOLUTION_ID = "claims-triage"

#: The Run a Run-scoped call acts for (§5.1). A token without it is refused on
#: retrieve/decisions/approvals, so the default token carries one.
RUN_ID = "run_01ARZ3NDEKTSV4RRFFQ69G5FAV"

#: How long a spawned process may take to answer `/healthz`.
START_TIMEOUT_SECONDS = 20.0
#: How long a probe gets before the harness gives up on it.
REQUEST_TIMEOUT_SECONDS = 10.0


def _free_port() -> int:
    """Bind :0, read the port, release it. The child process re-binds it."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _tail(path: Path, lines: int = 40) -> str:
    try:
        content = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    return "\n".join(content[-lines:])


@dataclass
class ServiceProcess:
    """One running context-service, addressable over HTTP."""

    base_url: str
    data_dir: Path
    issuers: dict[str, Issuer]
    _proc: subprocess.Popen[bytes]
    _log: Path
    _client: httpx.Client = field(init=False)

    def __post_init__(self) -> None:
        self._client = httpx.Client(
            base_url=self.base_url,
            timeout=REQUEST_TIMEOUT_SECONDS,
            headers={"accept": "application/json"},
        )

    # -- HTTP -------------------------------------------------------------

    def request(self, method: str, path: str, *, omit_traceparent: bool = False, **kwargs: object) -> httpx.Response:
        """One HTTP request with the trace header the contract requires.

        `omit_traceparent=True` is for the cases that assert what happens without
        it; every other call gets a fresh trace, because the contract requires one.
        """
        headers = dict(kwargs.pop("headers", {}) or {})  # type: ignore[arg-type]
        if not omit_traceparent:
            headers.setdefault("traceparent", new_traceparent())
        return self._client.request(method, path, headers=headers, **kwargs)  # type: ignore[arg-type]

    def get(self, path: str, **kwargs: object) -> httpx.Response:
        return self.request("GET", path, **kwargs)

    def post(self, path: str, **kwargs: object) -> httpx.Response:
        return self.request("POST", path, **kwargs)

    # -- identity ---------------------------------------------------------

    def authorized(
        self,
        *,
        issuer: str = "mastra-app",
        scopes: Iterable[str] | None = None,
        tenant_id: str = TENANT_ID,
        trace_id: str | None = None,
        traceparent_trace_id: str | None = None,
        run_id: str | None = RUN_ID,
        actor: dict[str, str] | None = None,
        ttl_seconds: int = TOKEN_TTL_SECONDS,
        now: int | None = None,
    ) -> dict[str, str]:
        """A fresh `ExecutionContext` and the `traceparent` it is bound to.

        `jti` is single-use, so every call mints a new token: two requests cannot
        share one header set any more than two calls can share one identity.
        `traceparent_trace_id` is the deliberate-mismatch knob — C6 exists because
        a token minted for one trace must not be usable on another.
        """
        trace = trace_id or os.urandom(16).hex()
        token = mint(
            self.issuers[issuer],
            deployment_id=DEPLOYMENT_ID,
            tenant_id=tenant_id,
            solution_id=SOLUTION_ID,
            trace_id=trace,
            actor=actor,
            scopes=scopes,
            run_id=run_id,
            ttl_seconds=ttl_seconds,
            now=now,
        )
        return {
            "authorization": f"Bearer {token}",
            "traceparent": new_traceparent(traceparent_trace_id or trace),
        }

    # -- lifecycle --------------------------------------------------------

    def stop(self) -> None:
        self._client.close()
        if self._proc.poll() is not None:
            return
        self._proc.terminate()
        try:
            self._proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self._proc.kill()
            self._proc.wait(timeout=10)

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop()

    def logs(self) -> str:
        return _tail(self._log)

    @classmethod
    def start(
        cls,
        *,
        data_dir: Path | None = None,
        env: dict[str, str] | None = None,
        cwd: Path | None = None,
    ) -> ServiceProcess:
        """Spawn the service and wait until it is alive.

        A process that dies before `/healthz` is a *startup* failure; the error
        carries the log tail, because "connection refused" alone would hide the
        traceback that explains it.
        """
        run_dir = Path(tempfile.mkdtemp(prefix="fde-context-service-"))
        data = data_dir or run_dir / "data"
        (data / "graph").mkdir(parents=True, exist_ok=True)
        (data / "audit").mkdir(parents=True, exist_ok=True)

        issuers = generate_issuers(DEPLOYMENT_ID)
        port = _free_port()
        log = run_dir / "service.log"
        log_handle = log.open("wb")

        child_env = {
            **os.environ,
            "PYTHONPATH": str(cwd or SERVICE_ROOT),
            "GRAPH_BACKEND": "embedded",
            "GRAPH_PATH": str(data / "graph" / "graph.json"),
            "AUDIT_PATH": str(data / "audit" / "audit.sqlite"),
            # The two verification halves the topology binds (§5.4, §9.3). The
            # service refuses to start without them, so the harness supplies the
            # configuration a deployment gives it.
            "EXECUTION_CONTEXT_PUBLIC_KEY": issuers["mastra-app"].public_pem,
            "FDE_JOBS_PUBLIC_KEY": issuers["fde-jobs"].public_pem,
            **(env or {}),
        }

        proc = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "--factory",
                "app.main:create_app",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--log-level",
                "warning",
            ],
            cwd=str(cwd or SERVICE_ROOT),
            env=child_env,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
        )

        service = cls(
            base_url=f"http://127.0.0.1:{port}",
            data_dir=data,
            issuers=issuers,
            _proc=proc,
            _log=log,
        )

        deadline = time.monotonic() + START_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                service.stop()
                raise RuntimeError(
                    f"context-service exited with {proc.returncode} before answering /healthz\n{service.logs()}"
                )
            try:
                if service._client.get("/healthz", timeout=1.0).status_code == 200:
                    return service
            except httpx.HTTPError:
                pass
            time.sleep(0.05)

        service.stop()
        raise RuntimeError(f"context-service did not answer /healthz within {START_TIMEOUT_SECONDS}s\n{service.logs()}")


def new_traceparent(trace_id: str | None = None) -> str:
    """A W3C `traceparent` for a fresh (or given) trace."""
    trace = trace_id or os.urandom(16).hex()
    span = os.urandom(8).hex()
    return f"00-{trace}-{span}-01"
