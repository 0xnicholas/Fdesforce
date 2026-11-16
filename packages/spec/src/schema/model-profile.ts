import { z } from 'zod';

import { ArtifactRefSchema, SemverSchema } from './common.js';

/**
 * `ModelProfile` — platform-owned, versioned model artifact pinned by
 * `solution.lock modelProfiles`. A Spec only writes `name@range`.
 *
 * Rules (ADR-0012, `docs/domain-model.md` §3):
 * - `kind: embedding` requires `dimensions` and forbids `fallback`: silently
 *   swapping the vector space is worse than failing.
 * - `modelVersion` is an immutable provider snapshot; ranges, aliases and
 *   `latest` are rejected.
 * - `fallback` is at most one hop and only for availability failures.
 */

const FloatingVersionPattern = /^(\^|~|\*|latest$|.*\*)/i;

const ModelParamsSchema = z.strictObject({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxOutputTokens: z.number().int().min(1).optional(),
  seed: z.number().int().optional(),
  stop: z.array(z.string()).optional(),
  responseFormat: z.enum(['text', 'json']).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

const ModelFallbackSchema = z.strictObject({
  profile: ArtifactRefSchema,
  on: z.array(z.enum(['timeout', 'rate_limit', 'provider_5xx'])).min(1),
});

const ModelCompatibilitySchema = z.strictObject({
  runtimeContract: z.string().regex(/^fde\.runtime\/v[0-9]+$/),
  specMajor: z.string().regex(/^v[0-9]+$/),
});

const ModelCapabilitiesSchema = z.strictObject({
  contextWindow: z.number().int().min(1).optional(),
  toolCalling: z.boolean().optional(),
  jsonMode: z.boolean().optional(),
});

export const ModelProfileSpecSchema = z
  .strictObject({
    kind: z.enum(['chat', 'embedding']),
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
    modelVersion: z.string().min(1).max(200).refine((version) => !FloatingVersionPattern.test(version), {
      message: 'modelVersion must be an immutable provider snapshot, not a range, alias or latest',
    }),
    dimensions: z.number().int().min(1).optional(),
    params: ModelParamsSchema.optional(),
    fallback: z.array(ModelFallbackSchema).max(1).optional(),
    compatibility: ModelCompatibilitySchema,
    capabilities: ModelCapabilitiesSchema.optional(),
  })
  .superRefine((spec, ctx) => {
    if (spec.kind === 'embedding') {
      if (spec.dimensions === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['dimensions'],
          message: 'kind: embedding requires dimensions',
        });
      }
      if (spec.fallback && spec.fallback.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['fallback'],
          message: 'kind: embedding forbids fallback; a different vector space is not a fallback',
        });
      }
    } else if (spec.dimensions !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['dimensions'],
        message: 'dimensions is only valid for kind: embedding',
      });
    }
  });

export const ModelProfileSchema = z.strictObject({
  apiVersion: z.literal('fde.dev/v0'),
  kind: z.literal('ModelProfile'),
  metadata: z.strictObject({
    name: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,62}$/),
    version: SemverSchema,
    owner: z.literal('platform'),
  }),
  spec: ModelProfileSpecSchema,
});

export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export type ModelProfileSpec = z.infer<typeof ModelProfileSpecSchema>;
