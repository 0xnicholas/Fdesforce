"""C1–C15: the context-service half of `contracts/conformance/cases.md`.

The table in that document is the suite; this module is the runner's
implementation of it. Two cases are real in this slice — C1 (every contract
example validates) and C10 (422 normalization) — and the rest are declared with
the ticket that will fill them. They are *declared*, not omitted: a runner that
silently ran two of fifteen cases would report a conformance level nobody has.

Each case returns the checks it passed so the output says what was proven, not
just "ok".
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError
from referencing.exceptions import Unresolvable

from conformance.documents import ContractDocuments
from conformance.embedded_examples import embedded_example_failures
from conformance.examples import Example, parse_examples
from conformance.harness import ServiceProcess

OPENAPI_DOCUMENTS = ("context-service-v1.openapi.yaml", "runtime-api-v1.openapi.yaml")


class CaseFailure(AssertionError):
    """One case's assertions failed; the message lists every failure, not the first."""

    def __init__(self, failures: Sequence[str]) -> None:
        self.failures = tuple(failures)
        super().__init__("\n".join(self.failures))


@dataclass(frozen=True)
class CaseContext:
    documents: ContractDocuments
    service: ServiceProcess | None

    def require_service(self) -> ServiceProcess:
        if self.service is None:
            raise RuntimeError("this case needs a running service; the runner was asked not to spawn one")
        return self.service


@dataclass(frozen=True)
class Case:
    case_id: str
    title: str
    run: Callable[[CaseContext], tuple[str, ...]] | None
    needs_service: bool = False
    owner: str | None = None


# ---------------------------------------------------------------------------
# C1 — every contract example validates against its schema
# ---------------------------------------------------------------------------


def example_documents(root: Path) -> list[Path]:
    """The docs C1 covers: the narrative contract and every `contracts/` markdown."""
    return [root / "docs" / "runtime-contract.md", *sorted((root / "contracts").rglob("*.md"))]


def read_examples(documents: ContractDocuments) -> list[Example]:
    parsed = [parse_examples(path) for path in example_documents(documents.root)]
    examples = [example for found in parsed for example in found.examples]
    if not examples:
        raise CaseFailure(["no marked ```json examples were found in docs/runtime-contract.md"])
    return examples


def _schema_ref_failures(documents: ContractDocuments) -> list[str]:
    failures: list[str] = []
    for name, document in documents.schemas.items():
        try:
            Draft202012Validator.check_schema(document)
        except SchemaError as error:
            failures.append(f"contracts/schemas/{name} is not a valid JSON Schema: {error.message}")

        resolver = documents.registry.resolver(base_uri=document["$id"])
        for reference in _refs(document):
            try:
                resolver.lookup(reference)
            except Unresolvable:
                failures.append(f"contracts/schemas/{name}: $ref {reference!r} does not resolve")
    return failures


def _refs(node: object) -> Iterable[str]:
    if isinstance(node, dict):
        reference = node.get("$ref")
        if isinstance(reference, str):
            yield reference
        for value in node.values():
            yield from _refs(value)
    elif isinstance(node, list):
        for value in node:
            yield from _refs(value)


def _openapi_failures(documents: ContractDocuments) -> list[str]:
    failures: list[str] = []
    for name in OPENAPI_DOCUMENTS:
        document = documents.openapi(name)
        for reference in _refs(document):
            if reference.startswith("#/"):
                cursor: object = document
                for part in reference.removeprefix("#/").split("/"):
                    if not isinstance(cursor, dict) or part not in cursor:
                        failures.append(f"contracts/{name}: $ref {reference!r} does not resolve")
                        break
                    cursor = cursor[part]
                continue
            if reference.startswith("./schemas/"):
                file, _, pointer = reference.partition("#")
                schema = documents.schemas.get(Path(file).name)
                if schema is None:
                    failures.append(f"contracts/{name}: $ref {reference!r} names no schema document")
                    continue
                if pointer and not pointer.startswith("/$defs/"):
                    failures.append(
                        f"contracts/{name}: $ref {reference!r} points outside $defs; the runner cannot resolve it"
                    )
                    continue
                cursor: object = schema.get("$defs", {}) if pointer else schema
                for part in pointer.removeprefix("/$defs/").split("/") if pointer else []:
                    if not isinstance(cursor, dict) or part not in cursor:
                        failures.append(f"contracts/{name}: $ref {reference!r} does not resolve")
                        break
                    cursor = cursor[part]
    return failures


