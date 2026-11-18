"""The `GraphStore` port's write rules, proved on the one implementation v0 ships.

Retrieval is asserted through HTTP (`tests/test_retrieval_http.py`) — the port is an
internal seam and nothing there doubles it. The write side is exercised end to end by
the ingest job (`tests/test_ingest.py`, `tests/test_ingest_job.py`), but its *error
semantics* are a port promise a second backend must keep, so this file writes through
the real `EmbeddedGraphStore` and reads the volume back, the way
`test_audit_store.py` proves the audit store's invariants at the store rather than
through the endpoint.

What a second backend must also do, and why each rule exists:

- an entity is attributable (`fde:<tenant>:<type>:<key>`, matching tenant and type)
  or it is refused — an unattributable node could only be returned as a citation
  with no source, or leak into another tenant's answer (§4.2, §5.3);
- an entity carries `source_ref` and `version` — `RetrievalItem` requires both, so an
  entity without them can never be served (§3.3);
- a relationship may not introduce an entity or cross a tenant — the engine happily
  creates a placeholder node for an unknown id, which would be a fact nobody wrote;
- writes are idempotent by `entity_id` and by `(source, predicate, target)`, because
  ingest is a rebuild-and-merge job, not an append log.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.graph import snapshot
from app.graph.embedded import EmbeddedGraphStore
from app.graph.port import Entity, InvalidEntity, InvalidRelationship, Relationship
from app.graph.snapshot import GraphSnapshotError

TENANT = "acme"


def entity(
    entity_id: str = "fde:acme:policy:refund",
    *,
    type: str = "Policy",
    content: str = "Premium customers may receive a refund within 30 days.",
    source_ref: str = "sharepoint://claims/policies/refund.md",
    version: str = "3",
) -> Entity:
    return Entity(
        entity_id=entity_id,
        type=type,
        content=content,
        source_ref=source_ref,
        version=version,
        attributes={"source_kind": "document"},
    )


@pytest.fixture
def path(tmp_path: Path) -> Path:
    """A migrated graph volume, as the job leaves it."""
    location = tmp_path / "graph" / "graph.json"
    snapshot.establish(location)
    return location


@pytest.fixture
def store(path: Path) -> EmbeddedGraphStore:
    opened = EmbeddedGraphStore(path).open()
    try:
        yield opened  # type: ignore[misc]
    finally:
        opened.close()


def test_an_entity_round_trips_through_the_volume(path: Path, store: EmbeddedGraphStore) -> None:
    store.upsert_entities(TENANT, [entity()])

    read = store.get_entity(TENANT, "fde:acme:policy:refund")
    assert read is not None
    assert read.type == "Policy"
    assert read.source_ref == "sharepoint://claims/policies/refund.md"
    assert read.version == "3"

    reopened = EmbeddedGraphStore(path).open()
    try:
        assert reopened.get_entity(TENANT, "fde:acme:policy:refund") is not None
        assert reopened.stats().nodes == 1, "a write is durable when it returns; the volume is the graph"
    finally:
        reopened.close()


def test_upserting_the_same_entity_twice_keeps_one_node_and_the_new_content(store: EmbeddedGraphStore) -> None:
    store.upsert_entities(TENANT, [entity()])
    store.upsert_entities(TENANT, [entity(content="Refunds are limited to 30 days.", version="4")])

    assert store.stats().nodes == 1
    read = store.get_entity(TENANT, "fde:acme:policy:refund")
    assert read is not None and read.version == "4" and read.content.startswith("Refunds are limited")


def test_an_entity_under_another_tenant_is_refused(store: EmbeddedGraphStore) -> None:
    with pytest.raises(InvalidEntity, match="tenant"):
        store.upsert_entities(TENANT, [entity("fde:beta:policy:refund")])

    assert store.stats().nodes == 0, "a refused batch leaves nothing behind"


def test_an_entity_without_a_source_or_a_version_is_refused(store: EmbeddedGraphStore) -> None:
    with pytest.raises(InvalidEntity, match="source_ref"):
        store.upsert_entities(TENANT, [entity(source_ref="")])
    with pytest.raises(InvalidEntity, match="version"):
        store.upsert_entities(TENANT, [entity(version="")])


def test_an_id_whose_type_disagrees_with_the_entity_is_refused(store: EmbeddedGraphStore) -> None:
    with pytest.raises(InvalidEntity, match="type"):
        store.upsert_entities(TENANT, [entity("fde:acme:claim:c-1001", type="Policy")])


def test_a_malformed_entity_id_is_refused(store: EmbeddedGraphStore) -> None:
    for malformed in (
        "policy:refund",  # no `fde:` prefix
        "fde:acme:policy",  # no key
        "fde:acme:policy:",  # empty key
        "fde:ACME:policy:refund",  # not a TenantId
        "fde:acme::refund",  # empty type
        "fde:acme:policy:refund/../../etc",  # outside the contract's character class
    ):
        with pytest.raises(InvalidEntity):
            store.upsert_entities(TENANT, [entity(malformed)])


def test_a_relationship_may_not_introduce_an_entity(store: EmbeddedGraphStore) -> None:
    """The engine invents a placeholder node for an unknown id; the port refuses to."""
    store.upsert_entities(TENANT, [entity()])

    with pytest.raises(InvalidRelationship, match="not in the graph"):
        store.upsert_relationships(
            TENANT,
            [
                Relationship(
                    source_id="fde:acme:policy:refund",
                    target_id="fde:acme:policy:unwritten",
                    predicate="related",
                )
            ],
        )

    assert store.stats().nodes == 1, "a refused relationship must not add the entity it named"


def test_a_relationship_may_not_cross_tenants(store: EmbeddedGraphStore) -> None:
    store.upsert_entities(TENANT, [entity()])
    store.upsert_entities("beta", [entity("fde:beta:policy:refund")])

    with pytest.raises(InvalidRelationship, match="tenant"):
        store.upsert_relationships(
            TENANT,
            [Relationship(source_id="fde:acme:policy:refund", target_id="fde:beta:policy:refund", predicate="related")],
        )

    assert store.stats().edges == 0


def test_upserting_the_same_relationship_twice_keeps_one_edge(store: EmbeddedGraphStore) -> None:
    store.upsert_entities(
        TENANT,
        [entity(), entity("fde:acme:policy:approval", content="Refunds over 100000 need approval.")],
    )
    relationship = Relationship(
        source_id="fde:acme:policy:refund", target_id="fde:acme:policy:approval", predicate="governedBy", weight=0.8
    )

    store.upsert_relationships(TENANT, [relationship])
    store.upsert_relationships(TENANT, [relationship])

    assert store.stats().nodes == 2
    assert store.stats().edges == 1


def test_a_relationship_weight_outside_the_unit_interval_is_refused(store: EmbeddedGraphStore) -> None:
    store.upsert_entities(TENANT, [entity(), entity("fde:acme:policy:approval")])

    for weight in (0.0, 1.5):
        with pytest.raises(InvalidRelationship, match="weight"):
            store.upsert_relationships(
                TENANT,
                [
                    Relationship(
                        source_id="fde:acme:policy:refund",
                        target_id="fde:acme:policy:approval",
                        predicate="governedBy",
                        weight=weight,
                    )
                ],
            )


def test_another_tenants_entity_is_not_found_rather_than_forbidden(store: EmbeddedGraphStore) -> None:
    """§5.3: a read that filters by tenant must not confirm that an id exists elsewhere."""
    store.upsert_entities(TENANT, [entity()])

    assert store.get_entity("beta", "fde:acme:policy:refund") is None
    assert store.lexical_search("beta", "refund", limit=10) == []


def test_a_snapshot_from_another_graph_schema_is_refused(tmp_path: Path) -> None:
    location = tmp_path / "graph" / "graph.json"
    snapshot.write(location, {"fde_schema": {"kind": snapshot.SCHEMA_KIND, "version": "99"}, "nodes": [], "edges": []})

    with pytest.raises(GraphSnapshotError, match="schema version"):
        EmbeddedGraphStore(location).open()


def test_deleting_by_source_removes_the_entities_and_the_edges_that_touched_them(
    store: EmbeddedGraphStore,
) -> None:
    """Ingest's rebuild path: a re-read source replaces its facts, it does not accumulate them."""
    store.upsert_entities(
        TENANT,
        [
            entity(),
            entity(
                "fde:acme:policy:approval",
                content="Refunds over 100000 need approval.",
                source_ref="sharepoint://claims/policies/approval.md",
            ),
            entity("fde:acme:claim:c-1001", type="Claim", source_ref="claims-db://claims/C-1001"),
        ],
    )
    store.upsert_relationships(
        TENANT,
        [
            Relationship(
                source_id="fde:acme:policy:refund",
                target_id="fde:acme:policy:approval",
                predicate="governedBy",
            ),
            Relationship(
                source_id="fde:acme:claim:c-1001",
                target_id="fde:acme:policy:refund",
                predicate="hasPolicy",
            ),
        ],
    )

    removed = store.delete_source_ref(TENANT, "sharepoint://claims/policies/refund.md")

    assert removed == 1
    assert store.get_entity(TENANT, "fde:acme:policy:refund") is None
    assert store.stats().nodes == 2
    assert store.stats().edges == 0, "an edge to a removed entity would cite something the graph no longer has"


