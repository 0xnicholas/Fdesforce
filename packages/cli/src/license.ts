import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson, normalizeText, sha256, type Digest } from '@fde/spec';
import { parse as parseYaml } from 'yaml';

import { asArray, asRecord, asString, isFile } from './fsutil.js';
import { diagnostic, type Diagnostic } from './types.js';

/**
 * The license gate, SBOM and notices (`docs/domain-model.md` §3.8, §5).
 *
 * A bundle may be redistributed to a customer, so its licenses are a build gate,
 * not documentation: the component inventory is declared in the vendored
 * `platform/licenses.yaml`, and a component with no declared license fails the
 * build rather than shipping an assertion nobody checked. The denylist is the v0
 * distribution boundary — GPL/AGPL/LGPL, SSPL, Elastic License and BUSL.
 *
 * Mastra is included **core-only**: `@mastra/ee` is not Apache-2.0, so the gate
 * refuses any Mastra package other than `@mastra/core` in the Runtime Profile or
 * the generated app's manifest. That check lives here, next to the denylist,
 * because both answer the same question: may this bundle be redistributed?
 */

export interface LicenseCatalogComponent {
  license: string;
  source?: string;
  url?: string;
}

export interface LicenseCatalog {
  file: string;
  digest: Digest;
  denied: string[];
  components: Record<string, LicenseCatalogComponent>;
}

export const LICENSE_CATALOG_FILE = 'licenses.yaml';

export function loadLicenseCatalog(platformRoot: string): { catalog?: LicenseCatalog; errors: Diagnostic[] } {
  const errors: Diagnostic[] = [];
  const path = join(platformRoot, LICENSE_CATALOG_FILE);
  if (!isFile(path)) {
    errors.push(
      diagnostic('license_catalog_missing', `the platform store has no ${LICENSE_CATALOG_FILE}; the license gate has nothing to check against`, {
        path,
        remediation: `vendor ${LICENSE_CATALOG_FILE} in the platform store, or pass --platform with one`,
      }),
    );
    return { errors };
  }

  let document: unknown;
  try {
    document = parseYaml(readFileSync(path, 'utf8'));
  } catch (cause) {
    errors.push(
      diagnostic('license_catalog_invalid', `${LICENSE_CATALOG_FILE} is not valid YAML: ${(cause as Error).message}`, { path }),
    );
    return { errors };
  }
  if (asString(asRecord(document)['kind']) !== 'LicenseCatalog') {
    errors.push(
      diagnostic('license_catalog_invalid', `${LICENSE_CATALOG_FILE} must declare kind LicenseCatalog`, { path }),
    );
    return { errors };
  }

  const spec = asRecord(asRecord(document)['spec']);
  const denied = asArray(spec['denied']).flatMap((entry) => {
    const value = asString(entry);
    return value === undefined ? [] : [value];
  });
  const components: Record<string, LicenseCatalogComponent> = {};
  for (const [name, raw] of Object.entries(asRecord(spec['components']))) {
    const license = asString(asRecord(raw)['license']);
    if (license === undefined) {
      errors.push(
        diagnostic('license_catalog_invalid', `component ${name} declares no license`, {
          path: `spec.components.${name}`,
          remediation: 'declare an SPDX license id for every component the bundle may contain',
        }),
      );
      continue;
    }
    const source = asString(asRecord(raw)['source']);
    const url = asString(asRecord(raw)['url']);
    components[name] = { license, ...(source === undefined ? {} : { source }), ...(url === undefined ? {} : { url }) };
  }
  if (denied.length === 0) {
    errors.push(
      diagnostic('license_catalog_invalid', 'the license catalog declares no denied licenses', {
        path: 'spec.denied',
        remediation: 'state the redistribution boundary explicitly; a gate with no denylist is not a gate',
      }),
    );
  }
  if (errors.length > 0) return { errors };

  return {
    catalog: {
      file: path,
      digest: sha256(normalizeText(readFileSync(path, 'utf8'))),
      denied,
      components,
    },
    errors,
  };
}

/** One third-party component the bundle carries, before the catalog resolves its license. */
export interface BundleComponent {
  name: string;
  version: string;
  source?: string;
}

export interface ResolvedComponent extends BundleComponent {
  license: string;
  source?: string;
  url?: string;
}

export interface LicenseGateResult {
  ok: boolean;
  components: ResolvedComponent[];
  errors: Diagnostic[];
}

/**
 * SPDX license families the denylist names, so `GPL-3.0-only`, `GPL-3.0-or-later`
 * and `GPL-3.0+` are one verdict instead of three spellings to remember.
 */
function licenseFamily(license: string): string {
  return license.trim().replace(/\+$/, '').replace(/-(only|or-later)$/i, '');
}

/**
 * Every license id in an SPDX expression, so `MIT AND GPL-3.0-only` is not
 * mistaken for a permissive license because it starts with `MIT`.
 */
function deniedIn(expression: string, deniedFamilies: ReadonlySet<string>): string | undefined {
  const tokens = expression.split(/[\s()]+/).filter((token) => token.length > 0);
  return tokens.map(licenseFamily).find((family) => deniedFamilies.has(family));
}

