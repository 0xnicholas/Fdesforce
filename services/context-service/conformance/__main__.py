"""`python -m conformance` — run the context-service conformance suite.

    python -m conformance            # every implemented case, and the pending ledger
    python -m conformance C1 C10     # named cases only
    python -m conformance --list     # what exists, what is pending, and who owns it

Exit code is 0 when every *implemented* case passed. Pending cases are reported,
not counted as passes: the summary always says how many of C1–C15 are still
missing, so a green run cannot be mistaken for full conformance.

Cases that need the service get one real spawned process, shared for the run
(`conformance.harness.ServiceProcess`) — uvicorn, a free port, a temp data
volume, and the two issuer public keys the topology binds.
"""

from __future__ import annotations

import argparse
import sys
import traceback
from collections.abc import Sequence

from conformance.cases import CASES, Case, CaseContext, CaseFailure
from conformance.documents import ContractDocuments
from conformance.harness import ServiceProcess


def _format(case: Case, status: str, detail: str) -> str:
    return f"{case.case_id:<4} {status:<5} {detail}"


def list_cases() -> int:
    for case in CASES:
        if case.run is None:
            print(_format(case, "TODO", f"{case.title} (needs {case.owner})"))
        else:
            print(_format(case, "READY", case.title))
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="run the fde.runtime/v1 context-service conformance cases")
    parser.add_argument("cases", nargs="*", help="case ids to run (default: every implemented case)")
    parser.add_argument("--list", action="store_true", help="list the suite and exit")
    arguments = parser.parse_args(argv)

    if arguments.list:
        return list_cases()

    selected = list(CASES)
    if arguments.cases:
        wanted = [case_id.upper() for case_id in arguments.cases]
        unknown = sorted(set(wanted) - {case.case_id for case in CASES})
        if unknown:
            print(f"conformance: unknown case(s): {', '.join(unknown)}", file=sys.stderr)
            return 2
        selected = [case for case in CASES if case.case_id in wanted]

    documents = ContractDocuments()
    failures = 0
    passed = 0
    pending = 0
    service: ServiceProcess | None = None
    try:
        if any(case.run is not None and case.needs_service for case in selected):
            service = ServiceProcess.start()

        for case in selected:
            if case.run is None:
                pending += 1
                print(_format(case, "SKIP", f"{case.title} (needs {case.owner})"))
                continue
            try:
                checks = case.run(CaseContext(documents=documents, service=service))
            except CaseFailure as failure:
                failures += 1
                print(_format(case, "FAIL", case.title))
                for detail in failure.failures:
                    print(f"       - {detail}")
            except Exception as error:  # noqa: BLE001 - a crashing case is a failing case
                failures += 1
                print(_format(case, "FAIL", f"{case.title} (crashed)"))
                print(f"       - {type(error).__name__}: {error}")
                traceback.print_exc(file=sys.stderr)
            else:
                passed += 1
                print(_format(case, "PASS", f"{case.title}: {', '.join(checks)}"))
    finally:
        if service is not None:
            service.stop()

    total = len(CASES)
    print(
        f"\n{passed} passed, {failures} failed, {pending} not implemented "
        f"({passed}/{total} cases have a runner)"
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
