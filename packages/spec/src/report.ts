import type { Diagnostic } from './parse.js';

/**
 * The validation report shape every `check*` function returns, and the two
 * helpers that add to it.
 *
 * Both document families (`Solution Spec`, Customer Context Package) answer
 * "do these documents agree?" the same way — a list of errors and a list of
 * warnings, each entry a `Diagnostic` with a stable `code`, a document `path`
 * and, where the fix is knowable, a `remediation`. Keeping the append helpers in
 * one place is what stops the two checkers from drifting into two vocabularies.
 */
export interface ValidationReport {
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

export function error(report: ValidationReport, code: string, path: string, message: string, remediation?: string): void {
  report.errors.push(remediation === undefined ? { code, path, message } : { code, path, message, remediation });
}

export function warn(report: ValidationReport, code: string, path: string, message: string): void {
  report.warnings.push({ code, path, message });
}
