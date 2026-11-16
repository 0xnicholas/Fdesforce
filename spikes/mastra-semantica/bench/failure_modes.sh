#!/bin/bash
ROOT=${SPIKE_ROOT:-/tmp/fdesforce-spike-5}
BASE=http://127.0.0.1:8011
OUT=$ROOT/artifacts/failure-modes.txt
: > "$OUT"

req() {
  local label="$1"; shift
  local code
  code=$(curl -s -o /tmp/fm-body.json -w '%{http_code}' "$@")
  echo "== $label: HTTP $code" >> "$OUT"
  head -c 500 /tmp/fm-body.json >> "$OUT"
  echo >> "$OUT"
}

req "missing tenant" -X POST "$BASE/v1/context/retrieve" -H 'content-type: application/json' -H 'x-actor: a' -d '{"query":"refund"}'
req "missing actor" -X POST "$BASE/v1/context/retrieve" -H 'content-type: application/json' -H 'x-tenant-id: acme' -d '{"query":"refund"}'
req "cross-tenant entity read" -X POST "$BASE/v1/decisions" -H 'content-type: application/json' -H 'x-tenant-id: globex' -H 'x-actor: a' -H 'x-trace-id: tr-fm-1' -d '{"category":"x","scenario":"x","reasoning":"x","outcome":"x","confidence":0.5,"entities":["acme:policy:refund"],"evidence_ids":["acme:policy:refund"]}'
req "unknown entity" -X POST "$BASE/v1/decisions" -H 'content-type: application/json' -H 'x-tenant-id: acme' -H 'x-actor: a' -H 'x-trace-id: tr-fm-2' -d '{"category":"x","scenario":"x","reasoning":"x","outcome":"x","confidence":0.5,"entities":["acme:missing"],"evidence_ids":["acme:missing"]}'
req "invalid confidence" -X POST "$BASE/v1/decisions" -H 'content-type: application/json' -H 'x-tenant-id: acme' -H 'x-actor: a' -H 'x-trace-id: tr-fm-3' -d '{"category":"x","scenario":"x","reasoning":"x","outcome":"x","confidence":2,"entities":[],"evidence_ids":[]}'
req "unknown provenance" -H 'x-tenant-id: acme' -H 'x-actor: a' -H 'x-trace-id: tr-fm-4' "$BASE/v1/provenance/nope"
req "globex retrieval" -X POST "$BASE/v1/context/retrieve" -H 'content-type: application/json' -H 'x-tenant-id: globex' -H 'x-actor: a' -H 'x-trace-id: tr-fm-5' -d '{"query":"refund policy","max_hops":1,"top_k":5}'
req "acme retrieval other tenant marker" -X POST "$BASE/v1/context/retrieve" -H 'content-type: application/json' -H 'x-tenant-id: acme' -H 'x-actor: a' -H 'x-trace-id: tr-fm-6' -d '{"query":"globex refund","max_hops":1,"top_k":5}'

cat "$OUT"