const MASTRA_CORE = '@mastra/core';

function isMastraPackage(name: string): boolean {
  return name.startsWith('@mastra/') || name === 'mastra' || name.startsWith('mastra-');
}

/**
 * The gate: every component has a declared license, no declared license is
 * denied, Mastra is core-only, and Semantica is the MIT package the platform
 * vouches for. `mastraPackages` is every Mastra package name the build can see
 * (the Runtime Profile's packages and the generated app's dependencies), so a
 * profile cannot smuggle `@mastra/ee` in under a different component id.
 */
export function checkLicenseGate(input: {
  catalog: LicenseCatalog;
  inventory: ReadonlyArray<BundleComponent>;
  mastraPackages: ReadonlyArray<string>;
}): LicenseGateResult {
  const errors: Diagnostic[] = [];
  const deniedFamilies = new Set(input.catalog.denied.map(licenseFamily));
  const resolved: ResolvedComponent[] = [];

  for (const name of [...new Set(input.mastraPackages)].sort()) {
    if (isMastraPackage(name) && name !== MASTRA_CORE) {
      errors.push(
        diagnostic('license_blocked', `${name} is a Mastra package other than ${MASTRA_CORE}; Mastra is bundled core-only (Apache-2.0)`, {
          path: 'profile.spec.packages',
          remediation: `remove ${name}; the \`ee/\` packages are not Apache-2.0 and cannot be redistributed in this bundle`,
        }),
      );
    }
  }

  const seen = new Set<string>();
  for (const component of input.inventory) {
    if (seen.has(component.name)) continue;
    seen.add(component.name);

    const declared = input.catalog.components[component.name];
    if (declared === undefined) {
      errors.push(
        diagnostic(
          'license_undeclared',
          `component ${component.name}@${component.version} is not declared in ${LICENSE_CATALOG_FILE}, so the bundle's license boundary cannot be checked`,
          {
            path: `spec.components.${component.name}`,
            remediation: `declare ${component.name} in platform/${LICENSE_CATALOG_FILE}, or remove it from the bundle`,
          },
        ),
      );
      continue;
    }

    const denied = deniedIn(declared.license, deniedFamilies);
    if (denied !== undefined) {
      errors.push(
        diagnostic(
          'license_blocked',
          `${component.name}@${component.version} is ${declared.license}, which the redistribution denylist forbids`,
          {
            path: `spec.components.${component.name}.license`,
            remediation: 'replace the component with a permissively licensed one, or change the distribution model',
          },
        ),
      );
      continue;
    }

    if (component.name === 'semantica' && declared.license !== 'MIT') {
      errors.push(
        diagnostic(
          'license_blocked',
          `Semantica is declared ${declared.license}, but the v0 bundle may only carry the MIT package`,
          {
            path: `spec.components.semantica.license`,
            remediation: 'pin the MIT Semantica distribution; the license boundary is part of the Slice 1 acceptance criteria',
          },
        ),
      );
      continue;
    }

    resolved.push({
      ...component,
      license: declared.license,
      ...(declared.source === undefined ? {} : { source: declared.source }),
      ...(declared.url === undefined ? {} : { url: declared.url }),
    });
  }

  return { ok: errors.length === 0, components: resolved, errors };
}

const spdxId = (name: string): string => `SPDXRef-Package-${name.replace(/[^A-Za-z0-9.-]+/g, '-')}`;

/**
 * SPDX 2.3 JSON. `created` is provenance about the build, so the build passes its
 * injected clock; the SBOM is evidence beside the payload, not part of the bundle
 * digest (see `build.ts`).
 */
export function renderSpdx(input: {
  name: string;
  namespace: string;
  created: string;
  components: ReadonlyArray<ResolvedComponent>;
}): string {
  const packages = input.components.map((component) => ({
    SPDXID: spdxId(component.name),
    name: component.name,
    versionInfo: component.version,
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: component.license,
    licenseDeclared: component.license,
    supplier: 'NOASSERTION',
    ...(component.url === undefined ? {} : { homepage: component.url }),
  }));

  const document = {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: input.name,
    documentNamespace: `https://fde.dev/spdx/${input.namespace}`,
    creationInfo: {
      created: input.created,
      creators: ['Tool: fde-build-0.1.0'],
    },
    packages,
    relationships: packages.map((pkg) => ({
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'DESCRIBES',
      relatedSpdxElement: pkg.SPDXID,
    })),
  };
  return `${JSON.stringify(JSON.parse(canonicalJson(document)), null, 2)}\n`;
}

/** The human-readable notice beside the SBOM. Deterministic: no clock, no paths. */
export function renderNotice(input: {
  customer: string;
  solution: string;
  components: ReadonlyArray<ResolvedComponent>;
}): string {
  const lines = [
    `FDE Bundle — ${input.customer}/${input.solution}`,
    '',
    'This bundle includes the following third-party components:',
    '',
    ...input.components.map(
      (component) => `- ${component.name} ${component.version} — ${component.license}${component.source === undefined ? '' : ` (${component.source})`}`,
    ),
    '',
    'Full license texts are distributed with the upstream packages and are not modified by this bundle.',
    '',
  ];
  return lines.join('\n');
}
