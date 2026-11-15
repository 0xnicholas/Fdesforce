# PROTOTYPE — generated skeleton.
# Source: docs/runtime-contract.md §6.2 + migrations/001_audit_schema.sql
# The real service must be append-only and hash-chained; this is a minimal
# illustration of the wire shape, not a durable implementation.
import hashlib
import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

from . import settings


def _connect() -> sqlite3.Connection:
    settings.AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(settings.AUDIT_PATH)
    connection.execute(
        """
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
        )
        """
    )
    return connection


def write(payload: dict) -> dict:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    payload_digest = hashlib.sha256(canonical.encode()).hexdigest()
    connection = _connect()
    with connection:
        previous = connection.execute(
            "SELECT hash FROM audit_entries ORDER BY seq DESC LIMIT 1"
        ).fetchone()
        prev_hash = previous[0] if previous else "0" * 64
        entry_hash = hashlib.sha256(f"{prev_hash}{canonical}".encode()).hexdigest()
        decision_id = payload.get("decision_id") or f"dec_{uuid.uuid4().hex[:26].upper()}"
        connection.execute(
            """
            INSERT INTO audit_entries
              (decision_id, tenant_id, run_id, payload_json, payload_digest, prev_hash, hash, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                decision_id,
                payload["tenant_id"],
                payload["run_id"],
                canonical,
                f"sha256:{payload_digest}",
                prev_hash,
                entry_hash,
                datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            ),
        )
    return {
        "decision_id": decision_id,
        "provenance_id": f"prov_{uuid.uuid4().hex[:26].upper()}",
        "hash": entry_hash,
        "seq": connection.execute("SELECT last_insert_rowid()").fetchone()[0],
    }


def provenance(decision_id: str) -> dict | None:
    connection = _connect()
    row = connection.execute(
        "SELECT decision_id, payload_json, hash, created_at FROM audit_entries WHERE decision_id = ?",
        (decision_id,),
    ).fetchone()
    if row is None:
        return None
    payload = json.loads(row[1])
    return {
        "decision_id": row[0],
        "entry_hash": row[2],
        "created_at": row[3],
        "prov": {
            "@context": "https://www.w3.org/ns/prov#",
            "activity": payload.get("run_id"),
            "agent": payload.get("actor"),
            "used": payload.get("evidence", []),
            "generated": row[0],
        },
    }


def read(decision_id: str) -> dict | None:
    connection = _connect()
    row = connection.execute(
        "SELECT decision_id, payload_json, seq, hash FROM audit_entries WHERE decision_id = ?",
        (decision_id,),
    ).fetchone()
    if row is None:
        return None
    return {"decision_id": row[0], "payload": json.loads(row[1]), "seq": row[2], "hash": row[3]}
