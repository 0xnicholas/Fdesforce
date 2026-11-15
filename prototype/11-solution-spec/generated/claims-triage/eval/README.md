# Evaluation assets (prototype)

The Bundle contains **definitions**, not data:

- `suites/claims-triage-quality.yaml` — L2 Capability Eval Suite.
- `suites/claims-context.yaml` — L1 Context Eval Suite.
- `metric-catalog.yaml` — Metric Catalog.
- scorer artifacts are generated from the suite's `scorers[]` entries; this
  prototype only stubs the wiring.

The dataset is a customer-side asset under
`acme/eval/claims-triage-quality/` and must be resolved in the customer
environment by version + digest. It is deliberately **not** copied into the
generated tree.

GAP: the Eval Suite pins a dataset digest, but the Spec has no environment-level
binding that tells `fde eval` where to resolve the dataset or which service
account to use. That is currently an implicit customer-side convention.
