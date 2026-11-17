# The platform-owned context-service image (`docs/runtime-contract.md` §9.1).
#
# The bundle's `ContextServiceTopology` fragment uses this directory as the build
# context (`platform/context-service/1.0.0/topology.yaml` → `build.context:
# context-service`), so this Dockerfile lands at the root of that context.
#
# The base image is the platform's pinned interpreter (`platform/toolchain.yaml`
# → `versions.python: 3.12.2`) on the same Debian release as the build toolchain.
# A version drift here is a deployment that speaks the contract from a different
# Python than the one the lock pinned.
FROM python:3.12.2-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv

# Editable install: the source in /srv/app is the module that runs, so the image
# has one copy of the service rather than a copy in the working directory and
# another in site-packages.
COPY pyproject.toml ./
COPY app ./app
RUN pip install --no-cache-dir -e .

# The packaged artifact checks itself (#38). `app/` is the code this image ships and
# `pyproject.toml` pins the engine, so this fails the build when the installed wheel
# does not provide every Semantica name the shipped modules import — the surface the
# prototype only asserted. `semantica-surface.json` is that reviewed surface; CI runs
# the same script over the sources (`python scripts/semantica_surface.py`).
COPY semantica-surface.json ./
COPY scripts/semantica_surface.py ./scripts/semantica_surface.py
RUN python scripts/semantica_surface.py --root /srv

# 8011 is the in-bundle port (§9.1). The service is never published to the host;
# the Compose renderer attaches no ingress network to it.
EXPOSE 8011

CMD ["python", "-m", "uvicorn", "--factory", "app.main:create_app", "--host", "0.0.0.0", "--port", "8011"]
