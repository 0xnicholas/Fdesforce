"""Stable IDs the service mints (§4.2).

Only `provenance_id` is the service's to generate: `decision_id` belongs to the
caller, and the store treats it as the write's idempotency key. The shape is the
contract's (`ProvenanceId` = `prov_<26 Crockford base32>`), so a generated id is
validated here by the same pattern the schema declares, not by a second regex.
"""

from __future__ import annotations

import re
import time

from app.ids import new_provenance_id, new_ulid

#: `contracts/schemas/common.schema.json#/$defs/ProvenanceId`, transcribed.
PROVENANCE_ID = re.compile(r"^prov_[0-9A-HJKMNP-TV-Z]{26}$")


def test_a_provenance_id_is_the_contract_shape() -> None:
    assert PROVENANCE_ID.match(new_provenance_id())


def test_generated_ids_are_unique() -> None:
    ids = {new_provenance_id() for _ in range(2_000)}

    assert len(ids) == 2_000


def test_a_ulid_sorts_by_time() -> None:
    """The 48-bit timestamp prefix is why the id is a ULID and not a random string."""
    earlier = new_ulid("dec_")
    time.sleep(0.003)
    later = new_ulid("dec_")

    assert earlier < later


def test_the_prefix_is_the_caller_s() -> None:
    assert new_ulid("run_").startswith("run_")
    assert len(new_ulid("run_")) == len("run_") + 26
