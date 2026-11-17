"""The generated modules: fresh, deterministic, and stricter than a dict.

`app/generated/**` is produced by `scripts/generate.py` from `contracts/`. These
tests pin the three properties the rest of the service relies on:

1. the committed output is what the generator produces now (`--check` in pytest),
2. generation is deterministic (same inputs, same bytes),
3. the models refuse what the schema refuses — extra fields, unknown codes, and
   explicit `null` where a field is optional but not nullable.
"""

from __future__ import annotations

import tomllib

import pytest
import yaml
from pydantic import ValidationError

from app.errors import ERROR_HTTP_STATUS
from app.generated import models
from app.generated.versions import (
    GRAPH_SCHEMA_VERSION,
    RUNTIME_CONTRACT_VERSION,
    SERVICE_VERSION,
)
from scripts.generate import OUT_DIR, REPO_ROOT, SERVICE_ROOT, generate

CONTRACT_VERSION_PATTERN = r"^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$"


def test_generation_is_deterministic() -> None:
    first = generate()
    second = generate()

    assert first.keys() == second.keys()
    assert all(first[name] == second[name] for name in first)


def test_committed_generated_code_is_fresh() -> None:
    stale = [name for name, content in generate().items() if (OUT_DIR / name).read_text(encoding="utf-8") != content]

    assert not stale, f"run `python scripts/generate.py`; stale: {', '.join(stale)}"


def test_service_version_is_the_platform_pin() -> None:
    project = tomllib.loads((SERVICE_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    toolchain = yaml.safe_load((REPO_ROOT / "platform" / "toolchain.yaml").read_text(encoding="utf-8"))

    assert project["project"]["version"] == SERVICE_VERSION
    assert toolchain["spec"]["versions"]["contextService"] == SERVICE_VERSION


def test_contract_version_is_the_contract_readme_minor() -> None:
    import re

    readme = (REPO_ROOT / "contracts" / "README.md").read_text(encoding="utf-8")
    stated = re.search(r"Current minor: `([0-9]+\.[0-9]+\.[0-9]+)`", readme)

    assert stated is not None
    assert stated.group(1) == RUNTIME_CONTRACT_VERSION
    assert re.match(CONTRACT_VERSION_PATTERN, RUNTIME_CONTRACT_VERSION)


def test_schema_versions_are_the_toolchain_pins() -> None:
    toolchain = yaml.safe_load((REPO_ROOT / "platform" / "toolchain.yaml").read_text(encoding="utf-8"))

    assert str(toolchain["spec"]["schemas"]["graph"]) == GRAPH_SCHEMA_VERSION


def test_models_refuse_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        models.RetrieveRequest.model_validate({"recipe_id": "claims-context", "query": "q", "sneaky": True})


def test_models_refuse_an_error_code_the_contract_does_not_define() -> None:
    with pytest.raises(ValidationError):
        models.ErrorDetail(code="teapot", message="nope", retryable=False, trace_id="0" * 32)


def test_optional_is_not_nullable() -> None:
    """`budget` is optional in `RetrieveRequest`; the schema does not allow null."""
    with pytest.raises(ValidationError):
        models.RetrieveRequest.model_validate({"recipe_id": "claims-context", "query": "q", "budget": None})


def test_every_error_code_in_the_enum_has_an_http_status() -> None:
    from typing import get_args

    assert set(get_args(models.ErrorCode)) == set(ERROR_HTTP_STATUS)


def test_the_generated_package_is_marked_generated() -> None:
    for path in OUT_DIR.glob("*.py"):
        first = path.read_text(encoding="utf-8").splitlines()[0]
        assert first.startswith("# GENERATED"), f"{path.name} is not marked as generated"
