"""Services the test suite the same way the conformance runner gets them.

The seam is the **served HTTP surface of a real process** (`conformance.harness`),
not an in-process test client. A client that skipped uvicorn would not prove the
process boots with the configuration the topology gives it.

`contract` is the checked-in `contracts/` as data, so a response can be validated
against the document it claims to satisfy rather than against a second Python
description of it.
"""

from __future__ import annotations

import pytest

from conformance.documents import ContractDocuments
from conformance.harness import ServiceProcess


@pytest.fixture(scope="session")
def service() -> ServiceProcess:
    with ServiceProcess.start() as process:
        yield process


@pytest.fixture(scope="session")
def contract() -> ContractDocuments:
    return ContractDocuments()
