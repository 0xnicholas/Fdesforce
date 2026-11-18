"""C1–C15: the context-service half of `contracts/conformance/cases.md`.

The table in that document is the suite; this module is the runner's
implementation of it. The cases that are real this slice — C1 (contract
examples), C2/C3/C6 (identity, tenant, trace), C4 (Decision replay), C5
(idempotency conflict), C10 (422 normalization), C13 (audit append-only) and C14
(provenance) — are run; the rest are declared with the ticket that fills them.
They are *declared*, not omitted: a runner that silently ran eight of fifteen
cases would report a conformance level nobody has.

The identity cases read what the contract says about an operation (its
`x-fde-issuer` and `x-fde-required-scope`) instead of hard-coding which endpoint
wants which token: a case that assumed the answer could pass while the contract
said something else.

Each case returns the checks it passed so the output says what was proven, not
just "ok".
"""

from __future__ import annotations

import copy
import json
import re
import secrets
import tempfile
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import jwt
from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError
from referencing.exceptions import Unresolvable

from app.clock import isoformat_z, utc_now
from conformance.documents import ContractDocuments
from conformance.embedded_examples import embedded_example_failures
from conformance.examples import Example, parse_examples
from conformance.harness import DEPLOYMENT_ID, RUN_ID, SOLUTION_ID, ServiceProcess, new_traceparent
from conformance.identity import generate_issuers, mint
from conformance.side_effect_tool import SideEffectTool, ToolInvocation

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
    "connector_id": "claims-db",
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
        # Identity and the idempotency key are checked before the body: a 422 is
        # the answer to a *caller the contract admits* sending a bad body.
        headers = operation_headers(service, documents, method, path)
        response = service.request(method, concrete_path(path), json={}, headers=headers)
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
        accepted = service.post(
            "/v1/context/retrieve",
            json=valid.instance,
            headers=operation_headers(service, documents, "post", "/v1/context/retrieve"),
        )
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
# Identity: what the contract says a caller must present
# ---------------------------------------------------------------------------


def openapi_operation(documents: ContractDocuments, method: str, path: str) -> dict[str, Any]:
    """One operation document from `contracts/context-service-v1.openapi.yaml`."""
    return (documents.openapi().get("paths") or {})[path][method.lower()]


def authenticated_operations(documents: ContractDocuments) -> list[tuple[str, str, dict[str, Any]]]:
    """Every operation the contract says needs an `ExecutionContext`."""
    openapi = documents.openapi()
    global_security = openapi.get("security") or []
    found: list[tuple[str, str, dict[str, Any]]] = []
    for path, item in (openapi.get("paths") or {}).items():
        for method in ("get", "post", "put", "patch", "delete"):
            operation = item.get(method)
            if operation is None:
                continue
            if operation.get("security", global_security):
                found.append((method, path, operation))
    return found


def header_parameters(documents: ContractDocuments, operation: Mapping[str, Any]) -> set[str]:
    """The header names one operation requires, resolving the document's own `$ref`s."""
    openapi = documents.openapi()
    names: set[str] = set()
    for parameter in operation.get("parameters") or []:
        resolved = parameter
        if "$ref" in parameter:
            cursor: Any = openapi
            for part in str(parameter["$ref"]).removeprefix("#/").split("/"):
                cursor = cursor[part]
            resolved = cursor
        if resolved.get("in") == "header":
            names.add(str(resolved.get("name")))
    return names


def operation_headers(
    service: ServiceProcess,
    documents: ContractDocuments,
    method: str,
    path: str,
    **authorized: Any,
) -> dict[str, str]:
    """Everything the operation's contract requires from the caller: a token, a key.

    The issuer comes from the operation's own `x-fde-issuer`, so the case cannot
    disagree with the contract about who may call what.
    """
    operation = openapi_operation(documents, method, path)
    issuer = "fde-jobs" if operation.get("x-fde-issuer") == "jobs" else "mastra-app"
    headers = service.authorized(issuer=issuer, **authorized)
    if "Idempotency-Key" in header_parameters(documents, operation):
        headers["Idempotency-Key"] = secrets.token_hex(16)
    return headers


def sample_body(documents: ContractDocuments, definition: str) -> dict[str, Any]:
    """A contract-valid request body, taken from the contract's own marked examples."""
    for example in read_examples(documents):
        if example.schema.endswith(definition):
            return copy.deepcopy(example.instance)
    raise CaseFailure([f"no marked {definition} example in the contract docs"])


def trace_of(response: Any) -> str | None:
    """The trace id a response carries, whether it is a success body or an envelope."""
    try:
        body = response.json()
    except ValueError:
        return None
    if not isinstance(body, dict):
        return None
    if isinstance(body.get("error"), dict):
        return body["error"].get("trace_id")
    return body.get("trace_id")


#: Crockford base32, the alphabet of a `dec_<ULID>` (§4.2).
_ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def new_decision_id() -> str:
    """A fresh caller-owned `decision_id`.

    The docs' `DecisionRequest` example carries one literal id. Two cases that
    wrote that literal with different bodies would be two Decisions under one
    stable id — a conflict the service is right to refuse, and not what the case
    meant to test. Each call mints an id the way the runtime does (§4.2); the
    caller owns it, so the runner must too.
    """
    return "dec_" + "".join(secrets.choice(_ULID_ALPHABET) for _ in range(26))


def body_and_headers(
    service: ServiceProcess,
    documents: ContractDocuments,
    definition: str,
    **authorized: Any,
) -> tuple[dict[str, Any], dict[str, str]]:
    """A contract-valid body plus a token it agrees with.

    The `ExecutionContext` is signed; a body that disagrees with it is refused
    (§5.3), so a case that wants to test something *else* must agree first. A
    `DecisionRequest` gets a fresh `decision_id`, because the id is the write's
    idempotency key and one example id reused across cases is one id with many
    payloads.
    """
    body = sample_body(documents, definition)
    authorized.setdefault("trace_id", secrets.token_hex(16))
    if "run_id" in body:
        authorized.setdefault("run_id", body["run_id"])
    headers = service.authorized(**authorized)
    claims = decode_claims(headers["authorization"])
    for field in ("tenant_id", "trace_id", "run_id"):
        if field in body:
            body[field] = claims[field]
    if "actor" in body:
        body["actor"] = claims["actor"]
    if "requested_by" in body:
        body["requested_by"] = claims["actor"]
    if "decision_id" in body:
        body["decision_id"] = new_decision_id()
    return body, headers


def decode_claims(authorization: str) -> dict[str, Any]:
    return jwt.decode(authorization.removeprefix("Bearer "), options={"verify_signature": False})


