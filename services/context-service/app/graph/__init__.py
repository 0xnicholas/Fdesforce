"""The internal graph side of context-service: a port, and the embedded backend.

`docs/runtime-contract.md` §4.3 fixes the arrangement: `GraphStore` is a port the
service owns, v0 ships exactly one implementation (`embedded` — Semantica's
in-process `ContextGraph` plus a JSON snapshot on the graph volume), and swapping
the backend later means replacing the implementation without touching the Context
API or the stable `entity_id`s.

Two rules keep that promise cheap:

- **One adapter imports Semantica.** `app.graph.semantica_graph` is the only
  module in this service allowed to `import semantica`; `scripts/semantica_surface.py`
  enforces it and checks every name it uses against the pinned wheel. An engine
  upgrade is then a reviewable diff, not a hunt.
- **No backend identifier leaves the port.** Every method speaks `entity_id`
  (`fde:<tenant>:<type>:<key>`, §4.2) and nothing else, so an implementation that
  happens to have integer node ids (Neo4j) or row ids (Postgres) cannot leak one.
"""
