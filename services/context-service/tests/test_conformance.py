"""The contract's cases, run from pytest as well as from `python -m conformance`.

One implementation, two entry points: the runner is the CI artifact, and this
test makes `pytest` alone fail when a case regresses. Every case that has a
runner must pass; every case that does not must name the ticket that owns it, so
the ledger cannot quietly lose an entry.
"""

from __future__ import annotations

from app.generated.api import OPERATIONS
from conformance.cases import CASES, CaseContext, CaseFailure
from conformance.documents import ContractDocuments
from conformance.harness import ServiceProcess


def test_every_case_in_the_contract_has_exactly_one_entry() -> None:
    assert [case.case_id for case in CASES] == [f"C{number}" for number in range(1, 16)]
    assert len({case.title for case in CASES}) == len(CASES)


def test_a_case_without_a_runner_names_its_owner() -> None:
    for case in CASES:
        if case.run is None:
            assert case.owner is not None and case.owner.startswith("#"), (
                f"{case.case_id} is not implemented and does not name the ticket that will implement it"
            )
        else:
            assert case.owner is None, f"{case.case_id} has a runner and a pending owner"


def test_implemented_cases_pass_against_the_real_process(service: ServiceProcess) -> None:
    context = CaseContext(documents=ContractDocuments(), service=service)
    failures: list[str] = []
    for case in CASES:
        if case.run is None:
            continue
        try:
            checks = case.run(context)
        except CaseFailure as failure:
            failures.extend(f"{case.case_id}: {detail}" for detail in failure.failures)
        else:
            assert checks, f"{case.case_id} returned no checks; a pass must say what it proved"
    assert not failures, "\n".join(failures)


def test_the_stub_ledger_covers_the_whole_contract_surface() -> None:
    from app.routes.stubs import IMPLEMENTED, STUBS

    operation_ids = {operation.operation_id for operation in OPERATIONS}
    assert operation_ids >= IMPLEMENTED
    assert set(STUBS) == operation_ids - IMPLEMENTED, (
        "every operation is either implemented or stubbed with an owning ticket"
    )
