# PROTOTYPE — generated skeleton.
# Source: solution.lock#/runtime + solution.yaml#/spec/environments
import os
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = APP_ROOT / "config"
GRAPH_PATH = Path(os.environ.get("GRAPH_PATH", "/data/graph/graph.json"))
AUDIT_PATH = Path(os.environ.get("AUDIT_PATH", "/data/audit/audit.sqlite"))
BACKEND = os.environ.get("GRAPH_BACKEND", "embedded")
LIMITS = {"max_nodes": 10_000, "max_edges": 50_000}
CONTRACT_VERSION = "1.4.0"
SERVICE_VERSION = "0.1.0"
