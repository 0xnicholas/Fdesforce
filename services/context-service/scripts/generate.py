#!/usr/bin/env python3
"""Generate the context-service's Python view of `contracts/` (`#35`).

`contracts/` is the single source of truth for the wire surface. This script is
the only producer of `app/generated/`; nothing under that directory may be
hand-edited, and `--check` fails CI when the committed output no longer matches.

It emits five modules:

| Module | What it is | Why it is generated |
| --- | --- | --- |
| `models.py` | Pydantic models for the OpenAPI schema closure | a wire type has one written source |
| `schemas.py` | the JSON Schema documents the runtime validates against | a bundle cannot read `contracts/` |
| `api.py` | method, path, auth, request/response schema per operation | every reader shares one table |
| `versions.py` | contract minor, service version, graph/audit schema | runtime-info reports the pins |

Deterministic by construction: files are visited in sorted order, document order
is preserved inside a file, and output depends on nothing else — no clock, no
environment, no network.

The schema *closure* is every schema file the context-service OpenAPI references,
followed transitively. Schemas outside it (Bundle Topology, the public Run API)
belong to other components; modelling them here would be a second copy of a
surface this service never serves.

Pydantic is the *shape*; JSON Schema is the *validator*. Constraints Pydantic
cannot express — `propertyNames`, conditional `if/then`, `uniqueItems` — are
enforced by the schema validator at the request seam (`app.contract`), so the
generated models do not try to reproduce them and silently weaken them.

Usage:
  python scripts/generate.py          # write app/generated/**
  python scripts/generate.py --check  # exit 1 when the committed output is stale
"""

from __future__ import annotations

import argparse
import json
import keyword
import pprint
import re
import sys
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVICE_ROOT.parents[1]
CONTRACTS_DIR = REPO_ROOT / "contracts"
SCHEMAS_DIR = CONTRACTS_DIR / "schemas"
OUT_DIR = SERVICE_ROOT / "app" / "generated"
OPENAPI_FILE = CONTRACTS_DIR / "context-service-v1.openapi.yaml"
TOOLCHAIN_FILE = REPO_ROOT / "platform" / "toolchain.yaml"
CONTRACTS_README = CONTRACTS_DIR / "README.md"

BANNER = """\
# GENERATED from {source} — do not edit.
# Regenerate with `python scripts/generate.py`; CI runs `python scripts/generate.py --check`.
"""

METHODS = ("get", "post", "put", "patch", "delete")

#: Schemas the OpenAPI document cannot `$ref` because they describe *how* it is
#: authenticated rather than what it returns: the bearer token itself. The
#: service verifies `ExecutionContext`s (#36), so it needs the model.
EXTRA_SCHEMA_FILES = ("execution-context.schema.json",)


class GenerationError(RuntimeError):
    """The contract uses a construct this generator cannot represent."""


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def read_schemas() -> dict[str, dict[str, Any]]:
    return {
        path.name: json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(SCHEMAS_DIR.glob("*.schema.json"))
    }


def schema_closure(openapi_text: str, schemas: Mapping[str, dict[str, Any]]) -> list[str]:
    """Every schema file reachable from the OpenAPI document, in sorted order."""
    pending = re.findall(r"\./schemas/([a-z0-9-]+\.schema\.json)", openapi_text)
    pending.extend(EXTRA_SCHEMA_FILES)
    seen: set[str] = set()
    while pending:
        name = pending.pop()
        if name in seen:
            continue
        if name not in schemas:
            raise GenerationError(f"{OPENAPI_FILE.name} references missing contracts/schemas/{name}")
        seen.add(name)
        pending.extend(re.findall(r"\"\./([a-z0-9-]+\.schema\.json)", json.dumps(schemas[name])))
    return sorted(seen)


# ---------------------------------------------------------------------------
# Naming and type mapping
# ---------------------------------------------------------------------------


def pascal(value: str) -> str:
    parts = re.split(r"[^A-Za-z0-9]+", value)
    return "".join(part[:1].upper() + part[1:] for part in parts if part)


