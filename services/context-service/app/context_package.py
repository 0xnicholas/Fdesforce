"""The frozen Customer Context Package, as the service reads it (`docs/semantic-modeling.md` §3, §6).

The package is the *definition* half of context-service's behaviour: the recipe that
says which stages run over which sources, the sources' connector references, the
mappings that turn a source record into an attributable entity, and the permission
baseline the `mask` stage applies. Nothing here is per-customer code (§2): a new
customer is a new directory, and the service is the same process.

`packages/spec` is the definition source (`packages/spec/src/context.ts`,
`checkRecipe`). This module re-checks at load time what the CLI checks at freeze
time, because a service that accepted a package the build gate rejects would make
`fde context validate` decorative:

| Refusal | Why |
| --- | --- |
| no manifest, or not a `CustomerContextPackage` | a directory that is not a package defines nothing |
| a stage twice, out of order, or unknown | §6.2's pipeline is ordered; reordering is a different plan |
| no `mask` or no `budget` stage | the two stages that leak, or overflow, when dropped |
| a stage naming a source the package never declared | "per the CCP's sources" has nothing to resolve |
| a key that is not a single column | v0 mints `fde:<tenant>:<type>:<key>` from one value |
| a `mask` stage naming another permissions file | a laxer baseline would be a data-permission hole |

Two things this module deliberately does **not** do. It does not validate ontology
terms against the ontology — that is `fde context validate`'s SHACL pass, and
re-implementing it here would be a second, weaker copy. And it does not enforce the
recipe's `inputSchema.required`: a recipe without a resolvable key falls back to
graph/lexical matching (§6.3), which is exactly what a query-shaped call does.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path
from typing import Any, ClassVar, TypeVar

import yaml

#: §6.3's pipeline order. A recipe's stages are a subsequence of it.
_StageT = TypeVar("_StageT", bound="Stage")
STAGE_ORDER: tuple[str, ...] = (
    "resolve",
    "structured",
    "graph",
    "lexical",
    "merge",
    "rank",
    "mask",
    "budget",
)

#: The stages a recipe cannot omit (§6.3: mask and budget come last and are
#: mandatory — one leaks, the other overflows the prompt).
MANDATORY_STAGES: tuple[str, ...] = ("mask", "budget")

#: The dedupe keys §6.3 defines for the `merge` stage.
DEDUPE_KEYS: frozenset[str] = frozenset({"entity_id", "content_hash"})

#: The rank weights a recipe may set (§6.3). `vector` is experimental in v0: the
#: recipe may declare it, and the pipeline has no vector stage to run it.
RANK_WEIGHTS: frozenset[str] = frozenset({"structured", "graph", "lexical", "vector"})

#: The mask actions `permissions.yaml` may apply to a property.
MASK_ACTIONS: frozenset[str] = frozenset({"redact", "hash", "tokenize", "null"})


class PackageError(RuntimeError):
    """The package cannot be served: fix the package, not the service."""


# ---------------------------------------------------------------------------
# Recipes
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Stage:
    """One `spec.stages[]` entry. `type` is the discriminator the loader read."""

    type: ClassVar[str] = ""


@dataclass(frozen=True)
class ResolveStage(Stage):
    """§6.3: resolve the business object from the query/filters, deterministically."""

    type: ClassVar[str] = "resolve"
    entity: str
    key: str


@dataclass(frozen=True)
class StructuredStage(Stage):
    """§6.3: the exact business facts of one source, for these entity classes."""

    type: ClassVar[str] = "structured"
    source: str
    entities: tuple[str, ...]


@dataclass(frozen=True)
class GraphStage(Stage):
    """§6.3: 1–`maxHops`-hop expansion from the resolved entity, over these relations."""

    type: ClassVar[str] = "graph"
    relations: tuple[str, ...]
    max_hops: int


@dataclass(frozen=True)
class LexicalStage(Stage):
    """§6.3: lexical retrieval over one source, `$query` interpolating the call's query."""

    type: ClassVar[str] = "lexical"
    source: str
    query: str
    top_k: int


