"""Minting the maintenance identity: a `fde-jobs` `ExecutionContext` (§5.1, §5.4).

The service *verifies* this token and never mints one — the private half lives in the
customer's secret store and is mounted only into the maintenance jobs
(`platform/context-service/1.1.0/topology.yaml`). So this module is the other side of
`app.identity`: the same claim shape, the same `kid` derivation (the RFC 7638 thumbprint
of the public key the service selects by), and the same five-minute ceiling.

Three things a job's token may not do, because they are why a second issuer exists:

- carry `run_id` — a maintenance job does not act for a Run;
- carry a runtime scope — `context:ingest` is the whole grant;
- outlive the run it was minted for — the job mints one per call, so a leaked token is
  a five-minute problem rather than a stored credential.

`trace_id` is the job's own: the service binds the token's `trace_id` to the request's
`traceparent`, so a maintenance call is traceable like any other and cannot be replayed
onto another call.
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from app.identity import AUDIENCE, ISSUER_CLAIMS

#: How long a minted token lives. The verifier refuses more than its own ceiling (§5.1),
#: and a job that mints one per call has no reason to ask for longer.
TOKEN_LIFETIME_SECONDS = 300

#: The one scope a maintenance token carries (`docs/security-and-deployment.md` §3.3).
JOBS_SCOPES = ("context:ingest",)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def thumbprint(public_key: ec.EllipticCurvePublicKey) -> str:
    """The RFC 7638 JWK thumbprint, base64url — the `kid` a service derives (§5.4)."""
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


def mint_jobs_token(
    *,
    private_key_pem: str,
    deployment_id: str,
    tenant_id: str,
    solution_id: str,
    trace_id: str | None = None,
    now: int | None = None,
    ttl_seconds: int = TOKEN_LIFETIME_SECONDS,
) -> str:
    """One signed `ExecutionContext` for one maintenance call."""
    key = serialization.load_pem_private_key(private_key_pem.encode("utf-8"), password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey):
        raise ValueError("the fde-jobs signing key is not an EC key; the contract's tokens are ES256")
    kid = thumbprint(key.public_key())
    issued_at = int(time.time() if now is None else now)
    claims = {
        "iss": ISSUER_CLAIMS["jobs"].format(deployment_id=deployment_id),
        "aud": AUDIENCE,
        "sub": "fde://jobs/ingest",
        "actor": {"type": "service", "id": "fde-jobs"},
        "tenant_id": tenant_id,
        "deployment_id": deployment_id,
        "solution_id": solution_id,
        "trace_id": trace_id or secrets.token_hex(16),
        "roles": ["service"],
        "scopes": list(JOBS_SCOPES),
        "iat": issued_at,
        "exp": issued_at + ttl_seconds,
        "jti": secrets.token_hex(16),
        "kid": kid,
    }
    return jwt.encode(claims, key, algorithm="ES256", headers={"kid": kid})