def literal(value: Any) -> str:
    """A deterministic Python literal (single quotes, stable key order)."""
    if isinstance(value, dict):
        return pprint.pformat(value, width=120, sort_dicts=False)
    if isinstance(value, tuple):
        return "(" + ", ".join(literal(item) for item in value) + ("," if len(value) == 1 else "") + ")"
    return repr(value)


@dataclass(frozen=True)
class ResolvedRef:
    file: str
    name: str


def resolve_ref(ref: str, current_file: str) -> ResolvedRef:
    """`#/$defs/X` or `./common.schema.json#/$defs/X`."""
    target, _, pointer = ref.partition("#")
    file = current_file if target == "" else target.removeprefix("./")
    match = re.fullmatch(r"/\$defs/([A-Za-z0-9_]+)", pointer)
    if match is None:
        raise GenerationError(
            f"unsupported $ref {ref!r}: only #/$defs/* is generated (whole-file and JSON-pointer refs need a name)"
        )
    return ResolvedRef(file=file, name=match.group(1))


class TypeNames:
    """`$defs` name → Python class name, refusing silent cross-file collisions."""

    def __init__(self, schemas: Mapping[str, dict[str, Any]], files: Sequence[str]) -> None:
        self._files = set(files)
        by_name: dict[str, list[tuple[str, dict[str, Any]]]] = {}
        for file in files:
            for name, schema in (schemas[file].get("$defs") or {}).items():
                by_name.setdefault(name, []).append((file, schema))
        for name, entries in by_name.items():
            if len(entries) > 1 and len({json.dumps(schema, sort_keys=True) for _, schema in entries}) > 1:
                files_with = ", ".join(file for file, _ in entries)
                raise GenerationError(
                    f"the name {name!r} is defined differently in {files_with}; rename one of them in contracts/ — "
                    "the generator will not guess which type a $ref means"
                )
        self._inline: dict[str, dict[str, Any]] = {}
        self._pending: list[tuple[str, dict[str, Any]]] = []

    def def_name(self, resolved: ResolvedRef) -> str:
        if resolved.file not in self._files:
            raise GenerationError(
                f"{resolved.file} is outside the context-service schema closure; "
                "the service cannot model a schema its OpenAPI document never references"
            )
        return resolved.name

    def inline_name(self, parent: str, parts: Iterable[str], schema: dict[str, Any]) -> str:
        name = parent + "".join(pascal(part) for part in parts)
        if not name.isidentifier() or keyword.iskeyword(name):
            raise GenerationError(f"{parent}: derived class name {name!r} is not a Python identifier")
        existing = self._inline.get(name)
        if existing is not None:
            if json.dumps(existing, sort_keys=True) != json.dumps(schema, sort_keys=True):
                raise GenerationError(f"two different inline schemas derive the name {name!r}; rename a property")
            return name
        self._inline[name] = schema
        self._pending.append((name, schema))
        return name

    def drain_pending(self) -> list[tuple[str, dict[str, Any]]]:
        drained: list[tuple[str, dict[str, Any]]] = []
        while self._pending:
            drained.extend(self._pending)
            self._pending = []
        return drained