@dataclass(frozen=True)
class MergeStage(Stage):
    """§6.3: dedupe by `entity_id` and/or content hash, *merging* provenance.

    A duplicate is not dropped: its `entity_id`, `source_ref` and `version` ride along in
    the survivor's metadata, because §6.3's "冲突保留，不丢弃候选" is about not losing a
    citation to a rendering detail.
    """

    type: ClassVar[str] = "merge"
    dedupe: tuple[str, ...]


@dataclass(frozen=True)
class RankStage(Stage):
    """§6.3: the recipe's per-stage weights plus a freshness boost; no LLM rerank."""

    type: ClassVar[str] = "rank"
    weights: Mapping[str, float]
    freshness_boost: float


@dataclass(frozen=True)
class MaskStage(Stage):
    """§7.2: the permission baseline to apply. It is the package's own, never a substitute."""

    type: ClassVar[str] = "mask"
    permissions: str


@dataclass(frozen=True)
class BudgetStage(Stage):
    """§6.3: the hard ceilings the answer is packed into, in the recipe's order."""

    type: ClassVar[str] = "budget"
    max_nodes: int
    max_tokens: int
    max_hops: int


@dataclass(frozen=True)
class Recipe:
    """One `recipes/*.yaml`: the retrieval plan the model may *choose*, never write."""

    name: str
    version: str
    semantic_model_ref: str
    stages: tuple[Stage, ...]
    input_schema: Mapping[str, Any] = field(default_factory=dict)

    def stage(self, kind: str) -> Stage | None:
        return next((stage for stage in self.stages if stage.type == kind), None)

    def _stage_as(self, expected: type[_StageT]) -> _StageT | None:
        """The stage of this kind, typed — the one place the cast happens."""
        stage = self.stage(expected.type)
        return stage if isinstance(stage, expected) else None

    @property
    def resolve(self) -> ResolveStage | None:
        return self._stage_as(ResolveStage)

    @property
    def structured(self) -> StructuredStage | None:
        return self._stage_as(StructuredStage)

    @property
    def graph(self) -> GraphStage | None:
        return self._stage_as(GraphStage)

    @property
    def lexical(self) -> LexicalStage | None:
        return self._stage_as(LexicalStage)

    @property
    def merge(self) -> MergeStage | None:
        return self._stage_as(MergeStage)

    @property
    def rank(self) -> RankStage | None:
        return self._stage_as(RankStage)

    @property
    def mask(self) -> MaskStage | None:
        return self._stage_as(MaskStage)

    @property
    def budget(self) -> BudgetStage | None:
        return self._stage_as(BudgetStage)


# ---------------------------------------------------------------------------
# Sources, mappings, permissions, revisions
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ContextSource:
    """One `context-sources/*.yaml`: where a source's data comes from and how stale it may be."""

    id: str
    connector: str
    dataset: str
    classification: str
    watermark: str | None
    stale_after: timedelta | None
    mode: str


@dataclass(frozen=True)
class Relation:
    """One `spec.relations[]` entry: a predicate from this entity to a target class."""

    property: str
    target_entity: str
    target_key: str


@dataclass(frozen=True)
class EntityMapping:
    """One `mappings/*.yaml` with `kind: EntityMapping`: record → entity + edges.

    `properties` maps a source field to the ontology property it becomes. The
    mapping's `join` tells a SQL source how it would produce a relation's target
    keys; a synthetic source may carry them pre-joined (see `app.connectors`), which
    is why the ingest reads them from the record under `relation.property`.
    """

    source: str
    dataset: str
    entity: str
    key: tuple[str, ...]
    properties: Mapping[str, str]
    relations: tuple[Relation, ...] = ()
    watermark: str | None = None


@dataclass(frozen=True)
class DocumentMapping:
    """One `kind: DocumentMapping`: paths → chunks, with the citation template.

    `entity_types` is `spec.extraction.entityTypes`: the classes the mapping expects to
    find inside a document. v0 has no extractor, so ingest materializes each chunk as the
    declared document class and extracts nothing from the text — the list is read here
    because that is where the chunk's class comes from (`app.ingest.document_term`).
    """

    source: str
    paths: tuple[str, ...]
    source_ref: str
    version: str
    entity_types: tuple[str, ...] = ()
    chunk_heading: str = "heading"
    max_tokens: int = 800


