"""The harness mints real ES256 ExecutionContexts for both issuers (§5.1, §5.4).

"Real" is the claim under test: EC P-256 keys (not a shared secret, not `none`),
signed JWTs that verify with the public half, a `kid` that is the RFC 7638
thumbprint the service derives, and claims that satisfy
`contracts/schemas/execution-context.schema.json`. This is what C2/C3/C6 send; a
harness that could only fabricate an unsigned dict would make those cases theatre.
`test_identity.py` proves the service's verifier accepts what this mints and
refuses what it should.
"""

from __future__ import annotations

import jwt
import pytest
from pydantic import ValidationError

from app.generated.models import ExecutionContext
from conformance.harness import (
    DEPLOYMENT_ID,
    SOLUTION_ID,
    TENANT_ID,
    ServiceProcess,
    new_traceparent,
)
from conformance.identity import (
    JOBS_SCOPES,
    RUNTIME_SCOPES,
    generate_issuers,
    mint,
    rfc7638_thumbprint,
)


def test_both_issuers_sign_with_their_own_key_and_the_contract_claims(service: ServiceProcess) -> None:
    assert set(service.issuers) == {"mastra-app", "fde-jobs"}

    for name, expected_iss in (("mastra-app", f"fde://{DEPLOYMENT_ID}"), ("fde-jobs", f"fde://{DEPLOYMENT_ID}/jobs")):
        issuer = service.issuers[name]
        token = mint(
            issuer,
            deployment_id=DEPLOYMENT_ID,
            tenant_id=TENANT_ID,
            solution_id=SOLUTION_ID,
            trace_id=new_traceparent().split("-")[1],
        )

        claims = issuer.verify(token)
        assert claims["iss"] == expected_iss
        assert claims["aud"] == "context-service"
        assert claims["kid"] == issuer.kid
        assert isinstance(claims["jti"], str) and len(claims["jti"]) >= 16
        assert claims["exp"] - claims["iat"] == 300

        # The generated model is the contract's own shape check.
        ExecutionContext.model_validate(claims)


def test_the_two_issuers_never_share_a_key(service: ServiceProcess) -> None:
    runtime = service.issuers["mastra-app"]
    jobs = service.issuers["fde-jobs"]
    token = mint(
        runtime,
        deployment_id=DEPLOYMENT_ID,
        tenant_id=TENANT_ID,
        solution_id=SOLUTION_ID,
        trace_id=new_traceparent().split("-")[1],
    )

    assert runtime.kid != jobs.kid
    with pytest.raises(jwt.InvalidSignatureError):
        jobs.verify(token)


def test_scopes_are_the_issuer_s_narrow_set(service: ServiceProcess) -> None:
    def scopes(issuer_name: str) -> set[str]:
        issuer = service.issuers[issuer_name]
        token = mint(
            issuer,
            deployment_id=DEPLOYMENT_ID,
            tenant_id=TENANT_ID,
            solution_id=SOLUTION_ID,
            trace_id=new_traceparent().split("-")[1],
        )
        return set(issuer.verify(token)["scopes"])

    assert scopes("mastra-app") == set(RUNTIME_SCOPES)
    assert scopes("fde-jobs") == set(JOBS_SCOPES)
    # The maintenance issuer must not hold the user-facing retrieval scope: the
    # narrower scope set is the reason the second issuer exists (§5.1).
    assert "context:retrieve" not in scopes("fde-jobs")


def test_every_minted_token_is_unique(service: ServiceProcess) -> None:
    issuer = service.issuers["mastra-app"]
    arguments = {
        "deployment_id": DEPLOYMENT_ID,
        "tenant_id": TENANT_ID,
        "solution_id": SOLUTION_ID,
        "trace_id": new_traceparent().split("-")[1],
    }

    first = issuer.verify(mint(issuer, **arguments))
    second = issuer.verify(mint(issuer, **arguments))

    assert first["jti"] != second["jti"]


def test_kid_is_the_rfc7638_thumbprint_of_the_public_key(service: ServiceProcess) -> None:
    from cryptography.hazmat.primitives import serialization

    issuer = service.issuers["mastra-app"]
    public_key = serialization.load_pem_public_key(issuer.public_pem.encode("ascii"))

    assert issuer.kid == rfc7638_thumbprint(public_key)  # type: ignore[arg-type]


def test_a_token_missing_a_required_claim_is_not_a_valid_execution_context(service: ServiceProcess) -> None:
    issuer = service.issuers["mastra-app"]
    claims = issuer.verify(
        mint(
            issuer,
            deployment_id=DEPLOYMENT_ID,
            tenant_id=TENANT_ID,
            solution_id=SOLUTION_ID,
            trace_id=new_traceparent().split("-")[1],
        )
    )
    claims.pop("solution_id")

    with pytest.raises(ValidationError):
        ExecutionContext.model_validate(claims)


def test_fresh_issuers_are_independent() -> None:
    first = generate_issuers(DEPLOYMENT_ID)
    second = generate_issuers(DEPLOYMENT_ID)

    assert first["mastra-app"].kid != second["mastra-app"].kid