class Models:
    """Emit Pydantic models for one schema closure."""

    def __init__(self, schemas: Mapping[str, dict[str, Any]], files: Sequence[str], names: TypeNames) -> None:
        self._schemas = schemas
        self._files = files
        self._names = names
        self._blocks: list[str] = []
        self._rebuilt: list[str] = []
        self._typing: set[str] = set()
        self._pydantic: set[str] = set()
        self._wire: set[str] = set()

    # -- types ------------------------------------------------------------

    def type_of(self, schema: Any, current_file: str, owner: str, path: tuple[str, ...] = ()) -> str:
        if schema is True or schema == {}:
            self._typing.add("Any")
            return "Any"
        if schema is False:
            raise GenerationError(f"{current_file}: a `false` schema has no Python type")
        if not isinstance(schema, dict):
            raise GenerationError(f"{current_file}: a schema must be an object or boolean")

        if "$ref" in schema:
            return self._names.def_name(resolve_ref(str(schema["$ref"]), current_file))

        if "const" in schema:
            self._typing.add("Literal")
            return f"Literal[{literal(schema['const'])}]"
        if isinstance(schema.get("enum"), list):
            self._typing.add("Literal")
            values = ", ".join(literal(value) for value in schema["enum"])
            return f"Literal[{values}]"

        union = schema.get("oneOf") or schema.get("anyOf")
        if isinstance(union, list):
            variants = [self.type_of(variant, current_file, owner, path) for variant in union]
            return " | ".join(variants)

        if "allOf" in schema:
            raise GenerationError(
                f"{current_file}: allOf is only supported as a single $ref base class, not at {owner}"
            )

        schema_type = schema.get("type")
        if schema_type == "string":
            if schema.get("format") == "date-time":
                self._wire.add("Rfc3339")
                return "Rfc3339"
            return "str"
        if schema_type == "integer":
            return "int"
        if schema_type == "number":
            return "float"
        if schema_type == "boolean":
            return "bool"
        if schema_type == "null":
            return "None"
        if schema_type == "array":
            item = self.type_of(schema.get("items", True), current_file, owner, path + ("item",))
            return f"list[{item}]"
        if schema_type == "object" or "properties" in schema or "additionalProperties" in schema:
            return self._object_type(schema, current_file, owner, path)

        raise GenerationError(f"{current_file}: no type for schema {json.dumps(schema)[:120]} at {owner}")

    def _object_type(self, schema: dict[str, Any], current_file: str, owner: str, path: tuple[str, ...]) -> str:
        self._typing.add("Any")
        if "properties" in schema:
            return self._names.inline_name(owner, path, schema)
        additional = schema.get("additionalProperties", True)
        if additional is True or additional == {}:
            return "dict[str, Any]"
        return f"dict[str, {self.type_of(additional, current_file, owner, path)}]"

    # -- field constraints ------------------------------------------------

    def constraints(self, schema: dict[str, Any]) -> list[str]:
        if not isinstance(schema, dict):
            return []
        arguments: list[str] = []
        for key, argument in (
            ("minLength", "min_length"),
            ("minItems", "min_length"),
            ("minProperties", "min_length"),
            ("maxLength", "max_length"),
            ("maxItems", "max_length"),
        ):
            if isinstance(schema.get(key), int):
                arguments.append(f"{argument}={schema[key]}")
        if isinstance(schema.get("pattern"), str):
            arguments.append(f"pattern={literal(schema['pattern'])}")
        if isinstance(schema.get("minimum"), (int, float)):
            arguments.append(f"ge={literal(schema['minimum'])}")
        if isinstance(schema.get("maximum"), (int, float)):
            arguments.append(f"le={literal(schema['maximum'])}")
        if isinstance(schema.get("exclusiveMinimum"), (int, float)):
            arguments.append(f"gt={literal(schema['exclusiveMinimum'])}")
        if isinstance(schema.get("exclusiveMaximum"), (int, float)):
            arguments.append(f"lt={literal(schema['exclusiveMaximum'])}")
        if isinstance(schema.get("multipleOf"), (int, float)):
            arguments.append(f"multiple_of={literal(schema['multipleOf'])}")
        # `uniqueItems` and `propertyNames` are collection/key rules the JSON
        # Schema validator enforces at the request seam; Pydantic rejects an
        # unknown `Field` keyword, and silently approximating the rule would be
        # worse than leaving it to the authority.
        return arguments

    @staticmethod
    def annotated(value: str, arguments: Sequence[str]) -> str:
        return f"Annotated[{value}, Field({', '.join(arguments)})]"

    # -- classes ----------------------------------------------------------

    def _doc(self, schema: dict[str, Any]) -> str:
        text = schema.get("description") or schema.get("title")
        if not isinstance(text, str) or not text.strip():
            return ""
        return '    """' + " ".join(text.split()) + '"""'

    def object_class(self, name: str, schema: dict[str, Any], current_file: str) -> str:
        properties = schema.get("properties") or {}
        required = set(schema.get("required") or [])
        allows_extra = schema.get("additionalProperties", True) is not False

        bases: list[str] = []
        for variant in schema.get("allOf") or []:
            if not isinstance(variant, dict):
                raise GenerationError(f"{current_file}#{name}: unsupported allOf variant")
            if "if" in variant or "then" in variant:
                # Conditional rules are the JSON Schema validator's job at the
                # request seam; a partial Pydantic copy would be a second, weaker
                # implementation of the same rule.
                continue
            if "$ref" in variant:
                bases.append(self._names.def_name(resolve_ref(str(variant["$ref"]), current_file)))
                continue
            raise GenerationError(f"{current_file}#{name}: allOf variants must be $refs or if/then rules")
        if not bases:
            bases = ["WireModel"]

        body: list[str] = []
        description = self._doc(schema)
        if description:
            body.append(description)
        if allows_extra:
            self._pydantic.add("ConfigDict")
            body.append("    model_config = ConfigDict(extra='allow')")

        null_sentinels: list[str] = []
        for property_name, property_schema in properties.items():
            if not property_name.isidentifier() or keyword.iskeyword(property_name):
                raise GenerationError(f"{current_file}#{name}: {property_name!r} is not a Python field name")
            is_required = property_name in required
            annotation = self.type_of(property_schema, current_file, name, (property_name,))
            constraints = self.constraints(property_schema)
            if is_required:
                self._pydantic.add("Field")
                assignment = f" = Field({', '.join(constraints)})" if constraints else ""
            else:
                annotation = f"{annotation} | None"
                self._pydantic.add("Field")
                assignment = f" = Field({', '.join(['default=None', *constraints])})"
                # Optional means absent, not null: Pydantic cannot say "may be
                # omitted but not null" with a default alone, so the generated
                # validator says it.
                if property_schema.get("type") != "null":
                    null_sentinels.append(property_name)
            body.append(f"    {property_name}: {annotation}{assignment}")

        if null_sentinels:
            self._pydantic.add("model_validator")
            self._typing.add("Any")
            keys = ", ".join(literal(key) for key in null_sentinels)
            body.extend(
                [
                    "",
                    "    @model_validator(mode='before')",
                    "    @classmethod",
                    "    def _reject_null(cls, data: Any) -> Any:",
                    "        if isinstance(data, dict):",
                    f"            for key in ({keys}):",
                    "                if key in data and data[key] is None:",
                    "                    raise ValueError(f'{cls.__name__}.{key} must not be null')",
                    "        return data",
                ]
            )

        if not body:
            body.append("    pass")
        self._rebuilt.append(name)
        return "\n".join([f"class {name}({', '.join(bases)}):", *body])

    def type_alias(self, name: str, schema: dict[str, Any], current_file: str) -> str:
        if schema.get("type") == "object" and not schema.get("properties"):
            # A map-shaped document (`CapabilityDetails`): the alias is the value
            # type, plus the constraints on the map itself and on its keys.
            arguments: list[str] = []
            if isinstance(schema.get("minProperties"), int):
                self._pydantic.add("Field")
                arguments.append(f"Field(min_length={schema['minProperties']})")
            property_names = schema.get("propertyNames")
            if isinstance(property_names, dict) and isinstance(property_names.get("pattern"), str):
                self._pydantic.add("AfterValidator")
                self._typing.add("partial")  # functools.partial
                self._wire.add("check_key_pattern")
                arguments.append(
                    f"AfterValidator(partial(check_key_pattern, pattern={literal(property_names['pattern'])}))"
                )
            value = self.type_of(schema, current_file, name)
            if arguments:
                self._typing.add("Annotated")
                return f"{name} = Annotated[{value}, {', '.join(arguments)}]"
            return f"{name} = {value}"

        constraints = self.constraints(schema)
        value = self.type_of(schema, current_file, name)
        if constraints:
            self._pydantic.add("Field")
            self._typing.add("Annotated")
            return f"{name} = {self.annotated(value, constraints)}"
        return f"{name} = {value}"

    def marker_class(self, name: str, schema: dict[str, Any]) -> str:
        """A conditional rule with no fields of its own (`DegradedRequiresLimitations`).

        It exists to be inherited by the capability nodes; the rule it carries is
        enforced by the JSON Schema validator, so the model is an empty marker
        rather than a second, partial implementation.
        """
        description = self._doc(schema)
        self._rebuilt.append(name)
        body = [description] if description else []
        body.append("    pass")
        return "\n".join([f"class {name}(WireModel):", *body])

    def emit(self) -> str:
        emitted: set[str] = set()

        def emit_block(name: str, schema: dict[str, Any], file: str) -> None:
            if name in emitted:
                raise GenerationError(f"two schemas derive the model name {name!r}; rename one in contracts/")
            emitted.add(name)
            if schema.get("type") == "object" and "properties" in schema:
                self._blocks.append(self.object_class(name, schema, file))
            elif "if" in schema and "properties" not in schema:
                self._blocks.append(self.marker_class(name, schema))
            else:
                self._blocks.append(self.type_alias(name, schema, file))
            for inline_name, inline_schema in self._names.drain_pending():
                emit_block(inline_name, inline_schema, file)

        for file in self._files:
            for def_name, schema in (self._schemas[file].get("$defs") or {}).items():
                emit_block(self._names.def_name(ResolvedRef(file, def_name)), schema, file)

        # A schema file whose *root* is an object names itself: `execution-context`
        # is the bearer token's shape, and it is not in `$defs`.
        for file in self._files:
            root = self._schemas[file]
            if root.get("type") == "object" and "properties" in root and "$ref" not in root:
                emit_block(pascal(file.removesuffix(".schema.json")), root, file)

        typing_names = sorted(self._typing - {"partial"})
        typing_import = f"from typing import {', '.join(typing_names)}\n" if typing_names else ""
        functools_import = "from functools import partial\n" if "partial" in self._typing else ""
        pydantic_names = sorted(self._pydantic)
        pydantic_import = f"from pydantic import {', '.join(pydantic_names)}\n" if pydantic_names else ""
        wire_names = sorted({"WireModel", *self._wire})
        wire_import = f"from app.wire import {', '.join(wire_names)}\n"

        rebuilds = "\n".join(f"    {name}," for name in self._rebuilt)
        return (
            BANNER.format(source="contracts/ (the context-service OpenAPI schema closure)")
            + "\nfrom __future__ import annotations\n\n"
            + functools_import
            + typing_import
            + "\n"
            + pydantic_import
            + wire_import
            + "\n\n"
            + "\n\n\n".join(self._blocks)
            + "\n\n\n# `from __future__ import annotations` makes every reference a string; resolve\n"
            + "# them once, after the whole closure exists.\n"
            + "for _model in (\n"
            + rebuilds
            + "\n):\n    _model.model_rebuild()\n"
        )