@dataclass(frozen=True)
class PropertyPermission:
    """One `permissions.yaml` → `spec.properties` entry."""

    classification: str | None = None
    pii: str | None = None
    mask: str | None = None
    required_scopes: tuple[str, ...] = ()


@dataclass(frozen=True)
class PermissionProfile:
    """The Customer's permission baseline (§7.1): classification, PII masks, class scopes."""

    unknown_classification: str
    default_pii_mask: str
    classifications: Mapping[str, str]
    properties: Mapping[str, PropertyPermission]
    scopes: Mapping[str, tuple[str, ...]]
    row_filters: Mapping[str, str]


@dataclass(frozen=True)
class PackageRevision:
    """`revisions/<version>.yaml`: `fde context freeze`'s attestation for one version."""

    version: str
    digest: str
    frozen_at: str | None
    frozen_by: str | None


@dataclass(frozen=True)
class ContextPackage:
    """A loaded, verified package: everything retrieval and ingest read from the CCP."""

    root: Path
    tenant: str
    name: str
    version: str
    recipes: Mapping[str, Recipe]
    sources: Mapping[str, ContextSource]
    entities: tuple[EntityMapping, ...]
    documents: tuple[DocumentMapping, ...]
    permissions: PermissionProfile
    revisions: Mapping[str, PackageRevision]

    # -- lookups ----------------------------------------------------------

    def recipe(self, recipe_id: str) -> Recipe:
        """The recipe the caller named, or a refusal that lists what exists."""
        found = self.recipes.get(recipe_id)
        if found is None:
            raise PackageError(
                f"recipe {recipe_id!r} is not in {self.name}@{self.version}; "
                f"the package declares {', '.join(sorted(self.recipes)) or 'none'} — "
                "a caller may choose a recipe, never name one that was not frozen"
            )
        return found

    def revision(self, version: str) -> PackageRevision | None:
        return self.revisions.get(version)

    def source(self, source_id: str) -> ContextSource:
        found = self.sources.get(source_id)
        if found is None:
            raise PackageError(f"context source {source_id!r} is not declared by {self.name}@{self.version}")
        return found

    # -- loading ----------------------------------------------------------

    @classmethod
    def load(cls, root: str | Path) -> ContextPackage:
        """Read and verify a package directory, or refuse it naming the file to fix."""
        path = Path(root)
        manifest = _document(path / "manifest.yaml", "CustomerContextPackage")
        metadata = _section(manifest, "metadata", path / "manifest.yaml")
        spec = _section(manifest, "spec", path / "manifest.yaml")

        tenant = _text(metadata, "customer", path / "manifest.yaml")
        name = _text(metadata, "name", path / "manifest.yaml")
        version = _text(metadata, "version", path / "manifest.yaml")

        model_path = path / _text(spec, "semanticModelRef", path / "manifest.yaml")
        model = _document(model_path, "SemanticModel")
        model_spec = _section(model, "spec", model_path)

        sources = _sources(path, model_spec.get("sources"), model_path)
        entities, documents = _mappings(path, model_spec.get("entityMappings"), model_path)

        permissions_ref = _permissions_ref(spec, model_spec, path, model_path)
        permissions = _permissions(path / permissions_ref)

        recipes = _recipes(path, spec, model_spec, sources, permissions_ref, path / "manifest.yaml")
        revisions = _revisions(path)

        package = cls(
            root=path,
            tenant=tenant,
            name=name,
            version=version,
            recipes=recipes,
            sources=sources,
            entities=entities,
            documents=documents,
            permissions=permissions,
            revisions=revisions,
        )
        package._check_coverable()
        return package

    def _check_coverable(self) -> None:
        """Every declared source must be materializable by *something* ingest can ask.

        Checked here rather than at ingest time because a source no mapping produces
        is a package that can never be complete: the ingest would report a green job
        over a source that contributed nothing, and every retrieval would then call
        the context whole when it is not.
        """
        covered = {mapping.source for mapping in self.entities} | {mapping.source for mapping in self.documents}
        missing = sorted(source for source in self.sources if source not in covered)
        if missing:
            raise PackageError(
                f"{', '.join(missing)} is a declared context source with no entity or document mapping; "
                "ingest would have nothing to materialize for it"
            )
        unmapped = sorted(covered - set(self.sources))
        if unmapped:
            raise PackageError(
                f"{', '.join(unmapped)} has a mapping but is not a declared context source; "
                "a mapping over a source nobody registered is not attributable to a CITATION"
            )


