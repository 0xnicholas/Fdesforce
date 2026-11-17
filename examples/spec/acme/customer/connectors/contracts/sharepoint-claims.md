# sharepoint-claims data contract (reference stub)

The documented `Connector.dataContract` field has no schema yet (GAPS.md GAP-1).
This file is the placeholder the document-extraction path resolves.

## Operations

### `listDocuments`

- Input: `{path: string}`
- Output: `{items: [{path, etag, modifiedAt}]}`
- Side effects: read
- Required scopes: `claims:documents:read`

### `readDocument`

- Input: `{path: string}`
- Output: `{path, etag, modifiedAt, content}`
- Side effects: read
- Required scopes: `claims:documents:read`

## Data classification

| Field | Classification | PII | Mask |
|---|---|---|---|
| path | internal | none | none |
| content | confidential | sensitive | redact |
