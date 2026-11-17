"""The route surface is the contract's surface (§3.3).

The service must serve exactly the operations in
`contracts/context-service-v1.openapi.yaml`: a missing route is a contract the
service claims and does not keep, and an extra route is a surface the runner
cannot check and the contract does not describe. FastAPI's own `/docs`,
`/openapi.json` and `/redoc` are off for the same reason.
"""

from __future__ import annotations

from fastapi.routing import APIRoute

from app.generated.api import OPERATIONS
from app.main import create_app


def api_routes(routes) -> list[tuple[str, str]]:  # type: ignore[no-untyped-def]
    found: list[tuple[str, str]] = []
    for route in routes:
        if isinstance(route, APIRoute):
            found.extend((method, route.path) for method in route.methods - {"HEAD", "OPTIONS"})
            continue
        # FastAPI 0.163 wraps `include_router` in a lazy node; unwrap it.
        original = getattr(route, "original_router", None)
        if original is not None:
            found.extend(api_routes(original.routes))
    return found


def test_registered_routes_are_exactly_the_contract_operations() -> None:
    expected = {(operation.method.upper(), operation.path) for operation in OPERATIONS}
    assert set(api_routes(create_app().routes)) == expected


def test_the_operation_table_is_unique() -> None:
    operation_ids = [operation.operation_id for operation in OPERATIONS]
    assert len(set(operation_ids)) == len(operation_ids)
    assert len({(operation.method, operation.path) for operation in OPERATIONS}) == len(OPERATIONS)


def test_the_implicit_fastapi_surface_is_disabled() -> None:
    paths = {path for _, path in api_routes(create_app().routes)}
    assert not paths & {"/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"}