# ---------------------------------------------------------------------------
# OpenAPI operations
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class OperationSpec:
    method: str
    path: str
    operation_id: str
    auth: bool
    traceparent: bool
    idempotency_key: bool
    required_scope: str | None
    issuer: str | None
    request: tuple[str, str] | None
    success_status: int
    #: The status a replay answers with (§3.5): the operation's own 200 response
    #: when the contract declares one, otherwise its success status.
    replay_status: int
    response_ref: tuple[str, str] | None
    response_inline: dict[str, Any] | None


#: The two `ExecutionContext` issuers (§5.1). `runtime` is `mastra-app`
#: (`fde://<deployment_id>`); `jobs` is `fde-jobs` (`fde://<deployment_id>/jobs`).
ISSUER_KINDS = ("runtime", "jobs")


def _pointer(doc: Mapping[str, Any], ref: str) -> Any:
    if not ref.startswith("#/"):
        raise GenerationError(f"the generator only follows local OpenAPI $refs, not {ref!r}")
    cursor: Any = doc
    for raw in ref[2:].split("/"):
        cursor = cursor[raw.replace("~1", "/").replace("~0", "~")]
    return cursor


def _resolve(doc: Mapping[str, Any], value: Any) -> Any:
    seen = 0
    while isinstance(value, dict) and "$ref" in value:
        value = _pointer(doc, str(value["$ref"]))
        seen += 1
        if seen > 8:
            raise GenerationError(f"circular $ref {value!r}")
    return value


