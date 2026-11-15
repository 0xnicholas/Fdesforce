# sharepoint-claims data contract (prototype stub)

## Operations

### `searchDocuments`

- Input: `{ query: string, topK: number }`
- Output: `{ items: [{ documentId, title, excerpt, sourceRef, version }] }`
- Side effects: read
- Required scopes: `claims:documents:read`

### `readDocument`

- Input: `{ documentId: string }`
- Output: `{ documentId, content, sourceRef, version }`
- Side effects: read
- Required scopes: `claims:documents:read`

## Data classification

Documents are `confidential`; extracted PII is classified at ingest and masked
at retrieval. The audit store only keeps references and digests.
