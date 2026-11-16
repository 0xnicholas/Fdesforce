import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { buildCatalogues } from './artifacts.js';
import { isDirectory, isFile } from './fsutil.js';
import { buildLock, diffLock, driftDiagnostics, renderLock } from './lock.js';
import { loadProject } from './project.js';
import { parseRef } from './refs.js';
import { diagnostic, type Diagnostic, type Report } from './types.js';
import { loadWorkspace, type Workspace } from './workspace.js';
import { validateProject } from './validate.js';

export interface CliIO {
  cwd?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

interface Sink {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

type Flags = Record<string, string | true>;

const USAGE = `fde — the FDE workbench CLI

Usage:
  fde spec init --template <name@version> --out <dir> [--workspace <dir>] [--platform <dir>] [--json]
  fde spec validate --spec <dir> [--workspace <dir>] [--platform <dir>] [--json]
  fde spec lock [--check] --spec <dir> [--template <name@version>] [--workspace <dir>] [--platform <dir>] [--json]
  fde --help

Commands:
  spec init       materialize a versioned Solution Template into a complete Solution directory
  spec validate   report schema, reference, grammar and artifact errors in one pass
  spec lock       regenerate solution.lock; --check fails on any drift

Paths:
  --workspace     directory holding fde.workspace.yaml (discovered upward by default)
  --platform      vendored platform artifact store (overrides the workspace manifest)
  --spec          Solution directory containing solution.yaml and solution.lock`;

export async function runCli(argv: readonly string[], io: CliIO = {}): Promise<number> {
  const sink: Sink = {
    cwd: resolve(io.cwd ?? process.cwd()),
    out: io.stdout ?? ((line: string) => process.stdout.write(`${line}\n`)),
    err: io.stderr ?? ((line: string) => process.stderr.write(`${line}\n`)),
  };

  try {
    return dispatch([...argv], sink);
  } catch (error) {
    sink.err(`error: unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function dispatch(argv: string[], io: Sink): number {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    io.out(USAGE);
    return 0;
  }
  if (argv[0] !== 'spec') {
    return usageError(io, `unknown command "${argv[0] ?? ''}"`);
  }
  const subcommand = argv[1];
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    io.out(USAGE);
    return subcommand === undefined ? 2 : 0;
  }

  const rest = argv.slice(2);
  switch (subcommand) {
    case 'init':
      return specInit(rest, io);
    case 'validate':
      return specValidate(rest, io);
    case 'lock':
      return specLock(rest, io);
    default:
      return usageError(io, `unknown command "fde spec ${subcommand}"`);
  }
}

// ---------------------------------------------------------------------------
// fde spec init
// ---------------------------------------------------------------------------

function specInit(args: string[], io: Sink): number {
  const flags = parseFlags(args, {
    strings: ['template', 'out', 'workspace', 'platform'],
    booleans: ['json'],
  });
  if (flags.errors.length > 0) return usageError(io, flags.errors[0] ?? 'invalid arguments');
  const json = flags.values['json'] === true;

  const templateRef = stringFlag(flags, 'template');
  const outArg = stringFlag(flags, 'out');
  if (templateRef === undefined) return usageError(io, 'missing required flag --template');
  if (outArg === undefined) return usageError(io, 'missing required flag --out');

  const workspace = resolveWorkspace(flags, io, io.cwd, 'spec init', json);
  if (workspace === undefined) return 1;

  const templates = buildCatalogues({ platformRoot: workspace.platformRoot, assets: workspace.assets });
  const template = templates.templates.solution.resolve(templateRef, '--template');
  if (!template.ok) return emitDiagnostics('spec init', { errors: [template.error], warnings: [] }, io, json);

  const out = resolve(io.cwd, outArg);
  if (existsSync(out) && (!isDirectory(out) || readdirSync(out).length > 0)) {
    return emitDiagnostics(
      'spec init',
      {
        errors: [
          diagnostic('output_not_empty', `${out} is not an empty directory`, {
            path: out,
            remediation: 'choose an empty --out directory; `fde spec init` never overwrites a Solution',
          }),
        ],
        warnings: [],
      },
      io,
      json,
    );
  }

  mkdirSync(dirname(out), { recursive: true });
  const staging = mkdtempSync(join(dirname(out), '.fde-init-'));
  try {
    for (const file of template.value.files) {
      const target = join(staging, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(template.value.dir, file), target);
    }

    const project = loadProject({ specDir: staging, workspace });
    const locked = buildLock(project, {
      solutionTemplate: { name: template.value.name, version: template.value.version },
    });
    if (locked.lock === undefined) {
      return emitDiagnostics('spec init', { errors: locked.errors, warnings: [] }, io, json);
    }
    writeFileSync(join(staging, 'solution.lock'), renderLock(locked.lock));

    if (existsSync(out)) rmSync(out, { recursive: true, force: true });
    renameSync(staging, out);

    if (json) {
      io.out(
        JSON.stringify({
          command: 'spec init',
          ok: true,
          template: `${template.value.name}@${template.value.version}`,
          out,
          errors: [],
          warnings: [],
        }),
      );
    } else {
      io.out(`materialized ${template.value.name}@${template.value.version} into ${out}`);
    }
    return 0;
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// fde spec validate
// ---------------------------------------------------------------------------

function specValidate(args: string[], io: Sink): number {
  const flags = parseFlags(args, {
    strings: ['spec', 'workspace', 'platform'],
    booleans: ['json'],
  });
  if (flags.errors.length > 0) return usageError(io, flags.errors[0] ?? 'invalid arguments');
  const json = flags.values['json'] === true;

  if (stringFlag(flags, 'spec') === undefined) return usageError(io, 'missing required flag --spec');
  const specDir = resolveSpecDir(flags, io, 'spec validate', json);
  if (specDir === undefined) return 1;

  const workspace = resolveWorkspace(flags, io, specDir, 'spec validate', json);
  if (workspace === undefined) return 1;

  const project = loadProject({ specDir, workspace });
  const report = validateProject(project);
  return emitDiagnostics('spec validate', report, io, json);
}

// ---------------------------------------------------------------------------
// fde spec lock
// ---------------------------------------------------------------------------

function specLock(args: string[], io: Sink): number {
  const flags = parseFlags(args, {
    strings: ['spec', 'workspace', 'platform', 'template'],
    booleans: ['check', 'json'],
  });
  if (flags.errors.length > 0) return usageError(io, flags.errors[0] ?? 'invalid arguments');
  const json = flags.values['json'] === true;
  const check = flags.values['check'] === true;

  if (stringFlag(flags, 'spec') === undefined) return usageError(io, 'missing required flag --spec');
  const specDir = resolveSpecDir(flags, io, 'spec lock', json);
  if (specDir === undefined) return 1;

  const workspace = resolveWorkspace(flags, io, specDir, 'spec lock', json);
  if (workspace === undefined) return 1;

  const project = loadProject({ specDir, workspace });
  const templateArg = stringFlag(flags, 'template');
  const solutionTemplate =
    templateArg === undefined ? undefined : exactTemplateRef(templateArg, io);
  if (solutionTemplate === undefined && templateArg !== undefined) return 2;

  const recorded = Object.entries(project.lock?.templates.solution ?? {});
  if (solutionTemplate === undefined && recorded.length > 0) {
    const [name, pin] = recorded[0] as [string, string];
    const version = pin.split('@')[0] ?? '';
    return emitDiagnostics(
      'spec lock',
      {
        errors: [
          diagnostic(
            'solution_template_unresolved',
            `solution.lock records materialization provenance ${name}@${version}; pass --template to re-pin it`,
            {
              path: 'templates.solution',
              remediation: `add --template ${name}@${version}`,
            },
          ),
        ],
        warnings: [],
      },
      io,
      json,
    );
  }

  const expected = buildLock(project, solutionTemplate === undefined ? {} : { solutionTemplate });
  if (expected.lock === undefined) {
    return emitDiagnostics('spec lock', { errors: expected.errors, warnings: [] }, io, json);
  }

  if (!check) {
    const path = join(specDir, 'solution.lock');
    writeFileSync(path, renderLock(expected.lock));
    if (json) {
      io.out(JSON.stringify({ command: 'spec lock', ok: true, lock: path, errors: [], warnings: [] }));
    } else {
      io.out(`wrote ${path}`);
    }
    return 0;
  }

  if (!project.lockPresent) {
    return emitDiagnostics(
      'spec lock',
      {
        errors: [
          diagnostic('solution_lock_missing', 'the Solution has no solution.lock to check', {
            path: join(specDir, 'solution.lock'),
            remediation: 'run `fde spec lock`',
          }),
        ],
        warnings: [],
      },
      io,
      json,
    );
  }
  if (project.lock === undefined) {
    return emitDiagnostics('spec lock', { errors: project.lockErrors, warnings: [] }, io, json);
  }

  const drift = diffLock(expected.lock, project.lock);
  if (drift.length === 0) {
    if (json) {
      io.out(JSON.stringify({ command: 'spec lock --check', ok: true, errors: [], warnings: [] }));
    } else {
      io.out('lock is current');
    }
    return 0;
  }
  return emitDiagnostics('spec lock', { errors: driftDiagnostics(drift), warnings: [] }, io, json);
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

interface FlagSpec {
  strings: string[];
  booleans: string[];
}

function parseFlags(args: string[], spec: FlagSpec): { values: Flags; errors: string[] } {
  const values: Flags = {};
  const errors: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (!arg.startsWith('--')) {
      errors.push(`unexpected argument "${arg}"`);
      break;
    }
    const equals = arg.indexOf('=');
    const name = equals < 0 ? arg.slice(2) : arg.slice(2, equals);
    if (spec.booleans.includes(name)) {
      if (equals >= 0) {
        errors.push(`--${name} does not take a value`);
        break;
      }
      values[name] = true;
      continue;
    }
    if (!spec.strings.includes(name)) {
      errors.push(`unknown flag --${name}`);
      break;
    }
    if (equals >= 0) {
      values[name] = arg.slice(equals + 1);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      errors.push(`--${name} needs a value`);
      break;
    }
    values[name] = value;
    index += 1;
  }

  return { values, errors };
}

function stringFlag(flags: { values: Flags }, name: string): string | undefined {
  const value = flags.values[name];
  return typeof value === 'string' ? value : undefined;
}

function exactTemplateRef(ref: string, io: Sink): { name: string; version: string } | undefined {
  const { name, range } = parseRef(ref);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(range)) {
    io.err(`error: --template must be an exact name@version (got "${ref}")`);
    return undefined;
  }
  return { name, version: range };
}

function resolveSpecDir(
  flags: { values: Flags },
  io: Sink,
  command: string,
  json: boolean,
): string | undefined {
  const value = stringFlag(flags, 'spec') as string;
  const path = resolve(io.cwd, value);
  if (isFile(path)) return dirname(path);
  if (!isDirectory(path)) {
    emitDiagnostics(
      command,
      {
        errors: [
          diagnostic('spec_missing', `Spec directory ${path} does not exist`, {
            path,
            remediation: 'pass --spec with a Solution directory, or run `fde spec init`',
          }),
        ],
        warnings: [],
      },
      io,
      json,
    );
    return undefined;
  }
  return path;
}

function resolveWorkspace(
  flags: { values: Flags },
  io: Sink,
  startDir: string,
  command: string,
  json: boolean,
): Workspace | undefined {
  const workspaceArg = stringFlag(flags, 'workspace');
  const platformArg = stringFlag(flags, 'platform');
  const load = loadWorkspace({
    startDir,
    ...(workspaceArg === undefined ? {} : { workspaceDir: resolve(io.cwd, workspaceArg) }),
    ...(platformArg === undefined ? {} : { platformDir: resolve(io.cwd, platformArg) }),
  });
  if (load.workspace === undefined) {
    emitDiagnostics(command, { errors: load.errors, warnings: [] }, io, json);
    return undefined;
  }
  return load.workspace;
}

function usageError(io: Sink, message: string): number {
  io.err(`error: ${message}`);
  io.err('run `fde --help` for usage');
  return 2;
}

function emitDiagnostics(command: string, report: Report, io: Sink, json: boolean): number {
  const ok = report.errors.length === 0;
  if (json) {
    io.out(JSON.stringify({ command, ok, errors: report.errors, warnings: report.warnings }));
    return ok ? 0 : 1;
  }

  for (const warning of report.warnings) printDiagnostic(io, 'warning', warning);
  for (const error of report.errors) printDiagnostic(io, 'error', error);

  const summary = ok
    ? report.warnings.length === 0
      ? 'ok'
      : `ok (${count(report.warnings.length, 'warning')})`
    : `${count(report.errors.length, 'error')}, ${count(report.warnings.length, 'warning')}`;
  io.out(`fde ${command}: ${summary}`);
  return ok ? 0 : 1;
}

function printDiagnostic(io: Sink, level: 'warning' | 'error', item: Diagnostic): void {
  const location = item.path === undefined ? '' : `${item.path}: `;
  io.err(`${level}[${item.code}] ${location}${item.message}`);
  if (item.remediation !== undefined) io.err(`  remediation: ${item.remediation}`);
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}