def _contract_minor(documents: ContractDocuments) -> tuple[str, list[str]]:
    """`contracts/README.md` and the narrative doc must state the same minor."""
    readme = (documents.root / "contracts" / "README.md").read_text(encoding="utf-8")
    narrative = (documents.root / "docs" / "runtime-contract.md").read_text(encoding="utf-8")
    stated = re.search(r"Current minor: `([0-9]+\.[0-9]+\.[0-9]+)`", readme)
    header = re.search(r"契约版本：`fde\.runtime/v([0-9]+\.[0-9]+\.[0-9]+)`", narrative)
    if stated is None or header is None:
        return "", ["the contract minor is no longer stated in contracts/README.md and docs/runtime-contract.md"]
    if stated.group(1) != header.group(1):
        return stated.group(1), [
            f"contracts/README.md says {stated.group(1)} and docs/runtime-contract.md says {header.group(1)}"
        ]
    return stated.group(1), []


def run_c1(context: CaseContext) -> tuple[str, ...]:
    documents = context.documents
    failures: list[str] = []

    parsed = [parse_examples(path) for path in example_documents(documents.root)]
    examples = [example for found in parsed for example in found.examples]
    for found in parsed:
        failures.extend(
            f"{unmarked.source}:{unmarked.line}: a ```json example has no `<!-- schema: ... -->` marker"
            for unmarked in found.unmarked
        )
        failures.extend(f"{broken.source}:{broken.line}: {broken.detail}" for broken in found.broken)

    if not examples:
        failures.append("no marked ```json examples were found in the contract docs")
    for example in examples:
        failures.extend(
            f"{example.label} ({example.schema}): {problem}"
            for problem in documents.problems(example.instance, example.schema)
        )

    failures.extend(_schema_ref_failures(documents))
    failures.extend(_openapi_failures(documents))
    failures.extend(embedded_example_failures(documents))
    minor, minor_failures = _contract_minor(documents)
    failures.extend(minor_failures)

    if failures:
        raise CaseFailure(failures)
    return (
        f"{len(examples)} contract examples",
        f"{len(documents.schemas)} schema documents",
        f"{len(OPENAPI_DOCUMENTS)} OpenAPI documents",
        f"contract minor {minor}",
    )


# ---------------------------------------------------------------------------
# C10 — 422 normalization
# ---------------------------------------------------------------------------

#: Path parameters need a value the schema accepts before the body is even read.
_PATH_IDS = {
    "approval_id": "appr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "decision_id": "dec_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "run_id": "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
}
_PATH_PARAM = re.compile(r"\{([a-z_]+)\}")


def body_operations(openapi: dict) -> list[tuple[str, str, str]]:
    """Every contract operation with a request body: (method, path, operationId)."""
    found = []
    for path, item in (openapi.get("paths") or {}).items():
        for method in ("get", "post", "put", "patch", "delete"):
            operation = item.get(method)
            if operation is not None and operation.get("requestBody") is not None:
                found.append((method.upper(), path, str(operation.get("operationId"))))
    return found


def declared_statuses(openapi: dict, operation_id: str) -> set[int]:
    """The statuses the contract declares for one operation."""
    for item in (openapi.get("paths") or {}).values():
        for method in ("get", "post", "put", "patch", "delete"):
            operation = item.get(method)
            if operation is not None and operation.get("operationId") == operation_id:
                return {int(status) for status in (operation.get("responses") or {}) if str(status).isdigit()}
    return set()


def concrete_path(path: str) -> str:
    def substitute(match: re.Match[str]) -> str:
        name = match.group(1)
        if name not in _PATH_IDS:
            raise CaseFailure([f"{path}: no sample value for path parameter {name!r}"])
        return _PATH_IDS[name]

    return _PATH_PARAM.sub(substitute, path)


def _error_envelope(documents: ContractDocuments, response, label: str) -> dict:
    try:
        body = response.json()
    except ValueError as error:
        raise CaseFailure([f"{label}: response is not JSON: {error}"]) from error
    problems = documents.problems(body, "error.schema.json")
    if problems:
        raise CaseFailure([f"{label}: not the unified error envelope"] + problems)
    return body["error"]