# ---------------------------------------------------------------------------
# C2 — an ExecutionContext is required, and only a real one counts
# ---------------------------------------------------------------------------


def run_c2(context: CaseContext) -> tuple[str, ...]:
    service = context.require_service()
    documents = context.documents
    failures: list[str] = []
    openapi = documents.openapi()

    operations = authenticated_operations(documents)
    if not operations:
        failures.append("the contract declares no authenticated operation; C2 would assert nothing")

    for method, path, operation in operations:
        label = f"{operation.get('operationId')} ({method.upper()} {path})"
        trace_id = new_traceparent().split("-")[1]
        headers = {"traceparent": new_traceparent(trace_id)}
        concrete = concrete_path(path)
        response = (
            service.request(method, concrete, json={}, headers=headers)
            if operation.get("requestBody") is not None
            else service.request(method, concrete, headers=headers)
        )
        if response.status_code != 401:
            failures.append(f"{label}: an anonymous request answered {response.status_code}, expected 401")
            continue
        if 401 not in declared_statuses(openapi, str(operation.get("operationId"))):
            failures.append(f"{label}: 401 is not among the operation's declared responses")
        try:
            error = _error_envelope(documents, response, label)
        except CaseFailure as failure:
            failures.extend(failure.failures)
            continue
        if error["code"] != "unauthenticated":
            failures.append(f"{label}: code is {error['code']!r}, expected 'unauthenticated'")
        if error["retryable"] is not False:
            failures.append(f"{label}: an authentication failure must not be retryable")
        if error["trace_id"] != trace_id:
            failures.append(f"{label}: the envelope's trace_id is not the request's trace")

    # A token this deployment did not issue is not an identity, even when it
    # verifies under *some* key and claims the right tenant.
    stranger = generate_issuers(DEPLOYMENT_ID)["mastra-app"]
    forged = mint(
        stranger,
        deployment_id=DEPLOYMENT_ID,
        tenant_id="acme",
        solution_id=SOLUTION_ID,
        trace_id=new_traceparent().split("-")[1],
    )
    response = service.post(
        "/v1/context/retrieve",
        json={},
        headers={"authorization": f"Bearer {forged}", "traceparent": new_traceparent()},
    )
    if response.status_code != 401 or _error_envelope(documents, response, "foreign key")["code"] != "unauthenticated":
        failures.append(f"a token signed by a key this deployment does not hold answered {response.status_code}")

    # `Authorization` is the only credential: no header, no scheme, no token.
    for label, authorization in (
        ("a bare token without a scheme", "not-a-bearer-scheme"),
        ("a non-JWT bearer value", "Bearer not-a-jwt"),
        ("a scheme with no token", "Bearer"),
    ):
        response = service.post(
            "/v1/context/retrieve",
            json={},
            headers={"authorization": authorization, "traceparent": new_traceparent()},
        )
        if response.status_code != 401:
            failures.append(f"{label} answered {response.status_code}, expected 401")

    # The probes and the handshake stay open: proving identity works is not the
    # same claim as "every route is closed".
    for path in ("/healthz", "/readyz", "/v1/runtime-info"):
        if service.get(path).status_code != 200:
            failures.append(f"{path} refused an unauthenticated caller; it declares `security: []`")

    if failures:
        raise CaseFailure(failures)
    return (
        f"{len(operations)} authenticated operations answer 401 without a token",
        "a foreign signing key is not an identity",
        "the probes and runtime-info stay public",
    )


# ---------------------------------------------------------------------------
# C3 — tenant, scope and issuer are enforced from the token, not the request
# ---------------------------------------------------------------------------


def run_c3(context: CaseContext) -> tuple[str, ...]:
    service = context.require_service()
    documents = context.documents
    failures: list[str] = []

    def expect_forbidden(response: Any, label: str, reason: str) -> None:
        if response.status_code != 403:
            failures.append(f"{label}: answered {response.status_code}, expected 403")
            return
        try:
            error = _error_envelope(documents, response, label)
        except CaseFailure as failure:
            failures.extend(failure.failures)
            return
        if error["code"] != "forbidden":
            failures.append(f"{label}: code is {error['code']!r}, expected 'forbidden'")
        if (error.get("details") or {}).get("reason") != reason:
            failures.append(f"{label}: reason is {(error.get('details') or {}).get('reason')!r}, expected {reason!r}")

    # A plaintext identity header is not an identity source: if it disagrees with
    # the token the request is refused, not resolved in the header's favour (§5.3).
    response = service.get("/v1/approvals", headers={**service.authorized(), "X-Tenant-Id": "globex"})
    expect_forbidden(response, "X-Tenant-Id disagreeing with the token", "tenant_header_mismatch")

    response = service.get("/v1/approvals", headers={**service.authorized(), "X-Actor": "someone-else"})
    expect_forbidden(response, "X-Actor disagreeing with the token", "actor_header_mismatch")

    # The body may describe the caller; it may not name a different tenant.
    decision, headers = body_and_headers(service, documents, "DecisionRequest")
    response = service.post(
        "/v1/decisions",
        json={**decision, "tenant_id": "globex"},
        headers={**headers, "Idempotency-Key": secrets.token_hex(16)},
    )
    expect_forbidden(response, "DecisionRequest.tenant_id from another tenant", "body_identity_mismatch")

    decision, headers = body_and_headers(service, documents, "DecisionRequest")
    response = service.post(
        "/v1/decisions",
        json={**decision, "actor": {"type": "user", "id": "someone-else"}},
        headers={**headers, "Idempotency-Key": secrets.token_hex(16)},
    )
    expect_forbidden(response, "DecisionRequest.actor that is not the token's actor", "body_identity_mismatch")

    # The control: the same request with a body that agrees is *not* refused for
    # identity reasons. Without it, "refuses everything" would pass every check.
    decision, headers = body_and_headers(service, documents, "DecisionRequest")
    control = service.post(
        "/v1/decisions",
        json=decision,
        headers={**headers, "Idempotency-Key": secrets.token_hex(16)},
    )
    if control.status_code == 403:
        failures.append(f"a body that agrees with its token was refused: {control.text[:200]}")

    # §3.3: `RetrieveRequest.subject` is a hint about the caller, not a credential.
    subject, headers = body_and_headers(service, documents, "RetrieveRequest")
    someone_else = {**subject, "subject": {"type": "user", "id": "someone-else"}}
    response = service.post("/v1/context/retrieve", json=someone_else, headers=headers)
    expect_forbidden(response, "RetrieveRequest.subject from another caller", "body_identity_mismatch")

    subject, headers = body_and_headers(service, documents, "RetrieveRequest")
    response = service.post("/v1/context/retrieve", json=subject, headers=headers)
    if response.status_code == 403:
        failures.append(f"a retrieval whose subject agrees with its token was refused: {response.text[:200]}")

    # §5.1: a Run-scoped call must name the Run it acts for.
    response = service.post("/v1/context/retrieve", json={}, headers=service.authorized(run_id=None))
    if response.status_code != 401:
        failures.append(f"a Run-scoped call with no run_id in the token answered {response.status_code}, expected 401")

    # Scope: an operation the token's scopes do not cover.
    narrow = service.authorized(scopes=("context:retrieve",))
    response = service.post("/v1/decisions", json={}, headers={**narrow, "Idempotency-Key": secrets.token_hex(16)})
    expect_forbidden(response, "a token without decision:write", "missing_scope")

    # Issuer: the maintenance surface is not reachable with a user-facing token,
    # and the user-facing surface is not reachable with a maintenance token.
    response = service.post("/internal/v1/jobs/ingest", json={}, headers=service.authorized())
    expect_forbidden(response, "a runtime token on the jobs surface", "issuer_not_allowed")

    response = service.post(
        "/v1/context/retrieve",
        json={},
        headers=service.authorized(issuer="fde-jobs"),
    )
    expect_forbidden(response, "a jobs token on the user-facing surface", "issuer_not_allowed")

    if failures:
        raise CaseFailure(failures)
    return (
        "plaintext tenant/actor headers cannot override the token",
        "body identity fields, including RetrieveRequest.subject, must repeat the token",
        "a Run-scoped call needs run_id in the token",
        "scope is required per operation",
        "the two issuers cannot reach each other's surface",
    )


