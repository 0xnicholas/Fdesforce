/**
 * Naming rules for generated identifiers.
 *
 * A Spec id is kebab-case; a TypeScript identifier is not. One place decides the
 * mapping, so two modules that refer to the same Spec construct always agree on
 * the name — a mismatch would be a compile error in the generated tree, which is
 * exactly the failure mode the slice cannot afford to discover late.
 */

/** `triage-agent` → `triageAgent`. */
export const camel = (value: string): string => {
  const parts = value.split(/[^A-Za-z0-9]+/).filter((part) => part.length > 0);
  return parts
    .map((part, index) => (index === 0 ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
    .join('');
};

/** A safe identifier: camelCase, and never starting with a digit. */
export const identifier = (value: string): string => camel(value).replace(/^([0-9])/, 'n$1');

/** `claims-lookup.input.json` → `claims_lookup_input` (a module name, not an identifier). */
export const moduleName = (specFilePath: string): string => {
  const base = specFilePath.split('/').pop() ?? specFilePath;
  return base
    .replace(/\.json$/, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
};

/** The exported `PublicSchema` constant for a Spec JSON Schema file. */
export const schemaExportName = (specFilePath: string): string =>
  `${identifier(moduleName(specFilePath).replace(/_/g, '-'))}Schema`;

/** A file's text as a template-literal body: backslashes, backticks and `${` are escaped. */
export const templateLiteral = (text: string): string =>
  text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

/** JSON as a TypeScript object literal: canonical order, indented to `indent`. */
export function jsonLiteral(value: unknown, indent = 0): string {
  return JSON.stringify(value, null, 2)
    .split('\n')
    .map((line, index) => (index === 0 ? line : `${' '.repeat(indent)}${line}`))
    .join('\n');
}

/** A string as a single-quoted TypeScript literal, matching the emitted code's style. */
export const singleQuoted = (text: string): string => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
