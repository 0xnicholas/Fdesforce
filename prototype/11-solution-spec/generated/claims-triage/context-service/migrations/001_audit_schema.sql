-- PROTOTYPE — generated skeleton.
-- Source: docs/runtime-contract.md §6.4 + solution.lock#/runtime/auditSchema
CREATE TABLE IF NOT EXISTS audit_entries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_entries_tenant_run
  ON audit_entries (tenant_id, run_id);

CREATE TABLE IF NOT EXISTS audit_chain_head (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  seq INTEGER NOT NULL,
  hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