# ---------------------------------------------------------------------------
# Parsing helpers: one place that reads YAML and says which file is wrong
# ---------------------------------------------------------------------------


def _yaml(path: Path) -> Any:
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise PackageError(f"{path} cannot be read: {error.strerror}; the package is mounted read-only") from error
    except yaml.YAMLError as error:
        raise PackageError(f"{path} is not valid YAML: {error}") from error


def _document(path: Path, kind: str) -> Mapping[str, Any]:
    """One package document, checked for the `kind` the loader is expecting."""
    if not path.is_file():
        raise PackageError(f"{path} is missing; a Context Package needs a {kind} document here")
    document = _yaml(path)
    if not isinstance(document, Mapping):
        raise PackageError(f"{path} is not a YAML mapping")
    if document.get("kind") != kind:
        raise PackageError(f"{path} is a {document.get('kind')!r} document, not a {kind!r}")
    if document.get("apiVersion") != "fde.dev/v0":
        raise PackageError(f"{path} declares apiVersion {document.get('apiVersion')!r}; v0 serves `fde.dev/v0`")
    return document


def _section(document: Mapping[str, Any], key: str, path: Path) -> Mapping[str, Any]:
    value = document.get(key)
    if not isinstance(value, Mapping):
        raise PackageError(f"{path} has no `{key}` mapping")
    return value


def _text(document: Mapping[str, Any], key: str, path: Path | str) -> str:
    value = document.get(key)
    if not isinstance(value, str) or not value:
        raise PackageError(f"{path} needs a non-empty `{key}`")
    return value


def _sources(root: Path, declared: Any, model_path: Path) -> dict[str, ContextSource]:
    if not isinstance(declared, list) or not declared:
        raise PackageError(f"{model_path} declares no `spec.sources`; a package without sources has no context")
    sources: dict[str, ContextSource] = {}
    for entry in declared:
        if not isinstance(entry, Mapping) or "contextSource" not in entry:
            raise PackageError(f"{model_path}: a `spec.sources` entry needs a `contextSource` file")
        path = root / str(entry["contextSource"])
        document = _document(path, "ContextSource")
        metadata = _section(document, "metadata", path)
        spec = _section(document, "spec", path)
        source_id = _text(metadata, "name", path)
        if source_id in sources:
            raise PackageError(f"{path} declares the source {source_id!r} twice")
        freshness = spec.get("freshness") or {}
        sources[source_id] = ContextSource(
            id=source_id,
            connector=_text(spec, "connectorRef", path),
            dataset=_text(spec, "dataset", path),
            classification=str(spec.get("classification") or "restricted"),
            watermark=_optional_text(freshness.get("watermark")),
            stale_after=_duration(freshness.get("staleAfter"), path),
            mode=str(spec.get("mode") or "incremental"),
        )
    return sources