def _schema_ref(schema: Any) -> tuple[tuple[str, str] | None, dict[str, Any] | None]:
    if not isinstance(schema, dict):
        return None, None
    ref = schema.get("$ref")
    if not isinstance(ref, str):
        return None, schema
    target, _, pointer = ref.partition("#")
    return (target.removeprefix("./schemas/"), pointer), None


def read_operations(openapi: Mapping[str, Any]) -> list[OperationSpec]:
    operations: list[OperationSpec] = []
    global_security = bool(openapi.get("security") or [])
    for path, item in (openapi.get("paths") or {}).items():
        for method in METHODS:
            operation = item.get(method)
            if operation is None:
                continue
            operation_id = operation.get("operationId")
            if not isinstance(operation_id, str) or not operation_id:
                raise GenerationError(f"{method.upper()} {path} has no operationId")

            parameters = [_resolve(openapi, parameter) for parameter in operation.get("parameters") or []]
            headers = {parameter.get("name") for parameter in parameters if parameter.get("in") == "header"}
            security = operation.get("security", openapi.get("security"))
            auth = bool(security) and global_security

            # Authorization is a property of the operation, so it lives in the
            # contract. An authenticated operation that does not say which scope
            # and which issuer it accepts is one the service could only guess at,
            # so the generator refuses it instead of emitting a guess.
            required_scope = operation.get("x-fde-required-scope")
            issuer = operation.get("x-fde-issuer")
            if auth:
                if not isinstance(required_scope, str) or not required_scope:
                    raise GenerationError(
                        f"{method.upper()} {path} is authenticated but declares no x-fde-required-scope"
                    )
                if issuer not in ISSUER_KINDS:
                    raise GenerationError(
                        f"{method.upper()} {path} declares x-fde-issuer={issuer!r}; expected one of {ISSUER_KINDS}"
                    )
            elif required_scope is not None or issuer is not None:
                raise GenerationError(
                    f"{method.upper()} {path} declares authorization facts but has no security requirement; "
                    "an unauthenticated operation has no caller identity to check"
                )

            body = _resolve(openapi, operation.get("requestBody"))
            request = None
            if body is not None:
                schema = (body.get("content") or {}).get("application/json", {}).get("schema")
                request, inline = _schema_ref(schema)
                if request is None:
                    raise GenerationError(
                        f"{method.upper()} {path} has an inline request schema; name it in contracts/schemas/ "
                        f"so the generator can model it ({json.dumps(inline)[:80]})"
                    )

            success_status = 0
            response_ref = None
            response_inline = None
            declared = {
                int(status) for status in (operation.get("responses") or {}) if str(status).isdigit()
            }
            for status, response in (operation.get("responses") or {}).items():
                if not str(status).isdigit():
                    continue
                code = int(status)
                if not 200 <= code < 300:
                    continue
                success_status = code
                resolved = _resolve(openapi, response)
                schema = (resolved.get("content") or {}).get("application/json", {}).get("schema")
                response_ref, response_inline = _schema_ref(schema)
                break
            if success_status == 0:
                raise GenerationError(f"{method.upper()} {path} declares no 2xx response")
            # §3.5: a replay answers 200 with the original body. An operation that
            # declares a 200 beside its 201 is declaring exactly that; one whose
            # success is already 200 replays with the status it always answers.
            replay_status = 200 if 200 in declared else success_status

            operations.append(
                OperationSpec(
                    method=method,
                    path=path,
                    operation_id=operation_id,
                    auth=auth,
                    traceparent="traceparent" in headers,
                    idempotency_key="Idempotency-Key" in headers,
                    required_scope=required_scope if auth else None,
                    issuer=issuer if auth else None,
                    request=request,
                    success_status=success_status,
                    replay_status=replay_status,
                    response_ref=response_ref,
                    response_inline=response_inline,
                )
            )
    return operations