# ---------------------------------------------------------------------------
# C4 — one logical Decision write, one audit entry
# ---------------------------------------------------------------------------

DECISION_RESPONSE = "decision.schema.json#/$defs/DecisionResponse"
PROVENANCE_RESPONSE = "decision.schema.json#/$defs/ProvenanceResponse"

#: Names a provenance document must never contain (C14): how the store keeps the
#: Decision, not what the Decision is. `verification.chain_head` is deliberately
#: not on this list — the contract declares it, and it is the digest of the audit
#: chain, not a backend-internal id.
PROVENANCE_INTERNALS = ("sqlite", "rowid", "prev_hash", "payload_digest", '"seq"')


def _decision_response_failures(documents: ContractDocuments, body: Any, label: str) -> list[str]:
    return [f"{label}: {problem}" for problem in documents.problems(body, DECISION_RESPONSE)]


def run_c4(context: CaseContext) -> tuple[str, ...]:
    service = context.require_service()
    documents = context.documents
    failures: list[str] = []

    trace_id = secrets.token_hex(16)
    decision, headers = body_and_headers(service, documents, "DecisionRequest", trace_id=trace_id)
    key = secrets.token_hex(16)

    first = service.post("/v1/decisions", json=decision, headers={**headers, "Idempotency-Key": key})
    if first.status_code != 201:
        raise CaseFailure([f"the first write answered {first.status_code}, expected 201: {first.text[:300]}"])
    original = first.json()
    failures.extend(_decision_response_failures(documents, original, "the first write"))
    if original.get("decision_id") != decision["decision_id"]:
        failures.append("the response does not name the Decision that was written")
    if original.get("idempotent_replay") is not False:
        failures.append("a first write reported idempotent_replay=true")
    if original.get("trace_id") != trace_id:
        failures.append("the response's trace_id is not the caller's trace")

    replay = service.post(
        "/v1/decisions",
        json=decision,
        headers={
            **service.authorized(trace_id=trace_id, run_id=decision["run_id"]),
            "Idempotency-Key": key,
        },
    )
    if replay.status_code != 200:
        failures.append(f"the same key and payload answered {replay.status_code}, expected the 200 replay")
    else:
        body = replay.json()
        failures.extend(_decision_response_failures(documents, body, "the replay"))
        for field in ("decision_id", "provenance_id", "created_at", "chain_head"):
            if body.get(field) != original.get(field):
                failures.append(f"the replay changed {field}: {body.get(field)!r} != {original.get(field)!r}")
        if body.get("idempotent_replay") is not True:
            failures.append("the replay did not set idempotent_replay=true")

    # `decision_id` is the durable idempotency key (§4.2): a retry with a *new*
    # `Idempotency-Key` is still the same write, or a restart would duplicate it.
    durable = service.post(
        "/v1/decisions",
        json=decision,
        headers={
            **service.authorized(trace_id=trace_id, run_id=decision["run_id"]),
            "Idempotency-Key": secrets.token_hex(16),
        },
    )
    if durable.status_code != 200:
        failures.append(f"a new key for the same decision_id answered {durable.status_code}, expected the 200 replay")
    else:
        body = durable.json()
        failures.extend(_decision_response_failures(documents, body, "the replay under a new key"))
        if body.get("provenance_id") != original.get("provenance_id"):
            failures.append("a new Idempotency-Key appended a second audit entry for one decision_id")
        if body.get("idempotent_replay") is not True:
            failures.append("a replay under a new key did not set idempotent_replay=true")

    if failures:
        raise CaseFailure(failures)
    return (
        "a Decision write is 201 with its decision_id and provenance_id",
        "the same key and payload is the 200 replay, naming the original entry",
        "decision_id is the durable key: a new Idempotency-Key does not append a second entry",
    )


# ---------------------------------------------------------------------------
# C5 — one key, one payload
# ---------------------------------------------------------------------------


