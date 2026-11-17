"""The service verifies `ExecutionContext`s itself (§5.1, §5.4).

The counterpart of `test_identity_harness.py`: that file proves the harness mints
real ES256 tokens; this one proves the service refuses everything that is not one
the deployment issued. Each test names one way a token can be wrong — the
algorithm, the key, the issuer, the audience, the lifetime, the replay — because
"invalid token" is not a diagnosis an operator can act on.

The seam is `JwtVerifier`, the object the request edge calls. No HTTP here: the
wire checks are `test_identity_http.py`'s.
"""

from __future__ import annotations

import json
import secrets
import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from app.errors import FdeError
from app.identity import (
    CLOCK_SKEW_SECONDS,
    MAX_TOKEN_LIFETIME_SECONDS,
    IssuerKey,
    JwtVerifier,
    ReplayGuard,
    load_issuer_keys,
)
from app.settings import ConfigurationError, Settings
from conformance.harness import DEPLOYMENT_ID, SOLUTION_ID, TENANT_ID
from conformance.identity import RUNTIME_SCOPES, Issuer, generate_issuers, mint, rfc7638_thumbprint

TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"


@pytest.fixture(scope="module")
def issuers() -> dict[str, Issuer]:
    return generate_issuers(DEPLOYMENT_ID)


@pytest.fixture(scope="module")
def verifier(issuers: dict[str, Issuer]) -> JwtVerifier:
    return JwtVerifier.from_pems(
        runtime_pem=issuers["mastra-app"].public_pem,
        jobs_pem=issuers["fde-jobs"].public_pem,
    )


def claims(issuers: dict[str, Issuer], name: str = "mastra-app", **overrides: object) -> dict[str, object]:
    """A contract-shaped claim set for one issuer, before any tampering."""
    issuer = issuers[name]
    issued_at = int(time.time())
    base: dict[str, object] = {
        "iss": issuer.iss,
        "aud": "context-service",
        "sub": "user-42",
        "actor": {"type": "user", "id": "u-42"},
        "tenant_id": TENANT_ID,
        "deployment_id": DEPLOYMENT_ID,
        "solution_id": SOLUTION_ID,
        "trace_id": TRACE_ID,
        "roles": ["service"],
        "scopes": list(RUNTIME_SCOPES),
        "iat": issued_at,
        "exp": issued_at + MAX_TOKEN_LIFETIME_SECONDS,
        "jti": secrets.token_hex(16),
        "kid": issuer.kid,
    }
    base.update(overrides)
    return base


def sign(issuers: dict[str, Issuer], value: dict[str, object], name: str = "mastra-app", kid: str | None = None) -> str:
    issuer = issuers[name]
    return jwt.encode(
        value,
        issuer.private_pem,
        algorithm="ES256",
        headers={"kid": issuer.kid if kid is None else kid},
    )


def refuses(verifier: JwtVerifier, value: str) -> str:
    """Verify, expect a 401, and return the reason the service reports."""
    with pytest.raises(FdeError) as caught:
        verifier.verify(value)
    assert caught.value.code == "unauthenticated"
    assert caught.value.status == 401
    assert caught.value.retryable is False
    return str((caught.value.details or {}).get("reason"))


def public_key(issuer: Issuer) -> ec.EllipticCurvePublicKey:
    return serialization.load_pem_public_key(issuer.public_pem.encode("ascii"))  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# The happy path, and what "verified" means
# ---------------------------------------------------------------------------


def test_a_token_from_either_issuer_verifies(verifier: JwtVerifier, issuers: dict[str, Issuer]) -> None:
    runtime = verifier.verify(sign(issuers, claims(issuers)))
    jobs = verifier.verify(sign(issuers, claims(issuers, "fde-jobs"), "fde-jobs"))

    assert (runtime.kind, jobs.kind) == ("runtime", "jobs")
    assert runtime.tenant_id == TENANT_ID
    assert runtime.context.deployment_id == DEPLOYMENT_ID
    assert runtime.trace_id == TRACE_ID
    assert runtime.kid == issuers["mastra-app"].kid

    assert runtime.scopes == tuple(RUNTIME_SCOPES)
    assert runtime.has_scope("context:retrieve")
    assert not runtime.has_scope("context:ingest")


def test_a_harness_minted_token_verifies(verifier: JwtVerifier, issuers: dict[str, Issuer]) -> None:
    """The conformance harness and the service share one definition of a token."""
    value = mint(
        issuers["mastra-app"],
        deployment_id=DEPLOYMENT_ID,
        tenant_id=TENANT_ID,
        solution_id=SOLUTION_ID,
        trace_id=TRACE_ID,
    )

    assert verifier.verify(value).context.kid == issuers["mastra-app"].kid


