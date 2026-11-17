"""The platform-owned context-service (`docs/runtime-contract.md` §2).

One Python service, not generated per Solution: Customer/Solution differences
arrive as the compiled Customer Context Package and environment configuration,
never as source. Wire types come from `contracts/` via `scripts/generate.py`;
nothing under `app/generated/` is hand-written.
"""