def run_c5(context: CaseContext) -> tuple[str, ...]:
    service = context.require_service()
    documents = context.documents
    failures: list[str] = []

    # A retry keeps the trace, not the token: `jti` is single use, so the second
    # request mints a fresh ExecutionContext for the *same* logical write.
    trace_id = secrets.token_hex(16)
    decision, first = body_and_headers(service, documents, "DecisionRequest", trace_id=trace_id)
    retry = service.authorized(trace_id=trace_id, run_id=decision["run_id"])
    key = secrets.token_hex(16)

    original = service.post("/v1/decisions", json=decision, headers={**first, "Idempotency-Key": key})
    if original.status_code != 201:
        failures.append(
            f"the first write with a fresh key answered {original.status_code}, expected 201: {original.text[:200]}"
        )
        first_body: dict[str, Any] = {}
    else:
        first_body = original.json()

    repeat = service.post("/v1/decisions", json=decision, headers={**retry, "Idempotency-Key": key})
    if repeat.status_code == 409:
        failures.append("the same key with the same payload was refused as a conflict")
    elif repeat.status_code != 200:
        # §3.5: the replay answers the operation's 200, with the original ids.
        failures.append(f"the same key and payload answered {repeat.status_code}, expected the 200 replay")
    else:
        replay = repeat.json()
        if replay.get("decision_id") != first_body.get("decision_id"):
            failures.append("the replay named a different decision_id")
        if replay.get("provenance_id") != first_body.get("provenance_id"):
            failures.append("the replay named a different provenance_id")
        if replay.get("idempotent_replay") is not True:
            failures.append("the replay did not set idempotent_replay=true")

    # A retry is the same *trace*: the body's `trace_id` is bound to the token's,
    # so a write cannot be moved onto another call — which is why a replayed body
    # already names the caller's trace (C6 holds for replays too).
    moved = service.post(
        "/v1/decisions",
        json=decision,
        headers={
            **service.authorized(
                trace_id=trace_id, run_id=decision["run_id"], traceparent_trace_id=secrets.token_hex(16)
            ),
            "Idempotency-Key": key,
        },
    )
    if moved.status_code != 403:
        failures.append(f"a retried write moved onto another trace answered {moved.status_code}, expected 403")

    changed = {**decision, "rationale": f"{decision['rationale']} (revised)"}
    conflicting = service.post(
        "/v1/decisions",
        json=changed,
        headers={**service.authorized(trace_id=trace_id, run_id=decision["run_id"]), "Idempotency-Key": key},
    )
    if conflicting.status_code != 409:
        failures.append(f"the same key with a different payload answered {conflicting.status_code}, expected 409")
    else:
        error = _error_envelope(documents, conflicting, "idempotency conflict")
        if error["code"] != "idempotency_conflict":
            failures.append(f"the conflict's code is {error['code']!r}, expected 'idempotency_conflict'")
        if error["retryable"] is not False:
            failures.append("an idempotency conflict must not be retryable")

    # A different key is a different write. A different write also needs its own
    # `decision_id`: the id is the Decision's stable identity, so keeping it while
    # changing the payload is the conflict the previous check just proved.
    other_write = {**changed, "decision_id": new_decision_id()}
    other_key = service.post(
        "/v1/decisions",
        json=other_write,
        headers={
            **service.authorized(trace_id=trace_id, run_id=decision["run_id"]),
            "Idempotency-Key": secrets.token_hex(16),
        },
    )
    if other_key.status_code == 409:
        failures.append("a different Idempotency-Key was treated as a replay of the first")

    # The header is required, not optional: without it there is no replay safety.
    missing = service.post(
        "/v1/decisions",
        json=decision,
        headers=service.authorized(trace_id=trace_id, run_id=decision["run_id"]),
    )
    if missing.status_code != 400:
        failures.append(f"a write with no Idempotency-Key answered {missing.status_code}, expected 400")
    else:
        error = _error_envelope(documents, missing, "no idempotency key")
        if (error.get("details") or {}).get("reason") != "missing_idempotency_key":
            failures.append("a write with no Idempotency-Key did not say why it was refused")

    if failures:
        raise CaseFailure(failures)
    return (
        "the same key and payload is one write, with one outcome",
        "a retry must carry the original trace, so a replay cannot move a Decision",
        "the same key with a different payload is 409 idempotency_conflict",
        "a different key is a different write",
        "a write without a key is 400",
    )


# ---------------------------------------------------------------------------
# C6 — one trace, from header to envelope
# ---------------------------------------------------------------------------


def run_c6(context: CaseContext) -> tuple[str, ...]:
    service = context.require_service()
    documents = context.documents
    failures: list[str] = []
    trace_id = new_traceparent().split("-")[1]

    # The JWT's trace_id must repeat the traceparent: a token minted for one call
    # cannot be moved onto another (§5.1).
    mismatched = service.authorized(trace_id=secrets.token_hex(16), traceparent_trace_id=trace_id)
    response = service.post("/v1/context/retrieve", json={}, headers=mismatched)
    if response.status_code != 403:
        failures.append(
            f"a token whose trace_id is not the traceparent's answered {response.status_code}, expected 403"
        )
    else:
        error = _error_envelope(documents, response, "trace mismatch")
        if (error.get("details") or {}).get("reason") != "trace_mismatch":
            failures.append(f"the trace refusal's reason is {(error.get('details') or {}).get('reason')!r}")

    # The header is required wherever the contract declares it.
    response = service.post(
        "/v1/context/retrieve",
        json={},
        headers={"authorization": service.authorized()["authorization"]},
        omit_traceparent=True,
    )
    if response.status_code != 400:
        failures.append(f"an authenticated request with no traceparent answered {response.status_code}, expected 400")

    # And a matching trace is carried into the response, on every surface the case
    # names. These are error envelopes (the bodies are deliberately invalid), which
    # is the path a failing call takes; C4 and C14 assert the same trace on the
    # success bodies of the decision and provenance operations.
    for method, template, body in (
        ("post", "/v1/context/retrieve", {}),
        ("post", "/v1/decisions", {}),
        ("get", "/v1/provenance/{decision_id}", None),
    ):
        headers = operation_headers(service, documents, method, template, trace_id=trace_id)
        arguments = {"json": body} if body is not None else {}
        response = service.request(method, concrete_path(template), headers=headers, **arguments)
        if trace_of(response) != trace_id:
            failures.append(
                f"{method.upper()} {template}: the response's trace_id is {trace_of(response)!r}, "
                f"not the caller's {trace_id!r}"
            )

    if failures:
        raise CaseFailure(failures)
    return (
        "JWT trace_id must equal the traceparent trace-id",
        "traceparent is required on authenticated operations",
        "retrieve, decision and provenance responses carry the caller's trace "
        "(error envelopes here; C4/C14 read the success bodies)",
    )


# ---------------------------------------------------------------------------
# C13 — the audit trail survives the process
# ---------------------------------------------------------------------------

#: How long a restarted process gets to record its first `verify_chain` pass.
RESTART_VERIFY_TIMEOUT_SECONDS = 20.0


def _verified_after_restart(
    service: ServiceProcess, decision_id: str, *, not_before: datetime
) -> tuple[dict[str, Any] | None, str]:
    """Poll provenance until a pass *this process* ran has verified the inherited chain.

    `not_before` is when the restart began. The verification record is in the same
    SQLite file, so a `valid` carrying an older `checked_at` is the previous
    process's pass and proves nothing about the restart.
    """
    deadline = time.monotonic() + RESTART_VERIFY_TIMEOUT_SECONDS
    last = "no response"
    while time.monotonic() < deadline:
        response = service.get(f"/v1/provenance/{decision_id}", headers=service.authorized())
        last = f"{response.status_code}: {response.text[:200]}"
        if response.status_code == 200:
            body = response.json()
            if body["verification"]["status"] == "valid":
                raw = body["verification"].get("checked_at")
                if raw and datetime.fromisoformat(raw.replace("Z", "+00:00")) > not_before:
                    return body, last
        time.sleep(0.1)
    return None, last


