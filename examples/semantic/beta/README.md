# Beta Bank KYC reuse delta

This example shows how the same method is reused for a second customer without forking the Capability Template. It is intentionally a delta, not a full second case:

- Reuses `document-triage@1.0.0` and the same CCP structure.
- Selects `kyc-ontology@1.0.0` instead of `insurance-claims@1.0.0`.
- Uses `beta-dms` and `core-banking` as Context Sources.
- Applies stricter PII masking and a higher context-eval threshold (0.9).
- The ontology module is referenced as a template and is assumed to be vendored at build time; no customer data is included.