def _mappings(
    root: Path, declared: Any, model_path: Path
) -> tuple[tuple[EntityMapping, ...], tuple[DocumentMapping, ...]]:
    if not isinstance(declared, list) or not declared:
        raise PackageError(f"{model_path} declares no `spec.entityMappings`; ingest would build an empty graph")
    entities: list[EntityMapping] = []
    documents: list[DocumentMapping] = []
    for entry in declared:
        if not isinstance(entry, Mapping) or "ref" not in entry:
            raise PackageError(f"{model_path}: an `spec.entityMappings` entry needs a `ref` file")
        path = root / str(entry["ref"])
        document = _yaml(path) if path.is_file() else None
        if not isinstance(document, Mapping):
            raise PackageError(f"{path} is missing; {model_path} declares it as a mapping")
        kind = document.get("kind")
        if kind == "EntityMapping":
            entities.append(_entity_mapping(path, _document(path, "EntityMapping")))
        elif kind == "DocumentMapping":
            documents.append(_document_mapping(path, _document(path, "DocumentMapping")))
        else:
            raise PackageError(f"{path} is a {kind!r} document; a mapping is EntityMapping or DocumentMapping")
    return tuple(entities), tuple(documents)


def _entity_mapping(path: Path, document: Mapping[str, Any]) -> EntityMapping:
    spec = _section(document, "spec", path)
    keys = spec.get("key")
    if not isinstance(keys, list) or len(keys) != 1 or not isinstance(keys[0], str):
        raise PackageError(
            f"{path}: v0 mints `fde:<tenant>:<type>:<key>` from a single column; "
            f"`key` is {keys!r}, and a composite key needs a decision about its separator"
        )
    properties = spec.get("properties") or {}
    if not isinstance(properties, Mapping) or not properties:
        raise PackageError(f"{path}: `spec.properties` is empty; an entity with no property has no content")
    terms: dict[str, str] = {}
    for source_field, annotation in properties.items():
        if not isinstance(annotation, Mapping) or not isinstance(annotation.get("property"), str):
            raise PackageError(f"{path}: property {source_field!r} needs an `property` ontology term")
        terms[str(source_field)] = str(annotation["property"])
    relations: list[Relation] = []
    for entry in spec.get("relations") or []:
        if not isinstance(entry, Mapping):
            raise PackageError(f"{path}: a `spec.relations` entry is not a mapping")
        relations.append(
            Relation(
                property=_text(entry, "property", path),
                target_entity=_text(entry, "targetEntity", path),
                target_key=_text(entry, "targetKey", path),
            )
        )
    watermark = spec.get("watermark") or {}
    return EntityMapping(
        source=_text(spec, "connectorRef", path),
        dataset=_text(spec, "dataset", path),
        entity=_text(spec, "entity", path),
        key=(keys[0],),
        properties=terms,
        relations=tuple(relations),
        watermark=_optional_text(watermark.get("column")),
    )


def _document_mapping(path: Path, document: Mapping[str, Any]) -> DocumentMapping:
    spec = _section(document, "spec", path)
    chunking = spec.get("chunking") or {}
    provenance = spec.get("provenance") or {}
    extraction = spec.get("extraction") or {}
    if not isinstance(provenance, Mapping):
        raise PackageError(f"{path}: `spec.provenance` must be a mapping with `sourceRef` and `version`")
    paths = spec.get("paths")
    if not isinstance(paths, list) or not paths:
        raise PackageError(f"{path}: `spec.paths` is empty; nothing to read")
    entity_types = extraction.get("entityTypes") if isinstance(extraction, Mapping) else None
    if not isinstance(entity_types, list) or not entity_types:
        raise PackageError(f"{path}: `spec.extraction.entityTypes` is empty; a chunk has no class to become")
    return DocumentMapping(
        source=_text(spec, "connectorRef", path),
        paths=tuple(str(entry) for entry in paths),
        source_ref=_text(provenance, "sourceRef", path),
        version=_text(provenance, "version", path),
        entity_types=tuple(str(term) for term in entity_types),
        chunk_heading=str(chunking.get("strategy") or "heading"),
        max_tokens=int(chunking.get("maxTokens") or 800),
    )


def _permissions_ref(
    manifest_spec: Mapping[str, Any], model_spec: Mapping[str, Any], root: Path, model_path: Path
) -> str:
    """The package's `permissionsRef`, from the manifest, cross-checked with the model."""
    reference = manifest_spec.get("permissionsRef")
    if not isinstance(reference, str) or not reference:
        raise PackageError(f"{root / 'manifest.yaml'} declares no `spec.permissionsRef` (§7's baseline is mandatory)")
    model_permissions = model_spec.get("permissions")
    if isinstance(model_permissions, Mapping) and model_permissions.get("ref") not in (None, reference):
        raise PackageError(
            f"{model_path} names {model_permissions.get('ref')!r} as the permission baseline and the "
            f"manifest names {reference!r}; a package has exactly one baseline (§7.2)"
        )
    return reference


