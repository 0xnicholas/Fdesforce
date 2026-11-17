"""ES256 `ExecutionContext` minting for the conformance harness (§5.1, §5.4).

Two issuers, two key pairs, never one key shared:

| issuer | `iss` | key pair |
| --- | --- | --- |
| `mastra-app` | `fde://<deployment_id>` | `fde/execution-context-*` |
| `fde-jobs` | `fde://<deployment_id>/jobs` | `fde/jobs/*` |

The keys are EC P-256, like `fde install keys` writes them; `kid` is the RFC 7638
JWK thumbprint, which is how the service derives the id from the public key it is
given (`docs/runtime-contract.md` §5.4, `platform/context-service`). The
`kid` is also a *claim*, because `ExecutionContext` requires it there, so it is
set in both the JOSE header and the payload.
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, Literal

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

AUDIENCE = "context-service"
TOKEN_TTL_SECONDS = 300

#: The preview of §5.1 that a runtime-issued call carries. The scope matrix is
#: `packages/spec/src/schema/platform-roles.ts`; #36 makes the service enforce it,
#: and these are the scopes that ticket will pin the harness to.
RUNTIME_SCOPES = ("context:retrieve", "decision:write", "approval:create", "approval:consume")
#: `fde-jobs` carries only the maintenance scopes — that narrowness is the reason
#: the second issuer exists (`MAINTENANCE_SCOPES`).
JOBS_SCOPES = ("context:ingest",)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def rfc7638_thumbprint(public_key: ec.EllipticCurvePublicKey) -> str:
    """The RFC 7638 JWK thumbprint, base64url: the `kid` a service derives."""
    numbers = public_key.public_numbers()
    canonical = json.dumps(
        {
            "crv": "P-256",
            "kty": "EC",
            "x": _b64url(numbers.x.to_bytes(32, "big")),
            "y": _b64url(numbers.y.to_bytes(32, "big")),
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return _b64url(hashlib.sha256(canonical).digest())


#: The two issuer kinds. A `runtime` token authorizes user-facing calls; a `jobs`
#: token authorizes the maintenance surface and nothing else (§5.1).
IssuerKind = Literal["runtime", "jobs"]


@dataclass(frozen=True)
class Issuer:
    """One issuer's key pair and the `iss` it signs under."""

    kind: IssuerKind
    name: str
    iss: str
    kid: str
    private_pem: str
    public_pem: str

    def verify(self, token: str) -> dict[str, Any]:
        """Verify a token with this issuer's public half and return its claims."""
        return jwt.decode(
            token,
            self.public_pem,
            algorithms=["ES256"],
            audience=AUDIENCE,
            options={"require": ["exp", "iat", "iss", "aud"]},
        )


def _issuer(name: str, kind: IssuerKind, iss: str) -> Issuer:
    private_key = ec.generate_private_key(ec.SECP256R1())
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")
    public_pem = (
        private_key.public_key()
        .public_bytes(encoding=serialization.Encoding.PEM, format=serialization.PublicFormat.SubjectPublicKeyInfo)
        .decode("ascii")
    )
    return Issuer(
        kind=kind,
        name=name,
        iss=iss,
        kid=rfc7638_thumbprint(private_key.public_key()),
        private_pem=private_pem,
        public_pem=public_pem,
    )


def generate_issuers(deployment_id: str) -> dict[str, Issuer]:
    """A fresh pair of issuer key pairs for one deployment."""
    return {
        "mastra-app": _issuer("mastra-app", "runtime", f"fde://{deployment_id}"),
        "fde-jobs": _issuer("fde-jobs", "jobs", f"fde://{deployment_id}/jobs"),
    }


def mint(
    issuer: Issuer,
    *,
    deployment_id: str,
    tenant_id: str,
    solution_id: str,
    trace_id: str,
    actor: dict[str, str] | None = None,
    subject: str | None = None,
    roles: Iterable[str] = ("service",),
    scopes: Iterable[str] | None = None,
    run_id: str | None = None,
    ttl_seconds: int = TOKEN_TTL_SECONDS,
    now: int | None = None,
) -> str:
    """Sign one `ExecutionContext` for this issuer.

    The returned token is a real ES256 JWS: the caller can hand it to the service
    *and* verify it with the issuer's public key, which is how the harness proves
    it minted what it claims to have minted.
    """
    issued_at = int(time.time()) if now is None else now
    is_jobs = issuer.kind == "jobs"
    claims: dict[str, Any] = {
        "iss": issuer.iss,
        "aud": AUDIENCE,
        "sub": subject or ("fde-jobs" if is_jobs else "user-42"),
        "actor": actor
        or {"type": "service" if is_jobs else "user", "id": subject or ("fde-jobs" if is_jobs else "u-42")},
        "tenant_id": tenant_id,
        "deployment_id": deployment_id,
        "solution_id": solution_id,
        "trace_id": trace_id,
        "roles": list(roles),
        "scopes": sorted(set(scopes if scopes is not None else (JOBS_SCOPES if is_jobs else RUNTIME_SCOPES))),
        "iat": issued_at,
        "exp": issued_at + ttl_seconds,
        "jti": secrets.token_hex(16),
        "kid": issuer.kid,
    }
    if run_id is not None:
        claims["run_id"] = run_id
    return jwt.encode(claims, issuer.private_pem, algorithm="ES256", headers={"kid": issuer.kid})
