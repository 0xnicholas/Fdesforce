"""The service's process configuration (§9.3).

Every value arrives as an environment variable the bundle's topology sets; the
service never reads a secret store itself (`docs/runtime-contract.md` §9.3). This
module decides what is *required* and what a missing value means — fail closed at
startup rather than degrade into an unconfigured runtime.

The two issuer public keys (`EXECUTION_CONTEXT_PUBLIC_KEY`, `FDE_JOBS_PUBLIC_KEY`)
are bound here too, because the topology binds them. Their parsing and use belong
to the identity ticket (#36); #35 only fixes the configuration surface so a
deployment cannot boot with a variable nobody reads.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass


class ConfigurationError(RuntimeError):
    """Startup must stop: the process cannot be the service the bundle deployed."""


#: The graph backends `runtime-info.backend.graph` may name. v0 ships `embedded`
#: only (§4.3); the others are reserved for the production store.
GRAPH_BACKENDS = ("embedded", "neo4j", "postgres")
IMPLEMENTED_GRAPH_BACKENDS = ("embedded",)

#: The audit backends `runtime-info.backend.audit` may name. SQLite is v0's only.
AUDIT_BACKENDS = ("sqlite", "postgres")
IMPLEMENTED_AUDIT_BACKENDS = ("sqlite",)


@dataclass(frozen=True)
class Settings:
    """The environment the process booted into."""

    #: The graph backend this process actually opens. A declaration the service
    #: cannot honour is a startup failure, not a runtime-info field.
    graph_backend: str = "embedded"
    #: The audit backend. v0 writes SQLite on the audit volume.
    audit_backend: str = "sqlite"
    #: Where the embedded graph snapshot lives (`/data/graph` in the bundle).
    graph_path: str = "./data/graph/graph.json"
    #: Where the append-only audit store lives (`/data/audit` in the bundle).
    audit_path: str = "./data/audit/audit.sqlite"
    #: PEM halves of the two issuer keys (§5.4). Never `None` in a running
    #: service: `JwtVerifier.from_settings` refuses to build without both.
    execution_context_public_key: str | None = None
    fde_jobs_public_key: str | None = None

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> Settings:
        """The service's configuration: the stores *and* both issuer keys."""
        return cls.storage_from_env(environ).validated()

    @classmethod
    def storage_from_env(cls, environ: Mapping[str, str] | None = None) -> Settings:
        """The stores only, for a maintenance job (`python -m app.migrate`).

        The migrate job holds no identity surface: the topology gives it the graph
        and audit paths and no issuer keys (`platform/context-service/1.0.0/
        topology.yaml` → `jobs.migrate`). Building the service's settings there
        would make a job that only writes schema demand the keys of a caller it
        never authenticates.
        """
        source = os.environ if environ is None else environ

        graph_backend = source.get("GRAPH_BACKEND", "embedded")
        if graph_backend not in GRAPH_BACKENDS:
            raise ConfigurationError(
                f"GRAPH_BACKEND={graph_backend!r} is not one of {', '.join(GRAPH_BACKENDS)}; "
                "the topology sets `embedded` in v0"
            )
        if graph_backend not in IMPLEMENTED_GRAPH_BACKENDS:
            raise ConfigurationError(
                f"GRAPH_BACKEND={graph_backend!r} is declared in the contract but not implemented; "
                f"this release only serves {', '.join(IMPLEMENTED_GRAPH_BACKENDS)}"
            )

        audit_backend = source.get("AUDIT_BACKEND", "sqlite")
        if audit_backend not in AUDIT_BACKENDS:
            raise ConfigurationError(
                f"AUDIT_BACKEND={audit_backend!r} is not one of {', '.join(AUDIT_BACKENDS)}"
            )
        if audit_backend not in IMPLEMENTED_AUDIT_BACKENDS:
            raise ConfigurationError(
                f"AUDIT_BACKEND={audit_backend!r} is declared in the contract but not implemented; "
                f"this release only serves {', '.join(IMPLEMENTED_AUDIT_BACKENDS)}"
            )

        return cls(
            graph_backend=graph_backend,
            audit_backend=audit_backend,
            graph_path=source.get("GRAPH_PATH", cls.graph_path),
            audit_path=source.get("AUDIT_PATH", cls.audit_path),
            execution_context_public_key=source.get("EXECUTION_CONTEXT_PUBLIC_KEY"),
            fde_jobs_public_key=source.get("FDE_JOBS_PUBLIC_KEY"),
        )

    def validated(self) -> Settings:
        """This configuration, or a startup failure naming what is missing."""
        self.require_issuer_keys()
        return self

    def require_issuer_keys(self) -> tuple[str, str]:
        """The two public halves, or a startup failure naming what the topology owes."""
        missing = [
            name
            for name, value in (
                ("EXECUTION_CONTEXT_PUBLIC_KEY", self.execution_context_public_key),
                ("FDE_JOBS_PUBLIC_KEY", self.fde_jobs_public_key),
            )
            if not value
        ]
        if missing:
            raise ConfigurationError(
                f"missing {', '.join(missing)}: without both issuer public keys this service cannot "
                "verify any caller, so it must not start (§5.1, §5.4); the bundle topology binds both"
            )
        return str(self.execution_context_public_key), str(self.fde_jobs_public_key)
