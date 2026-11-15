# Semantic examples

These are illustrative artifacts for the semantic modeling method in [`docs/semantic-modeling.md`](../../docs/semantic-modeling.md). They are not production schemas: field names, IDs, and digests are placeholders, and no customer data is included.

- `acme/` — Acme Claims end-to-end slice: ontology, SHACL, Semantic Model, sources, mappings, recipe, permissions, and context eval.
- `beta/` — Beta Bank KYC reuse delta: different ontology, sources, stricter PII, and a higher eval threshold. It intentionally does not repeat the full Acme artifact set.

Validate YAML with any YAML 1.2 parser; validate Turtle with an RDF parser before using these as a starting point.
