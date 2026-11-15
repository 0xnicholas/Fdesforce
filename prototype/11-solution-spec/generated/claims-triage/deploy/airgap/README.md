# Air-gapped install (prototype)

The bundle is the same OCI artifact as the connected install; only transport
changes. No registry or template fetch at install time.

1. On the build side, export the bundle and images:

   ```sh
   fde bundle export --bundle sha256:1717... --out claims-triage-airgap.tar
   ```

2. Copy `claims-triage-airgap.tar`, the bundle signature, and the public key to
   the customer host.

3. Verify before unpacking:

   ```sh
   fde install verify --bundle claims-triage-airgap.tar --signature claims-triage.sig
   docker load -i claims-triage-airgap.tar
   ```

4. Resolve the secret refs listed in `acme/environments/acme-prod.yaml`
   (`execution-context signing/public`, `claims-db`, `sharepoint`, model key)
   into the customer's secret store. The bundle never contains secret values.

5. Start the bundle:

   ```sh
   cd deploy
   docker compose --env-file acme-prod.env up -d
   ```

   Expected order: `migrate` exits 0 → `context-service` ready → `ingest`
   exits 0 → `mastra-app` ready.

6. Smoke test:

   ```sh
   curl -fsS http://127.0.0.1:4111/healthz
   curl -fsS http://127.0.0.1:4111/v1/runtime-info
   curl -fsS -X POST http://127.0.0.1:4111/v1/runs \
     -H 'content-type: application/json' \
     -H 'idempotency-key: smoke-1' \
     -d '{"capability_id":"document-triage","input":{"claimId":"C-1001"}}'
   ```

7. Upgrade: stop the old bundle, run the new `migrate`, start the new services,
   keep the audit volume. Rollback re-deploys the previous bundle; audit is not
   rolled back.
