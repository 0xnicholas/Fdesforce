"""The Semantica surface check, exercised through its own exit code (CI's seam).

`scripts/semantica_surface.py` is what CI runs, so the tests run the script the way
CI does — a process, a root, an exit code — and never import its internals. Each
negative case plants exactly one way for the surface to drift and asserts the
script names it: an unimportable name, an undeclared import, an import outside the
adapter, and a pin that moved without the manifest.

The positive case is the committed service: if this file's first test fails, the
pinned wheel and this repository disagree about what `semantica` provides.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = SERVICE_ROOT / "scripts" / "semantica_surface.py"

#: A manifest that declares only what the adapter below imports.
MANIFEST = {
    "distribution": "semantica",
    "pin": "0.7.0",
    "adapters": ["app/graph/semantica_graph.py"],
    "modules": {"semantica.context": {"kind": "module", "names": {"ContextGraph": {"kind": "class"}}}},
}

ADAPTER = '''from semantica.context import ContextGraph


def build() -> object:
    return ContextGraph(advanced_analytics=False)
'''


def run(root: Path | None = None) -> subprocess.CompletedProcess[str]:
    command = [sys.executable, str(SCRIPT)]
    if root is not None:
        command += ["--root", str(root)]
    return subprocess.run(
        command,
        cwd=str(SERVICE_ROOT),
        env={**os.environ, "PYTHONPATH": str(SERVICE_ROOT)},
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )


def tree(tmp_path: Path, *, files: dict[str, str], pin: str = "0.7.0", manifest: dict | None = MANIFEST) -> Path:
    """A service-shaped root: the generated pin, the sources under test, a manifest."""
    write(tmp_path / "app" / "generated" / "versions.py", f'SEMANTICA_VERSION = "{pin}"\n')
    for name, content in files.items():
        write(tmp_path / name, content)
    if manifest is not None:
        write(tmp_path / "semantica-surface.json", json.dumps(manifest, indent=2))
    return tmp_path


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_the_committed_service_matches_the_pinned_wheel() -> None:
    """The claim CI makes: every Semantica import in this service is on the 0.7.0 wheel."""
    result = run()

    assert result.returncode == 0, result.stdout + result.stderr
    assert "semantica 0.7.0" in result.stdout


def test_an_import_the_pinned_wheel_does_not_provide_fails(tmp_path: Path) -> None:
    root = tree(tmp_path, files={"app/graph/semantica_graph.py": "from semantica.context import ContextGraphs\n"})

    result = run(root)

    assert result.returncode != 0
    assert "ContextGraphs" in result.stderr, "the failure must name the symbol, or an operator cannot act on it"


def test_an_import_the_manifest_does_not_declare_fails(tmp_path: Path) -> None:
    """Widening the dependency is a reviewed decision, not something a merge can slip in."""
    root = tree(
        tmp_path,
        files={
            "app/graph/semantica_graph.py": (
                "from semantica.context import ContextGraph\n"
                "from semantica.ontology import OntologyGenerator\n"
            )
        },
    )

    result = run(root)

    assert result.returncode != 0
    assert "semantica.ontology.OntologyGenerator" in result.stderr


def test_the_engine_outside_the_declared_adapter_fails(tmp_path: Path) -> None:
    """`app/` ships in the image; `docs/research/semantic-layer-selection.md` §5.4 keeps the engine in one module."""
    root = tree(
        tmp_path,
        files={
            "app/graph/semantica_graph.py": ADAPTER,
            "app/retrieval.py": "import semantica\n",
        },
    )

    result = run(root)

    assert result.returncode != 0
    assert "app/retrieval.py" in result.stderr


def test_a_pin_that_moved_without_the_manifest_fails(tmp_path: Path) -> None:
    root = tree(tmp_path, files={"app/graph/semantica_graph.py": ADAPTER}, pin="0.8.0")

    result = run(root)

    assert result.returncode != 0
    assert "0.8.0" in result.stderr and "0.7.0" in result.stderr


def test_the_installed_engine_must_be_the_pinned_one(tmp_path: Path) -> None:
    root = tree(
        tmp_path,
        files={"app/graph/semantica_graph.py": ADAPTER},
        pin="9.9.9",
        manifest={**MANIFEST, "pin": "9.9.9"},
    )

    result = run(root)

    assert result.returncode != 0
    assert "installed semantica" in result.stderr


def test_write_produces_a_manifest_the_check_accepts(tmp_path: Path) -> None:
    """The documented workflow: add an import, `--write`, review the diff, green."""
    root = tree(tmp_path, files={"app/graph/semantica_graph.py": ADAPTER}, manifest=None)
    assert run(root).returncode != 0, "without a manifest there is nothing to check against"

    written = subprocess.run(
        [sys.executable, str(SCRIPT), "--root", str(root), "--write"],
        cwd=str(SERVICE_ROOT),
        env={**os.environ, "PYTHONPATH": str(SERVICE_ROOT)},
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )

    assert written.returncode == 0, written.stdout + written.stderr
    manifest = json.loads((root / "semantica-surface.json").read_text(encoding="utf-8"))
    assert manifest["modules"]["semantica.context"]["names"]["ContextGraph"]["kind"] == "class"
    assert run(root).returncode == 0
