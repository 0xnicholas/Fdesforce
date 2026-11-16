// Seam: the `RuntimeGenerator` port's shape (`docs/runtime-adapter.md` §4).
//
// Two properties are non-negotiable. Everything crossing the port is
// JSON-serializable, because a second generator may be Python behind a JSON shim.
// And the port has no lifecycle: `build`, `deploy`, `run`, `resume` and
// `checkpoint` would turn it back into the runtime abstraction ADR-0010 rejected.
import { describe, expect, it } from 'vitest';

import { canonicalJson, parseRuntimeTopology } from '@fde/spec';
import type { GeneratedApp, RuntimeGenerator, RuntimeValidationInput } from '../src/index.js';
import { deriveRequirements, resolveRuntimeProfile, validateRuntime } from '../src/index.js';
import { SOURCE_DIGEST, fakeGenerator } from './support/fake-generator.js';
import { exampleProfile, validationInput } from './support/fixtures.js';

/** `AssertNever<X>` only compiles when `X` is `never`; used as a compile-time check. */
type AssertNever<T extends never> = T;

/**
 * Every leaf of a port type must be plain data. `Date`, `Map`, `Set`, `bigint`,
 * `symbol` and functions are the ways a "JSON-serializable" type usually stops
 * being one, so each is reported as a problem type.
 */
type DataProblem<T> = T extends string | number | boolean | null | undefined
  ? never
  : T extends readonly (infer U)[]
    ? DataProblem<U>
    : T extends (...args: never[]) => unknown
      ? ['function']
      : T extends Date | Map<unknown, unknown> | Set<unknown> | bigint | symbol
        ? ['not json']
        : T extends object
          ? { [K in keyof T]-?: DataProblem<T[K]> }[keyof T]
          : never;

export type _InputIsData = AssertNever<DataProblem<RuntimeValidationInput>>;
export type _GeneratedAppIsData = AssertNever<DataProblem<GeneratedApp>>;

const LIFECYCLE_METHODS = ['build', 'deploy', 'run', 'resume', 'checkpoint', 'snapshot', 'start', 'stop'] as const;
type LifecycleMethod = (typeof LIFECYCLE_METHODS)[number];
/** The port must not grow a lifecycle method; this fails to compile if it does. */
export type _NoLifecycleMethods = AssertNever<Extract<keyof RuntimeGenerator, LifecycleMethod>>;

const PORT_METHODS = [
  'capabilities',
  'family',
  'generateApp',
  'generateContractTests',
  'generateMigrations',
  'generateTopology',
  'validate',
  'version',
];

/** Paths holding `undefined`, which `JSON.stringify` would silently drop. */
function undefinedPaths(value: unknown, path = '$'): string[] {
  if (value === undefined) return [path];
  if (Array.isArray(value)) return value.flatMap((item, index) => undefinedPaths(item, `${path}[${index}]`));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => undefinedPaths(item, `${path}.${key}`));
  }
  return [];
}

/** A generate input: the validation input plus the deterministic build context. */
const generateInputFor = () => {
  const input = validationInput();
  return {
    ...input,
    profile: input.profile!,
    build: {
      buildId: 'build-1',
      toolchain: { generator: '0.1.0', image: `ghcr.io/fde/workbench/toolchain@sha256:${'d'.repeat(64)}` },
    },
  };
};

function expectJsonClean(value: unknown): void {
  expect(undefinedPaths(value)).toEqual([]);
  expect(() => canonicalJson(value)).not.toThrow();
  expect(JSON.parse(JSON.stringify(value))).toEqual(value);
}

describe('the port surface', () => {
  it('exposes two identity fields and six methods, and nothing else', () => {
    expect(Object.keys(fakeGenerator()).sort()).toEqual(PORT_METHODS);
  });

  it('answers capabilities() with the shared normalized declaration', () => {
    const profile = exampleProfile();
    const generator = fakeGenerator();

    expect(generator.capabilities(profile)).toEqual(resolveRuntimeProfile(profile).capabilities);
  });

  it('has no build/deploy/run/resume/checkpoint method to call', () => {
    const generator = fakeGenerator() as unknown as Record<string, unknown>;

    for (const method of LIFECYCLE_METHODS) expect(generator[method]).toBeUndefined();
  });
});

describe('everything crossing the port is plain JSON', () => {
  it('round-trips a validation input', () => {
    expectJsonClean(validationInput());
  });

  it('round-trips a validation result, errors and warnings included', () => {
    const input = validationInput();
    delete input.profile;
    const result = fakeGenerator().validate(input);

    expect(result.errors.length).toBeGreaterThan(0);
    expectJsonClean(result);
  });

  it('round-trips requirements and the resolved profile', () => {
    const input = validationInput();

    expectJsonClean(deriveRequirements({ spec: input.spec, environment: input.environment }));
    expectJsonClean(resolveRuntimeProfile(exampleProfile()));
  });

  it('round-trips a generated app, migrations and test plan', () => {
    const generator = fakeGenerator();
    const generateInput = generateInputFor();

    const app = generator.generateApp(generateInput);
    expectJsonClean(app);
    expect(app.sourceDigest).toBe(SOURCE_DIGEST);

    expectJsonClean(generator.generateMigrations(generateInput));
    expectJsonClean(generator.generateContractTests(generateInput));
  });

  it('emits a RuntimeTopology the topology document schema accepts', () => {
    const topology = fakeGenerator().generateTopology(generateInputFor());
    const parsed = parseRuntimeTopology(topology);

    expect(parsed.ok, parsed.ok ? '' : JSON.stringify(parsed.errors)).toBe(true);
    expectJsonClean(topology);
  });
});

describe('validate never throws for an expected failure', () => {
  it('returns diagnostics through the port', () => {
    const input = { ...validationInput() };
    delete input.profile;

    expect(() => validateRuntime(input)).not.toThrow();
    expect(fakeGenerator().validate(input).errors[0]?.code).toBe('runtime_profile_missing');
  });
});