def _schema_ref_literal(ref: tuple[str, str] | None) -> str:
    return f"SchemaRef({literal(ref[0])}, {literal(ref[1])})" if ref is not None else "None"


def render_api(
    openapi: Mapping[str, Any], operations: Sequence[OperationSpec], schema_files: Sequence[str]
) -> str:
    lines = []
    for operation in operations:
        inline = "None" if operation.response_inline is None else literal(operation.response_inline)
        lines.append(
            "    Operation(\n"
            f"        method={literal(operation.method)},\n"
            f"        path={literal(operation.path)},\n"
            f"        operation_id={literal(operation.operation_id)},\n"
            f"        auth={operation.auth},\n"
            f"        traceparent={operation.traceparent},\n"
            f"        idempotency_key={operation.idempotency_key},\n"
            f"        required_scope={literal(operation.required_scope)},\n"
            f"        issuer={literal(operation.issuer)},\n"
            f"        request={_schema_ref_literal(operation.request)},\n"
            f"        success_status={operation.success_status},\n"
            f"        replay_status={operation.replay_status},\n"
            f"        response_ref={_schema_ref_literal(operation.response_ref)},\n"
            f"        response_inline={inline},\n"
            "    ),"
        )

    version = (openapi.get("info") or {}).get("version")
    if not isinstance(version, str):
        raise GenerationError("the OpenAPI document has no info.version")
    return (
        BANNER.format(source="contracts/context-service-v1.openapi.yaml")
        + "\nfrom app.wire import Operation, SchemaRef\n\n"
        + "#: The version of this API document. It is *not* the `fde.runtime/v1` minor:\n"
        + "#: `versions.RUNTIME_CONTRACT_VERSION` is what `runtime-info.contract_version` reports.\n"
        + f"CONTEXT_SERVICE_API_VERSION = {literal(version)}\n\n"
        + "#: Schema files the operation table refers to.\n"
        + f"SCHEMA_FILES = {literal(tuple(schema_files))}\n\n"
        + "OPERATIONS: tuple[Operation, ...] = (\n"
        + "\n".join(lines)
        + "\n)\n\n"
        + "OPERATIONS_BY_ID: dict[str, Operation] = {operation.operation_id: operation for operation in OPERATIONS}\n\n"
        + "#: Keyed by the (METHOD, path template) a FastAPI route matches on.\n"
        + "OPERATIONS_BY_ROUTE: dict[tuple[str, str], Operation] = {\n"
        + "    (operation.method.upper(), operation.path): operation for operation in OPERATIONS\n"
        + "}\n"
    )


