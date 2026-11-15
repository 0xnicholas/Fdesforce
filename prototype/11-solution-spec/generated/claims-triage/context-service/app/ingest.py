# PROTOTYPE — generated skeleton.
# Source: customer/context-packages/acme-claims-context/context-sources/*.yaml
# GAP: the generated ingestion job needs a Connector implementation contract.
# The CCP says `connectorRef: claims-db`, but nothing defines how Python code
# reaches a Postgres/SharePoint connector, or how the same connector is reused
# by a TS Tool. This stub only reads the compiled source list.
import sys

import yaml

from . import settings
from .semantica.graph_store import GraphStore


def run() -> int:
    sources = yaml.safe_load((settings.CONFIG_DIR / "sources.yaml").read_text())["sources"]
    store = GraphStore()
    store.load()
    for source in sources:
        # GAP: no connector invocation here; the ingest path has no contract.
        print(f"would ingest source={source['id']} connector={source['connectorRef']}")
    store.save()
    print(f"graph size: {store.size()}")
    return 0


if __name__ == "__main__":
    sys.exit(run())
