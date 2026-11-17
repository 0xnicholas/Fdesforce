"""The route surface is the contract's surface (§3.3).

The service must serve exactly the operations in
`contracts/context-service-v1.openapi.yaml`: a missing route is a contract the
service claims and does not keep, and an extra route is a surface the runner
cannot check and the contract does not describe. FastAPI's own `/docs`,
`/openapi.json` and `/redoc` are off for the same reason.
"""

from __future__ import annotations

from fastapi.routing import APIRoute

from app.contract import OPERATION_INDEX
from app.generated.api import OPERATIONS
from app.main import create_app
from app.settings import Settings
from conformance.cases import concrete_path


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


def test_registered_routes_are_exactly_the_contract_operations(app_settings: Settings) -> None:
    expected = {(operation.method.upper(), operation.path) for operation in OPERATIONS}
    assert set(api_routes(create_app(settings=app_settings).routes)) == expected


def test_the_operation_table_is_unique() -> None:
    operation_ids = [operation.operation_id for operation in OPERATIONS]
    assert len(set(operation_ids)) == len(operation_ids)
    assert len({(operation.method, operation.path) for operation in OPERATIONS}) == len(OPERATIONS)


def test_the_implicit_fastapi_surface_is_disabled(app_settings: Settings) -> None:
    paths = {path for _, path in api_routes(create_app(settings=app_settings).routes)}
    assert not paths & {"/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"}


def test_the_request_edge_index_agrees_with_the_router(app_settings: Settings) -> None:
    """The middleware matches the path itself, before the router has run.

    It must find exactly the operations the router would serve: one it missed
    would be an unguarded route, and one it invented would be a 401 on a 404.
    """
    for operation in OPERATIONS:
        concrete = concrete_path(operation.path)
        assert OPERATION_INDEX.match(operation.method, concrete) is operation

    assert len(OPERATION_INDEX) == len(OPERATIONS)
    assert OPERATION_INDEX.match("get", "/v1/does-not-exist") is None
    assert OPERATION_INDEX.match("post", "/v1/provenance/dec_01ARZ3NDEKTSV4RRFFQ69G5FAV") is None
    # A path parameter is one segment, not zero and not many.
    assert OPERATION_INDEX.match("get", "/v1/provenance/") is None
    assert OPERATION_INDEX.match("get", "/v1/provenance/a/b") is None