# ---------------------------------------------------------------------------
# Embedded schemas and versions
# ---------------------------------------------------------------------------


def render_schemas(schemas: Mapping[str, dict[str, Any]], files: Sequence[str]) -> str:
    entries = []
    for file in files:
        rendered = pprint.pformat(schemas[file], width=110, sort_dicts=False)
        indented = "\n".join(f"    {line}" for line in rendered.splitlines())
        entries.append(f"    {literal(file)}: {indented.lstrip()},")
    return (
        BANNER.format(source="contracts/schemas/ (the closure the service serves)")
        + "\nfrom typing import Any\n\n"
        + "#: Schema documents keyed by file name. Each document's `$id` makes the\n"
        + "#: cross-file `$ref`s resolvable, so this is the runtime's whole contract.\n"
        + "SCHEMAS: dict[str, dict[str, Any]] = {\n"
        + "\n".join(entries)
        + "\n}\n"
    )


def read_contract_version() -> str:
    text = CONTRACTS_README.read_text(encoding="utf-8")
    match = re.search(r"Current minor: `([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)`", text)
    if match is None:
        raise GenerationError("contracts/README.md no longer states `Current minor: `X.Y.Z``")
    return match.group(1)


def render_versions(toolchain: Mapping[str, Any]) -> str:
    versions = (toolchain.get("spec") or {}).get("versions") or {}
    schemas = (toolchain.get("spec") or {}).get("schemas") or {}
    for key, source in (
        ("contextService", "spec.versions.contextService"),
        ("python", "spec.versions.python"),
        ("semantica", "spec.versions.semantica"),
    ):
        if not isinstance(versions.get(key), str):
            raise GenerationError(f"platform/toolchain.yaml has no {source}")
    for key in ("graph", "audit"):
        if not isinstance(schemas.get(key), (str, int)):
            raise GenerationError(f"platform/toolchain.yaml has no spec.schemas.{key}")

    return (
        BANNER.format(source="contracts/README.md + platform/toolchain.yaml")
        + "\n#: The `fde.runtime/v1` minor this service speaks. The runtime app's handshake\n"
        + "#: compares majors (`packages/runtime-generator-mastra/src/runtime-info.ts`).\n"
        + f"RUNTIME_CONTRACT_VERSION = {literal(read_contract_version())}\n\n"
        + "#: The platform's pin for this service (`lock.runtime.contextService`).\n"
        + f"SERVICE_VERSION = {literal(versions['contextService'])}\n\n"
        + "#: Interpreter and semantic-engine pins, for the SBOM and runtime-info.\n"
        + f"PYTHON_VERSION = {literal(versions['python'])}\n"
        + f"SEMANTICA_VERSION = {literal(versions['semantica'])}\n\n"
        + "#: Graph and audit schema versions the migrations establish (`spec.schemas`).\n"
        + f"GRAPH_SCHEMA_VERSION = {literal(str(schemas['graph']))}\n"
        + f"AUDIT_SCHEMA_VERSION = {literal(str(schemas['audit']))}\n"
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def generate() -> dict[str, str]:
    """The text of every generated file, keyed by path relative to `app/generated/`."""
    schemas = read_schemas()
    openapi_text = OPENAPI_FILE.read_text(encoding="utf-8")
    openapi = yaml.safe_load(openapi_text)
    if not isinstance(openapi, dict):
        raise GenerationError(f"{OPENAPI_FILE.name} is not an OpenAPI document")
    files = schema_closure(openapi_text, schemas)

    names = TypeNames(schemas, files)
    models = Models(schemas, files, names).emit()
    operations = read_operations(openapi)
    toolchain = yaml.safe_load(TOOLCHAIN_FILE.read_text(encoding="utf-8"))
    if not isinstance(toolchain, dict):
        raise GenerationError("platform/toolchain.yaml is not a toolchain document")

    return {
        "__init__.py": BANNER.format(source="contracts/ (via scripts/generate.py)").rstrip("\n") + "\n",
        "models.py": models,
        "schemas.py": render_schemas(schemas, files),
        "api.py": render_api(openapi, operations, files),
        "versions.py": render_versions(toolchain),
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="generate the contract-derived Python modules")
    parser.add_argument("--check", action="store_true", help="fail when the committed output is stale")
    arguments = parser.parse_args(argv)

    try:
        outputs = generate()
    except GenerationError as error:
        print(f"generate: {error}", file=sys.stderr)
        return 1

    stale: list[str] = []
    for name, content in outputs.items():
        path = OUT_DIR / name
        if arguments.check:
            current = path.read_text(encoding="utf-8") if path.exists() else None
            if current != content:
                stale.append(str(path.relative_to(SERVICE_ROOT)))
            continue
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    if arguments.check:
        if stale:
            print("contracts/ and app/generated/ disagree; run `python scripts/generate.py`:", file=sys.stderr)
            for entry in stale:
                print(f"  {entry}", file=sys.stderr)
            return 1
        print(f"app/generated/ is up to date ({len(outputs)} files).")
        return 0

    print(f"wrote {len(outputs)} files to {OUT_DIR.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
