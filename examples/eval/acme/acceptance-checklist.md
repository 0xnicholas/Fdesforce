# Acme Claims acceptance checklist

Reference slice: Customer `acme`, Solution `claims-triage`, Capability `document-triage`, CCP `acme-claims-context@1.0.0`, Sources `claims-db` and `sharepoint-claims`.

Use this checklist with [`docs/evaluation-and-observability.md`](../../../docs/evaluation-and-observability.md). The sample dataset is truncated; a release dataset needs at least 50 cases with at least 10 holdout cases.

## L1 Context Eval

- [ ] 20 golden questions from [`examples/semantic/acme/evals/claims-context.golden.yaml`](../../semantic/acme/evals/claims-context.golden.yaml).
- [ ] `recall_at_budget` >= 0.80.
- [ ] `citation_validity` = 1.00.
- [ ] `silent_stale` = 0.
- [ ] `silent_conflict` = 0.
- [ ] `budget_efficiency` recorded (no hard threshold).
- [ ] Every degraded result has a `reason`.

## L2 Capability Eval

- [ ] Dataset >= 50 cases; holdout >= 10; version + digest recorded.
- [ ] `task_success` >= 0.85.
- [ ] `citation_validity` = 1.00 (blocking).
- [ ] `citation_coverage` >= 0.95.
- [ ] `groundedness` >= 0.85 with a calibrated judge.
- [ ] `refusal_precision` >= 0.90.
- [ ] `refusal_recall` >= 0.90.
- [ ] `pii_leak_rate` = 0 (blocking).
- [ ] `unauthorized_side_effect_rate` = 0 (blocking).
- [ ] `decision_coverage` = 1.00 (blocking).
- [ ] `audit_write_success` = 1.00 (blocking).
- [ ] No threshold metric regressed > 3 percentage points vs the active Release.
- [ ] `run_latency_p95` <= 30s; `retrieve_latency_p95` <= 300ms.
- [ ] `cost_per_successful_run` within the Capability budget; 80%/100% alerts configured (monitor, not a Release gate).
- [ ] 95% CI reported; no unexplained `inconclusive`; Waivers listed.
- [ ] Judge calibration agreement >= 0.70 Cohen's kappa or >= 85%.

## L3 Deployment / SLO

- [ ] Smoke: `/healthz`, `/readyz`, retrieve, decision, provenance, approval.
- [ ] 30-day availability >= 99.0%.
- [ ] Runtime API 5xx/timeout rate < 1%.
- [ ] `retrieve_latency_p95` <= 300ms; p99 <= 800ms.
- [ ] `run_latency_p95` <= 30s.
- [ ] `degraded_rate` < 5%.
- [ ] Audit write success 100%; side-effect Run Decision coverage 100%.
- [ ] Online eval coverage >= 95%; judge error rate < 1%.
- [ ] 2% judge sampling and daily cost cap configured.
- [ ] No open P1; open P2/P3 have owner and due date; Waiver list complete.
- [ ] Acceptance Report issued as a governance Decision; customer sign-off is handled by the delivery SOP.

## Beta Bank differential

- Same method; `kyc-review` / `document-triage`; CCP `beta-kyc-context@1.0.0`; Sources `beta-dms`, `core-banking`.
- Stricter PII: full mask for names and identity numbers; `pii_leak_rate` = 0 remains blocking.
- `recall_at_budget` >= 0.90; `groundedness` >= 0.90.
- Judge calibration must cover KYC terminology and refusal boundaries.
- Record diffs in Beta's Eval Suite/README; do not duplicate this checklist.

## Failure walkthroughs

- `sharepoint-claims` unavailable: retrieve returns `degraded=true, reason=partial`; the answer may use `claims-db`, but the prompt marks the document context as incomplete; no fabricated document citations. If L2 thresholds fail, the Release gate fails; in production use P2/P3 based on impact.
- Online sample detects PII: P1; kill switch + fail closed + preserve audit; roll back if Release-related; write an incident Decision.
- Audit write failure: side-effect Run fails closed (P1); read-only Run may return but is marked `audit_incomplete` and must not claim it was audited.
