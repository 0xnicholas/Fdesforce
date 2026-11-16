import { createHash } from 'node:crypto';

/** `sha256:<64 lowercase hex>`, the only digest form the workbench accepts. */
export type Digest = `sha256:${string}`;

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export interface FileEntry {
  /** POSIX relative path, e.g. `files/prompts/triage.md`. */
  path: string;
  content: string;
}

export interface FileSetDigest {
  /** Digest over the sorted `{path: digest}` manifest — `solution.lock spec.digest`. */
  digest: Digest;
  /** Per-file digests — `solution.lock spec.files`. */
  files: Record<string, Digest>;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') {
    const name = (value as object).constructor?.name;
    return name && name !== 'Object' ? name : 'object';
  }
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Serialize JSON deterministically: object keys sorted by code unit, no
 * insignificant whitespace, arrays in order. Anything JSON cannot round-trip
 * (undefined, non-finite numbers, bigint, class instances) is rejected instead
 * of being silently coerced, so a digest can never depend on `toJSON` quirks.
 */
export function canonicalJson(value: unknown): string {
  const encode = (node: unknown): string => {
    if (node === null) return 'null';
    switch (typeof node) {
      case 'boolean':
        return node ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(node)) {
          throw new TypeError(`canonical JSON rejects non-finite number: ${String(node)}`);
        }
        return JSON.stringify(node);
      case 'string':
        return JSON.stringify(node);
      case 'bigint':
        throw new TypeError('canonical JSON rejects bigint; use a string or number');
      case 'undefined':
        throw new TypeError('canonical JSON rejects undefined; omit the key instead');
      case 'object':
        break;
      default:
        throw new TypeError(`canonical JSON rejects ${typeof node} values`);
    }

    if (Array.isArray(node)) {
      return `[${node.map((item) => encode(item)).join(',')}]`;
    }
    if (!isPlainObject(node)) {
      throw new TypeError(`canonical JSON rejects ${describe(node)} instances; pass plain data`);
    }
    const keys = Object.keys(node).sort();
    const members = keys.map((key) => `${JSON.stringify(key)}:${encode(node[key])}`);
    return `{${members.join(',')}}`;
  };

  return encode(value);
}

/** UTF-8 text normalization shared by every content digest: LF line endings only. */
export function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** `sha256:` digest of the UTF-8 bytes of `text`. */
export function sha256(text: string | Uint8Array): Digest {
  const hash = createHash('sha256').update(text).digest('hex');
  return `sha256:${hash}`;
}

/** Digest of a document's canonical JSON. */
export function digestOf(value: unknown): Digest {
  return sha256(canonicalJson(value));
}

export function isDigest(value: unknown): value is Digest {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function assertLockPath(path: string): void {
  if (path.length === 0) {
    throw new Error('file path must be a non-empty relative path');
  }
  if (path.includes('\\')) {
    throw new Error(`file path must be POSIX-style (no backslashes): ${path}`);
  }
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new Error(`file path must be relative to the Spec directory: ${path}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`file path must be relative and must not contain '..': ${path}`);
  }
  if (segments.some((segment) => segment === '' || segment === '.')) {
    throw new Error(`file path must not contain empty or '.' segments: ${path}`);
  }
}

/**
 * Digest a Spec's local file set the way `solution.lock` records it: per-file
 * digests over LF-normalized text plus one digest over the sorted manifest.
 */
export function digestFiles(entries: ReadonlyArray<FileEntry>): FileSetDigest {
  const files: Record<string, Digest> = {};
  for (const entry of entries) {
    assertLockPath(entry.path);
    if (Object.hasOwn(files, entry.path)) {
      throw new Error(`duplicate file path in file set: ${entry.path}`);
    }
    files[entry.path] = sha256(normalizeText(entry.content));
  }

  const sorted: Record<string, Digest> = {};
  for (const path of Object.keys(files).sort()) {
    sorted[path] = files[path] as Digest;
  }

  return { digest: digestOf(sorted), files: sorted };
}