def run_c13(context: CaseContext) -> tuple[str, ...]:
    """Replaying a write never appends a second entry, and a restart verifies what it inherits.

    This case owns its process: the proof is a restart on the same audit volume,
    which the shared conformance service must survive for the other cases.
    """
    documents = context.documents
    failures: list[str] = []

    with ServiceProcess.start() as first:
        decision, headers = body_and_headers(first, documents, "DecisionRequest")
        original_response = first.post(
            "/v1/decisions", json=decision, headers={**headers, "Idempotency-Key": secrets.token_hex(16)}
        )
        if original_response.status_code != 201:
            raise CaseFailure(
                [
                    f"the first write answered {original_response.status_code}, expected 201: "
                    f"{original_response.text[:300]}"
                ]
            )
        original = original_response.json()

        replay = first.post(
            "/v1/decisions",
            json=decision,
            headers={
                **first.authorized(trace_id=headers["traceparent"].split("-")[1], run_id=decision["run_id"]),
                "Idempotency-Key": secrets.token_hex(16),
            },
        )
        if replay.status_code != 200:
            failures.append(f"the replayed write answered {replay.status_code}, expected 200")
        else:
            replayed = replay.json()
            if replayed.get("provenance_id") != original.get("provenance_id"):
                failures.append("the replay created a second audit entry (a new provenance_id)")
            if replayed.get("chain_head") != original.get("chain_head"):
                failures.append("the replay moved the chain head; a replay must not append")
        data_dir = first.data_dir

    # The verification record lives in the same SQLite file, so a `valid` read
    # could be the *pre-restart* pass. A fresh pass must have stamped `checked_at`
    # after this point, or the case would prove nothing about the restart.
    restart_started = datetime.now(UTC)
    with ServiceProcess.start(data_dir=data_dir) as restarted:
        body, last = _verified_after_restart(restarted, decision["decision_id"], not_before=restart_started)
        if body is None:
            failures.append(f"the restarted service never verified the inherited chain (last: {last})")
        else:
            if body.get("provenance_id") != original.get("provenance_id"):
                failures.append("the restarted service read a different audit entry")
            if body.get("decision") != decision:
                failures.append("the restarted service returned a different Decision")
            if body["verification"].get("chain_head") != original.get("chain_head"):
                failures.append("the verified chain head is not the head the write produced")
            checked_at_raw = body["verification"].get("checked_at")
            if not checked_at_raw:
                failures.append("the verification carries no checked_at, so the restart cannot be dated")
            else:
                checked_at = datetime.fromisoformat(checked_at_raw.replace("Z", "+00:00"))
                if checked_at <= restart_started:
                    failures.append(
                        "the restarted service reported the pre-restart verification, not a pass of its own"
                    )

    if failures:
        raise CaseFailure(failures)
    return (
        "a replayed Decision write appends no second audit entry",
        "the chain on the audit volume verifies after a restart",
        "the verified head is the head the original write produced",
    )


# ---------------------------------------------------------------------------
# C14 — provenance returns the Decision, and only stable ids
# ---------------------------------------------------------------------------


def run_c14(context: CaseContext) -> tuple[str, ...]:
    service = context.require_service()
    documents = context.documents
    failures: list[str] = []

    decision, headers = body_and_headers(service, documents, "DecisionRequest")
    write = service.post("/v1/decisions", json=decision, headers={**headers, "Idempotency-Key": secrets.token_hex(16)})
    if write.status_code != 201:
        raise CaseFailure([f"the write answered {write.status_code}, expected 201: {write.text[:300]}"])
    recorded = write.json()

    read_trace = secrets.token_hex(16)
    response = service.get(
        f"/v1/provenance/{decision['decision_id']}", headers=service.authorized(trace_id=read_trace)
    )
    if response.status_code != 200:
        raise CaseFailure([f"provenance answered {response.status_code}, expected 200: {response.text[:300]}"])
    body = response.json()
    failures.extend(
        f"the provenance document: {problem}" for problem in documents.problems(body, PROVENANCE_RESPONSE)
    )
    if body.get("decision_id") != decision["decision_id"]:
        failures.append("the document names a different Decision")
    if body.get("provenance_id") != recorded.get("provenance_id"):
        failures.append("the document names a provenance_id the write did not return")
    if body.get("decision") != decision:
        failures.append("the document does not return the original Decision")
    if body.get("trace_id") != read_trace:
        failures.append("the document's trace_id is not the reader's trace (C6)")

    relationships = {(link.get("type"), link.get("relationship")) for link in body.get("lineage") or []}
    for expected in (("run", "wasGeneratedBy"), ("actor", "wasAttributedTo")):
        if expected not in relationships:
            failures.append(f"the lineage does not carry {expected[0]} {expected[1]}")
    if "@context" not in (body.get("prov_o") or {}):
        failures.append("prov_o is not a JSON-LD document")

    serialized = json.dumps(body)
    for internal in PROVENANCE_INTERNALS:
        if internal in serialized:
            failures.append(f"the provenance document leaks the backend-internal name {internal!r} (C14)")

    unknown = service.get(f"/v1/provenance/{new_decision_id()}", headers=service.authorized())
    if unknown.status_code != 404:
        failures.append(f"an unknown decision_id answered {unknown.status_code}, expected 404")

    if failures:
        raise CaseFailure(failures)
    return (
        "the document returns the original Decision and the write's provenance_id",
        "the lineage names the Run and the actor in PROV-O terms",
        "the answer carries stable ids only, never a backend-internal one",
        "an unknown Decision is a 404",
    )


# ---------------------------------------------------------------------------
# C15 — ready/degraded: ingest does not block readiness, and a partial answer says so
# ---------------------------------------------------------------------------

#: The scopes a retrieval of the Acme claim needs: the platform scope for the operation
#: and the baseline's class scope for `ic:Claim` (`permissions.yaml`).
C15_SCOPES = ("context:retrieve", "claims:read")


