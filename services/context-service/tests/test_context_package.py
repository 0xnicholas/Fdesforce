"""The Customer Context Package as the service reads it (`docs/semantic-modeling.md` §3, §6).

The recipe is the FDE's retrieval plan, not the model's: the stages, their order and
the sources they name are the package's, so the determinism this service promises
starts here. These are the reader's refusals — a recipe whose stages are out of
order, a recipe without `mask`, a stage that names a source the package never
declared, a composite key v0 cannot mint — plus the one positive case that pins the
Acme package the deployment ships (`examples/semantic/acme`).

The checks are not invented here: `packages/spec/src/context.ts` (`checkRecipe`) is
the definition source, and the reader refuses the same things at startup that
`fde context validate` refuses at build time — a service that accepted a package the
CLI would have rejected would make the build gate decorative.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest
import yaml

from app.context_package import ContextPackage, PackageError
from conformance.harness import REPO_ROOT

ACME_PACKAGE = REPO_ROOT / "examples" / "semantic" / "acme"


@pytest.fixture
def package_root(tmp_path: Path) -> Path:
    """A private copy of the Acme package a test may break in one specific way."""
    root = tmp_path / "acme"
    shutil.copytree(ACME_PACKAGE, root)
    return root


def edit_yaml(path: Path, change) -> None:
    document = yaml.safe_load(path.read_text(encoding="utf-8"))
    change(document)
    path.write_text(yaml.safe_dump(document, sort_keys=False), encoding="utf-8")


def test_the_acme_package_is_the_one_the_deployment_ships() -> None:
    package = ContextPackage.load(ACME_PACKAGE)

    assert (package.tenant, package.name, package.version) == ("acme", "acme-claims-context", "1.0.0")
    assert sorted(package.recipes) == ["claims-context"]
    assert sorted(package.sources) == ["claims-db", "sharepoint-claims"]

    recipe = package.recipe("claims-context")
    assert [stage.type for stage in recipe.stages] == [
        "resolve",
        "structured",
        "graph",
        "lexical",
        "merge",
        "rank",
        "mask",
        "budget",
    ]
    assert recipe.resolve is not None
    assert (recipe.resolve.entity, recipe.resolve.key) == ("ic:Claim", "claim_id")
    assert recipe.structured is not None
    assert recipe.structured.source == "claims-db"
    assert recipe.structured.entities[0] == "ic:Claim"
    assert recipe.graph is not None
    assert recipe.graph.max_hops == 2
    assert "ic:hasPolicy" in recipe.graph.relations
    assert recipe.lexical is not None
    assert recipe.lexical.source == "sharepoint-claims"
    assert recipe.rank is not None
    assert recipe.rank.weights["structured"] == 0.5
    assert recipe.budget is not None
    assert (recipe.budget.max_nodes, recipe.budget.max_tokens) == (50, 4000)


def test_the_package_carries_its_frozen_revision() -> None:
    package = ContextPackage.load(ACME_PACKAGE)

    revision = package.revision("1.0.0")
    assert revision is not None
    assert revision.digest == "sha256:a8216d62662cf855120f1b3ec4ab9c865a5bc9a9f3ef179f6deb2b7a5ed0eaf5"
    assert revision.frozen_by == "fde://acme/fde-lead"
    assert package.revision("2.0.0") is None


def test_the_permission_baseline_is_the_one_the_mask_stage_names() -> None:
    package = ContextPackage.load(ACME_PACKAGE)

    assert package.permissions.unknown_classification == "restricted"
    assert package.permissions.classifications["ic:Claim"] == "confidential"
    assert package.permissions.properties["ic:customerEmail"].mask == "hash"
    assert package.permissions.scopes["ic:Customer"] == ("customer:pii:read",)
    assert package.recipe("claims-context").mask.permissions == "permissions.yaml"  # type: ignore[union-attr]


def test_the_mappings_name_the_entities_and_the_relations_ingest_builds() -> None:
    package = ContextPackage.load(ACME_PACKAGE)

    claim = next(mapping for mapping in package.entities if mapping.entity == "ic:Claim")
    assert claim.source == "claims-db"
    assert claim.dataset == "public.claims"
    assert claim.key == ("claim_id",)
    assert claim.properties["claim_id"] == "ic:claimId"
    assert [relation.property for relation in claim.relations] == [
        "ic:hasPolicy",
        "ic:hasCoverage",
        "ic:forCustomer",
        "ic:hasFraudFlag",
    ]

    document = package.documents[0]
    assert document.source == "sharepoint-claims"
    assert document.source_ref == "sharepoint://{path}"
    assert document.version == "{etag}"


def test_a_stage_out_of_canonical_order_is_refused(package_root: Path) -> None:
    recipe = package_root / "recipes" / "claims-context.yaml"

    def swap_stages(document):
        stages = document["spec"]["stages"]
        merge = next(stage for stage in stages if stage["type"] == "merge")
        stages.remove(merge)
        stages.insert(0, merge)

    edit_yaml(recipe, swap_stages)

    with pytest.raises(PackageError) as caught:
        ContextPackage.load(package_root)
    assert "merge" in str(caught.value)
    assert "resolve" in str(caught.value)


def test_a_recipe_without_a_mask_stage_is_refused(package_root: Path) -> None:
    recipe = package_root / "recipes" / "claims-context.yaml"
    edit_yaml(recipe, lambda document: document["spec"]["stages"].pop(6))

    with pytest.raises(PackageError) as caught:
        ContextPackage.load(package_root)
    assert "mask" in str(caught.value)


def test_a_stage_naming_an_undeclared_source_is_refused(package_root: Path) -> None:
    recipe = package_root / "recipes" / "claims-context.yaml"

    def rename_source(document):
        document["spec"]["stages"][3]["source"] = "warehouse"

    edit_yaml(recipe, rename_source)

    with pytest.raises(PackageError) as caught:
        ContextPackage.load(package_root)
    assert "warehouse" in str(caught.value)


def test_a_composite_key_is_refused(package_root: Path) -> None:
    mapping = package_root / "mappings" / "claims-db.yaml"
    edit_yaml(mapping, lambda document: document["spec"].__setitem__("key", ["claim_id", "policy_number"]))

    with pytest.raises(PackageError) as caught:
        ContextPackage.load(package_root)
    assert "claim_id" in str(caught.value)


def test_an_empty_directory_is_not_a_package(tmp_path: Path) -> None:
    with pytest.raises(PackageError) as caught:
        ContextPackage.load(tmp_path)
    assert "manifest.yaml" in str(caught.value)


def test_a_malformed_recipe_is_refused_with_its_path(package_root: Path) -> None:
    (package_root / "recipes" / "claims-context.yaml").write_text("spec: [not, a, mapping\n", encoding="utf-8")

    with pytest.raises(PackageError) as caught:
        ContextPackage.load(package_root)
    assert "claims-context.yaml" in str(caught.value)