def _permissions(path: Path) -> PermissionProfile:
    document = _document(path, "PermissionProfile")
    spec = _section(document, "spec", path)
    defaults = _section(spec, "defaults", path)

    unknown = defaults.get("unknownClassification")
    if unknown != "restricted":
        raise PackageError(
            f"{path}: `defaults.unknownClassification` is {unknown!r}; the fail-closed default is "
            "`restricted` and it is not a setting (§7.1)"
        )
    pii_mask = str(defaults.get("pii") or "redact")
    _check_mask(pii_mask, path, "defaults.pii")

    classifications: dict[str, str] = {}
    for term, annotation in (_section(spec, "classifications", path)).items():
        if isinstance(annotation, Mapping) and isinstance(annotation.get("classification"), str):
            classifications[str(term)] = str(annotation["classification"])

    properties: dict[str, PropertyPermission] = {}
    for term, annotation in (_section(spec, "properties", path)).items():
        if not isinstance(annotation, Mapping):
            raise PackageError(f"{path}: property permission {term!r} is not a mapping")
        mask = _optional_text(annotation.get("columnMask"))
        if mask is not None:
            _check_mask(mask, path, f"properties.{term}.columnMask")
        properties[str(term)] = PropertyPermission(
            classification=_optional_text(annotation.get("classification")),
            pii=_optional_text(annotation.get("pii")),
            mask=mask,
            required_scopes=tuple(str(scope) for scope in annotation.get("requiredScopes") or ()),
        )

    row_filters_value = spec.get("rowFilters") or {}
    if not isinstance(row_filters_value, Mapping):
        raise PackageError(f"{path}: `spec.rowFilters` must be a mapping")
    scopes_value = spec.get("scopes") or {}
    if not isinstance(scopes_value, Mapping):
        raise PackageError(f"{path}: `spec.scopes` must be a mapping")
    return PermissionProfile(
        unknown_classification=unknown,
        default_pii_mask=pii_mask,
        classifications=classifications,
        properties=properties,
        scopes={str(term): tuple(str(scope) for scope in entry or ()) for term, entry in scopes_value.items()},
        row_filters={str(term): str(entry) for term, entry in row_filters_value.items()},
    )


def _check_mask(action: str, path: Path, slot: str) -> None:
    if action not in MASK_ACTIONS:
        raise PackageError(f"{path}: {slot} is {action!r}; a mask is one of {', '.join(sorted(MASK_ACTIONS))}")


def _recipes(
    root: Path,
    manifest_spec: Mapping[str, Any],
    model_spec: Mapping[str, Any],
    sources: Mapping[str, ContextSource],
    permissions_ref: str,
    manifest_path: Path,
) -> dict[str, Recipe]:
    declared = model_spec.get("recipes") or manifest_spec.get("recipes") or []
    if not isinstance(declared, list) or not declared:
        raise PackageError(f"{manifest_path} declares no recipes; the runtime would have nothing to execute")
    recipes: dict[str, Recipe] = {}
    for entry in declared:
        reference = entry.get("ref") if isinstance(entry, Mapping) else entry
        if not isinstance(reference, str):
            raise PackageError(f"{manifest_path}: a `spec.recipes` entry needs a `ref` file")
        path = root / reference
        document = _document(path, "ContextRecipe")
        metadata = _section(document, "metadata", path)
        spec = _section(document, "spec", path)
        name = _text(metadata, "name", path)
        if name in recipes:
            raise PackageError(f"{path} declares the recipe {name!r} twice")
        recipes[name] = Recipe(
            name=name,
            version=_text(metadata, "version", path),
            semantic_model_ref=_text(spec, "semanticModelRef", path),
            stages=_stages(path, spec.get("stages"), sources, permissions_ref),
            input_schema=spec.get("inputSchema") or {},
        )
    return recipes


