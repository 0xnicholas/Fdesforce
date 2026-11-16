# The build toolchain that produces a Bundle. Nothing here runs at deploy time;
# the generated runtime app ships its own image.
#
# Pinned to the versions in `platform/toolchain.yaml` and the active Runtime
# Profile. `fde spec lock` folds this file's digest into the image reference, so
# a base-image bump is visible as lock drift rather than a silent rebuild.
FROM node:22.13.0-bookworm-slim AS node

FROM python:3.12.2-slim-bookworm

COPY --from=node /usr/local /usr/local

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
    && corepack prepare pnpm@10.33.2 --activate \
    && pip install --no-cache-dir uv==0.8.15

WORKDIR /workspace
