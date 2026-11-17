"""The stable `entity_id`, and the rules that make it usable as a tenant filter.

`docs/runtime-contract.md` §4.2 fixes the shape — `fde:<tenant>:<type>:<key>` — and
three properties that everything else in the service leans on:

1. **Opaque and stable.** The id is minted by ingest and never re-derived from a
   backend's own identifier, so rebuilding, renaming or moving the graph does not
   change what a Decision cites. §4.2's `same_as` relationship is how a changed
   source key keeps the old id alive; nothing here reuses or renumbers one.
2. **Tenant-attributable.** The tenant is a segment of the id, and it is the same
   `TenantId` the `ExecutionContext` carries. That is what lets the graph store
   filter by tenant in one comparison (§5.3: the filter is server-side, never a
   client parameter) instead of trusting a property a writer might forget.
3. **Self-describing.** The type segment names the entity's domain type, in an
   id-safe spelling (`fde:acme:policy:refund` for a `Policy` — the contract's own
   example, §3.3), and the graph store refuses an entity whose declared type is not
   that word. A `Policy` whose id says `Claim` is two different answers to "what is
   this", and a retrieval that returned either would make the citation ambiguous.

The key is everything after the third colon, so keys may contain `:` and `.`
(`fde:acme:policy:claims/refund.md` style keys are ugly but not the parser's
business). Only the contract's own character class is allowed at all
(`^fde:[A-Za-z0-9._~:-]{1,200}$`), because the id travels on the wire.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

#: `EntityId` in `contracts/schemas/common.schema.json`.
_PATTERN = re.compile(r"^fde:(?P<rest>[A-Za-z0-9._~:-]{1,200})$")

#: `TenantId` in `contracts/schemas/common.schema.json`.
_TENANT = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}$")


class InvalidEntityId(ValueError):
    """Not an id this service can attribute to a tenant and a type."""


@dataclass(frozen=True, order=True)
class EntityId:
    """A parsed stable id. `render()` is the only way back to the wire form."""

    tenant: str
    type: str
    key: str

    def render(self) -> str:
        return render(self.tenant, self.type, self.key)

    def __str__(self) -> str:
        return self.render()


def parse(value: str) -> EntityId:
    """`value` as `(tenant, type, key)`, or a refusal naming the offending part."""
    matched = _PATTERN.fullmatch(value) if isinstance(value, str) else None
    if matched is None:
        raise InvalidEntityId(
            f"{value!r} is not an entity id: §4.2 fixes `fde:<tenant>:<type>:<key>` "
            "over the contract's character class"
        )

    parts = matched.group("rest").split(":", 2)
    if len(parts) != 3:
        raise InvalidEntityId(
            f"{value!r} names no key: `fde:<tenant>:<type>:<key>` needs all four segments"
        )
    tenant, type_name, key = parts
    if not _TENANT.fullmatch(tenant):
        raise InvalidEntityId(
            f"{value!r}: {tenant!r} is not a tenant id; the id's tenant must be the "
            "`TenantId` an `ExecutionContext` carries, or it cannot be filtered (§5.3)"
        )
    if not type_name:
        raise InvalidEntityId(f"{value!r} names no type")
    if len(type_name) > 100:
        raise InvalidEntityId(f"{value!r}: the type segment is longer than the wire's 100 characters")
    if not key:
        raise InvalidEntityId(f"{value!r} names no key")
    return EntityId(tenant=tenant, type=type_name, key=key)


def render(tenant: str, type_name: str, key: str) -> str:
    """`fde:<tenant>:<type>:<key>` — validated, so no caller can mint an unparseable id."""
    value = f"fde:{tenant}:{type_name}:{key}"
    parse(value)
    return value


def tenant_of(value: str) -> str | None:
    """The tenant segment, or `None` when the id is not one (§4.2's attribution rule)."""
    try:
        return parse(value).tenant
    except InvalidEntityId:
        return None
