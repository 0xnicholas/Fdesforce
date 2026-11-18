"""The append-only audit store (§6.4, C13/C14): evidence that cannot grow a second copy.

The audit volume is separate from the graph because the two have different
lifetimes: the graph is rebuilt from the Context Package, the audit trail is not.
This module is the only writer of *entries*. Schema is a separate act: `migrate()`
creates or converges the tables and triggers (the `python -m app.migrate` job, #38)
and `open()` only verifies what it finds — §9.2's order, enforced from both ends.
The store also holds the Retrieval Snapshots (§4.1) in their own append-only table,
because a Decision's evidence and the answer it was drawn from belong to the same
lifetime.

Every Decision entry is a link in a SHA-256 chain:

```text
payload        = canonical_json({seq, provenance_id, tenant_id, created_at, decision})
payload_digest = SHA-256(payload)
hash           = SHA-256(prev_hash || payload)
```

`prev_hash` is the previous entry's `hash`, and the first entry links to
`GENESIS_HASH`. Verification walks the chain and recomputes both digests, so a
rewritten payload, a broken link or a missing entry is a disagreement rather than
a silent edit.

What is *not* here:

- **No `verify_chain()` on the read path.** `verification()` reports the last
  recorded result in O(1) (plus one anchored hash lookup); `verify_chain()` walks
  the chain and is called by the background verifier (`app.audit_verifier`).
- **No raw prompt or output.** The field is the caller's `DecisionRequest`, whose
  schema carries digests and references rather than content (§6.5); there is no
  column that could hold anything else.

Two limits are deliberate and documented rather than papered over:

- append-only is enforced by triggers, so a privileged process could drop them.
  Verification then detects the rewrite, but a rewrite that recomputes every later
  link needs an external anchor to disprove — §6.4's "chain_head recorded on the
  Deployment Revision" is that anchor, and this slice does not yet have a
  deployment-revision store.
- the store is single-writer by contract (§4.3), so the write path serializes on a
  process lock and `BEGIN IMMEDIATE` rather than attempting multi-writer liveness.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote

from app.canonical import canonical_json, sha256_digest
from app.clock import isoformat_z, utc_now
from app.generated.versions import AUDIT_SCHEMA_VERSION
from app.ids import new_provenance_id

logger = logging.getLogger("fde.context_service.audit")

#: The first link's `prev_hash`: a well-formed digest that no entry can produce.
GENESIS_HASH = "sha256:" + "0" * 64

#: `PRAGMA application_id`, so the store refuses a SQLite file that is not this store.
APPLICATION_ID = 0x46444541  # "FDEA"

#: One message for every `decision_id` collision, including a cross-tenant one:
#: whether the id belongs to another tenant is not the caller's business (C3).
DUPLICATE_DECISION = (
    "this decision_id is already recorded; one decision_id is one Decision, "
    "so a different write needs a different id"
)

VerificationStatus = Literal["valid", "pending", "stale", "invalid"]
ChainStatus = Literal["valid", "invalid"]


#: The tables and triggers the evidence depends on. `migrate` creates them; `open`
#: refuses a store missing any of them, because "the version matches" and "the
#: append-only triggers are there" are different claims (§6.4).
REQUIRED_OBJECTS: tuple[str, ...] = (
    "audit_entry",
    "chain_verification",
    "retrieval_snapshot",
    "approval",
    "audit_entry_append_only_update",
    "audit_entry_append_only_delete",
    "retrieval_snapshot_append_only_update",
    "retrieval_snapshot_append_only_delete",
)


class AuditStoreError(RuntimeError):
    """The audit store cannot be the evidence the deployment needs."""


class AuditSchemaMismatch(AuditStoreError):
    """The file on the audit volume is not this schema version."""


class DecisionConflict(Exception):
    """This `decision_id` already names a different Decision (or another tenant's)."""


class RetrievalSnapshotConflict(Exception):
    """This `retrieval_id` already names a different Retrieval Snapshot (or another tenant's)."""


@dataclass(frozen=True)
class AuditEntry:
    """One link of the chain, as a reader sees it.

    `document` is exactly the payload that was hashed — `seq`, `provenance_id`,
    `tenant_id`, `created_at` and the original Decision — so an auditor can
    recompute the digests without reconstructing the store's ordering.
    """

    seq: int
    provenance_id: str
    decision_id: str
    tenant_id: str
    created_at: str
    document: Mapping[str, Any]
    payload_digest: str
    prev_hash: str
    hash: str

    @property
    def decision(self) -> Mapping[str, Any]:
        return self.document["decision"]


@dataclass(frozen=True)
class StoredSnapshot:
    """A Retrieval Snapshot as the audit volume holds it (§4.1).

    `manifest` is the hashed evidence; the rest is the identity of the call that
    produced it, kept so an auditor can tie the evidence to a trace and a time.
    """

    retrieval_id: str
    tenant_id: str
    trace_id: str
    created_at: str
    digest: str
    manifest: Mapping[str, Any]


@dataclass(frozen=True)
class AppendResult:
    """`created=False` means the write was a replay: same id, same payload, same entry."""

    entry: AuditEntry
    created: bool


@dataclass(frozen=True)
class VerificationState:
    """What the read path reports: the last background verification, and the chain head.

    `chain_head` is the head the verification covered, not the current head. When
    the chain has grown since, the status is `stale` and the digest still names
    what was checked.
    """

    status: VerificationStatus
    checked_at: str | None = None
    chain_head: str | None = None
    detail: str | None = None


@dataclass(frozen=True)
class ChainReport:
    """One full pass over the chain, recorded by `verify_chain()`."""

    status: ChainStatus
    verified_through_seq: int
    chain_head: str
    checked_at: str
    detail: str | None


class AuditStore:
    """`AUDIT_PATH` → an append-only, hash-chained SQLite store."""

    def __init__(self, path: str | Path, *, now: Callable[[], datetime] | None = None) -> None:
        self.path = Path(path)
        self._now = now if now is not None else utc_now
        self._connection: sqlite3.Connection | None = None
        # One connection, one writer, one process (§4.3). The lock is what makes
        # `BEGIN IMMEDIATE` a formality rather than a busy-retry loop.
        self._lock = threading.RLock()

    # -- lifecycle --------------------------------------------------------

    def open(self) -> AuditStore:
        """Open and **verify** the schema the migrate job established (§9.2).

        The service never writes schema: `python -m app.migrate` runs first (the
        topology's `dependsOn: [migrate]`), and a service that migrated its own
        volume would make that job's exit code decorative. Verification is the
        whole opening move — version stamp, store identity, and the tables and
        triggers the evidence depends on.
        """
        with self._lock:
            if self._connection is not None:
                return self
            connection = self._connect()
            try:
                self._verify(connection)
            except Exception:
                connection.close()
                raise
            self._connection = connection
            return self

    def migrate(self) -> AuditStore:
        """Establish or converge the schema. The migrate job's half of this module.

        Idempotent DDL: a missing table or trigger is created, an interrupted
        migration resumes, and a store already at this version with every object
        present is left alone. A *newer* store and another application's file are
        refusals, because neither is something a migration may guess at.
        """
        with self._lock:
            if self._connection is not None:
                return self
            connection = self._connect()
            try:
                self._establish(connection)
            except Exception:
                connection.close()
                raise
            self._connection = connection
            return self

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            connection = sqlite3.connect(
                self.path,
                timeout=10.0,
                isolation_level=None,  # explicit transactions; see `_transaction`
                check_same_thread=False,
            )
        except sqlite3.DatabaseError as error:
            raise AuditStoreError(f"cannot open the audit store at {self.path}: {error}") from error
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("PRAGMA synchronous = FULL")
        except sqlite3.DatabaseError as error:
            connection.close()
            raise AuditStoreError(f"cannot open the audit store at {self.path}: {error}") from error
        return connection

    def close(self) -> None:
        with self._lock:
            if self._connection is not None:
                self._connection.close()
                self._connection = None

    def __enter__(self) -> AuditStore:
        return self.open()

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _stamps(self, connection: sqlite3.Connection) -> tuple[int, int]:
        """`(user_version, application_id)`, or a startup failure naming the file."""
        try:
            version = int(connection.execute("PRAGMA user_version").fetchone()[0])
            application_id = int(connection.execute("PRAGMA application_id").fetchone()[0])
        except sqlite3.DatabaseError as error:
            raise AuditStoreError(f"{self.path} is not a readable SQLite database: {error}") from error
        return version, application_id

    def _verify(self, connection: sqlite3.Connection) -> None:
        """The store on the audit volume is exactly the schema this build writes."""
        expected = int(AUDIT_SCHEMA_VERSION)
        version, application_id = self._stamps(connection)
        if application_id != APPLICATION_ID:
            raise AuditSchemaMismatch(
                f"{self.path} is not an FDE audit store (application_id {application_id}); "
                "`python -m app.migrate` creates the schema and refuses to overwrite a foreign file"
            )
        if version != expected:
            raise AuditSchemaMismatch(
                f"the audit store at {self.path} is schema version {version}, and this build "
                f"writes version {expected}; run `python -m app.migrate` on the audit volume first "
                "(§9.2: the service verifies the schema, the job establishes it)"
            )
        present = _objects(connection)
        missing = sorted(set(REQUIRED_OBJECTS) - present)
        if missing:
            raise AuditSchemaMismatch(
                f"the audit store at {self.path} is missing {', '.join(missing)}; "
                "run `python -m app.migrate` to converge it"
            )

    def _establish(self, connection: sqlite3.Connection) -> None:
        """Create or converge the schema (the migrate job).

        `executescript` commits before it runs, so this is deliberately not inside
        `_transaction`: DDL is idempotent (`IF NOT EXISTS`). The application id is
        written before the version stamp on purpose — a crash between the two then
        leaves `version 0 + our id`, which the next run resumes. The reverse order
        would leave `our version + no id`, which is indistinguishable from a
        foreign file and would refuse a store we created.
        """
        expected = int(AUDIT_SCHEMA_VERSION)
        version, application_id = self._stamps(connection)
        # A fresh file is `version 0 + no id`; an interrupted migration of ours is
        # `version 0 + our id` (the id is written first, below). Anything stamped
        # but not ours belongs to another store, and a migration may not write into it.
        if application_id != APPLICATION_ID and not (application_id == 0 and version == 0):
            raise AuditSchemaMismatch(
                f"{self.path} is not an FDE audit store (application_id {application_id}, "
                f"user_version {version}); migrate will not write schema into a file it does not recognise"
            )
        if version > expected:
            raise AuditSchemaMismatch(
                f"the audit store at {self.path} is schema version {version}, newer than this "
                f"build's {expected}; a newer deployment wrote it, so this one must not downgrade it"
            )
        connection.executescript(_SCHEMA)
        connection.execute(f"PRAGMA application_id = {APPLICATION_ID}")
        connection.execute(f"PRAGMA user_version = {expected}")

    @contextmanager
    def _transaction(self, connection: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
        connection.execute("BEGIN IMMEDIATE")
        try:
            yield connection
        except BaseException:
            connection.execute("ROLLBACK")
            raise
        else:
            connection.execute("COMMIT")

    def _connected(self) -> sqlite3.Connection:
        if self._connection is None:
            raise AuditStoreError(f"the audit store at {self.path} is not open; call open() first")
        return self._connection

    # -- write ------------------------------------------------------------

    @contextmanager
    def write(self) -> Iterator[AuditTransaction]:
        """One `BEGIN IMMEDIATE`, for a writer whose decisions and rows are one commit.

        The chain has a second writer: the approval state machine (`app.approvals`),
        whose resource rows must move in the same commit as the Decision that moved
        them. A Decision appended while the approval stayed `pending` (or the
        reverse) would be evidence that disagrees with the resource it describes,
        with no way to tell which side is stale. So the seam is a transaction, not a
        second connection: everything written inside it commits together or not at
        all, and `append` is the same idempotent Decision write as `append_decision`.
        """
        with self._lock, self._transaction(self._connected()) as connection:
            yield AuditTransaction(connection, now=self._now)

    def append_decision(self, decision: Mapping[str, Any]) -> AppendResult:
        """Append one Decision, or replay the entry its `decision_id` already names.

        `decision_id` is the write's idempotency key (§4.2): a repeat with the same
        payload is the same write and must not append a second link (C13); a
        repeat with a different payload — or from another tenant — is a conflict,
        not a guess.
        """
        with self.write() as writes:
            return writes.append(decision)

    # -- retrieval snapshots ----------------------------------------------

    def append_retrieval_snapshot(self, record: StoredSnapshot) -> bool:
        """Append one Retrieval Snapshot. `False` means this exact one was already there.

        §4.1 puts the snapshot in the audit store, and a Decision cites it by
        `retrieval_id`, so the row has to be as immutable as the Decision it will
        support: the table's triggers refuse `UPDATE` and `DELETE`, and a second
        append under the same id is either the same bytes (a retry, not a second
        snapshot) or a conflict.

        The row is split in two on purpose. Its *identity* — `retrieval_id`, trace,
        time — is per call and lives in columns; its *evidence* is `manifest`, and
        `digest` covers exactly that. So two identical retrievals carry the same
        digest ("the same evidence"), while each is still its own snapshot ("this
        call's evidence").

        `digest` is checked against the manifest rather than trusted: it is the value
        the caller was given, and a row whose digest did not cover its manifest would
        be evidence nobody could re-verify.
        """
        payload = canonical_json(record.manifest)
        if sha256_digest(payload) != record.digest:
            raise ValueError(
                "the snapshot digest does not cover the manifest it names; "
                "a Decision citing this snapshot could never be re-verified"
            )
        if str(record.manifest.get("tenant_id")) != record.tenant_id:
            raise ValueError(
                "the snapshot manifest names a different tenant than the row; "
                "the filter column and the evidence it filters must agree"
            )

        with self._lock, self._transaction(self._connected()) as connection:
            existing = connection.execute(
                "SELECT * FROM retrieval_snapshot WHERE retrieval_id = ?", (record.retrieval_id,)
            ).fetchone()
            if existing is not None:
                if str(existing["digest"]) != record.digest or str(existing["tenant_id"]) != record.tenant_id:
                    raise RetrievalSnapshotConflict(
                        "this retrieval_id is already recorded with a different manifest; "
                        "one retrieval_id is one Retrieval Snapshot"
                    )
                return False
            connection.execute(
                """
                INSERT INTO retrieval_snapshot (retrieval_id, tenant_id, trace_id, created_at, digest, manifest)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    record.retrieval_id,
                    record.tenant_id,
                    record.trace_id,
                    record.created_at,
                    record.digest,
                    payload,
                ),
            )
            return True

    def retrieval_snapshot(self, retrieval_id: str, *, tenant_id: str) -> StoredSnapshot | None:
        """The snapshot `retrieval_id` names in `tenant_id`, or nothing (§5.3)."""
        with self._lock:
            row = self._connected().execute(
                "SELECT * FROM retrieval_snapshot WHERE retrieval_id = ? AND tenant_id = ?",
                (retrieval_id, tenant_id),
            ).fetchone()
        if row is None:
            return None
        return StoredSnapshot(
            retrieval_id=str(row["retrieval_id"]),
            tenant_id=str(row["tenant_id"]),
            trace_id=str(row["trace_id"]),
            created_at=str(row["created_at"]),
            digest=str(row["digest"]),
            manifest=json.loads(str(row["manifest"])),
        )

    # -- read -------------------------------------------------------------

    def decision(self, decision_id: str, *, tenant_id: str) -> AuditEntry | None:
        """The entry for `decision_id` in `tenant_id`, or nothing.

        The tenant filter is the read's authorization, not a hint: an id that
        belongs to another tenant is indistinguishable from an unknown id (C3).
        """
        with self._lock:
            row = self._connected().execute(
                "SELECT * FROM audit_entry WHERE decision_id = ? AND tenant_id = ?",
                (decision_id, tenant_id),
            ).fetchone()
        return None if row is None else _entry(row)

    def head(self) -> tuple[int, str]:
        """`(seq, hash)` of the newest entry, or `(0, GENESIS_HASH)` when empty."""
        with self._lock:
            row = self._connected().execute("SELECT seq, hash FROM audit_entry ORDER BY seq DESC LIMIT 1").fetchone()
        return (0, GENESIS_HASH) if row is None else (int(row["seq"]), str(row["hash"]))

    def __len__(self) -> int:
        with self._lock:
            return int(self._connected().execute("SELECT COUNT(*) FROM audit_entry").fetchone()[0])

    def verification(self) -> VerificationState:
        """The last recorded verification, related to the current head in O(1).

        This is the read path's whole contribution to C13: it never walks the
        chain. The recorded head is looked up directly, so a chain that shrank
        below what was verified reads `invalid` immediately.
        """
        with self._lock:
            connection = self._connected()
            record = connection.execute("SELECT * FROM chain_verification WHERE id = 1").fetchone()
            head_seq, _ = self.head()
            if record is None:
                return VerificationState(status="pending")

            checked_at = str(record["checked_at"])
            recorded_head = str(record["chain_head"])
            through = int(record["verified_through_seq"])
            if str(record["status"]) == "invalid":
                return VerificationState("invalid", checked_at, recorded_head, _detail_of(record))

            anchored = connection.execute("SELECT hash FROM audit_entry WHERE seq = ?", (through,)).fetchone()
            if through == 0:
                anchor_hash: str | None = GENESIS_HASH
            elif anchored is None:
                anchor_hash = None
            else:
                anchor_hash = str(anchored["hash"])
            if anchor_hash != recorded_head or through > head_seq:
                return VerificationState(
                    "invalid",
                    checked_at,
                    recorded_head,
                    f"the chain no longer contains the verified head at seq {through}",
                )
            if through < head_seq:
                return VerificationState("stale", checked_at, recorded_head)
            return VerificationState("valid", checked_at, recorded_head)

    # -- verification -----------------------------------------------------

    def verify_chain(self) -> ChainReport:
        """Walk the chain, recompute every link, and record the result (§6.4).

        Off the read path by construction: a separate read-only connection takes a
        consistent snapshot without holding the write lock, and the result is a
        single row the read path can look up. The cost is linear, which is why it
        is a background pass and not a request.
        """
        connection = self._read_only()
        try:
            rows = connection.execute("SELECT * FROM audit_entry ORDER BY seq").fetchall()
        finally:
            connection.close()

        prev_hash = GENESIS_HASH
        verified_through = 0
        detail: str | None = None
        for row in rows:
            failure = _chain_failure(row, expected_seq=verified_through + 1, prev_hash=prev_hash)
            if failure is not None:
                detail = failure
                break
            prev_hash = str(row["hash"])
            verified_through += 1

        report = ChainReport(
            status="invalid" if detail is not None else "valid",
            verified_through_seq=verified_through,
            chain_head=prev_hash,
            checked_at=isoformat_z(self._now()),
            detail=detail,
        )
        self._record(report)
        if detail is not None:
            logger.warning("audit chain verification failed at seq %s: %s", verified_through + 1, detail)
        return report

    def _read_only(self) -> sqlite3.Connection:
        return read_only_connection(self.path)

    def _record(self, report: ChainReport) -> None:
        with self._lock, self._transaction(self._connected()) as connection:
            connection.execute(
                """
                INSERT INTO chain_verification
                  (id, status, verified_through_seq, chain_head, checked_at, detail)
                VALUES (1, ?, ?, ?, ?, ?)
                ON CONFLICT (id) DO UPDATE SET
                  status = excluded.status,
                  verified_through_seq = excluded.verified_through_seq,
                  chain_head = excluded.chain_head,
                  checked_at = excluded.checked_at,
                  detail = excluded.detail
                """,
                (report.status, report.verified_through_seq, report.chain_head, report.checked_at, report.detail),
            )


class AuditTransaction:
    """The audit chain and a sub-store's rows, inside one transaction.

    `append` is the chain's one write: it links the new entry to the head and is
    idempotent by `decision_id`, so a retried transaction cannot produce two
    entries. `execute`/`fetchone`/`fetchall` are the same connection, which is what
    lets `app.approvals` read and update its own table and append the Decision in
    one commit.

    Nothing here begins or commits a transaction: the caller is already inside one
    (`AuditStore.write`), and a nested `BEGIN` is a SQLite error rather than a savepoint.
    """

    def __init__(self, connection: sqlite3.Connection, *, now: Callable[[], datetime]) -> None:
        self._connection = connection
        self._now = now

    def append(self, decision: Mapping[str, Any]) -> AppendResult:
        """Append one Decision inside this transaction, or replay the one its id names."""
        return _append(self._connection, decision, now=self._now)

    def execute(self, sql: str, parameters: Sequence[Any] = ()) -> sqlite3.Cursor:
        return self._connection.execute(sql, parameters)

    def fetchone(self, sql: str, parameters: Sequence[Any] = ()) -> sqlite3.Row | None:
        return self._connection.execute(sql, parameters).fetchone()

    def fetchall(self, sql: str, parameters: Sequence[Any] = ()) -> list[sqlite3.Row]:
        return self._connection.execute(sql, parameters).fetchall()


def _append(
    connection: sqlite3.Connection,
    decision: Mapping[str, Any],
    *,
    now: Callable[[], datetime],
) -> AppendResult:
    """One Decision into the chain: a new link, or the entry this `decision_id` names."""
    decision_id = str(decision["decision_id"])
    tenant_id = str(decision["tenant_id"])
    payload = canonical_json(decision)

    existing = connection.execute("SELECT * FROM audit_entry WHERE decision_id = ?", (decision_id,)).fetchone()
    if existing is not None:
        return _replay(existing, tenant_id, payload)

    head = connection.execute("SELECT seq, hash FROM audit_entry ORDER BY seq DESC LIMIT 1").fetchone()
    seq = 1 if head is None else int(head["seq"]) + 1
    prev_hash = GENESIS_HASH if head is None else str(head["hash"])
    entry = _build(seq, prev_hash, tenant_id, decision, now=now)
    connection.execute(
        """
        INSERT INTO audit_entry
          (seq, provenance_id, decision_id, tenant_id, created_at, payload, payload_digest, prev_hash, hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            entry.seq,
            entry.provenance_id,
            entry.decision_id,
            entry.tenant_id,
            entry.created_at,
            canonical_json(entry.document),
            entry.payload_digest,
            entry.prev_hash,
            entry.hash,
        ),
    )
    return AppendResult(entry=entry, created=True)


def _replay(row: sqlite3.Row, tenant_id: str, payload: str) -> AppendResult:
    """The entry `decision_id` already names — or a refusal to pretend it is one."""
    if str(row["tenant_id"]) != tenant_id:
        raise DecisionConflict(DUPLICATE_DECISION)
    stored = json.loads(str(row["payload"]))
    if canonical_json(stored["decision"]) != payload:
        raise DecisionConflict(DUPLICATE_DECISION)
    return AppendResult(entry=_entry(row), created=False)


def _build(
    seq: int,
    prev_hash: str,
    tenant_id: str,
    decision: Mapping[str, Any],
    *,
    now: Callable[[], datetime],
) -> AuditEntry:
    document = {
        "seq": seq,
        "provenance_id": new_provenance_id(),
        "tenant_id": tenant_id,
        "created_at": isoformat_z(now()),
        "decision": dict(decision),
    }
    payload = canonical_json(document)
    return AuditEntry(
        seq=seq,
        provenance_id=str(document["provenance_id"]),
        decision_id=str(decision["decision_id"]),
        tenant_id=tenant_id,
        created_at=str(document["created_at"]),
        document=document,
        payload_digest=sha256_digest(payload),
        prev_hash=prev_hash,
        hash=sha256_digest(prev_hash, payload),
    )


def read_only_connection(path: str | Path) -> sqlite3.Connection:
    """A second, read-only connection to the store at `path`.

    For a pass that must not hold the write lock and must not be able to change the
    file: the background `verify_chain`, and the migrate job's "what does this volume
    hold right now" probe. `mode=ro` also refuses a path that is not there, instead of
    creating an empty database — which is the difference between inspecting a volume
    and quietly making one.
    """
    uri = f"file:{quote(str(Path(path).resolve()), safe='/')}?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=10.0)
    connection.row_factory = sqlite3.Row
    return connection


def _entry(row: sqlite3.Row) -> AuditEntry:
    document = json.loads(str(row["payload"]))
    return AuditEntry(
        seq=int(row["seq"]),
        provenance_id=str(row["provenance_id"]),
        decision_id=str(row["decision_id"]),
        tenant_id=str(row["tenant_id"]),
        created_at=str(row["created_at"]),
        document=document,
        payload_digest=str(row["payload_digest"]),
        prev_hash=str(row["prev_hash"]),
        hash=str(row["hash"]),
    )


def _chain_failure(row: sqlite3.Row, *, expected_seq: int, prev_hash: str) -> str | None:
    """Why this link does not follow from the previous one, or None.

    Every column is checked against the payload it claims to summarise: a store
    that rewrote the `decision_id` index but not the payload would otherwise serve
    one Decision under another's id.
    """
    seq = int(row["seq"])
    label = f"seq {seq}"
    if seq != expected_seq:
        return f"{label}: expected seq {expected_seq}; the chain has a gap"
    payload = str(row["payload"])
    try:
        document = json.loads(payload)
    except json.JSONDecodeError:
        return f"{label}: the payload is not JSON"
    if not isinstance(document, dict):
        return f"{label}: the payload is not a JSON object"
    if canonical_json(document) != payload:
        return f"{label}: the payload is not canonical JSON"
    if str(row["payload_digest"]) != sha256_digest(payload):
        return f"{label}: payload_digest does not match the payload"
    if str(row["prev_hash"]) != prev_hash:
        return f"{label}: prev_hash does not link to the previous entry"
    if str(row["hash"]) != sha256_digest(prev_hash, payload):
        return f"{label}: hash does not cover prev_hash and the payload"
    decision = document.get("decision")
    if not isinstance(decision, dict):
        return f"{label}: the payload carries no Decision object"
    for column, asserted in (
        ("seq", document.get("seq")),
        ("provenance_id", document.get("provenance_id")),
        ("tenant_id", document.get("tenant_id")),
        ("created_at", document.get("created_at")),
        ("decision_id", decision.get("decision_id")),
    ):
        if str(row[column]) != str(asserted):
            return f"{label}: the {column} column disagrees with the payload"
    return None


def _detail_of(record: sqlite3.Row) -> str | None:
    return None if record["detail"] is None else str(record["detail"])


def _objects(connection: sqlite3.Connection) -> set[str]:
    """Every table and trigger name in the file."""
    rows = connection.execute("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')").fetchall()
    return {str(row["name"]) for row in rows}


_SCHEMA = """
CREATE TABLE IF NOT EXISTS audit_entry (
  seq            INTEGER PRIMARY KEY,
  provenance_id  TEXT NOT NULL UNIQUE,
  decision_id    TEXT NOT NULL UNIQUE,
  tenant_id      TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  payload        TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL UNIQUE
) STRICT;

CREATE INDEX IF NOT EXISTS audit_entry_tenant ON audit_entry (tenant_id, decision_id);

CREATE TRIGGER IF NOT EXISTS audit_entry_append_only_update
BEFORE UPDATE ON audit_entry
BEGIN
  SELECT RAISE(ABORT, 'audit_entry is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_entry_append_only_delete
BEFORE DELETE ON audit_entry
BEGIN
  SELECT RAISE(ABORT, 'audit_entry is append-only');
END;

-- Derived state, not evidence: the last verification pass. One row, overwritten
-- in place; it is what the read path reports (§6.4) and it anchors the tail.
CREATE TABLE IF NOT EXISTS chain_verification (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  status               TEXT NOT NULL CHECK (status IN ('valid', 'invalid')),
  verified_through_seq INTEGER NOT NULL,
  chain_head           TEXT NOT NULL,
  checked_at           TEXT NOT NULL,
  detail               TEXT
) STRICT;

-- The approval resource (§8.1, #40): a state machine over the Decisions that move
-- it. Mutable on purpose — `status` and `decided_at` are what a resource *is* —
-- while every transition also appends its Decision to the chain above, in the same
-- transaction. `request_key` is the create's Idempotency-Key, kept on disk so a
-- restart replays the original approval instead of minting a second one; `decide_*`
-- remembers the deciding request so a retry can answer with what it did.
CREATE TABLE IF NOT EXISTS approval (
  approval_id        TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  run_id             TEXT NOT NULL,
  capability_id      TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'consumed')),
  request            TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  decided_at         TEXT,
  request_decision_id   TEXT,
  request_provenance_id TEXT,
  decided_decision_id   TEXT,
  decided_provenance_id TEXT,
  request_key        TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  decide_key         TEXT,
  decide_fingerprint TEXT,
  UNIQUE (tenant_id, request_key)
) STRICT;

CREATE INDEX IF NOT EXISTS approval_tenant_status ON approval (tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS approval_run ON approval (tenant_id, run_id);

-- The Retrieval Snapshot manifest (§4.1): what a retrieval returned, by reference.
-- `manifest` is canonical JSON with one hash covering it; the content itself stays in
-- the graph, where it can be rebuilt (§6.5 keeps the audit store from holding a copy).
CREATE TABLE IF NOT EXISTS retrieval_snapshot (
  retrieval_id TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  trace_id     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  digest       TEXT NOT NULL,
  manifest     TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS retrieval_snapshot_tenant ON retrieval_snapshot (tenant_id, retrieval_id);

CREATE TRIGGER IF NOT EXISTS retrieval_snapshot_append_only_update
BEFORE UPDATE ON retrieval_snapshot
BEGIN
  SELECT RAISE(ABORT, 'retrieval_snapshot is append-only');
END;

CREATE TRIGGER IF NOT EXISTS retrieval_snapshot_append_only_delete
BEFORE DELETE ON retrieval_snapshot
BEGIN
  SELECT RAISE(ABORT, 'retrieval_snapshot is append-only');
END;
"""
