# `services/context-service`

The platform-owned Python service that serves the internal Context API
(`contracts/context-service-v1.openapi.yaml`). One service, not generated per
Solution: Customer and Solution differences arrive as the compiled Customer
Context Package and environment configuration, never as source
(`docs/runtime-contract.md` §2).

This directory holds the wire surface, the error envelope, the probes, the
contract-derived models, the C1–C15 runner — and, since #36, the **identity
boundary**: ES256 `ExecutionContext` verification, server-side tenant/scope
enforcement and write idempotency. Since #37 it also holds the **audit store**: an
append-only, hash-chained SQLite ledger on its own volume, the idempotent Decision
write, and the provenance read. Since #38 it holds the **graph**: a `GraphStore`
port with one embedded implementation (Semantica's `ContextGraph` over a JSON
snapshot on the graph volume) and the `migrate` job that establishes both volumes.
Since #39 it holds the **Recipe pipeline** — the whole of
`resolve → structured → graph → lexical → merge → rank → mask → budget`, executed
from the frozen Customer Context Package rather than from a strategy in this file —
plus the **ingest job** that materializes that package's sources into the graph, the
**Connector typed operations** a Tool reaches its customer system through, and the
degraded semantics that make an incomplete graph say so. Approvals land in #40; the
table below says exactly which handler is whose.

## Layout

```text
app/
  main.py            create_app: the one place the service is assembled
  settings.py        environment → Settings; missing configuration fails at startup
  readiness.py       the probe registry /readyz evaluates (ready | degraded | not_ready)
  runtime_info.py    GET /v1/runtime-info, built through the generated RuntimeInfo model
  errors.py          FdeError + handlers: every non-2xx is the unified envelope (§3.4)
  identity.py        ES256 ExecutionContext verification, issuer keys, jti replay (§5.1, §5.4)
  identity_edge.py   the middleware that requires a token and enforces tenant/scope (§5.3)
  idempotency.py     Idempotency-Key: scope, payload fingerprint, replay, conflict (§3.5)
  canonical.py       canonical JSON + SHA-256, shared by the chain and the fingerprint
  ids.py             the service-minted stable ids (`prov_<ULID>`, `ret_<ULID>`)
  audit.py           the append-only, hash-chained SQLite audit store (§6.4) + Retrieval Snapshots (§4.1)
  audit_verifier.py  the background verify_chain pass (startup + periodic)
  provenance.py      Decision → PROV-O JSON-LD + lineage summary (§6.3, C14)
  migrate.py         `python -m app.migrate`: the job that establishes both schemas (§9.2)
  retrieval.py       the Recipe pipeline: resolve → structured → graph → lexical → merge →
                     rank → mask → budget → snapshot (every stage read from the package)
  mask.py            the permission baseline (§7): class scopes, property masks, denials
  content.py         how an entity's content is rendered — once, so a digest is stable
  context_package.py the frozen Customer Context Package: recipes, sources, mappings,
                     permissions, revisions — and the refusals `fde context validate` makes
  connectors/        the Connector port and the two synthetic reference sources
    port.py          read() for ingest, invoke() for a typed operation, four error classes
    claims_db.py     `claims-db`: the public.* datasets and `lookupClaim`, from a seed
    documents.py     `sharepoint-claims`: the document corpus, chunked by heading
  ingest.py          the compile step: package + sources → entities and edges; also
                     `python -m app.ingest`, the container the topology runs
  ingest_ledger.py   the ledger on the graph volume: package revision, watermarks, and
                     IngestStatus — the one answer `/readyz` and `retrieve` share
  jobs_identity.py   minting a `fde-jobs` ExecutionContext (the maintenance side of §5.4)
  limits.py          the published envelope (§7.2, §4.3) the pipeline enforces
  graph/
    port.py          the GraphStore port: methods, stable-ID rules, error semantics (§4.3)
    entity_id.py     `fde:<tenant>:<type>:<key>` — parse, render, tenant attribution (§4.2)
    embedded.py      the v0 implementation, over Semantica's ContextGraph
    semantica_graph.py  the ONE module that imports semantica (see the pin, below)
    snapshot.py      the graph volume's envelope: schema stamp + the engine's payload
    probes.py        what /readyz says about the graph (loaded? over the ceiling?)
  contract.py        the request seam: JSON Schema validation + body↔token identity binding
  schema_registry.py JSON Schema registry + validation helpers
  tracing.py         traceparent → trace_id for every envelope (C6)
  wire.py            the generated models' base class and the Operation table types
  routes/            one module per OpenAPI tag: ops, context, connectors, decisions,
                     approvals, jobs
  generated/         GENERATED from contracts/ — never hand-edited
conformance/         the C1–C15 runner, its real-process ES256 key harness, and the graph-volume fixture
scripts/generate.py  contracts/ → app/generated/**; `--check` runs in CI
scripts/semantica_surface.py   every semantica import vs the pinned wheel; runs in CI and in the image build
semantica-surface.json         the reviewed surface: modules, names, class members, and the one adapter
tests/               pytest, against a spawned process for the HTTP surface
```

