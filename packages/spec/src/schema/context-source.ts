import { z } from 'zod';

import { ClassificationSchema, NameSchema, TenantIdSchema } from './common.js';
import { DurationSchema } from './solution-spec.js';

/**
 * `context-sources/*.yaml` — one Customer data source (`docs/semantic-modeling.md` §5.1).
 *
 * A Context Source declares *where* semantics come from and *how fresh* they must
 * be; it never carries data, a connection string or a secret value. `connectorRef`
 * points at a Customer-level Connector asset, which `solution.lock` pins
 * separately — the CCP references connectors, it does not contain them (§3.1).
 *
 * `classification` and `freshness` are required: an unclassified source would
 * default to `restricted` at retrieval, and a source with no freshness SLA could
 * only ever return facts that look fresh. `mode` says which ingest behaviour the
 * source supports — `incremental` follows the watermark, `backfill` replays a
 * window, `rebuild` is the maintenance-window path.
 */
export const ContextSourceSpecSchema = z.strictObject({
  connectorRef: NameSchema,
  /** The dataset/table/path prefix inside the connector's scope. */
  dataset: z.string().min(1).max(300),
  classification: ClassificationSchema,
  freshness: z.strictObject({
    staleAfter: DurationSchema,
    /** The column/token an incremental ingest resumes from. */
    watermark: z.string().min(1).max(100),
  }),
  /** Cron expression; the customer environment schedules the job. */
  schedule: z.string().min(1).max(100),
  mode: z.enum(['incremental', 'backfill', 'rebuild']),
  /** A `secretRef`, never a secret value (`docs/security-and-deployment.md` §5.4). */
  secretRef: z.string().min(1).max(200).optional(),
});

export const ContextSourceSchema = z.strictObject({
  apiVersion: z.literal('fde.dev/v0'),
  kind: z.literal('ContextSource'),
  metadata: z.strictObject({
    customer: TenantIdSchema,
    name: NameSchema,
  }),
  spec: ContextSourceSpecSchema,
});

export type ContextSource = z.infer<typeof ContextSourceSchema>;
export type ContextSourceSpec = z.infer<typeof ContextSourceSpecSchema>;
