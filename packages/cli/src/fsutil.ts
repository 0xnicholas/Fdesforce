import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { Diagnostic } from './types.js';

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

export type DocumentResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: Diagnostic };

/** Parse a YAML file into a plain object, or return a readable diagnostic. */
export function readDocument(path: string, label: string): DocumentResult {
  if (!isFile(path)) {
    return {
      ok: false,
      error: {
        code: 'document_missing',
        message: `${label} does not exist at ${path}`,
        path,
        remediation: 'check the path or vendor the missing artifact',
      },
    };
  }
  try {
    const parsed: unknown = parseYaml(readFileSync(path, 'utf8'));
    if (!isRecord(parsed)) {
      return {
        ok: false,
        error: { code: 'document_invalid', message: `${label} at ${path} is not a YAML mapping`, path },
      };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'document_unreadable',
        message: `${label} at ${path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
        path,
      },
    };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Sorted child names of a directory; empty when it is not a directory. */
export function listDir(path: string): string[] {
  if (!isDirectory(path)) return [];
  return readdirSync(path).sort();
}

/**
 * Whether a path is content a Context Package digest should cover.
 *
 * Hidden files are editor and filesystem debris (`.DS_Store`, `.gitignore`), not
 * semantics: including them would make a package's digest depend on who checked it
 * out, which is the opposite of content addressing.
 */
export function isContentPath(path: string): boolean {
  return !path.split('/').some((segment) => segment.startsWith('.'));
}

export function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/**
 * Every file below `root`, as sorted POSIX paths relative to `root`.
 * Symlinks are followed so a vendored tree can link a shared package.
 */
export function walkFiles(root: string): string[] {
  if (!isDirectory(root)) return [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push(toPosix(relative(root, path)));
    }
  };
  walk(root);
  return files;
}

export function exists(path: string): boolean {
  return existsSync(path);
}

/**
 * Walk a tree without following symlinks. A Spec file set must not depend on a
 * path outside the Solution directory, so `fde` rejects links instead of
 * quietly reading through them.
 */
export function walkTree(root: string): { files: string[]; links: string[] } {
  if (!isDirectory(root)) return { files: [], links: [] };
  const files: string[] = [];
  const links: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        links.push(toPosix(relative(root, path)));
      } else if (stat.isDirectory()) {
        walk(path);
      } else if (stat.isFile()) {
        files.push(toPosix(relative(root, path)));
      }
    }
  };
  walk(root);
  return { files, links };
}
