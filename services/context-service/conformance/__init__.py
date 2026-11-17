"""The C1–C15 conformance runner for context-service.

`contracts/conformance/cases.md` is the suite; this package is its runner. Cases
talk to a real spawned process over HTTP (`harness`) and mint real ES256
`ExecutionContext` tokens (`identity`).
"""
