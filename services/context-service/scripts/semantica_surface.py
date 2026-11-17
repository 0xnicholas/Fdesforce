#!/usr/bin/env python3
"""Check every Semantica import against the pinned wheel's export surface.

The prototype asserted a Semantica version and never checked it; this closes that
gap (`#38`, `docs/architecture-synthesis.md` §5's "asserted, not pinned"). The claim
being checked has four parts, and each fails separately and loudly:

1. **The pin is installed.** `importlib.metadata.version("semantica")` must equal
   `SEMANTICA_VERSION` in `app/generated/versions.py`, which
   `scripts/generate.py` compiles from `platform/toolchain.yaml`. An environment
   with a different engine installed is not this service.
2. **Every import resolves.** Each `import semantica…` / `from semantica… import …`
   in the service's Python sources (the packaged `app/`, plus `conformance/`,
   `scripts/` and `tests/`) is resolved against the installed distribution: the
   module must exist, and every imported name must be an attribute of it or a
   submodule. A rename in a patch release is then a failed build, not a request that
   blows up in production.
3. **The manifest is the surface.** `semantica-surface.json` is the reviewed list of
   modules and names this service depends on. An import that is not in it fails
   (so widening the dependency is a deliberate, reviewable edit via `--write`), and
   every entry in it must still exist on the wheel (so an upgrade that removes
   something we declared is caught even when no source file changed). Declared
   class members are checked with `hasattr`, because a method is part of the surface
   as much as a class is.
4. **The engine stays in one place.** Inside `app/` — the half that ships in the
   image — Semantica may only be imported by the adapters the manifest names.
   `docs/research/semantic-layer-selection.md` §5.4 asks for exactly this: one
   adapter, so an engine upgrade (or replacement) is one file's diff.

What this does *not* do: pin the wheel by hash. There is no Python lockfile in this
slice; the pin is the exact version in `pyproject.toml` + `platform/toolchain.yaml`,
and CI installs exactly that. Adding a hash lock is a supply-chain change for the
whole toolchain (#33's territory), not something this check should fake.

Usage:
  python scripts/semantica_surface.py            # verify (the default, and what CI runs)
  python scripts/semantica_surface.py --write    # rewrite the manifest after a review
  python scripts/semantica_surface.py --root DIR # verify another tree (tests)

There is no `--check` flag, unlike `scripts/generate.py`: checking is this script's
safe default, and *writing* is the act that needs saying out loud.
"""

from __future__ import annotations

import argparse
import ast
import importlib
import json
import sys
from dataclasses import dataclass
from importlib import metadata
from pathlib import Path
from typing import Any

SERVICE_ROOT = Path(__file__).resolve().parents[1]
MANIFEST_NAME = "semantica-surface.json"

#: Where imports are looked for. `app/` is what the image ships; the rest is ours to
#: keep honest even though it is not packaged.
SOURCE_DIRS = ("app", "conformance", "scripts", "tests")

#: The half of the tree that is packaged in the service image. Confinement applies
#: here: a test may import the engine to inspect it, a shipped module may not.
PACKAGED_DIR = "app"

DISTRIBUTION = "semantica"


@dataclass(frozen=True)
class Dependency:
    """One imported name, and where it came from."""

    file: str
    module: str
    name: str | None

    @property
    def key(self) -> str:
        return self.module if self.name is None else f"{self.module}.{self.name}"

    @property
    def packaged(self) -> bool:
        return self.file.split("/", 1)[0] == PACKAGED_DIR


class SurfaceError(RuntimeError):
    """The surface check could not run at all (a missing manifest, an unreadable pin)."""


def read_pin(root: Path) -> str:
    """The platform's pin, as compiled into the service (`scripts/generate.py`)."""
    versions = root / "app" / "generated" / "versions.py"
    if not versions.exists():
        raise SurfaceError(f"no {versions}; run `python scripts/generate.py` first")
    for line in versions.read_text(encoding="utf-8").splitlines():
        if line.startswith("SEMANTICA_VERSION"):
            return str(ast.literal_eval(line.split("=", 1)[1].strip()))
    raise SurfaceError(f"{versions} declares no SEMANTICA_VERSION")