def _stages(
    path: Path, declared: Any, sources: Mapping[str, ContextSource], permissions_ref: str
) -> tuple[Stage, ...]:
    if not isinstance(declared, list) or not declared:
        raise PackageError(f"{path}: `spec.stages` is empty; the pipeline is the recipe")
    stages: list[Stage] = []
    seen: set[str] = set()
    highest = -1
    for index, entry in enumerate(declared):
        slot = f"{path} spec.stages[{index}]"
        if not isinstance(entry, Mapping) or not isinstance(entry.get("type"), str):
            raise PackageError(f"{slot} has no `type`")
        kind = str(entry["type"])
        if kind not in STAGE_ORDER:
            raise PackageError(f"{slot}: {kind!r} is not a stage; the pipeline is {' → '.join(STAGE_ORDER)}")
        if kind in seen:
            raise PackageError(f"{slot}: stage {kind} appears twice; each stage runs at most once")
        seen.add(kind)
        position = STAGE_ORDER.index(kind)
        if position < highest:
            raise PackageError(
                f"{slot}: stage {kind} comes after a later stage; the pipeline is {' → '.join(STAGE_ORDER)}"
            )
        highest = position
        stages.append(_stage(slot, kind, entry, sources, permissions_ref))

    missing = [mandatory for mandatory in MANDATORY_STAGES if mandatory not in seen]
    if missing:
        raise PackageError(
            f"{path}: recipe has no {', '.join(missing)} stage; mask is what stops a leak and budget is what "
            "stops an overflow, so neither is optional (§6.3)"
        )
    return tuple(stages)


def _stage(
    slot: str, kind: str, entry: Mapping[str, Any], sources: Mapping[str, ContextSource], permissions_ref: str
) -> Stage:
    if kind == "resolve":
        return ResolveStage(entity=_text(entry, "entity", slot), key=_text(entry, "key", slot))
    if kind == "structured":
        entities = entry.get("entities")
        if not isinstance(entities, list) or not entities:
            raise PackageError(f"{slot}: a structured stage needs the entity classes it fetches")
        return StructuredStage(
            source=_declared_source(slot, entry, sources),
            entities=tuple(str(entity) for entity in entities),
        )
    if kind == "graph":
        relations = entry.get("relations")
        if not isinstance(relations, list) or not relations:
            raise PackageError(f"{slot}: a graph stage needs the relations it expands over")
        hops = entry.get("maxHops")
        if not isinstance(hops, int) or not 1 <= hops <= 2:
            raise PackageError(f"{slot}: maxHops is {hops!r}; v0's graph is 1–2 hops (§4.3)")
        if entry.get("from") not in (None, "resolved"):
            raise PackageError(f"{slot}: v0 expands from `resolved`; {entry.get('from')!r} has no anchor")
        return GraphStage(relations=tuple(str(relation) for relation in relations), max_hops=hops)
    if kind == "lexical":
        top_k = entry.get("topK")
        if not isinstance(top_k, int) or top_k < 1:
            raise PackageError(f"{slot}: topK is {top_k!r}; a lexical stage needs a positive ceiling")
        return LexicalStage(
            source=_declared_source(slot, entry, sources),
            query=_text(entry, "query", slot),
            top_k=top_k,
        )
    if kind == "merge":
        dedupe = entry.get("dedupe")
        if not isinstance(dedupe, list) or not dedupe:
            raise PackageError(f"{slot}: a merge stage needs `dedupe` keys")
        unknown = [key for key in dedupe if key not in DEDUPE_KEYS]
        if unknown:
            raise PackageError(f"{slot}: {unknown[0]!r} is not a dedupe key; merge dedupes on {sorted(DEDUPE_KEYS)}")
        return MergeStage(dedupe=tuple(str(key) for key in dedupe))
    if kind == "rank":
        weights = entry.get("weights")
        if not isinstance(weights, Mapping) or not weights:
            raise PackageError(f"{slot}: a rank stage needs per-stage weights")
        unknown = [key for key in weights if key not in RANK_WEIGHTS]
        if unknown:
            raise PackageError(f"{slot}: {unknown[0]!r} is not a ranked stage; weights are {sorted(RANK_WEIGHTS)}")
        boost = entry.get("freshnessBoost", 0.0)
        if not isinstance(boost, (int, float)):
            raise PackageError(f"{slot}: freshnessBoost is {boost!r}")
        return RankStage(
            weights={str(key): float(value) for key, value in weights.items()},
            freshness_boost=float(boost),
        )
    if kind == "mask":
        reference = _text(entry, "permissions", slot)
        if reference != permissions_ref:
            raise PackageError(
                f"{slot}: the mask stage names {reference!r} and the package's baseline is {permissions_ref!r}; "
                "a recipe may not substitute a laxer baseline (§7.2)"
            )
        return MaskStage(permissions=reference)
    if kind == "budget":
        values = {key: entry.get(key) for key in ("maxNodes", "maxTokens", "maxHops")}
        for key, value in values.items():
            if not isinstance(value, int) or value < 1:
                raise PackageError(f"{slot}: {key} is {value!r}; a budget is a positive integer")
        return BudgetStage(
            max_nodes=int(values["maxNodes"]),
            max_tokens=int(values["maxTokens"]),
            max_hops=int(values["maxHops"]),
        )
    raise PackageError(f"{slot}: {kind!r} has no reader")  # pragma: no cover - STAGE_ORDER gates this


