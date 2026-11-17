"""Verifying an `ExecutionContext` (§5.1, §5.4) — the service's only identity.

The bundle's network is not an identity source: every assertion this service acts
on is signed, and the only thing it trusts is the public half of each issuer's
ES256 key. So this module answers one question — *which* verified identity, if any,
does this bearer token carry — and answers it from the token alone:

| Check | Why it is here |
| --- | --- |
| `alg` is ES256 | `none` and HMAC-with-the-public-key are the classic JWT confusions |
| `kid` selects the key | §5.4's rotation story: the id *is* the RFC 7638 thumbprint, so it cannot name the wrong key |
| signature, `aud` | the token was issued by this issuer for this service |
| `iss` ↔ `deployment_id` ↔ key kind | two issuers, two keys, and a token cannot claim to be the other one |
| `exp`/`iat`, ≤ 5 minutes | a short-lived assertion; a longer one outlives key rotation |
| `jti` single use | a captured token is not a credential for the next request |
| `ExecutionContext` shape | a signed token the contract does not describe is not an assertion it can act on |
| `kid` claim == key id | the payload names the key that signed it, and it must be the one that did |

Everything the *request* asserts — tenant, actor, trace, scope — is checked
against this identity by `app.identity_edge`, never against another header or
body field. That is what "tenant/scope are enforced server-side" means.

Replay records live in memory: context-service is a single writer by contract
(`docs/runtime-contract.md` §4.3), so there is one process to remember them in.
The record lives until the token would have expired anyway, which is the whole
window in which the token is replayable.
"""

from __future__ import annotations

import base64
import hashlib
import json
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from pydantic import ValidationError
from starlette.requests import Request

from app.errors import unauthenticated
from app.generated.models import Actor, ExecutionContext
from app.settings import ConfigurationError, Settings

#: The `aud` every `ExecutionContext` carries (§5.1).
AUDIENCE = "context-service"

#: §5.1's default lifetime. A token that claims longer is not a token this
#: service accepts: it would stay valid across a key rotation.
MAX_TOKEN_LIFETIME_SECONDS = 300

#: Container clocks drift; two processes in one bundle disagree by milliseconds,
#: not minutes. The allowance applies to `iat` and `exp` only — the *lifetime*
#: cap above is exact.
CLOCK_SKEW_SECONDS = 30

#: The two issuers (#5.1). The kind is derived from the key that verified the
#: token, never from a claim the token makes about itself.
IssuerKind = Literal["runtime", "jobs"]

#: `iss` per issuer kind (§5.1). Two issuers, two keys, two audiences of calls.
ISSUER_CLAIMS: Mapping[IssuerKind, str] = {
    "runtime": "fde://{deployment_id}",
    "jobs": "fde://{deployment_id}/jobs",
}


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def thumbprint(key: ec.EllipticCurvePublicKey) -> str:
    """The RFC 7638 JWK thumbprint, base64url — the `kid` §5.4 derives."""
    numbers = key.public_numbers()
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


def issuer_for(kind: IssuerKind, deployment_id: str) -> str:
    """The `iss` one issuer kind signs under for a given deployment."""
    return ISSUER_CLAIMS[kind].format(deployment_id=deployment_id)


@dataclass(frozen=True)
class IssuerKey:
    """One issuer's verification half, and the `kid` derived from it."""

    kind: IssuerKind
    kid: str
    key: ec.EllipticCurvePublicKey


#: The environment variable each issuer's public key arrives in (topology binding).
KEY_SOURCES: Mapping[IssuerKind, str] = {
    "runtime": "EXECUTION_CONTEXT_PUBLIC_KEY",
    "jobs": "FDE_JOBS_PUBLIC_KEY",
}


def _load_public_key(pem: str, *, source: str) -> ec.EllipticCurvePublicKey:
    try:
        key = serialization.load_pem_public_key(pem.encode("ascii"))
    except (ValueError, UnicodeEncodeError) as error:
        raise ConfigurationError(
            f"{source} is not a PEM public key: {error}. The service holds the verification half only (§5.4)"
        ) from error
    if not isinstance(key, ec.EllipticCurvePublicKey) or key.curve.name != "secp256r1":
        raise ConfigurationError(
            f"{source} is not an EC P-256 key, so it cannot verify the ES256 tokens §5.1 requires"
        )
    return key


