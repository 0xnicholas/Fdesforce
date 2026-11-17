"""`POST /internal/v1/jobs/ingest` and `python -m app.ingest` (§5.5, §9.2).

The job is the only thing that fills the graph, so these tests are the end-to-end path a
deployment takes: the package on its read-only volume, the `fde-jobs` issuer, the job, the
ledger, and a retrieval that can then cite the facts the package's golden questions ask
for. Two things they deliberately do not do: re-derive the package (a mutated copy is how
"a source is broken" is simulated) and fake the ledger (a `/readyz` that says `partial`
is the deployment's own signal, not a test hook).
"""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
import yaml

from conformance.documents import ContractDocuments
from conformance.harness import (
    DEPLOYMENT_ID,
    REFERENCE_PACKAGE,
    REFERENCE_PACKAGE_DIGEST,
    REFERENCE_PACKAGE_NAME,
    REFERENCE_PACKAGE_VERSION,
    SOLUTION_ID,
    ServiceProcess,
)

RETRIEVE_RESPONSE = "retrieval.schema.json#/$defs/RetrieveResponse"
JOB_RESULT = "ingest-job.schema.json#/$defs/IngestJobResult"

#: The scopes an adjuster's token carries for the Acme baseline's classes.
CLAIMS = ("context:retrieve", "claims:read", "claims:documents:read", "customer:pii:read")

PACKAGE = {
    "name": REFERENCE_PACKAGE_NAME,
    "version": REFERENCE_PACKAGE_VERSION,
    "digest": REFERENCE_PACKAGE_DIGEST,
}


@pytest.fixture(scope="module")
def ingested() -> Iterator[ServiceProcess]:
    with ServiceProcess.start() as process:
        yield process


def test_the_job_materializes_the_package_and_the_graph_answers(
    ingested: ServiceProcess, contract: ContractDocuments
) -> None:
    """The Acme package's facts become entities a retrieval can cite (§5.2, §6.2)."""
    response = ingested.ingest()

    assert response.status_code == 200, response.text
    job = response.json()
    contract.require(job, JOB_RESULT, "ingest job result")
    assert job["status"] == "succeeded", job
    assert job["mode"] == "incremental"
    assert [source["source"] for source in job["sources"]] == ["claims-db", "sharepoint-claims"]
    claims = next(source for source in job["sources"] if source["source"] == "claims-db")
    assert claims["status"] == "ok"
    assert claims["entities"] == 9
    assert claims["edges"] == 9
    assert claims["watermark"] == "2026-01-04T09:30:00Z"

    retrieval = ingested.post(
        "/v1/context/retrieve",
        json={"recipe_id": "claims-context", "query": "claim C-1001", "filters": {"claim_id": "C-1001"}},
        headers=ingested.authorized(scopes=CLAIMS),
    )

    assert retrieval.status_code == 200, retrieval.text
    body = retrieval.json()
    contract.require(body, RETRIEVE_RESPONSE, "retrieve response")
    assert body["degraded"] is False, body
    citations = {item["source_ref"] for item in body["items"]}
    assert "claims-db://public.claims/C-1001" in citations
    assert "claims-db://public.policies/P-2001" in citations
    entity_ids = {item["entity_id"] for item in body["items"]}
    assert {
        "fde:acme:claim:C-1001",
        "fde:acme:policy:P-2001",
        "fde:acme:coverage:COV-1",
        "fde:acme:fraudflag:FF-7",
    } <= entity_ids


def test_the_document_source_is_retrievable_and_cited(
    ingested: ServiceProcess, contract: ContractDocuments
) -> None:
    """The lexical stage serves the document source the recipe declares, with its citation."""
    body = ingested.post(
        "/v1/context/retrieve",
        json={"recipe_id": "claims-context", "query": "refund policy premium customer"},
        headers=ingested.authorized(scopes=CLAIMS),
    ).json()
    contract.require(body, RETRIEVE_RESPONSE, "retrieve response")

    item = next(
        item for item in body["items"] if item["source_ref"] == "sharepoint://claims/policies/refund.md"
    )
    assert item["version"] == "e-7781"
    assert item["source_kind"] == "document"
    assert "within 30 days" in item["content"]


def test_the_ledger_records_the_watermarks_and_readiness_turns_ready(ingested: ServiceProcess) -> None:
    ingested.ingest()

    ledger = json.loads((ingested.data_dir / "graph" / "ingest.json").read_text(encoding="utf-8"))
    assert ledger["package"] == PACKAGE
    assert {source["source"]: source["watermark"] for source in ledger["sources"]} == {
        "claims-db": "2026-01-04T09:30:00Z",
        "sharepoint-claims": "2026-01-05T08:00:00Z",
    }
    assert ingested.get("/readyz").json() == {"status": "ready", "reasons": []}


def test_a_second_incremental_run_re_reads_nothing(ingested: ServiceProcess) -> None:
    """The watermark is the whole point of `incremental`: a quiet source costs one read."""
    ingested.ingest()

    second = ingested.ingest().json()

    assert second["status"] == "succeeded", second
    assert [source["entities"] for source in second["sources"]] == [0, 0]


def test_a_digest_that_is_not_the_frozen_revision_is_a_conflict(ingested: ServiceProcess) -> None:
    """§5.5: the runtime materializes what `fde context freeze` attested, not what a caller says."""
    response = ingested.ingest(package={**PACKAGE, "digest": "sha256:" + "0" * 64})

    assert response.status_code == 409, response.text
    error = response.json()["error"]
    assert error["code"] == "conflict"
    assert error["details"]["reason"] == "package_not_frozen"
    assert REFERENCE_PACKAGE_DIGEST in error["message"]