def imported_dependencies(root: Path) -> list[Dependency]:
    """Every Semantica import in the service's sources, one entry per imported name."""
    found: list[Dependency] = []
    for directory in SOURCE_DIRS:
        for path in sorted((root / directory).rglob("*.py")):
            relative = path.relative_to(root).as_posix()
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"), filename=str(path))):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        if alias.name == DISTRIBUTION or alias.name.startswith(f"{DISTRIBUTION}."):
                            found.append(Dependency(file=relative, module=alias.name, name=None))
                elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                    if node.module != DISTRIBUTION and not node.module.startswith(f"{DISTRIBUTION}."):
                        continue
                    for alias in node.names:
                        # `from semantica.context import ContextGraph`
                        found.append(Dependency(file=relative, module=node.module, name=alias.name))
    return found


def _kind_of(value: Any) -> str:
    import inspect

    if inspect.ismodule(value):
        return "module"
    if inspect.isclass(value):
        return "class"
    if inspect.isroutine(value):
        return "function"
    return "attribute"


def resolve(dependency: Dependency) -> str:
    """Import-check one dependency; the kind it resolves to.

    Raises `LookupError` with the reason, which the caller prints as a failure: the
    whole point is that a missing name is *explicit*.
    """
    try:
        module = importlib.import_module(dependency.module)
    except ImportError as error:
        raise LookupError(f"{dependency.file}: cannot import {dependency.module!r}: {error}") from error
    if dependency.name is None:
        return "module"
    if hasattr(module, dependency.name):
        return _kind_of(getattr(module, dependency.name))
    try:
        importlib.import_module(f"{dependency.module}.{dependency.name}")
    except ImportError as error:
        raise LookupError(
            f"{dependency.file}: {dependency.module!r} has no attribute {dependency.name!r} "
            f"and no submodule of that name ({error})"
        ) from error
    return "module"


def load_manifest(root: Path) -> dict[str, Any]:
    path = root / MANIFEST_NAME
    if not path.exists():
        raise SurfaceError(f"no {path}; run `python scripts/semantica_surface.py --write`")
    document = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(document, dict):
        raise SurfaceError(f"{path} is not a JSON object")
    return document