### Generated, not written

`app/generated/**` comes from `contracts/` via `scripts/generate.py`:

| Module | Contents |
| --- | --- |
| `models.py` | Pydantic models for the OpenAPI document's schema closure |
| `schemas.py` | the JSON Schema documents the runtime validates against |
| `api.py` | the operation table: method, path, auth, required scope, issuer, header requirements, request/response schemas, replay status |
| `versions.py` | the runtime contract minor, the service pin, graph/audit schema versions |

Pydantic is the **shape**; JSON Schema is the **validator**. `app.contract`
validates every request body against the schema the operation declares, so rules
Pydantic cannot express (`if/then`, `propertyNames`, `uniqueItems`) are enforced
exactly once — by the contract. The models make the same data typed for the code
that serves it.

`app/generated/**` is fresh or CI fails (`python scripts/generate.py --check`),
and `tests/test_generated.py` also asserts it byte-for-byte.

## The migrate job, and why the service refuses to start without it

`platform/context-service/1.1.0/topology.yaml` runs `python -m app.migrate` before
`context-service` and makes the service wait on its exit (`dependsOn: [migrate]`).
§9.2 says which side owns what, and the split is enforced in both directions:

| Who | Does |
| --- | --- |
| `python -m app.migrate` | creates or converges the audit schema and the graph snapshot |
| `context-service` | **verifies** both, and stops the process if a volume was not prepared |

A service that created its own schema would make the topology's order decorative: a
volume nothing had migrated could still reach a serving process, and the exit code
the deployment waits for would gate nothing. So `AuditStore.open()` compares the
version stamp, the store identity and the tables/triggers, and
`EmbeddedGraphStore.open()` reads the snapshot's schema stamp; either refusal names
the job that fixes it.

The job is idempotent — it runs on every `docker compose up` — additive (a missing
table or trigger is created; an interrupted migration resumes), and it will not
touch a file it does not recognise: a newer audit schema or a foreign snapshot is a
non-zero exit and a message, never an overwrite. It takes the stores' paths only
(`Settings.storage_from_env`): the maintenance surface holds no `ExecutionContext`
and the topology gives it no issuer keys (§5.4).

## The graph: a port, one adapter, one snapshot

§4.3 fixes the arrangement. `GraphStore` (`app/graph/port.py`) is the service's
internal port — method set, stable `entity_id` rules, and three error classes a
caller can act on — and v0 ships exactly one implementation, `embedded`: Semantica's
`ContextGraph` in process, over a JSON snapshot on the graph volume. The production
answer is Postgres + pgvector (`docs/research/retrieval-index-selection.md` §5.1);
swapping it replaces the implementation, not the port, the `entity_id`s or the
Context API.

Three rules the engine does not give us, and the store therefore does:

- **Attributable or refused.** An entity's id must parse as
  `fde:<tenant>:<type>:<key>`, its tenant must be the write's tenant, its declared
  type must match the id's type segment, and it must carry `source_ref` and
  `version` — `RetrievalItem` requires both, so an entity without them could only
  ever be served as a citation with no source.
- **An edge never invents an entity.** Semantica's `add_edge` silently creates a
  placeholder node for an unknown id. The store checks both ends first: a
  relationship is an assertion about two things the graph holds, not a way to
  introduce them.
- **Writes are durable when they return.** The snapshot is rewritten atomically after
  each accepted batch. The volume is ingest's output; a crash between accepting a
  batch and saving it would hand the next retrieval a graph that never existed.

The volume file is an envelope around the engine's own payload — `fde_schema`
(`kind`, `version`), `graph_id`, `written_at`, `nodes`, `edges` — because the
platform needs to know which graph schema wrote it and whether it was written at
all. Semantica ignores the keys it does not know, so `ContextGraph.load_from_file`
can still read it, and `graph_id` is minted once by `migrate` and preserved, so a
backup has a stable name.

## The Recipe pipeline: the package decides, the service executes