def run_c15(context: CaseContext) -> tuple[str, ...]:
    """`/readyz` is degraded while ingest is incomplete, and `retrieve` says `partial`.

    §9.2's sequence is what is tested: the service starts on a migrated but unmaterialized
    volume, the ingest job runs, and readiness turns green — the process never stops
    serving in between, it reports. The case owns its process because the transition is the
    assertion, and a shared one would already be on the far side of it.
    """
    documents = context.documents
    failures: list[str] = []

    with ServiceProcess.start() as service:
        before = service.get("/readyz")
        if before.status_code != 200:
            failures.append(f"/readyz answered {before.status_code} before ingest, expected 200 (degraded)")
        elif before.json()["status"] != "degraded":
            failures.append(f"/readyz said {before.json()['status']!r} before ingest, expected 'degraded'")
        elif not any(reason.startswith("ingest:") for reason in before.json()["reasons"]):
            failures.append(f"/readyz gave no ingest reason before it ran: {before.json()['reasons']}")

        retrieve_body = {
            "recipe_id": "claims-context",
            "query": "claim C-1001",
            "filters": {"claim_id": "C-1001"},
        }
        unready = service.post(
            "/v1/context/retrieve",
            json=retrieve_body,
            headers=service.authorized(scopes=C15_SCOPES),
        )
        if unready.status_code != 200:
            failures.append(f"retrieve answered {unready.status_code} before ingest: {unready.text[:200]}")
        else:
            body = unready.json()
            failures.extend(
                f"the pre-ingest response: {problem}"
                for problem in documents.problems(body, "retrieval.schema.json#/$defs/RetrieveResponse")
            )
            if body.get("degraded") is not True:
                failures.append("retrieve answered as complete before the package was materialized")
            if body.get("reason") != "partial":
                failures.append(
                    f"retrieve's reason was {body.get('reason')!r}, expected 'partial' "
                    "(the graph is not the source's current state yet)"
                )

        job = service.ingest()
        if job.status_code != 200:
            failures.append(f"the ingest job answered {job.status_code}: {job.text[:300]}")
        else:
            failures.extend(
                f"the ingest job: {problem}"
                for problem in documents.problems(job.json(), "ingest-job.schema.json#/$defs/IngestJobResult")
            )
            if job.json().get("status") != "succeeded":
                failures.append(f"the ingest job finished {job.json().get('status')!r}: {job.json().get('message')}")

        after = service.get("/readyz")
        if after.status_code != 200 or after.json()["status"] != "ready":
            failures.append(f"/readyz after ingest: {after.status_code} {after.text[:200]}")

        ready = service.post(
            "/v1/context/retrieve",
            json=retrieve_body,
            headers=service.authorized(scopes=C15_SCOPES),
        )
        if ready.status_code != 200:
            failures.append(f"retrieve answered {ready.status_code} after ingest: {ready.text[:200]}")
        else:
            body = ready.json()
            if body.get("degraded") is not False:
                failures.append(f"retrieve still reports {body.get('reason')!r} after a complete ingest")
            if not body.get("items"):
                failures.append("the materialized package answered the golden question with no items")

    if failures:
        raise CaseFailure(failures)
    return (
        "/readyz is degraded (not not_ready) while ingest is incomplete",
        "retrieve answers degraded=true, reason=partial before the package is materialized",
        "after the job: /readyz ready, and the retrieval cites the package's facts",
    )



# ---------------------------------------------------------------------------
# C7 — record-before-act: a refused intent blocks the side-effect Tool
# ---------------------------------------------------------------------------

APPROVAL = "approval.schema.json#/$defs/Approval"
APPROVAL_LIST = "approval.schema.json#/$defs/ApprovalList"
APPROVAL_DECISION_RESPONSE = "approval.schema.json#/$defs/ApprovalDecisionResponse"
PROVENANCE_RESPONSE = "decision.schema.json#/$defs/ProvenanceResponse"
PROPOSED_ACTION = {
    "tool": "claim-decision",
    "operation": "recordDecision",
    "input_digest": "sha256:" + "c" * 64,
    "summary": "Mark claim C-1001 as approved.",
}
APPROVER_ROLE = "claims-supervisor"
APPROVER = {"type": "user", "id": "u-supervisor"}


def _intent_writer(service: ServiceProcess, invocation: ToolInvocation):
    """The Tool's one write: `POST /v1/decisions` as the same trace and actor.

    C6 binds the body to the token, so the identity that writes the intent is the
    one the intent names — a Tool cannot record its act under another's identity.
    """

    def write(decision: Mapping[str, Any], key: str) -> tuple[int, str]:
        headers = service.authorized(
            actor=dict(invocation.actor), trace_id=invocation.trace_id, run_id=invocation.run_id
        )
        response = service.post("/v1/decisions", json=dict(decision), headers={**headers, "Idempotency-Key": key})
        return response.status_code, response.text

    return write


def run_c7(context: CaseContext) -> tuple[str, ...]:
    """C7: the intent Decision comes first; if it cannot be written, nothing happens.

    The Tool is the fixture in `conformance.side_effect_tool` (a synthetic
    capability, not the Acme reference path): it writes its intent through the real
    audit endpoint and only acts on a 2xx. The case proves the gate both ways —
    refused writes block the effect, a recorded one lets it run — so a wrapper that
    always refused could not pass it.
    """
    service = context.require_service()
    documents = context.documents
    failures: list[str] = []
    tool = SideEffectTool(Path(tempfile.mkdtemp(prefix="fde-c7-effects-")) / "effects.jsonl")

    def invocation() -> ToolInvocation:
        trace_id = secrets.token_hex(16)
        claims = decode_claims(service.authorized(trace_id=trace_id, run_id=RUN_ID)["authorization"])
        return ToolInvocation.fresh(
            tenant_id=claims["tenant_id"], run_id=claims["run_id"], actor=claims["actor"], trace_id=trace_id
        )

    # (a) The audit store refuses the intent: an id it already holds for another
    # payload. This is the store's own 409, not a simulated failure.
    blocked = invocation()
    poisoned, poisoned_headers = body_and_headers(service, documents, "DecisionRequest", run_id=blocked.run_id)
    poisoned["decision_id"] = blocked.decision_id
    written = service.post(
        "/v1/decisions", json=poisoned, headers={**poisoned_headers, "Idempotency-Key": secrets.token_hex(16)}
    )
    if written.status_code != 201:
        failures.append(
            f"the case could not claim the Tool's decision_id: {written.status_code} {written.text[:200]}"
        )
    refused = tool.invoke(blocked, write_intent=_intent_writer(service, blocked))
    if refused.executed:
        failures.append("a Tool ran although its intent Decision was refused (record-before-act is not enforced)")
    if refused.intent_status != 409:
        failures.append(f"the refused intent answered {refused.intent_status}, expected the store's 409")
    if tool.observed():
        failures.append("the customer system was written to although no intent was recorded")

    # (b) The store is unreachable. A wrapper that only checked for non-2xx answers
    # would act here; the gate has to treat a transport failure as "not recorded".
    unreachable = invocation()

    def down(decision: Mapping[str, Any], key: str) -> tuple[int, str]:
        raise ConnectionError("connection refused: the audit store is not answering")

    offline = tool.invoke(unreachable, write_intent=down)
    if offline.executed:
        failures.append("a Tool ran while it could not reach the audit store; the gate is not fail-closed")
    if tool.observed():
        failures.append("the customer system was written to while the intent write never left the process")

    # (c) The control: an intent that is recorded lets the effect run, exactly once.
    allowed = invocation()
    recorded = tool.invoke(allowed, write_intent=_intent_writer(service, allowed))
    if not recorded.executed:
        failures.append(f"a recorded intent did not let the Tool run: {recorded.intent_error}")
    effects = tool.observed()
    if len(effects) != 1:
        failures.append(f"the Tool ran {len(effects)} times for one invocation, expected exactly once")
    provenance = service.get(f"/v1/provenance/{allowed.decision_id}", headers=service.authorized())
    if provenance.status_code != 200:
        failures.append(f"the intent Decision is not readable: {provenance.status_code} {provenance.text[:200]}")
    else:
        failures.extend(
            f"the intent Decision: {problem}"
            for problem in documents.problems(provenance.json(), PROVENANCE_RESPONSE)
        )
        decision = provenance.json()["decision"]
        if decision.get("phase") != "intent" or decision.get("status") != "proposed":
            failures.append(
                f"the recorded Decision is {decision.get('phase')}/{decision.get('status')}, not intent/proposed"
            )
        if decision.get("invocation_id") != allowed.invocation_id:
            failures.append("the intent Decision does not name the invocation it was written for")

    if failures:
        raise CaseFailure(failures)
    return (
        "a conflicting intent write (409) blocked the side effect, no effect observed",
        "an unreachable audit store blocked it too; the gate is fail-closed",
        "a recorded intent (201) let the one effect run, with its intent Decision readable",
    )


