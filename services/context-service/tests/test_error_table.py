"""The error table is `docs/runtime-contract.md` §3.4, mechanically.

§3.4 fixes each code's HTTP status and whether a client may retry. A table in a
document drifts from the code that implements it unless something compares them,
so this test parses the markdown table and holds `app.errors` to it. The codes
themselves come from the generated `ErrorCode` enum, which comes from
`contracts/schemas/common.schema.json` — a new code therefore has to be added in
all three places, which is the point.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import get_args

from app.errors import ERROR_HTTP_STATUS, HTTP_STATUS_TO_ERROR, RETRYABLE_CODES
from app.generated.models import ErrorCode

DOC = Path(__file__).resolve().parents[3] / "docs" / "runtime-contract.md"
ROW = re.compile(r"^\|\s*`([a-z_]+)`\s*\|\s*(\d{3})\s*\|\s*(true|false)\s*\|", re.MULTILINE)


def documented_table() -> dict[str, tuple[int, bool]]:
    rows = ROW.findall(DOC.read_text(encoding="utf-8"))
    assert rows, "docs/runtime-contract.md §3.4's code table could not be read"
    return {code: (int(status), retryable == "true") for code, status, retryable in rows}


def test_the_documented_table_is_what_the_service_serves() -> None:
    table = documented_table()

    assert {code: status for code, (status, _) in table.items()} == dict(ERROR_HTTP_STATUS)
    assert {code for code, (_, retryable) in table.items() if retryable} == set(RETRYABLE_CODES)


def test_every_contract_error_code_is_documented() -> None:
    assert set(get_args(ErrorCode)) == set(documented_table())


def test_framework_status_mapping_uses_only_contract_codes() -> None:
    codes = set(get_args(ErrorCode))

    assert set(HTTP_STATUS_TO_ERROR.values()) <= codes


def test_retryable_codes_are_transient_dependency_failures() -> None:
    """A retry only helps when the failure is outside the request's content."""
    assert {"rate_limited", "bad_gateway", "unavailable", "timeout"} == RETRYABLE_CODES