def load_issuer_keys(*, runtime_pem: str, jobs_pem: str) -> dict[str, IssuerKey]:
    """`kid` → key for both issuers. Anything malformed fails startup."""
    loaded = (
        IssuerKey(kind="runtime", kid="", key=_load_public_key(runtime_pem, source=KEY_SOURCES["runtime"])),
        IssuerKey(kind="jobs", kid="", key=_load_public_key(jobs_pem, source=KEY_SOURCES["jobs"])),
    )
    by_kid = {entry.kind: IssuerKey(kind=entry.kind, kid=thumbprint(entry.key), key=entry.key) for entry in loaded}
    if by_kid["runtime"].kid == by_kid["jobs"].kid:
        raise ConfigurationError(
            "EXECUTION_CONTEXT_PUBLIC_KEY and FDE_JOBS_PUBLIC_KEY are the same key. "
            "Every Deployment has one key pair per issuer, and sharing one erases the "
            "maintenance surface's narrower scope (§5.1, §5.4)"
        )
    return {entry.kid: entry for entry in by_kid.values()}


@dataclass(frozen=True)
class VerifiedIdentity:
    """A signature-checked `ExecutionContext`: the only identity the request edge reads."""

    kind: IssuerKind
    context: ExecutionContext

    @property
    def tenant_id(self) -> str:
        return self.context.tenant_id

    @property
    def trace_id(self) -> str:
        return self.context.trace_id

    @property
    def actor(self) -> Actor:
        return self.context.actor

    @property
    def run_id(self) -> str | None:
        return self.context.run_id

    @property
    def kid(self) -> str:
        return self.context.kid

    @property
    def scopes(self) -> tuple[str, ...]:
        return tuple(self.context.scopes)

    def has_scope(self, scope: str | None) -> bool:
        """Whether this identity holds `scope`; an operation with none needs nothing."""
        return scope is None or scope in self.context.scopes


#: Where the request edge publishes the identity it verified (`request.state`).
IDENTITY_STATE_KEY = "identity"


def identity_of(request: Request) -> VerifiedIdentity:
    """This request's verified identity; a handler may rely on it existing."""
    identity = getattr(request.state, IDENTITY_STATE_KEY, None)
    if not isinstance(identity, VerifiedIdentity):
        raise RuntimeError(
            f"{request.method} {request.url.path} reads an ExecutionContext but none reached the handler; "
            "the operation must declare `security` in contracts/context-service-v1.openapi.yaml"
        )
    return identity


class ReplayGuard:
    """`jti` single use, remembered for as long as the token could be replayed.

    Keyed by `(issuer kind, jti)`: the two issuers mint independently, so one
    issuer's random id says nothing about the other's.
    """

    #: How often expired records are swept away, in seconds of the guard's clock.
    SWEEP_INTERVAL_SECONDS = 60.0

    def __init__(self, *, now: Callable[[], float] | None = None) -> None:
        self._now = now if now is not None else _wall_clock
        self._seen: dict[tuple[str, str], float] = {}
        self._next_sweep = 0.0

    def consume(self, kind: IssuerKind, jti: str, *, expires_at: float) -> bool:
        """Record `jti`; `False` when it was already used (a replay)."""
        self._sweep_if_due()
        key = (kind, jti)
        if key in self._seen:
            return False
        self._seen[key] = expires_at
        return True

    def _sweep_if_due(self) -> None:
        now = self._now()
        if now < self._next_sweep:
            return
        self._seen = {key: expiry for key, expiry in self._seen.items() if expiry >= now}
        self._next_sweep = now + self.SWEEP_INTERVAL_SECONDS

    def __len__(self) -> int:
        return len(self._seen)


def _wall_clock() -> float:
    return time.time()