# ---------------------------------------------------------------------------
# C8 — the approval state machine
# ---------------------------------------------------------------------------


def _approval_body(*, run_id: str, expires_at: str) -> dict[str, Any]:
    return {
        "run_id": run_id,
        "capability_id": "document-triage",
        "proposed_action": dict(PROPOSED_ACTION),
        "approver_roles": [APPROVER_ROLE],
        "expires_at": expires_at,
        "evidence": [{"type": "graph_entity", "entity_id": "fde:acme:Claim:C-1001"}],
    }


def _approval_decision_body(*, actor: Mapping[str, str], approved: bool = True) -> dict[str, Any]:
    return {
        "approved": approved,
        "rationale": "The claim matches the approval threshold.",
        "actor": dict(actor),
    }


def _timestamp_in(seconds: int) -> str:
    """An RFC 3339 timestamp `seconds` from now (negative for the past)."""
    return isoformat_z(utc_now() + timedelta(seconds=seconds))


def run_c8(context: CaseContext) -> tuple[str, ...]:
    """C8: pending → approved → consumed, rejection, expiry, self-approval, replay.

    Every call mints its own token (a `jti` is single use), and each refusal is
    read as the contract's envelope: a self-approval is a `403`, a second decision
    under a new key is `409 approval_already_decided`, and a consume repeat is the
    consumed resource rather than an error.
    """
    service = context.require_service()
    documents = context.documents
    failures: list[str] = []

    def create_approval(*, expires_in_seconds: int = 3600) -> dict[str, Any] | None:
        run_id = RUN_ID
        body = _approval_body(run_id=run_id, expires_at=_timestamp_in(expires_in_seconds))
        claims = decode_claims(service.authorized(run_id=run_id)["authorization"])
        body["requested_by"] = claims["actor"]
        response = service.post(
            "/v1/approvals",
            json=body,
            headers={
                **service.authorized(trace_id=secrets.token_hex(16), run_id=run_id),
                "Idempotency-Key": secrets.token_hex(16),
            },
        )
        if response.status_code != 201:
            failures.append(f"create approval answered {response.status_code}: {response.text[:300]}")
            return None
        document = response.json()
        failures.extend(f"the created approval: {problem}" for problem in documents.problems(document, APPROVAL))
        if document.get("status") != "pending":
            failures.append(f"a created approval is {document.get('status')!r}, expected 'pending'")
        return document

    def decide(approval_id: str, *, actor: Mapping[str, str], roles: Sequence[str], approved: bool = True) -> Any:
        return service.post(
            f"/v1/approvals/{approval_id}/decisions",
            json=_approval_decision_body(actor=actor, approved=approved),
            headers={
                **service.authorized(actor=dict(actor), roles=roles, run_id=RUN_ID),
                "Idempotency-Key": secrets.token_hex(16),
            },
        )

    def consume(approval_id: str) -> Any:
        return service.post(
            f"/v1/approvals/{approval_id}/consume",
            headers={
                **service.authorized(actor=dict(APPROVER), roles=(APPROVER_ROLE,), run_id=RUN_ID),
                "Idempotency-Key": secrets.token_hex(16),
            },
        )

    # pending → approved → consumed
    approval = create_approval()
    if approval is None:
        raise CaseFailure(failures)
    approval_id = approval["approval_id"]
    requester = decode_claims(service.authorized(run_id=RUN_ID)["authorization"])["actor"]

    queue = service.get(
        "/v1/approvals",
        params={"run_id": RUN_ID, "status": "pending"},
        headers=service.authorized(run_id=None),
    )
    if queue.status_code != 200:
        failures.append(f"the approval queue answered {queue.status_code}: {queue.text[:200]}")
    else:
        failures.extend(f"the queue page: {problem}" for problem in documents.problems(queue.json(), APPROVAL_LIST))
        if approval_id not in [item["approval_id"] for item in queue.json()["items"]]:
            failures.append("a pending approval is missing from the pending queue")

    # Self-approval: the requester's own token decides nothing (§8.3 default deny).
    self_decided = decide(approval_id, actor=requester, roles=(APPROVER_ROLE,))
    if self_decided.status_code != 403:
        failures.append(f"a self-approval answered {self_decided.status_code}, expected 403")
    else:
        error = _error_envelope(documents, self_decided, "the self-approval")
        if error["details"].get("reason") != "self_approval_denied":
            failures.append(f"a self-approval was refused with {error['details'].get('reason')!r}")

    # Not a declared approver: the role the request names is the one that decides.
    wrong_role = decide(approval_id, actor=APPROVER, roles=("auditor",))
    if wrong_role.status_code != 403:
        failures.append(f"an approver without the declared role answered {wrong_role.status_code}, expected 403")

    # The one decision this approval gets, under the key its retry will reuse.
    decide_key = secrets.token_hex(16)
    decide_payload = _approval_decision_body(actor=APPROVER)

    def decide_with_key(key: str) -> Any:
        return service.post(
            f"/v1/approvals/{approval_id}/decisions",
            json=decide_payload,
            headers={
                **service.authorized(actor=dict(APPROVER), roles=(APPROVER_ROLE,), run_id=RUN_ID),
                "Idempotency-Key": key,
            },
        )

    approved = decide_with_key(decide_key)
    if approved.status_code != 200:
        failures.append(f"an approval answered {approved.status_code}: {approved.text[:300]}")
    else:
        decision = approved.json()
        failures.extend(
            f"the approval decision: {problem}" for problem in documents.problems(decision, APPROVAL_DECISION_RESPONSE)
        )
        if decision.get("status") != "approved":
            failures.append(f"the approval decision says {decision.get('status')!r}, expected 'approved'")
        provenance = service.get(f"/v1/provenance/{decision['decision_id']}", headers=service.authorized())
        if provenance.status_code != 200:
            failures.append(f"the approval Decision is not readable: {provenance.status_code}")
        else:
            failures.extend(
                f"the approval Decision: {problem}"
                for problem in documents.problems(provenance.json(), PROVENANCE_RESPONSE)
            )
            recorded = provenance.json()["decision"]
            if recorded.get("phase") != "approval" or recorded.get("status") != "succeeded":
                failures.append(
                    f"the approval Decision is {recorded.get('phase')}/{recorded.get('status')}, not approval/succeeded"
                )
            if recorded.get("rationale") != _approval_decision_body(actor=APPROVER)["rationale"]:
                failures.append("the approval Decision does not keep the approver's rationale")

    # Idempotent decide: the same key and payload answers with the same decision.
    replay = decide_with_key(decide_key)
    if replay.status_code != 200:
        failures.append(f"a decide replay answered {replay.status_code}: {replay.text[:200]}")
    elif approved.status_code == 200 and replay.json()["decision_id"] != approved.json()["decision_id"]:
        failures.append("a decide replay named a different decision_id")
    # A different key after the decision is a conflict, not a second decision.
    again = decide(approval_id, actor=APPROVER, roles=(APPROVER_ROLE,), approved=False)
    if again.status_code != 409:
        failures.append(f"a second decision answered {again.status_code}, expected 409")
    elif _error_envelope(documents, again, "the second decision")["code"] != "approval_already_decided":
        failures.append("a second decision did not answer 'approval_already_decided'")

    # consume twice: the same consumed resource, no second decision.
    consumed = consume(approval_id)
    repeat = consume(approval_id)
    for label, response in (("the consume", consumed), ("the consumed repeat", repeat)):
        if response.status_code != 200:
            failures.append(f"{label} answered {response.status_code}: {response.text[:200]}")
            continue
        failures.extend(f"{label}: {problem}" for problem in documents.problems(response.json(), APPROVAL))
        if response.json().get("status") != "consumed":
            failures.append(f"{label} says {response.json().get('status')!r}, expected 'consumed'")

    # Rejection: denied, never consumable, and the Decision keeps the reason.
    rejected_approval = create_approval()
    if rejected_approval is not None:
        rejected = decide(rejected_approval["approval_id"], actor=APPROVER, roles=(APPROVER_ROLE,), approved=False)
        if rejected.status_code != 200:
            failures.append(f"a rejection answered {rejected.status_code}: {rejected.text[:200]}")
        else:
            if rejected.json().get("status") != "rejected":
                failures.append("a rejection did not answer status='rejected'")
            provenance = service.get(f"/v1/provenance/{rejected.json()['decision_id']}", headers=service.authorized())
            if provenance.status_code != 200 or provenance.json()["decision"].get("status") != "denied":
                failures.append("a rejection's Decision is not recorded as 'denied'")
        not_consumable = consume(rejected_approval["approval_id"])
        if not_consumable.status_code != 409:
            failures.append(f"consuming a rejected approval answered {not_consumable.status_code}, expected 409")

    # Expiry: past the deadline the approval is expired, and no decision lands.
    expiring = create_approval(expires_in_seconds=1)
    if expiring is not None:
        time.sleep(1.3)
        late = decide(expiring["approval_id"], actor=APPROVER, roles=(APPROVER_ROLE,))
        if late.status_code != 409:
            failures.append(f"a decision after the deadline answered {late.status_code}, expected 409")
        else:
            error = _error_envelope(documents, late, "the late decision")
            if (error["details"] or {}).get("status") != "expired":
                failures.append("a decision after the deadline was not refused as 'expired'")
        expired = service.get(
            "/v1/approvals",
            params={"run_id": RUN_ID, "status": "expired"},
            headers=service.authorized(run_id=None),
        )
        if expired.status_code != 200 or expiring["approval_id"] not in [
            item["approval_id"] for item in expired.json()["items"]
        ]:
            failures.append("an overdue approval is not in the expired queue")

    if failures:
        raise CaseFailure(failures)
    return (
        "a pending approval is in the queue, and a self-approval is refused with 403",
        "an undeclared role is refused; the declared approver decides and the Decision is readable",
        "a decide replay names the same decision; a second decision is 409 approval_already_decided",
        "consume is idempotent and marks the approval consumed",
        "a rejection is a denied Decision and cannot be consumed",
        "an overdue approval expires and refuses the late decision",
    )


