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

The Eval Suite pins a dataset version + digest; the Environment's
`evalDatasetBindings` maps `dataset_id@version` to a store/path/secretRef and
optional service account. `fde eval` resolves that binding and verifies the
dataset digest before any model call; the dataset is never copied into the
Bundle.