`POST /v1/context/retrieve` runs the recipe the request names, stage by stage, in the
package's order (`docs/semantic-modeling.md` §6.2–6.4). Nothing about the pipeline is
decided in this service: the stages, their weights, the relations the walk may follow,
the classes a source is trusted for and the budget ceilings are the `ContextRecipe`'s,
and `app.context_package` refuses a package whose recipe reorders, duplicates or drops a
stage. The model selects a recipe and fills a query; it never writes one (§6.1) — an
unknown `recipe_id` is a `404 recipe_not_found` that lists what the package does declare.

| Stage | What it does here |
| --- | --- |
| `resolve` | the business object, in three decreasingly certain steps: `filters[key]` (deterministic), a key-shaped query token that names an entity, then a lexical match *inside the recipe's class* — §6.3's "解析不到 → 图/词法实体匹配", which is what keeps `graph`'s `from: resolved` true. No anchor, no walk: a neighbourhood of a guess is not evidence |
| `structured` | the resolved object **and its one-hop joins of the classes the recipe names**, from the source it trusts. A SQL source would answer it with one join over the mapped tables, so this is the graph equivalent; everything further, or from another source, belongs to the next stage. v0 reads it from the graph because ingest already applied the mapping — the Connector typed operation is the Tool seam, not a second data path inside a retrieval |
| `graph` | 1–`maxHops` out from the resolved entity, over the recipe's `relations` only (`ic:hasPolicy`, never "every edge"), scored `anchor × 0.5^hop × edge weight` |
| `lexical` | the query's matches inside the recipe's declared source, top-K as declared |
| `merge` | one candidate per `entity_id`, and one per content hash when the recipe dedupes on it; the best path to an entity wins |
| `rank` | `score = recipe weight × stage score`, plus the recipe's `freshnessBoost` when ingest recorded the entity fresh. A stage the recipe does not weight contributes `0` — the schema makes each weight optional, and a default of `1.0` would let a lexical hit outrank the exact fact §6.3 puts above it |
| `mask` | the permission baseline (§7): a class the caller's scopes do not reach is withheld and recorded, a masked property is replaced *before* the content is re-rendered |
| `budget` | the recipe's ceilings, tightened by the caller's (a caller may ask for less, never more), packed in rank order |

Three consequences worth reading twice.

**Weights are the priority, not a tie-break.** With the Acme recipe
(`structured: 0.5, graph: 0.3, lexical: 0.2`) an exact fact of the declared source scores
`0.5`, a two-hop reach `0.3 × 0.25`, and a lexical match at most `0.2` — so §6.3's
"exact > graph > lexical" is arithmetic rather than a rule bolted on after ranking.
`tests/test_recipe_pipeline.py` asserts those numbers from the recipe, not from the
implementation.

**Dedupe merges, it does not discard.** A content-hash duplicate keeps one item, and the
loser's `entity_id`, `source_ref` and `version` ride along in the survivor's
`metadata.merged`: §6.3's "冲突保留，不丢弃候选" is about not losing a citation to a
rendering coincidence.

**Freshness is decided at ingest.** A score that moved with the wall clock would change
the snapshot digest between two identical calls. Ingest records `fresh`/`stale` against
the source's `staleAfter`, so the boost is a property of the graph revision a Decision
cites.

**A mask that cannot be applied is not a mask.** A property whose baseline declares
`columnMask: hash` is replaced and the content is re-rendered from the masked facts —
masking the field while leaving the original string in `content` would mask nothing. A
class whose scopes the caller lacks is dropped and recorded as a `deny` policy
evaluation in the response (and in the snapshot manifest), so a Decision can say which
class of context was withheld instead of silently receiving less.

The response reports:

- `items[]` with `entity_id`, `type`, `content`, `score`, `source_ref`, `version`,
  `classification` (the baseline's, never the source's own, and `restricted` when the
  baseline is silent), `source_kind`/`provenance_id` when the entity carries them, and
  `trust: untrusted` always (C33: retrieved content is data, never instructions);