# ---------------------------------------------------------------------------
# The suite
# ---------------------------------------------------------------------------

CASES: tuple[Case, ...] = (
    Case("C1", "Schema validation", run_c1),
    Case("C2", "Missing ExecutionContext", run_c2, needs_service=True),
    Case("C3", "Wrong tenant", run_c3, needs_service=True),
    Case("C4", "Decision idempotent replay", run_c4, needs_service=True),
    Case("C5", "Idempotency conflict", run_c5, needs_service=True),
    Case("C6", "Trace propagation", run_c6, needs_service=True),
    Case("C7", "Record-before-act", run_c7, needs_service=True),
    Case("C8", "Approval state machine", run_c8, needs_service=True),
    Case("C9", "Contract handshake", None, needs_service=True, owner="#41"),
    Case("C10", "422 normalization", run_c10, needs_service=True),
    Case("C11", "SSE event envelope", None, needs_service=True, owner="#42"),
    Case("C12", "Cancellation", None, needs_service=True, owner="#42"),
    Case("C13", "Audit append-only", run_c13),
    Case("C14", "Provenance returns Decision", run_c14, needs_service=True),
    Case("C15", "Ready/degraded", run_c15),
)


def find(case_id: str) -> Case | None:
    return next((case for case in CASES if case.case_id == case_id), None)
