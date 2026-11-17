# GENERATED from contracts/README.md + platform/toolchain.yaml — do not edit.
# Regenerate with `python scripts/generate.py`; CI runs `python scripts/generate.py --check`.

#: The `fde.runtime/v1` minor this service speaks. The runtime app's handshake
#: compares majors (`packages/runtime-generator-mastra/src/runtime-info.ts`).
RUNTIME_CONTRACT_VERSION = '1.4.0'

#: The platform's pin for this service (`lock.runtime.contextService`).
SERVICE_VERSION = '0.1.0'

#: Interpreter and semantic-engine pins, for the SBOM and runtime-info.
PYTHON_VERSION = '3.12.2'
SEMANTICA_VERSION = '0.7.0'

#: Graph and audit schema versions the migrations establish (`spec.schemas`).
GRAPH_SCHEMA_VERSION = '1'
AUDIT_SCHEMA_VERSION = '1'