- `index` — `graph` when the walk contributed an item, `lexical` when it did not;
- `degraded` + `reason`, most specific first: `scale_limit` when the graph is past the
  embedded ceiling (10k nodes / 50k edges, §4.3) and the walk is skipped rather than
  attempted slowly; `partial` while ingest has not finished (§9.2 — the graph is not the
  source's current state yet) or when the caller's budget excluded everything that
  matched; `empty` only when the graph is complete and nothing matched;
- `policy_evaluations[]` when a class was withheld (§7.2);
- `budget_used`: nodes, an estimated token count (`chars / 4`, deterministic and
  documented rather than a tokenizer dependency), and the deepest hop kept.

**The Retrieval Snapshot** (§4.1) is what makes the answer evidence rather than
prose. `retrieval_id` names it; the audit store keeps its *manifest* — the request's
digest, item references with a content digest each, the budget, the degradation —
and `snapshot_digest` is the SHA-256 of that manifest. Two consequences worth
knowing:

- content stays in the graph. The audit store keeps references and digests, not a
  second copy of the customer's text (§6.5), and the query is represented by its
  digest too;
- identical retrievals carry the identical digest, while each is still its own
  snapshot (its `retrieval_id`, trace and time are the row's identity, outside the
  hash). So "the same question got the same evidence" is checkable, and so is "this
  snapshot has not been edited" — the table's triggers refuse `UPDATE`/`DELETE`,
  and the digest is re-checked on append, so a row whose digest does not cover its
  manifest cannot exist.

A failed append fails the request (`503 unavailable`, retryable) instead of handing
out a `retrieval_id` that names nothing: a Decision citing it would be a dead
reference.

## Ingest: the package materialized, and the ledger that says so

`python -m app.ingest` is the container the topology runs after the service is up, and
`POST /internal/v1/jobs/ingest` is the same job over HTTP (`fde-jobs` issuer,
`context:ingest`, not Run-scoped). Neither blocks readiness: §9.2 puts the job *after*
the service, and until it finishes `/readyz` answers `degraded` and `retrieve` answers
`reason=partial`.

Per declared Context Source the job reads the source's records through its Connector
(resumed from the watermark for `incremental`), applies the package's mapping —
`entity_id` from `fde:<tenant>:<type>:<key>`, `content` rendered from the mapped
properties, `source_ref` naming the row (`claims-db://public.claims/C-1001`), `version`
the watermark value — and writes one batch of entities, then the edges whose both ends
now exist. Five rules it keeps rather than optimizes away:

- **only frozen semantics.** The request names a package revision; the package's
  `revisions/<version>.yaml` is `fde context freeze`'s attestation, and a digest that is
  not that one is `409 package_not_frozen`. The runtime materializes what was signed off,
  never what a caller asserts;
- **a missing source degrades, it never vanishes.** A Connector that raises is one
  source's failure: the others still materialize, the job reports which one and why, the
  ledger keeps the graph `partial`, and every retrieval says so;
- **a record the wire cannot carry fails its source, not the job.** The store refuses an
  entity outside a `RetrievalItem`'s maxima (`content`, `source_ref`, `version`, type).
  The job turns that refusal into the source's `failed` outcome and drops its watermark,
  so the next `incremental` run re-reads the rows rather than resuming past them;
- **a key that is not an id is counted, not raised.** A source key or relation target
  outside `fde:<tenant>:<type>:<key>`'s character class cannot name an entity. The row or
  edge is dropped, the source is `degraded` with the count, and the rest still
  materializes;
- **an edge never invents an entity.** A relation whose target the package does not
  produce is dropped and counted. A dangling reference is a package or a data problem an
  operator should see, not a fact to make up.

`rebuild` drops what the source previously contributed *after* a successful read (a
rebuild whose source turned out to be unreachable must not leave the graph emptier than
it found it), `backfill` re-reads everything, `incremental` resumes from the ledger's
watermark. §5.5 says a backfill "replays a window" and `IngestJobRequest` has no field to
name one, so v0's `backfill` is a full re-read; a window is a contract change, not a flag
this job invents.

**The ledger** (`<GRAPH_PATH>/../ingest.json`) is what makes any of that survive a
restart: which package revision the graph came from, each source's outcome, and the
watermarks the next run resumes from. It lives on the graph volume because the snapshot
and the record of what produced it must be backed up, restored and replaced together.
`IngestStatus` is its only reader, and `/readyz` plus `retrieve` both go through it —
one decision, two readers, so an operator and a caller cannot be told different things:

| Ledger | `/readyz` | `retrieve` |
| --- | --- | --- |
| absent | `degraded` `ingest: not_started` | `partial` |
| another package revision | `degraded` `ingest: stale` | `partial` |
| this package, a source degraded/failed | `degraded` `ingest: partial (…)` | `partial` |
| this package, all sources ok | `ready` | complete (unless the graph is over its ceiling) |

## Connectors: two synthetic sources, one seam

v0 ships the **reference** sources, so a deployment can be ingested and retrieved before
any customer Connector exists (`docs/semantic-modeling.md` §5.1):

| Connector | Serves | Typed operations |
| --- | --- | --- |
| `claims-db` | `public.claims`, `public.policies`, `public.coverages`, `public.customers`, `public.fraud_flags` from a seed, with the pre-joined relation keys a SQL Connector would produce from the mapping's `join` | `lookupClaim` |
| `sharepoint-claims` | the policy corpus, pre-chunked by heading | none — a document source is retrieved, never called |

`POST /v1/connectors/{connector_id}/operations` is the **one seam** a Connector-backed
Tool has (`docs/runtime-adapter.md` D6). `claims-lookup` calls it; context-service calls
the Connector. So the Tool never holds Connector credentials and never learns the data
source's address, and the two permissions that matter are enforced where the credentials
are: the operation's platform scope (`context:retrieve`) authorizes context access, and
`permissions.yaml` authorizes *this data* — the same `scopes` map the mask stage applies,
so a Tool call and a retrieval cannot disagree about who may see a claim. `output_digest`
is the SHA-256 of the canonical result, so a Decision's outcome can cite what the Tool
returned without keeping a second copy of it (§6.5).

The seeds are part of the image (`app/connectors/seed/`), because a *reference* source is
what makes the deployment runnable with nothing to provision; a real Connector implements
the same port (`read` for ingest, `invoke` for a typed operation) and changes nothing above
it.

## The Semantica pin: asserted, then verified

The prototype asserted a Semantica version and never checked it. `semantica==0.7.0`
is pinned in `pyproject.toml` and in `platform/toolchain.yaml`
(`spec.versions.semantica`, compiled into `app/generated/versions.py`), and
`scripts/semantica_surface.py` runs in CI **and inside the image build**:

1. the installed distribution's version must equal the pin;
2. every `semantica` import in the service's sources must resolve on that wheel —
   module present, and each imported name present (or a submodule);
3. `semantica-surface.json` is the reviewed list of what the service depends on: an
   import that is not listed fails (so widening the dependency is a deliberate diff
   via `--write`), and every listed name — and declared class member — must still
   exist (so a patch release that removes something is caught even when no source
   changed);
4. inside `app/` — the half the image ships — Semantica may only be imported by
   `app/graph/semantica_graph.py`. One adapter, per
   `docs/research/semantic-layer-selection.md` §5.4, so an engine upgrade is one
   file's diff.

The wheel is not pinned by hash: there is no Python lockfile in this slice, and a
hash lock belongs to the toolchain (#33). What is pinned is the exact version, and
what is verified is the export surface this service actually uses.

## Running it

```bash
cd services/context-service
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -e '.[dev]'

python -m pytest             # unit + real-process HTTP tests
python -m conformance        # C1–C15 runner (C1–C6, C10, C13, C14, C15 in this slice)
python -m conformance --list # what runs, what is pending, and which ticket owns it
python scripts/generate.py --check
python scripts/semantica_surface.py           # imports vs the pinned wheel
ruff check app conformance scripts tests
```

To serve it by hand, prepare the volumes first — the service verifies them, it does
not create them:

```bash
GRAPH_PATH=./data/graph/graph.json \
AUDIT_PATH=./data/audit/audit.sqlite \
python -m app.migrate

GRAPH_BACKEND=embedded \
GRAPH_PATH=./data/graph/graph.json \
AUDIT_PATH=./data/audit/audit.sqlite \
CONTEXT_PACKAGE_PATH=../../examples/semantic/acme \
EXECUTION_CONTEXT_PUBLIC_KEY="$(cat execution-context.pub.pem)" \
FDE_JOBS_PUBLIC_KEY="$(cat jobs.pub.pem)" \
python -m uvicorn --factory app.main:create_app --host 127.0.0.1 --port 8011
```

The deployment's next step is the ingest job, which is what turns `/readyz` from
`degraded` to `ready`:

```bash
CONTEXT_SERVICE_URL=http://127.0.0.1:8011 \
CONTEXT_PACKAGE_PATH=../../examples/semantic/acme \
FDE_DEPLOYMENT_ID=dep_01ARZ3NDEKTSV4RRFFQ69G5FAV \
FDE_SOLUTION_ID=claims-triage \
FDE_JOBS_SIGNING_KEY=jobs.priv.pem \
python -m app.ingest --mode=incremental
```

`--factory` is deliberate: the module has no import-time `app`, so configuration
is read when the process starts (and a missing issuer key stops it there, which
is what fail-closed means), and a test can import `app.main` without a
deployment's environment.

`/healthz` is liveness; `/readyz` is serviceability and may answer `degraded`
with reasons. Neither needs a token.

## The conformance runner

`conformance/harness.py` spawns the **real** service
(`uvicorn --factory app.main:create_app`, a free port, a temp data volume) and
talks to it over HTTP. Nothing imports the app to assert on it: a case that called
a handler directly could pass while the served surface was wrong. The harness also
copies the reference package onto the volume the topology mounts
(`examples/semantic/acme`) and knows how to run the ingest job as the deployment's
container does, so a case can assert on a graph the real job built.

`conformance/identity.py` mints `ExecutionContext` JWTs with **real ES256 keys**,
one pair per issuer (`mastra-app` → `fde://<deployment_id>`, `fde-jobs` →
`fde://<deployment_id>/jobs`). `kid` is the RFC 7638 thumbprint, the same id the
service derives from the public keys the topology binds. `ServiceProcess.authorized()`
mints one per call — `jti` is single use, so two requests cannot share a token —
and the identity cases read each operation's `x-fde-issuer` and
`x-fde-required-scope` from the contract instead of assuming which endpoint wants
which token.

Cases return the checks they proved, so a pass reads as
`C10 422 normalization: 5 body operations normalized, 404 and 405 are envelopes,
a contract-valid body gets past the validator`. Pending cases are printed with
their owner, and the summary counts them: a green run is never mistaken for full
conformance.

### C1: examples carry their schema

Every ```json fence in `docs/runtime-contract.md` and `contracts/**/*.md` must be
preceded by a marker naming the schema it satisfies:

```markdown
<!-- schema: contracts/schemas/retrieval.schema.json#/$defs/RetrieveRequest -->
```

C1 fails on a JSON fence without a marker, on a marker that does not resolve, and
on an example that does not validate. Examples embedded in the machine-readable
contract — a schema's `example`/`examples` keyword, an OpenAPI media-type or
parameter `example`/`examples` — are validated against the schema around them.
C1 also checks that every schema document is valid JSON Schema 2020-12, that every
`$ref` in both OpenAPI documents resolves, and that `contracts/README.md` and
`docs/runtime-contract.md` state the same contract minor.

`tests/test_c1.py` plants each failure in a temporary copy of the contract, so the
checks are known to be able to fail: an unmarked example, an invalid doc example,
an invalid schema-embedded example, an invalid OpenAPI-embedded example, a moved
contract minor and a dangling `$ref`.

C10 makes the same demand of the service's status codes: an enveloped `422` is not
enough if the operation never declared it.

### C2, C3, C6: identity is the token, not the request

C2 asks every authenticated operation for an answer without a token and requires
`401 unauthenticated` with the caller's trace in the envelope; it also proves a
token signed by a key this deployment does not hold is not an identity, and that
`/healthz`, `/readyz` and `/v1/runtime-info` stay public.

C3 checks that a client can only *agree* with its token: a plaintext `X-Tenant-Id`
or `X-Actor` that disagrees is a `403`, a `DecisionRequest.tenant_id` or `.actor`
from another identity is a `403`, a `RetrieveRequest.subject` naming someone else
is a `403` (§3.3), a Run-scoped call whose token carries no `run_id` is a `401`
(§5.1), an operation whose scope the token lacks is a `403 missing_scope`, and
neither issuer can reach the other's surface. The control requests in the same
case — a body that agrees — must *not* be refused, so a service that refused
everything would fail.

C6 pins the trace: the JWT `trace_id` must equal the `traceparent` trace-id
(`403` otherwise), `traceparent` is required on authenticated operations (`400`
when absent), and the retrieve, decision and provenance responses carry the
caller's trace.

### C15: readiness is a transition, not a flag

C15 owns its process for the same reason C13 does: the assertion *is* the change. The
service starts on a migrated but unmaterialized volume, `/readyz` answers
`degraded` (200 — it can serve) with an `ingest: not_started` reason, and a retrieval
answers `degraded=true, reason=partial`. Then the ingest job runs, `/readyz` turns
`ready`, and the same retrieval cites the package's facts. A service that reported
`ready` before ingest would have no way to say "the graph is not the source's current
state yet"; one that reported `not_ready` would have turned a partial answer into an
outage (§9.2).

### C5: one key, one payload

`Idempotency-Key` is scoped by `tenant_id + endpoint + key` and retained for 24
hours. The same key with the same payload is not a conflict; the same key with a
different payload is `409 idempotency_conflict`; a different key is a different
write; a write without a key is `400`. The fingerprint is over the *payload* (key
order and whitespace do not matter), and it is recorded from the first request, so
a key reused after a failed attempt with a different body conflicts too.

A successful response is recorded and replayed as `200` with `idempotent_replay:
true` where the response schema declares that field (`DecisionResponse`); a failed
attempt records nothing to replay, so a retry of the same payload runs again.

A retry is the same *trace*: the body's `trace_id` is bound to the token's, which
is bound to the `traceparent`, so a replay cannot be moved onto another call — and
the replayed body therefore already carries the caller's trace (C6 holds for
replays, not just first attempts).

A different key is a different write, and a different write needs its own
`decision_id`: the id is the Decision's stable identity (§4.2), so reusing it with
a new payload is the same `409 idempotency_conflict` the audit store returns —
even after a restart, when the in-memory key records are gone.

### C4, C13, C14: one Decision write, one audit entry

`POST /v1/decisions` appends the caller's Decision to the audit chain and answers
`201` with `decision_id`, `provenance_id`, `created_at` and `chain_head` (the hash
of the entry it just appended). The same key and payload answers `200` with
`idempotent_replay: true` and the original ids; a new `Idempotency-Key` for the
same `decision_id` is still the same write, because the store's uniqueness on
`decision_id` — not the in-memory key record — is what makes the write idempotent.

The chain is `payload_digest = SHA-256(canonical_json(payload))` and
`hash = SHA-256(prev_hash || canonical_json(payload))`, with the first entry
linking to a fixed genesis digest. The `audit_entry` table has triggers that refuse
`UPDATE` and `DELETE`, so append-only is enforced by the schema as well as by the
module. `GET /v1/provenance/{decision_id}` returns the original Decision, a
PROV-O JSON-LD document and a flat `lineage` summary, scoped to the token's
tenant (another tenant's id is a `404`, indistinguishable from an unknown one).
No `seq`, `rowid`, `prev_hash` or `payload_digest` reaches the wire; the
contract's `verification.chain_head` is the *verified* chain digest, not a
backend-internal id, and the deployment smoke's internal-name list knows the
difference.

`verify_chain()` is **not** on the read path. `app/audit_verifier.py` runs one
pass at startup and then every five minutes; the pass walks the chain, recomputes
every link and records the result in `chain_verification`. A provenance read
reports that recorded result (`valid` / `stale` / `pending` / `invalid`) plus one
anchored hash lookup, so it costs the same at ten entries and at a hundred
thousand. C13 restarts a real process on the same audit volume and waits for the
startup pass to say `valid` over the inherited chain.

Two limits are deliberate: append-only triggers can be dropped by a privileged
process (verification then detects a rewrite, but a rewrite that recomputes every
later link needs an external anchor to disprove — §6.4's `chain_head` recorded on
the Deployment Revision, which this slice does not yet have a store for); and the
verifier starts a full linear pass rather than resuming from the last verified
sequence, which is fine at v0's scale and is the first thing to change if the
audit volume grows.

## What is real in this slice

| Surface | Status |
| --- | --- |
| `GET /healthz`, `GET /readyz` | served (`app/routes/ops.py`) |
| `GET /v1/runtime-info` | served, reports only context-service |
| Error envelope, 422 normalization | served; C10 green |
| Request-body validation against `contracts/` | served |
| `POST /v1/context/retrieve` | served (`app/routes/context.py`, `app/retrieval.py`); the package's recipe, stage by stage, `retrieval_id` + `snapshot_digest` |
| The Customer Context Package: recipes, sources, mappings, permissions, revisions | served (`app/context_package.py`); loaded at startup from `CONTEXT_PACKAGE_PATH`, and a missing or foreign package stops the process |
| The Recipe pipeline: `resolve → structured → graph → lexical → merge → rank → mask → budget` | served (`app/retrieval.py`, `app/mask.py`); every stage read from the recipe, C15 green |
| `POST /internal/v1/jobs/ingest` + `python -m app.ingest` | served (`app/routes/jobs.py`, `app/ingest.py`); frozen-digest refusal, per-source outcomes, watermarks, `rebuild`/`backfill`/`incremental` |
| The ingest ledger + `IngestStatus` | served (`app/ingest_ledger.py`); `/readyz` and `retrieve` read the same answer, and a restart keeps it |
| `POST /v1/connectors/{connector_id}/operations` | served (`app/routes/connectors.py`); the Tool seam, with the permission baseline's class gate |
| Reference Connectors (`claims-db`, `sharepoint-claims`) | served (`app/connectors/`); synthetic sources over a seed, `read` for ingest and `lookupClaim` for a Tool |
| Graph: `GraphStore` port, embedded backend, snapshot envelope | served (`app/graph/`); the store is loaded at startup and stops the process if the volume is not migrated |
| `migrate` job: graph + audit schema, exit 0 gates startup | served (`app/migrate.py`); the service verifies and refuses, it never creates |
| Semantica pin + import-surface check | `semantica==0.7.0`; `scripts/semantica_surface.py` runs in CI and in the image build |
| `POST /v1/decisions`, `GET /v1/provenance/{decision_id}` | served (`app/routes/decisions.py`); C4/C13/C14 green |
| Audit store: append-only hash chain, idempotent write, background verify | served (`app/audit.py`, `app/audit_verifier.py`); opened at startup, fail closed |
| `POST/GET /v1/approvals`, `…/decisions`, `…/consume` | routes + validation; handlers are #40 |
| Identity: ES256 verification, scope/issuer/tenant, trace binding | served (`app/identity.py`, `app/identity_edge.py`); C2/C3/C6 green |
| Write idempotency: key scope, fingerprint, conflict, replay | served (`app/idempotency.py`); C5 green; `decision_id` makes the write durable |
| Retrieval Snapshot: append-only manifest, content-addressed digest | served (`app/audit.py` → `retrieval_snapshot`); triggers refuse `UPDATE`/`DELETE`, the digest is re-checked on append |

An unimplemented handler answers `500 internal` with
`details.reason = "not_implemented"` and `details.ticket` naming the owner. The
response is contract-valid (every operation declares 500) and the route-parity
test proves every operation in the contract is registered, so the skeleton
cannot quietly shrink the surface it claims.

`/readyz`'s 503 is the one non-envelope response: the contract defines it as
`{status: not_ready, reasons: []}`. Every other non-2xx is the envelope.

## Configuration

The topology binds these (`platform/context-service/1.1.0/topology.yaml`); the
service reads nothing else.

| Variable | Meaning |
| --- | --- |
| `GRAPH_BACKEND` | `embedded` in v0; another declared backend fails startup |
| `GRAPH_PATH` | embedded graph snapshot path (`/data/graph` volume); verified at startup, and a missing, unreadable or foreign-schema snapshot stops the process |
| `AUDIT_PATH` | SQLite audit store path (`/data/audit` volume); opened at startup, and an unopenable or foreign-schema file stops the process |
| `AUDIT_BACKEND` | `sqlite` in v0 |
| `CONTEXT_PACKAGE_PATH` | the frozen Context Package the service executes (`/data/context-package`, mounted read-only); **required** — a service with no package has no recipe, so a missing or unservable package stops the process |
| `EXECUTION_CONTEXT_PUBLIC_KEY` | PEM public key of the `mastra-app` issuer; **required** |
| `FDE_JOBS_PUBLIC_KEY` | PEM public key of the `fde-jobs` issuer; **required** |

Both keys are required and are checked at startup: an EC P-256 public key, not a
private one, and not the same key twice — one key pair per issuer is the whole
reason the maintenance surface is separate (§5.1, §5.4). `kid` is not configured;
the service derives the RFC 7638 thumbprint of each key and selects by it.

Two things are in memory, by design in this slice:

- the `jti` replay records, kept until the token would have expired anyway (the
  service is a single writer by contract, §4.3);
- the `Idempotency-Key` records, kept for 24 hours. They are a fast path for
  replaying the original HTTP response, not the correctness mechanism: the
  Decision write's durable identity is `decision_id` in the audit store, so a
  restart forgets the key and the retry still returns the original entry rather
  than a second one.

The audit store and the graph are the opposite: both are opened in the lifespan,
verified against the schema the `migrate` job established, and closed with the
process. A restart re-reads the same chain and the same snapshot. What a restart does
**not** preserve is the short-lived memory above, which §4.3's single-writer contract
makes acceptable.

`python -m app.migrate` reads `GRAPH_PATH` and `AUDIT_PATH` and nothing else: it is
the maintenance surface, so it does not require the issuer keys.

One thing this slice does **not** do is key rotation overlap. §5.4 accepts the old
and new public key until the old tokens expire, but the topology binds exactly one
PEM per issuer, so there is nowhere to put the second key: rotation today means
replacing the key and accepting that in-flight tokens fail until they are minted
again. Adding overlap is a topology change (a list per issuer), not a service one.
