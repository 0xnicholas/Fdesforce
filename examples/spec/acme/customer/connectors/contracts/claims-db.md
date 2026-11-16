# claims-db data contract (prototype stub)

The documented `Connector.dataContract` field has no schema. This file is the
placeholder a prototype generator would need to resolve.

## Operations

### `lookupClaim`

- Input: `{ claimId: string }`
- Output: `{ claimId, policyNumber, customerId, amount, status }`
- Side effects: read
- Required scopes: `claims:read`

### `recordDecision`

- Input: `{ claimId, outcome, rationale, evidenceRefs[] }`
- Output: `{ decisionId, status }`
- Side effects: write
- Required scopes: `claims:write`, `decision:write`
- Idempotency: `Idempotency-Key` required, scoped by claim + run

## Data classification

| Field | Classification | PII | Mask |
|---|---|---|---|
| claimId | confidential | identifier | none |
| customerId | restricted | identifier | hash |
| amount | confidential | none | none |
| rationale | internal | none | none |
