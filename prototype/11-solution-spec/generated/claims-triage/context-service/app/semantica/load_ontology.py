# PROTOTYPE — generated skeleton.
# Source: customer/context-packages/acme-claims-context/ontology/*.ttl
# GAP: Semantica 0.7.0 API details are not part of any contract in this repo.
# These imports must be checked against the pinned wheel; the generated service
# cannot rely on documentation alone.
from pathlib import Path

from semantica.ontology import OntologyIngestor  # type: ignore[import-not-found]

ONTOLOGY_DIR = Path(__file__).resolve().parent.parent.parent / "config" / "ontology"


def load() -> None:
    ingestor = OntologyIngestor()
    for ttl in sorted(ONTOLOGY_DIR.glob("*.ttl")):
        ingestor.load(str(ttl))
    ingestor.validate()