def test_the_kid_is_the_rfc7638_thumbprint_of_the_configured_key(issuers: dict[str, Issuer]) -> None:
    """§5.4: the id comes from the public key, so it cannot name the wrong one."""
    keys = load_issuer_keys(
        runtime_pem=issuers["mastra-app"].public_pem,
        jobs_pem=issuers["fde-jobs"].public_pem,
    )

    assert set(keys) == {issuers["mastra-app"].kid, issuers["fde-jobs"].kid}
    assert keys[issuers["mastra-app"].kid].kid == rfc7638_thumbprint(public_key(issuers["mastra-app"]))
    assert {key.kind for key in keys.values()} == {"runtime", "jobs"}


# ---------------------------------------------------------------------------
# The signature
# ---------------------------------------------------------------------------


def test_an_unsigned_token_is_refused(verifier: JwtVerifier, issuers: dict[str, Issuer]) -> None:
    unsigned = jwt.encode(claims(issuers), None, algorithm="none", headers={"kid": issuers["mastra-app"].kid})

    assert refuses(verifier, unsigned) == "unsupported_algorithm"


def test_a_token_signed_by_a_key_this_deployment_does_not_trust_is_refused(verifier: JwtVerifier) -> None:
    stranger = generate_issuers(DEPLOYMENT_ID)["mastra-app"]
    forged = jwt.encode(
        {**claims({"mastra-app": stranger}), "kid": stranger.kid},
        stranger.private_pem,
        algorithm="ES256",
        headers={"kid": stranger.kid},
    )

    assert refuses(verifier, forged) == "unknown_kid"


def test_an_unknown_kid_is_refused_without_trying_every_key(
    verifier: JwtVerifier, issuers: dict[str, Issuer]
) -> None:
    """`kid` selects the key (§5.4); an id that names nothing is not a slower search."""
    assert refuses(verifier, sign(issuers, claims(issuers), kid="not-a-thumbprint")) == "unknown_kid"


def test_a_tampered_payload_is_refused(verifier: JwtVerifier, issuers: dict[str, Issuer]) -> None:
    header, _, signature = sign(issuers, claims(issuers)).split(".")
    forged_payload = jwt.utils.base64url_encode(
        json.dumps({**claims(issuers), "tenant_id": "someone-else"}).encode("utf-8")
    ).decode("ascii")

    assert refuses(verifier, f"{header}.{forged_payload}.{signature}") == "invalid_signature"


def test_a_token_signed_by_the_runtime_key_but_asserting_the_jobs_issuer_is_refused(
    verifier: JwtVerifier, issuers: dict[str, Issuer]
) -> None:
    """The key says which issuer signed; a claim that disagrees is not two issuers, it is one lie."""
    runtime_key = issuers["mastra-app"].private_pem
    forged = jwt.encode(
        claims(issuers, iss=f"fde://{DEPLOYMENT_ID}/jobs"),
        runtime_key,
        algorithm="ES256",
        headers={"kid": issuers["mastra-app"].kid},
    )

    assert refuses(verifier, forged) == "issuer_mismatch"


# ---------------------------------------------------------------------------
# The claims the contract fixes
# ---------------------------------------------------------------------------


def test_a_token_for_another_audience_is_refused(verifier: JwtVerifier, issuers: dict[str, Issuer]) -> None:
    assert refuses(verifier, sign(issuers, claims(issuers, aud="run-api"))) == "invalid_audience"


def test_an_issuer_that_does_not_match_its_deployment_id_is_refused(
    verifier: JwtVerifier, issuers: dict[str, Issuer]
) -> None:
    other_deployment = sign(issuers, claims(issuers, iss="fde://dep_01ARZ3NDEKTSV4RRFFQ69G5FBW"))

    assert refuses(verifier, other_deployment) == "issuer_mismatch"


def test_an_expired_token_is_refused(verifier: JwtVerifier, issuers: dict[str, Issuer]) -> None:
    issued_at = int(time.time()) - MAX_TOKEN_LIFETIME_SECONDS - CLOCK_SKEW_SECONDS - 10
    stale = claims(issuers, iat=issued_at, exp=issued_at + MAX_TOKEN_LIFETIME_SECONDS)

    assert refuses(verifier, sign(issuers, stale)) == "expired_token"


def test_a_token_that_lives_longer_than_five_minutes_is_refused(
    verifier: JwtVerifier, issuers: dict[str, Issuer]
) -> None:
    """§5.1 fixes 5 minutes; a longer lifetime outlives the rotation window."""
    issued_at = int(time.time())
    long_lived = claims(issuers, iat=issued_at, exp=issued_at + MAX_TOKEN_LIFETIME_SECONDS + 1)

    assert refuses(verifier, sign(issuers, long_lived)) == "token_lifetime_too_long"


def test_a_token_from_the_future_is_refused(verifier: JwtVerifier, issuers: dict[str, Issuer]) -> None:
    issued_at = int(time.time()) + 3600
    future = claims(issuers, iat=issued_at, exp=issued_at + MAX_TOKEN_LIFETIME_SECONDS)

    assert refuses(verifier, sign(issuers, future)) == "not_yet_valid"


def test_a_token_missing_a_required_claim_is_refused(verifier: JwtVerifier, issuers: dict[str, Issuer]) -> None:
    incomplete = claims(issuers)
    del incomplete["solution_id"]

    assert refuses(verifier, sign(issuers, incomplete)) == "invalid_claims"


