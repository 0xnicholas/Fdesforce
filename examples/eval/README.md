# Evaluation examples

These are illustrative artifacts for [`docs/evaluation-and-observability.md`](../../docs/evaluation-and-observability.md). They are not production schemas: field names, IDs, digests, and thresholds are placeholders, and no customer data or real PII is included.

- `acme/` — Acme Claims `document-triage` reference slice: Metric Catalog, Eval Suite, Eval Dataset manifest + sample cases, and the L1/L2/L3 acceptance checklist.
- Beta Bank is intentionally not repeated as a full artifact set; its diffs are listed in the acceptance checklist.

Validate YAML with any YAML 1.2 parser; validate JSONL by parsing each line as JSON. The dataset sample is truncated: a release dataset needs at least 50 cases with at least 10 holdout cases.