def _declared_source(slot: str, entry: Mapping[str, Any], sources: Mapping[str, ContextSource]) -> str:
    source = entry.get("source")
    if not isinstance(source, str) or not source:
        raise PackageError(f"{slot}: the stage names no `source`")
    if source not in sources:
        raise PackageError(
            f"{slot} names the source {source!r}, which the package does not declare; "
            f"declared sources are {', '.join(sorted(sources))}"
        )
    return source


def _revisions(root: Path) -> dict[str, PackageRevision]:
    revisions: dict[str, PackageRevision] = {}
    for path in sorted((root / "revisions").glob("*.yaml")):
        document = _document(path, "ContextPackageRevision")
        metadata = _section(document, "metadata", path)
        spec = _section(document, "spec", path)
        version = _text(metadata, "version", path)
        revisions[version] = PackageRevision(
            version=version,
            digest=_text(spec, "digest", path),
            frozen_at=_optional_text(spec.get("frozenAt")),
            frozen_by=_optional_text(spec.get("frozenBy")),
        )
    return revisions


_DURATION = {"D": "days", "H": "hours", "M": "minutes", "S": "seconds"}


def _duration(value: Any, path: Path) -> timedelta | None:
    """`PT1H` / `P1D` — the ISO 8601 subset the package's `freshness` uses."""
    if value is None:
        return None
    if not isinstance(value, str) or not value.startswith("P"):
        raise PackageError(f"{path}: freshness {value!r} is not an ISO 8601 duration")
    text = value[1:]
    total = timedelta()
    number = ""
    for character in text:
        if character.isdigit():
            number += character
            continue
        if character == "T":
            if number:
                raise PackageError(f"{path}: freshness {value!r} has a number with no unit before `T`")
            continue
        if character not in _DURATION or not number:
            raise PackageError(f"{path}: freshness {value!r} is not an ISO 8601 duration v0 can read")
        total += timedelta(**{_DURATION[character]: int(number)})
        number = ""
    if number:
        raise PackageError(f"{path}: freshness {value!r} has a trailing number")
    return total


def _optional_text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def type_of(term: str) -> str:
    """`ic:Claim` → `Claim`: the entity's `type`, as the package writes it.

    The type and the id's type segment are two spellings of one ontology term (§4.2)
    — `Claim` and `claim` — and `app.graph.embedded` compares them case-insensitively.
    These two functions are the one place that decides both.
    """
    return term.split(":", 1)[-1]


def segment_of(term: str) -> str:
    """`ic:Claim` → `claim`: the id-safe half of the same term (§4.2's `entity_id`)."""
    return type_of(term).casefold()
