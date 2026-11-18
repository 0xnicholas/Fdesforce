"""The maintenance token the ingest job mints is not a platform-role grant (§5.1, §5.4).

`roles` is the platform ∪ business union, and under §5.1's role→scope rule a platform
role *derives* scopes. A jobs token that claimed `service` would therefore assert the
runtime grants (`context:retrieve`, the Decision writes) while carrying only
`context:ingest`; the narrowness of the second issuer is the whole reason it exists.
"""

from __future__ import annotations

import jwt

from app.identity import JwtVerifier
from app.jobs_identity import mint_jobs_token
from conformance.harness import DEPLOYMENT_ID, SOLUTION_ID, TENANT_ID
from conformance.identity import JOBS_SCOPES, generate_issuers


def test_the_job_token_carries_the_maintenance_scope_and_no_platform_role() -> None:
    issuers = generate_issuers(DEPLOYMENT_ID)
    trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"

    token = mint_jobs_token(
        private_key_pem=issuers["fde-jobs"].private_pem,
        deployment_id=DEPLOYMENT_ID,
        tenant_id=TENANT_ID,
        solution_id=SOLUTION_ID,
        trace_id=trace_id,
    )
    claims = jwt.decode(token, options={"verify_signature": False})

    assert claims["iss"] == issuers["fde-jobs"].iss
    assert claims["roles"] == [], "a platform role would derive scopes the job does not carry"
    assert claims["scopes"] == list(JOBS_SCOPES)
    assert claims["trace_id"] == trace_id
    assert "run_id" not in claims, "a maintenance job does not act for a Run"
    assert claims["kid"] == issuers["fde-jobs"].kid

    verified = JwtVerifier.from_pems(
        runtime_pem=issuers["mastra-app"].public_pem,
        jobs_pem=issuers["fde-jobs"].public_pem,
    ).verify(token)
    assert verified.kind == "jobs"
    assert verified.context.scopes == list(JOBS_SCOPES)