def test_a_version_this_deployment_does_not_hold_is_a_conflict(ingested: ServiceProcess) -> None:
    response = ingested.ingest(package={**PACKAGE, "version": "2.0.0"})

    assert response.status_code == 409
    assert response.json()["error"]["details"]["reason"] == "package_not_frozen"


def test_an_undeclared_source_is_refused_before_anything_is_written(ingested: ServiceProcess) -> None:
    response = ingested.ingest(sources=["warehouse"])

    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation_failed"
    assert error["details"]["reason"] == "unknown_source"
    assert "claims-db" in error["message"]


def test_the_runtime_issuer_cannot_run_a_maintenance_job(ingested: ServiceProcess) -> None:
    """§5.4: the two issuers are two keys, and `mastra-app` has no path to ingest."""
    response = ingested.post(
        "/internal/v1/jobs/ingest",
        json={"package": PACKAGE, "mode": "incremental"},
        headers=ingested.authorized(),  # mastra-app
    )

    assert response.status_code == 403
    assert response.json()["error"]["details"]["reason"] == "issuer_not_allowed"


def test_a_job_token_without_the_maintenance_scope_is_refused(ingested: ServiceProcess) -> None:
    response = ingested.post(
        "/internal/v1/jobs/ingest",
        json={"package": PACKAGE, "mode": "incremental"},
        headers=ingested.authorized(issuer="fde-jobs", scopes=["context:retrieve"], run_id=None),
    )

    assert response.status_code == 403
    assert response.json()["error"]["details"]["reason"] == "missing_scope"


def test_a_source_with_no_connector_degrades_readiness_and_the_retrieval(
    tmp_path: Path,
) -> None:
    """The package names a Connector this deployment does not serve: `partial`, and it says why."""
    package = tmp_path / "package"
    shutil.copytree(REFERENCE_PACKAGE, package)
    source = package / "context-sources" / "claims-db.yaml"
    document = yaml.safe_load(source.read_text(encoding="utf-8"))
    document["spec"]["connectorRef"] = "warehouse"
    source.write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")

    with ServiceProcess.start(context_package=package) as process:
        job = process.ingest().json()

        assert job["status"] == "failed"
        failed = next(source for source in job["sources"] if source["source"] == "claims-db")
        assert failed["status"] == "failed"
        assert "no Connector is registered" in failed["reason"]

        readyz = process.get("/readyz").json()
        assert readyz["status"] == "degraded"
        assert any(reason.startswith("ingest: partial") for reason in readyz["reasons"]), readyz

        retrieval = process.post(
            "/v1/context/retrieve",
            json={"recipe_id": "claims-context", "query": "refund policy"},
            headers=process.authorized(scopes=CLAIMS),
        ).json()
        assert retrieval["degraded"] is True
        assert retrieval["reason"] == "partial"


def test_python_m_app_ingest_is_the_job_the_topology_runs(tmp_path: Path) -> None:
    """`platform/context-service/1.1.0/topology.yaml` runs `python -m app.ingest` after the
    service is up: the CLI mints its own maintenance token, posts the job, and exits on the
    outcome — so the deployment path is exercised, not only the endpoint."""
    with ServiceProcess.start() as process:
        signing_key = tmp_path / "fde-jobs-signing-key.pem"
        signing_key.write_text(process.issuers["fde-jobs"].private_pem, encoding="utf-8")
        completed = subprocess.run(
            [sys.executable, "-m", "app.ingest", "--mode=incremental"],
            cwd=str(Path(__file__).resolve().parents[1]),
            env={
                **config_env(process, signing_key),
                "PATH": "/usr/bin:/bin",
            },
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
        )

        assert completed.returncode == 0, completed.stdout + completed.stderr
        job = json.loads(completed.stdout)
        assert job["status"] == "succeeded", job
        assert process.get("/readyz").json()["status"] == "ready"

        rerun = subprocess.run(
            [sys.executable, "-m", "app.ingest"],
            cwd=str(Path(__file__).resolve().parents[1]),
            env={**config_env(process, signing_key), "PATH": "/usr/bin:/bin"},
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
        )
        assert rerun.returncode == 0, rerun.stdout + rerun.stderr
        assert json.loads(rerun.stdout)["sources"][0]["entities"] == 0


def test_the_cli_refuses_with_a_message_when_the_deployment_identity_is_unbound(tmp_path: Path) -> None:
    """A job acts for one Deployment and one Solution: a bundle cannot bake either in."""
    from app.ingest import main

    output = io.StringIO()

    code = main([], environ={"CONTEXT_SERVICE_URL": "http://127.0.0.1:1"}, stream=output)

    assert code == 2
    assert "FDE_DEPLOYMENT_ID, FDE_SOLUTION_ID" in output.getvalue()
    assert str(tmp_path) is not None


def config_env(process: ServiceProcess, signing_key: Path) -> dict[str, str]:
    return {
        **os.environ,
        "CONTEXT_SERVICE_URL": process.base_url,
        "CONTEXT_PACKAGE_PATH": str(process.data_dir / "context-package"),
        "FDE_DEPLOYMENT_ID": DEPLOYMENT_ID,
        "FDE_SOLUTION_ID": SOLUTION_ID,
        "FDE_JOBS_SIGNING_KEY": str(signing_key),
    }
