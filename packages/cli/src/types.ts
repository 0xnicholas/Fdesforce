import type { Diagnostic, ValidationReport } from '@fde/spec';

/**
 * The CLI emits the same diagnostic shape as `@fde/spec`, so a validation error
 * and a resolution error are interchangeable in text and JSON output.
 */
export type { Diagnostic };
export type Report = ValidationReport;

export function diagnostic(
  code: string,
  message: string,
  options: { path?: string; remediation?: string } = {},
): Diagnostic {
  const value: Diagnostic = { code, message };
  if (options.path !== undefined) value.path = options.path;
  if (options.remediation !== undefined) value.remediation = options.remediation;
  return value;
}

/** Keep the first diagnostic per `(code, path, message)`; exact duplicates add no signal. */
export function dedupe(diagnostics: ReadonlyArray<Diagnostic>): Diagnostic[] {
  const seen = new Set<string>();
  const kept: Diagnostic[] = [];
  for (const item of diagnostics) {
    const key = `${item.code}\u0000${item.path ?? ''}\u0000${item.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(item);
  }
  return kept;
}