class JwtVerifier:
    """Both issuers' public halves, plus the replay guard a token passes through."""

    def __init__(
        self,
        keys: Sequence[IssuerKey],
        *,
        replays: ReplayGuard | None = None,
        now: Callable[[], float] | None = None,
        max_lifetime: int = MAX_TOKEN_LIFETIME_SECONDS,
        clock_skew: int = CLOCK_SKEW_SECONDS,
    ) -> None:
        if not keys:
            raise ConfigurationError("a JwtVerifier needs at least one issuer key")
        self._keys: Mapping[str, IssuerKey] = {key.kid: key for key in keys}
        self._now = now if now is not None else _wall_clock
        self._replays = replays if replays is not None else ReplayGuard(now=self._now)
        self._max_lifetime = max_lifetime
        self._clock_skew = clock_skew

    @classmethod
    def from_pems(cls, *, runtime_pem: str, jobs_pem: str, **arguments: object) -> JwtVerifier:
        keys = load_issuer_keys(runtime_pem=runtime_pem, jobs_pem=jobs_pem)
        return cls(list(keys.values()), **arguments)  # type: ignore[arg-type]

    @classmethod
    def from_settings(cls, settings: Settings, **arguments: object) -> JwtVerifier:
        runtime_pem, jobs_pem = settings.require_issuer_keys()
        return cls.from_pems(runtime_pem=runtime_pem, jobs_pem=jobs_pem, **arguments)

    # -- verification -----------------------------------------------------

    def verify(self, token: str) -> VerifiedIdentity:
        """The identity this token carries, or a 401 naming what was wrong with it."""
        header = self._header(token)
        key = self._key_for(header)
        raw = self._decode(token, key)
        self._check_issuer(raw, key)
        self._check_lifetime(raw)
        context = self._context(raw, header)
        self._record(context, key)
        return VerifiedIdentity(kind=key.kind, context=context)

    def _header(self, token: str) -> dict[str, object]:
        try:
            header = jwt.get_unverified_header(token)
        except jwt.InvalidTokenError as error:
            raise unauthenticated("malformed_token", "the Authorization header does not carry a JWT") from error
        if header.get("alg") != "ES256":
            raise unauthenticated(
                "unsupported_algorithm",
                f"the token is signed with {header.get('alg')!r}; this service verifies ES256 only",
            )
        if not isinstance(header.get("kid"), str):
            raise unauthenticated("missing_kid", "the token's JOSE header names no `kid`, so no key can be selected")
        return header

    def _key_for(self, header: Mapping[str, object]) -> IssuerKey:
        kid = str(header["kid"])
        key = self._keys.get(kid)
        if key is None:
            raise unauthenticated(
                "unknown_kid",
                f"no issuer key with kid {kid!r} is bound to this deployment",
            )
        return key

    def _decode(self, token: str, key: IssuerKey) -> Mapping[str, object]:
        try:
            return jwt.decode(
                token,
                key.key,
                algorithms=["ES256"],
                audience=AUDIENCE,
                # The clock is the verifier's, not PyJWT's: a test must be able to
                # move it, and the reason codes below are this service's.
                options={
                    "verify_exp": False,
                    "verify_iat": False,
                    "verify_nbf": False,
                    "require": ["iss", "aud", "sub", "jti", "iat", "exp"],
                },
            )
        except jwt.InvalidSignatureError as error:
            raise unauthenticated("invalid_signature", "the token's signature does not verify") from error
        except jwt.InvalidAudienceError as error:
            raise unauthenticated("invalid_audience", f"the token's `aud` is not {AUDIENCE!r}") from error
        except jwt.MissingRequiredClaimError as error:
            raise unauthenticated("missing_claim", f"the token is missing the {error.claim!r} claim") from error
        except jwt.InvalidTokenError as error:
            raise unauthenticated("malformed_token", f"the token is not a usable JWT: {error}") from error

    def _check_issuer(self, claims: Mapping[str, object], key: IssuerKey) -> None:
        deployment_id = claims.get("deployment_id")
        if not isinstance(deployment_id, str) or not deployment_id:
            raise unauthenticated("missing_claim", "the token names no `deployment_id`, so its `iss` cannot be checked")
        expected = issuer_for(key.kind, deployment_id)
        if claims.get("iss") != expected:
            raise unauthenticated(
                "issuer_mismatch",
                f"the {key.kind} issuer key verified a token whose `iss` is {claims.get('iss')!r}; "
                f"this key signs {expected!r}",
            )

    def _check_lifetime(self, claims: Mapping[str, object]) -> None:
        issued_at = claims.get("iat")
        expires_at = claims.get("exp")
        if not isinstance(issued_at, int) or not isinstance(expires_at, int):
            raise unauthenticated("invalid_claims", "`iat` and `exp` must be integer seconds since the epoch")

        now = self._now()
        if expires_at < now - self._clock_skew:
            raise unauthenticated(
                "expired_token",
                f"the token expired {int(now - expires_at)}s ago; mint a fresh ExecutionContext per call",
            )
        if issued_at > now + self._clock_skew:
            raise unauthenticated("not_yet_valid", "the token's `iat` is in the future; the clocks disagree")
        if expires_at - issued_at > self._max_lifetime:
            raise unauthenticated(
                "token_lifetime_too_long",
                f"the token claims {expires_at - issued_at}s of life; §5.1 caps it at {self._max_lifetime}s",
            )

    def _context(self, claims: Mapping[str, object], header: Mapping[str, object]) -> ExecutionContext:
        try:
            context = ExecutionContext.model_validate(dict(claims))
        except ValidationError as error:
            problems = "; ".join(
                f"{'.'.join(str(part) for part in detail['loc'])}: {detail['msg']}" for detail in error.errors()
            )
            raise unauthenticated("invalid_claims", f"the token is not an ExecutionContext: {problems}") from error
        if context.kid != header["kid"]:
            raise unauthenticated(
                "kid_mismatch",
                f"the payload names kid {context.kid!r} and the JOSE header names {header['kid']!r}",
            )
        return context

    def _record(self, context: ExecutionContext, key: IssuerKey) -> None:
        if not self._replays.consume(key.kind, context.jti, expires_at=context.exp + self._clock_skew):
            raise unauthenticated(
                "replayed_jti",
                "this token was already used; an ExecutionContext is single-use, so mint a fresh one per call",
            )
