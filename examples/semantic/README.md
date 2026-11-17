# Semantic examples

These are illustrative artifacts for the semantic modeling method in [`docs/semantic-modeling.md`](../../docs/semantic-modeling.md). They are not production schemas: field names, IDs, and digests are placeholders, and no customer data is included.

- `acme/` — Acme Claims end-to-end slice: ontology, SHACL, Semantic Model, sources, mappings, recipe, permissions, and context eval.
- `beta/` — Beta Bank KYC reuse delta: different ontology, sources, stricter PII, and a higher eval threshold. It intentionally does not repeat the full Acme artifact set.

## The Acme package is a real, frozen reference asset

`acme/` is not illustrative in the same way `beta/` is: it is the reference
Customer Context Package (`acme-claims-context@1.0.0`) that the Acme Solution pins
and that context-service would ingest to execute the `claims-context` recipe.

```bash
node packages/cli/dist/main.js context validate --package examples/semantic/acme --workspace examples/spec/acme
```

`manifest.yaml` names the package; `mappings/claims-db-*.yaml` map the four
`claims-db` datasets the recipe expands over (claims, policies, coverages,
customers) and `mappings/sharepoint-claims.yaml` maps the document store, which is
why every term the recipe and the permission baseline name is produced by a
mapping. `revisions/1.0.0.yaml` is written by `fde context freeze` and is the
content address: its `spec.digest` is the same value
`solution.lock.assets.customerContextPackage` pins. A frozen version is immutable —
change the content, bump `metadata.version`, freeze again.

The package holds the Customer artefacts; the Domain Ontology module itself is
vendored in `platform/templates/ontology/insurance-claims/1.0.0/` and pinned by
the module digest in `semantic-model.yaml`. `ontology/insurance-claims.ttl` is a
reading copy for the sake of the example — a build resolves the module from the
platform store.

The golden suite ships three questions (the competency questions of §4.2), which
is a *sample* of the 20–50 a production CCP carries; the thresholds are real and
`freeze` refuses a package whose suite has no questions at all.

`beta/` is a reuse *sketch*: its ontology module is not vendored and its digest is
a placeholder, so `fde context validate` is expected to reject it. Validate YAML
with any YAML 1.2 parser; validate Turtle with an RDF parser before using these as
a starting point.
