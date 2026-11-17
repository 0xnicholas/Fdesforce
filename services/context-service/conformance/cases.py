"""C1–C15: the context-service half of `contracts/conformance/cases.md`.

The table in that document is the suite; this module is the runner's
implementation of it. The cases that are real this slice — C1 (contract
examples), C2/C3/C6 (identity, tenant, trace), C5 (idempotency conflict) and C10
(422 normalization) — are run; the rest are declared with the ticket that fills
them. They are *declared*, not omitted: a runner that silently ran six of fifteen
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
import re
import secrets
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import jwt
from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError
from referencing.exceptions import Unresolvable

from conformance.documents import ContractDocuments
from conformance.embedded_examples import embedded_example_failures
from conformance.examples import Example, parse_examples
from conformance.harness import DEPLOYMENT_ID, SOLUTION_ID, ServiceProcess, new_traceparent
from conformance.identity import generate_issuers, mint

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


def body_and_headers(
    service: ServiceProcess,
    documents: ContractDocuments,
    definition: str,
    **authorized: Any,
) -> tuple[dict[str, Any], dict[str, str]]:
    """A contract-valid body plus a token it agrees with.

    The `ExecutionContext` is signed; a body that disagrees with it is refused
    (§5.3), so a case that wants to test something *else* must agree first.
    """
    body = sample_body(documents, definition)
    authorized.setdefault("trace_id", secrets.token_hex(16))
    authorized.setdefault("run_id", body.get("run_id"))
    headers = service.authorized(**authorized)
    claims = decode_claims(headers["authorization"])
    for field in ("tenant_id", "trace_id", "run_id"):
        if field in body:
            body[field] = claims[field]
    if "actor" in body:
        body["actor"] = claims["actor"]
    if "requested_by" in body:
        body["requested_by"] = claims["actor"]
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
        "body identity fields must repeat the token",
        "scope is required per operation",
        "the two issuers cannot reach each other's surface",
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
    if original.status_code in (409, 400):
        failures.append(f"the first write with a fresh key answered {original.status_code}: {original.text[:200]}")

    repeat = service.post("/v1/decisions", json=decision, headers={**retry, "Idempotency-Key": key})
    if repeat.status_code == 409:
        failures.append("the same key with the same payload was refused as a conflict")

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

    # A different key is a different write: the same body is not a conflict.
    other_key = service.post(
        "/v1/decisions",
        json=changed,
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
        "the same key and payload is not a conflict",
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

    # And a matching trace is carried into the response, on every surface the
    # case names — envelope today, success body once the handlers land.
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
        "retrieve, decision and provenance responses carry the caller's trace",
    )


# ---------------------------------------------------------------------------
# The suite
# ---------------------------------------------------------------------------

CASES: tuple[Case, ...] = (
    Case("C1", "Schema validation", run_c1),
    Case("C2", "Missing ExecutionContext", run_c2, needs_service=True),
    Case("C3", "Wrong tenant", run_c3, needs_service=True),
    Case("C4", "Decision idempotent replay", None, needs_service=True, owner="#37"),
    Case("C5", "Idempotency conflict", run_c5, needs_service=True),
    Case("C6", "Trace propagation", run_c6, needs_service=True),
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