def manifest_dependencies(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """`module.name` → its entry, flattened from the manifest's nested shape."""
    flat: dict[str, dict[str, Any]] = {}
    for module, entry in (manifest.get("modules") or {}).items():
        names = entry.get("names") or {}
        if not names:
            flat[str(module)] = {"kind": entry.get("kind", "module"), "entry": entry, "name": None}
        for name, detail in names.items():
            flat[f"{module}.{name}"] = {"kind": detail.get("kind"), "entry": detail, "name": name}
    return flat


def _member_failures(key: str, entry: dict[str, Any]) -> list[str]:
    """Declared members must exist: a method is part of the surface a class ships."""
    members = entry.get("members") or []
    if not members:
        return []
    module, _, name = key.partition(".")
    try:
        target = getattr(importlib.import_module(module), name)
    except (ImportError, AttributeError):
        return []  # already reported by `resolve`
    return [
        f"{key}: declared member {member!r} is not on the pinned wheel"
        for member in members
        if not hasattr(target, member)
    ]


def check(root: Path) -> tuple[list[str], list[str]]:
    """`(failures, notes)` for `root` against the installed distribution."""
    pin = read_pin(root)
    manifest = load_manifest(root)
    failures: list[str] = []
    notes: list[str] = []

    installed = metadata.version(DISTRIBUTION)
    if installed != pin:
        failures.append(
            f"installed {DISTRIBUTION} {installed} is not the pinned {pin} "
            "(`platform/toolchain.yaml` → `spec.versions.semantica`, via app/generated/versions.py)"
        )
    if str(manifest.get("pin")) != pin:
        failures.append(
            f"{MANIFEST_NAME} was reviewed against {DISTRIBUTION} {manifest.get('pin')}, "
            f"but the platform pins {pin}; review the surface change, then `--write`"
        )

    dependencies = imported_dependencies(root)
    resolved: dict[str, str] = {}
    for dependency in dependencies:
        try:
            kind = resolve(dependency)
        except LookupError as error:
            failures.append(str(error))
            continue
        resolved[dependency.key] = kind

    declared = manifest_dependencies(manifest)
    for key in sorted(resolved):
        if key not in declared:
            failures.append(
                f"the service imports {key!r}, which {MANIFEST_NAME} does not declare; "
                "review the addition against the pinned wheel, then `--write`"
            )
    for key, detail in sorted(declared.items()):
        if key not in resolved:
            failures.append(
                f"{MANIFEST_NAME} declares {key!r}, which no source imports any more; "
                "drop it deliberately with `--write`"
            )
            continue
        declared_kind = detail["kind"]
        if declared_kind and declared_kind != resolved[key]:
            failures.append(
                f"{key!r} is a {resolved[key]} on the pinned wheel, but {MANIFEST_NAME} says {declared_kind!r}"
            )
        if detail["name"] is not None:
            failures.extend(_member_failures(key, detail["entry"]))

    adapters = {str(entry) for entry in (manifest.get("adapters") or [])}
    for dependency in dependencies:
        if dependency.packaged and dependency.file not in adapters:
            failures.append(
                f"{dependency.file} imports {DISTRIBUTION} outside the declared adapter(s) "
                f"({', '.join(sorted(adapters)) or 'none'}); the engine is reached through one module "
                "so an upgrade is one file's diff"
            )

    notes.append(
        f"{len(resolved)} Semantica names resolve on {DISTRIBUTION} {installed}; "
        f"{len(dependencies)} import statements in {len({d.file for d in dependencies})} files; "
        f"adapter(s): {', '.join(sorted(adapters))}"
    )
    return failures, notes


def write_manifest(root: Path) -> Path:
    """Rewrite the manifest from the sources, keeping what was reviewed about members."""
    pin = read_pin(root)
    previous = load_manifest(root) if (root / MANIFEST_NAME).exists() else {}
    previous_modules = previous.get("modules") or {}

    modules: dict[str, Any] = {}
    for dependency in imported_dependencies(root):
        try:
            kind = resolve(dependency)
        except LookupError as error:
            raise SurfaceError(str(error)) from error
        entry = modules.setdefault(dependency.module, {"kind": "module", "names": {}})
        if dependency.name is None:
            entry["kind"] = "module"
            continue
        prior = ((previous_modules.get(dependency.module) or {}).get("names") or {}).get(dependency.name) or {}
        detail: dict[str, Any] = {"kind": kind}
        if prior.get("members"):
            detail["members"] = list(prior["members"])
        entry["names"][dependency.name] = detail

    document = {
        "$comment": (
            "The Semantica surface this service depends on. Checked by "
            "`python scripts/semantica_surface.py`; rewrite it with `--write` when the pin "
            "or the imports change, and review the diff — that review is the upgrade decision."
        ),
        "distribution": DISTRIBUTION,
        "pin": pin,
        "adapters": list(previous.get("adapters") or ["app/graph/semantica_graph.py"]),
        "modules": modules,
    }
    path = root / MANIFEST_NAME
    path.write_text(json.dumps(document, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    return path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="check Semantica imports against the pinned wheel")
    parser.add_argument("--write", action="store_true", help=f"rewrite {MANIFEST_NAME} after a review")
    parser.add_argument("--root", type=Path, default=SERVICE_ROOT, help="the service root to check")
    arguments = parser.parse_args(argv)

    root = arguments.root.resolve()
    try:
        if arguments.write:
            print(f"wrote {write_manifest(root).relative_to(root)}")
            return 0
        failures, notes = check(root)
    except SurfaceError as error:
        print(f"semantica-surface: {error}", file=sys.stderr)
        return 1

    for note in notes:
        print(f"semantica-surface: {note}")
    if failures:
        print("semantica-surface: the pinned wheel does not provide this service's Semantica surface:", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
