"""Services the test suite the same way the conformance runner gets them.

The seam is the **served HTTP surface of a real process** (`conformance.harness`),
not an in-process test client. A client that skipped uvicorn would not prove the
process boots with the configuration the topology gives it.

`contract` is the checked-in `contracts/` as data, so a response can be validated
against the document it claims to satisfy rather than against a second Python
description of it.

`app_settings` is the environment the topology would hand the process — above all
the two issuer public keys. It generates its own pair instead of reusing the
spawned process's, because a test that builds the app in-process (`create_app`)
must not need a running service to do it.
"""

from __future__ import annotations

import pytest

from app.settings import Settings
from conformance.documents import ContractDocuments
from conformance.harness import DEPLOYMENT_ID, REFERENCE_PACKAGE, ServiceProcess
from conformance.identity import Issuer, generate_issuers


@pytest.fixture(scope="session")
def service() -> ServiceProcess:
    with ServiceProcess.start() as process:
        yield process


@pytest.fixture(scope="session")
def contract() -> ContractDocuments:
    return ContractDocuments()


@pytest.fixture(scope="session")
def deployment_keys() -> dict[str, Issuer]:
    """One key pair per issuer, as `fde install` writes them (§5.4)."""
    return generate_issuers(DEPLOYMENT_ID)


@pytest.fixture(scope="session")
def app_settings(deployment_keys: dict[str, Issuer]) -> Settings:
    return Settings(
        execution_context_public_key=deployment_keys["mastra-app"].public_pem,
        fde_jobs_public_key=deployment_keys["fde-jobs"].public_pem,
        # The service executes a package, so an in-process app needs one too: the
        # reference Acme package, read where the repository keeps it.
        context_package_path=str(REFERENCE_PACKAGE),
    )