def test_a_token_with_a_claim_outside_the_contract_is_refused(
    verifier: JwtVerifier, issuers: dict[str, Issuer]
) -> None:
    """`ExecutionContext` is closed (`additionalProperties: false`)."""
    assert refuses(verifier, sign(issuers, claims(issuers, may_do_everything=True))) == "invalid_claims"


def test_a_malformed_token_is_refused(verifier: JwtVerifier) -> None:
    assert refuses(verifier, "not-a-jwt") == "malformed_token"


# ---------------------------------------------------------------------------
# Replay
# ---------------------------------------------------------------------------


def test_the_same_jti_is_refused_the_second_time(verifier: JwtVerifier, issuers: dict[str, Issuer]) -> None:
    value = sign(issuers, claims(issuers))
    verifier.verify(value)

    assert refuses(verifier, value) == "replayed_jti"


def test_a_fresh_token_for_the_same_call_is_not_a_replay(
    verifier: JwtVerifier, issuers: dict[str, Issuer]
) -> None:
    """Two calls, two tokens: the jti is what makes them different, not the claims."""
    verifier.verify(sign(issuers, claims(issuers)))
    verifier.verify(sign(issuers, claims(issuers)))


def test_the_two_issuers_do_not_share_a_replay_namespace(
    verifier: JwtVerifier, issuers: dict[str, Issuer]
) -> None:
    """A burned jti under one issuer says nothing about the other's tokens."""
    jti = secrets.token_hex(16)
    jobs_token = sign(issuers, claims(issuers, "fde-jobs", jti=jti), "fde-jobs")
    runtime_token = sign(issuers, claims(issuers, jti=jti))

    verifier.verify(jobs_token)
    verifier.verify(runtime_token)

    assert refuses(verifier, jobs_token) == "replayed_jti"


class Clock:
    """A controllable clock, so a TTL test does not sleep for five minutes."""

    def __init__(self, now: float) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


def test_the_replay_guard_forgets_a_jti_once_the_token_would_have_expired(
    issuers: dict[str, Issuer]
) -> None:
    clock = Clock(1_700_000_000.0)
    verifier = JwtVerifier(
        [
            IssuerKey(kind="runtime", kid=issuers["mastra-app"].kid, key=public_key(issuers["mastra-app"])),
            IssuerKey(kind="jobs", kid=issuers["fde-jobs"].kid, key=public_key(issuers["fde-jobs"])),
        ],
        replays=ReplayGuard(now=clock),
        now=clock,
    )
    value = sign(
        issuers,
        claims(
            issuers,
            iat=int(clock.now),
            exp=int(clock.now) + MAX_TOKEN_LIFETIME_SECONDS,
            jti="c" * 32,
        ),
    )
    verifier.verify(value)

    # Past the token's own expiry the old record is gone; the token is refused for
    # being expired, which is the failure that matters, not for being remembered.
    clock.now += MAX_TOKEN_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS + 1
    with pytest.raises(FdeError) as caught:
        verifier.verify(value)
    assert str((caught.value.details or {}).get("reason")) == "expired_token"


def test_the_replay_guard_prunes_expired_entries() -> None:
    clock = Clock(1_000.0)
    guard = ReplayGuard(now=clock)

    assert guard.consume("runtime", "jti-1", expires_at=1_100) is True
    assert guard.consume("runtime", "jti-1", expires_at=1_100) is False

    clock.now = 200.0
    assert guard.consume("runtime", "jti-1", expires_at=1_100) is False, "a live entry must still be remembered"

    clock.now = 5_000.0
    guard.consume("runtime", "jti-2", expires_at=5_100)
    assert len(guard) == 1, "the expired entry must be pruned when the guard sweeps"


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def test_a_key_that_is_not_a_public_key_fails_configuration(issuers: dict[str, Issuer]) -> None:
    with pytest.raises(ConfigurationError):
        load_issuer_keys(runtime_pem="not a key", jobs_pem=issuers["fde-jobs"].public_pem)


def test_a_private_key_where_a_public_key_belongs_fails_configuration(issuers: dict[str, Issuer]) -> None:
    """The verification half is the only half context-service may hold (§5.4)."""
    with pytest.raises(ConfigurationError):
        load_issuer_keys(runtime_pem=issuers["mastra-app"].private_pem, jobs_pem=issuers["fde-jobs"].public_pem)


def test_binding_one_key_to_both_issuers_fails_configuration(issuers: dict[str, Issuer]) -> None:
    """One key pair per issuer; sharing one would erase the jobs boundary."""
    shared = issuers["mastra-app"].public_pem

    with pytest.raises(ConfigurationError):
        load_issuer_keys(runtime_pem=shared, jobs_pem=shared)


def test_settings_without_a_public_key_fail_startup() -> None:
    with pytest.raises(ConfigurationError):
        Settings.from_env({"GRAPH_BACKEND": "embedded"})
