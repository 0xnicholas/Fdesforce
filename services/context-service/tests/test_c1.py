"""C1 is only a check if it can fail.

`test_conformance.py` proves C1 passes on the real contract. These are the
negative controls, run against a temporary copy of `contracts/` + the narrative
doc: an unmarked example, an example that does not validate, a schema-embedded
example that does not validate, an OpenAPI-embedded example that does not
validate, a moved contract minor, and a `$ref` that does not resolve. Each must
turn C1 red with a message that names the thing to fix.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
import yaml

from conformance.cases import CaseContext, CaseFailure, run_c1
from conformance.documents import REPO_ROOT, ContractDocuments


def fixture_root(tmp_path: Path) -> Path:
    shutil.copytree(REPO_ROOT / "contracts", tmp_path / "contracts")
    (tmp_path / "docs").mkdir()
    shutil.copy(REPO_ROOT / "docs" / "runtime-contract.md", tmp_path / "docs" / "runtime-contract.md")
    return tmp_path


def failures_of(root: Path) -> list[str]:
    with pytest.raises(CaseFailure) as caught:
        run_c1(CaseContext(documents=ContractDocuments(root), service=None))
    return list(caught.value.failures)


def test_the_real_contract_passes() -> None:
    checks = run_c1(CaseContext(documents=ContractDocuments(), service=None))

    assert any("contract examples" in check for check in checks)


def test_an_unmarked_example_fails(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    narrative = root / "docs" / "runtime-contract.md"
    text = narrative.read_text(encoding="utf-8")
    marker = "<!-- schema: contracts/schemas/retrieval.schema.json#/$defs/RetrieveRequest -->\n"
    assert marker in text
    narrative.write_text(text.replace(marker, "", 1), encoding="utf-8")

    assert any("has no `<!-- schema: ... -->` marker" in failure for failure in failures_of(root))


def test_an_example_that_does_not_validate_fails(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    narrative = root / "docs" / "runtime-contract.md"
    text = narrative.read_text(encoding="utf-8")
    updated = text.replace('"query": "refund policy for premium customer"', '"query": 5', 1)
    narrative.write_text(updated, encoding="utf-8")

    failures = failures_of(root)
    assert any("RetrieveRequest" in failure and "$.query" in failure for failure in failures), failures


def test_a_schema_embedded_example_that_does_not_validate_fails(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    path = root / "contracts" / "schemas" / "common.schema.json"
    document = json.loads(path.read_text(encoding="utf-8"))
    document["$defs"]["TenantId"]["example"] = 5
    path.write_text(json.dumps(document, indent=2), encoding="utf-8")

    failures = failures_of(root)
    assert any("common.schema.json#/$defs/TenantId example" in failure for failure in failures), failures


def test_an_openapi_embedded_example_that_does_not_validate_fails(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    path = root / "contracts" / "context-service-v1.openapi.yaml"
    document = yaml.safe_load(path.read_text(encoding="utf-8"))
    media = document["paths"]["/v1/context/retrieve"]["post"]["requestBody"]["content"]["application/json"]
    media["example"] = 5
    path.write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")

    failures = failures_of(root)
    assert any("context-service-v1.openapi.yaml" in failure and "example" in failure for failure in failures), failures


def test_a_moved_contract_minor_fails(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    narrative = root / "docs" / "runtime-contract.md"
    text = narrative.read_text(encoding="utf-8")
    updated = text.replace("契约版本：`fde.runtime/v1.4.0`", "契约版本：`fde.runtime/v1.5.0`", 1)
    narrative.write_text(updated, encoding="utf-8")

    assert any("contracts/README.md says 1.4.0" in failure for failure in failures_of(root))


def test_an_openapi_ref_that_does_not_resolve_fails(tmp_path: Path) -> None:
    root = fixture_root(tmp_path)
    path = root / "contracts" / "context-service-v1.openapi.yaml"
    text = path.read_text(encoding="utf-8")
    updated = text.replace(
        "retrieval.schema.json#/$defs/RetrieveRequest",
        "retrieval.schema.json#/$defs/NoSuchRequest",
        1,
    )
    path.write_text(updated, encoding="utf-8")

    assert any("does not resolve" in failure for failure in failures_of(root))