def test_deleting_by_source_is_scoped_to_the_tenant(store: EmbeddedGraphStore) -> None:
    store.upsert_entities(TENANT, [entity()])
    store.upsert_entities("beta", [entity("fde:beta:policy:refund", source_ref="sharepoint://beta/policies/refund.md")])

    assert store.delete_source_ref("beta", "sharepoint://claims/policies/refund.md") == 0
    assert store.get_entity(TENANT, "fde:acme:policy:refund") is not None
    assert store.get_entity("beta", "fde:beta:policy:refund") is not None


def test_deleting_an_unknown_source_removes_nothing(store: EmbeddedGraphStore) -> None:
    store.upsert_entities(TENANT, [entity()])

    assert store.delete_source_ref(TENANT, "sharepoint://claims/policies/never-seen.md") == 0
    assert store.stats().nodes == 1


def test_an_entity_the_response_could_not_carry_is_refused(store: EmbeddedGraphStore) -> None:
    """The wire's own maxima are the store's: a 500 inside a handler is not a validation error.

    `RetrievalItem.content` allows 20 000 characters and `source_ref` 500; an entity
    over those would fail model validation while the response was being built, which
    is a mapping bug surfacing as a server error on a caller's retrieval.
    """
    for over in (
        Entity(
            entity_id="fde:acme:document:long",
            type="Document",
            content="x" * 20_001,
            source_ref="sharepoint://claims/long.md",
            version="1",
        ),
        Entity(
            entity_id="fde:acme:document:long",
            type="Document",
            content="short",
            source_ref="sharepoint://claims/" + "d/" * 300 + "refund.md",
            version="1",
        ),
    ):
        with pytest.raises(InvalidEntity, match="characters"):
            store.upsert_entities(TENANT, [over])

    assert store.stats().nodes == 0