def run_c10(context: CaseContext) -> tuple[str, ...]:
    service = context.require_service()
    documents = context.documents
    failures: list[str] = []

    openapi = documents.openapi()
    operations = body_operations(openapi)
    for method, path, operation_id in operations:
        label = f"{operation_id} ({method} {path})"
        declared = declared_statuses(openapi, operation_id)
        response = service.request(method, concrete_path(path), json={})
        if response.status_code != 422:
            failures.append(f"{label}: an invalid body answered {response.status_code}, expected 422")
            continue
        if 422 not in declared:
            # An enveloped 422 the operation never declared is still a broken
            # contract: the client was promised a different status set.
            failures.append(f"{label}: 422 is not among the operation's declared responses {sorted(declared)}")
        error = _error_envelope(documents, response, label)
        if error["code"] != "validation_failed":
            failures.append(f"{label}: code is {error['code']!r}, expected 'validation_failed'")
        if error["retryable"] is not False:
            failures.append(f"{label}: a validation failure must not be retryable")
        if not (error.get("details") or {}).get("errors"):
            failures.append(f"{label}: details.errors is empty; the client cannot tell what to fix")

    missing = service.get("/v1/does-not-exist")
    if missing.status_code != 404:
        failures.append(f"an unknown route answered {missing.status_code}, expected 404")
    else:
        if _error_envelope(documents, missing, "404")["code"] != "not_found":
            failures.append("an unknown route used a code other than 'not_found'")

    wrong_method = service.post("/healthz")
    if wrong_method.status_code != 405:
        failures.append(f"POST /healthz answered {wrong_method.status_code}, expected 405")
    elif _error_envelope(documents, wrong_method, "405")["code"] != "invalid_request":
        failures.append("a wrong method used a code other than 'invalid_request'")

    # A validator that rejected everything would also pass the checks above, so a
    # contract-valid body must get past it — the stub's 500 is fine, a 422 is not.
    valid = next(
        (example for example in read_examples(documents) if example.schema.endswith("RetrieveRequest")),
        None,
    )
    if valid is None:
        failures.append("no marked RetrieveRequest example to prove valid bodies are accepted")
    else:
        accepted = service.post("/v1/context/retrieve", json=valid.instance)
        if accepted.status_code == 422:
            failures.append("a contract-valid RetrieveRequest was rejected with 422")
        elif accepted.status_code >= 400 and accepted.status_code not in declared_statuses(openapi, "retrieveContext"):
            failures.append(f"a stub answered {accepted.status_code}, which retrieveContext does not declare")

    if failures:
        raise CaseFailure(failures)
    return (
        f"{len(operations)} body operations normalized",
        "404 and 405 are envelopes",
        "a contract-valid body gets past the validator",
    )


# ---------------------------------------------------------------------------
# The suite
# ---------------------------------------------------------------------------

CASES: tuple[Case, ...] = (
    Case("C1", "Schema validation", run_c1),
    Case("C2", "Missing ExecutionContext", None, needs_service=True, owner="#36"),
    Case("C3", "Wrong tenant", None, needs_service=True, owner="#36"),
    Case("C4", "Decision idempotent replay", None, needs_service=True, owner="#37"),
    Case("C5", "Idempotency conflict", None, needs_service=True, owner="#36"),
    Case("C6", "Trace propagation", None, needs_service=True, owner="#36"),
    Case("C7", "Record-before-act", None, needs_service=True, owner="#40"),
    Case("C8", "Approval state machine", None, needs_service=True, owner="#40"),
    Case("C9", "Contract handshake", None, needs_service=True, owner="#41"),
    Case("C10", "422 normalization", run_c10, needs_service=True),
    Case("C11", "SSE event envelope", None, needs_service=True, owner="#42"),
    Case("C12", "Cancellation", None, needs_service=True, owner="#42"),
    Case("C13", "Audit append-only", None, needs_service=True, owner="#37"),
    Case("C14", "Provenance returns Decision", None, needs_service=True, owner="#37"),
    Case("C15", "Ready/degraded", None, needs_service=True, owner="#39"),
)


def find(case_id: str) -> Case | None:
    return next((case for case in CASES if case.case_id == case_id), None)
