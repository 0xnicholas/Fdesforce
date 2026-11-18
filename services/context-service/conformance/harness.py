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
import shutil
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

#: The frozen Context Package a deployment serves. The Acme package is the reference
#: customer (`examples/semantic/acme`), and the harness copies it onto the volume the
#: topology mounts — a service with no package has no recipe to execute.
REFERENCE_PACKAGE = REPO_ROOT / "examples" / "semantic" / "acme"

#: The package's `metadata.name` and `version`, and the digest `revisions/<version>.yaml`
#: recorded (`fde context freeze`'s attestation). The ingest job names all three.
REFERENCE_PACKAGE_NAME = "acme-claims-context"
REFERENCE_PACKAGE_VERSION = "1.0.0"
REFERENCE_PACKAGE_DIGEST = "sha256:a8216d62662cf855120f1b3ec4ab9c865a5bc9a9f3ef179f6deb2b7a5ed0eaf5"

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
        roles: Iterable[str] | None = None,
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
            roles=roles,
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

    def ingest(
        self,
        *,
        mode: str = "incremental",
        sources: Iterable[str] | None = None,
        package: dict[str, str] | None = None,
        tenant_id: str = TENANT_ID,
    ) -> httpx.Response:
        """POST the ingest job as the deployment's `ingest` container does (§9.2).

        A `fde-jobs` token, no `run_id` (the maintenance surface is not Run-scoped), and
        the package revision the ledger and the lock name. The request body is the
        contract's, so a job the real CLI would send is the one the tests send.
        """
        body: dict[str, object] = {
            "package": package
            or {
                "name": REFERENCE_PACKAGE_NAME,
                "version": REFERENCE_PACKAGE_VERSION,
                "digest": REFERENCE_PACKAGE_DIGEST,
            },
            "mode": mode,
        }
        if sources is not None:
            body["sources"] = list(sources)
        return self.post(
            "/internal/v1/jobs/ingest",
            json=body,
            headers=self.authorized(issuer="fde-jobs", tenant_id=tenant_id, run_id=None),
        )

    @classmethod
    def start(
        cls,
        *,
        data_dir: Path | None = None,
        env: dict[str, str] | None = None,
        cwd: Path | None = None,
        migrate: bool = True,
        context_package: Path | None = None,
    ) -> ServiceProcess:
        """Migrate the volumes, spawn the service, and wait until it is alive.

        `migrate=True` is the deployment's order (§9.2): `python -m app.migrate`
        exits 0, and only then does the service start. The harness runs the job for
        the same reason it spawns uvicorn rather than importing the app — the
        sequence being tested is the one a deployment performs. `migrate=False`
        exists for the case that asserts the gate itself: a service started on an
        unprepared volume must refuse to serve.

        A process that dies before `/healthz` is a *startup* failure; the error
        carries the log tail, because "connection refused" alone would hide the
        traceback that explains it.
        """
        run_dir = Path(tempfile.mkdtemp(prefix="fde-context-service-"))
        data = data_dir or run_dir / "data"
        (data / "graph").mkdir(parents=True, exist_ok=True)
        (data / "audit").mkdir(parents=True, exist_ok=True)
        # The package is the bundle's read-only input, not the service's output: it is
        # copied beside the volumes rather than into one, exactly as the topology mounts
        # it (`platform/context-service/1.1.0/topology.yaml`).
        package_root = context_package if context_package is not None else REFERENCE_PACKAGE
        shutil.copytree(package_root, data / "context-package", dirs_exist_ok=True)

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
            "CONTEXT_PACKAGE_PATH": str(data / "context-package"),
            # The two verification halves the topology binds (§5.4, §9.3). The
            # service refuses to start without them, so the harness supplies the
            # configuration a deployment gives it.
            "EXECUTION_CONTEXT_PUBLIC_KEY": issuers["mastra-app"].public_pem,
            "FDE_JOBS_PUBLIC_KEY": issuers["fde-jobs"].public_pem,
            **(env or {}),
        }

        if migrate:
            run_migrate(child_env, cwd=cwd or SERVICE_ROOT)

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


def run_migrate(env: dict[str, str], *, cwd: Path) -> None:
    """Run the migrate job as the topology does, and fail loudly if it does not exit 0.

    The deployment waits on this exit code (`dependsOn: [migrate]`), so a harness
    that started the service without it would be testing a sequence no environment
    performs — and the volumes would be migrated by the service itself.
    """
    completed = subprocess.run(
        [sys.executable, "-m", "app.migrate"],
        cwd=str(cwd),
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"migrate exited with {completed.returncode}; the service is not started on an "
            f"unmigrated volume\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
        )
