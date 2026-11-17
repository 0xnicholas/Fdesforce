import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { CommitIdSchema, DeploymentIdSchema, SolutionIdSchema } from '@fde/spec';

import { buildCatalogues } from './artifacts.js';
import { BUILD_TARGETS, buildBundle, type BuildTarget } from './build.js';
import { installKeys, verifyInstall } from './install.js';
import { loadLockedBuildInput } from './build-input.js';
import {
  freezeContextPackage,
  loadContextPackage,
  scaffoldContextPackage,
  toolchainCompatibility,
  validateContextPackage,
  type ContextPackageProject,
} from './context.js';
import { isDirectory, isFile } from './fsutil.js';
import {
  loadJobsKey,
  newTraceId,
  readJobsKeyFile,
  runIngest,
  type IngestMode,
} from './ingest.js';
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
  fde build --spec <dir> --out <dir> [--deployment <dep_id>] [--target compose] [--environment <name>]
            [--workspace <dir>] [--platform <dir>] [--json]
  fde spec init --template <name@version> --out <dir> [--workspace <dir>] [--platform <dir>] [--json]
  fde spec validate --spec <dir> [--workspace <dir>] [--platform <dir>] [--json]
  fde spec lock [--check] --spec <dir> [--template <name@version>] [--workspace <dir>] [--platform <dir>] [--json]
  fde context init --customer <id> --name <package> --out <dir> [--version <x.y.z>] [--platform <dir>] [--json]
  fde context validate --package <dir> [--workspace <dir>] [--platform <dir>] [--json]
  fde context freeze --package <dir> --actor <id> [--source-commit <sha>] [--workspace <dir>] [--platform <dir>] [--json]
  fde context ingest --package <dir> --context-service <url> --deployment <dep_id> --solution <id> --jobs-key <file>
                     [--kid <id>] [--mode incremental|backfill|rebuild] [--source <id>]... [--workspace <dir>] [--json]
  fde install keys --bundle <dir> --out <dir> [--deployment <dep_id>] [--json]
  fde install verify --bundle <dir> --signature <file> --public-key <file>
                     --release <file> --release-signature <file> --release-public-key <file>
                     --license-catalog <file> [--json]
  fde --help

Commands:
  build           generate, compose and address a Bundle from the locked inputs
  spec init       materialize a versioned Solution Template into a complete Solution directory
  spec validate   report schema, reference, grammar and artifact errors in one pass
  spec lock       regenerate solution.lock; --check fails on any drift
  context init    scaffold a draft Customer Context Package
  context validate report schema, reference and permissions-baseline errors in one pass
  context freeze  write the content-addressed, immutable revision for this package version
  context ingest  run the context-service ingest job over the frozen package (internal job endpoint)
  install keys    generate the mastra-app and fde-jobs ES256 key pairs when they are missing
  install verify  verify the pinned bundle and release signatures, the license boundary and the secret hygiene

Paths:
  --workspace     directory holding fde.workspace.yaml (discovered upward by default)
  --platform      vendored platform artifact store (overrides the workspace manifest)
  --spec          Solution directory containing solution.yaml and solution.lock
  --out           empty directory the Bundle is written to
  --deployment    deployment instance id (dep_<ULID>) the Compose names are derived from; without it the build is unbound
  --environment   which spec.environments entry this bundle targets (required when there are several)
  --bundle        the directory fde build wrote (install)
  --signature     the detached signature over the bundle's address
  --public-key    the pinned key that signed the bundle
  --release       the Release record that approves this bundle
  --release-signature / --release-public-key   the Release signature and the pinned release-manager key
  --license-catalog  the customer's pinned licenses.yaml the redistribution boundary is checked against`;

export async function runCli(argv: readonly string[], io: CliIO = {}): Promise<number> {
  const sink: Sink = {
    cwd: resolve(io.cwd ?? process.cwd()),
    out: io.stdout ?? ((line: string) => process.stdout.write(`${line}\n`)),
    err: io.stderr ?? ((line: string) => process.stderr.write(`${line}\n`)),
  };

  try {
    return await dispatch([...argv], sink);
  } catch (error) {
    sink.err(`error: unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function dispatch(argv: string[], io: Sink): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    io.out(USAGE);
    return 0;
  }
  const group = argv[0];
  if (group !== 'spec' && group !== 'context' && group !== 'build' && group !== 'install') {
    return usageError(io, `unknown command "${group ?? ''}"`);
  }
  if (group === 'build') return buildCommand(argv.slice(1), io);
  const subcommand = argv[1];
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    io.out(USAGE);
    return subcommand === undefined ? 2 : 0;
  }

  const rest = argv.slice(2);
  switch (group) {
    case 'spec':
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
    case 'context':
      switch (subcommand) {
        case 'init':
          return contextInit(rest, io);
        case 'validate':
          return contextValidate(rest, io);
        case 'freeze':
          return contextFreeze(rest, io);
        case 'ingest':
          return contextIngest(rest, io);
        default:
          return usageError(io, `unknown command "fde context ${subcommand}"`);
      }
    case 'install':
      switch (subcommand) {
        case 'keys':
          return installKeysCommand(rest, io);
        case 'verify':
          return installVerifyCommand(rest, io);
        default:
          return usageError(io, `unknown command "fde install ${subcommand}"`);
      }
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
// fde context init
// ---------------------------------------------------------------------------

function contextInit(args: string[], io: Sink): number {
  const flags = parseFlags(args, {
    strings: ['customer', 'name', 'out', 'version', 'workspace', 'platform'],
    booleans: ['json'],
  });
  if (flags.errors.length > 0) return usageError(io, flags.errors[0] ?? 'invalid arguments');
  const json = flags.values['json'] === true;

  const customer = stringFlag(flags, 'customer');
  const name = stringFlag(flags, 'name');
  const outArg = stringFlag(flags, 'out');
  if (customer === undefined) return usageError(io, 'missing required flag --customer');
  if (name === undefined) return usageError(io, 'missing required flag --name');
  if (outArg === undefined) return usageError(io, 'missing required flag --out');

  const workspace = resolveWorkspace(flags, io, io.cwd, 'context init', json);
  if (workspace === undefined) return 1;

  const out = resolve(io.cwd, outArg);
  if (existsSync(out) && (!isDirectory(out) || readdirSync(out).length > 0)) {
    return emitDiagnostics(
      'context init',
      {
        errors: [
          diagnostic('output_not_empty', `${out} is not an empty directory`, {
            path: out,
            remediation: 'choose an empty --out directory; `fde context init` never overwrites a package',
          }),
        ],
        warnings: [],
      },
      io,
      json,
    );
  }

  const version = stringFlag(flags, 'version') ?? '0.1.0';
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) return usageError(io, `--version must be x.y.z (got "${version}")`);

  const compatibility = toolchainCompatibility(workspace.platformRoot);
  if (compatibility.errors.length > 0) {
    return emitDiagnostics('context init', { errors: compatibility.errors, warnings: [] }, io, json);
  }
  const files = scaffoldContextPackage({
    customer,
    name,
    version,
    actor: `fde://${customer}`,
    createdAt: new Date(),
    schemas: { graph: compatibility.graph, audit: compatibility.audit },
    contractMajor: compatibility.contractMajor,
  });

  mkdirSync(out, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    const target = join(out, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }

  if (json) {
    io.out(JSON.stringify({ command: 'context init', ok: true, package: `${customer}/${name}@${version}`, out, files: Object.keys(files).sort(), errors: [], warnings: [] }));
  } else {
    io.out(`scaffolded ${name}@${version} (draft) into ${out}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// fde context validate
// ---------------------------------------------------------------------------

function contextValidate(args: string[], io: Sink): number {
  const flags = parseFlags(args, {
    strings: ['package', 'workspace', 'platform'],
    booleans: ['json'],
  });
  if (flags.errors.length > 0) return usageError(io, flags.errors[0] ?? 'invalid arguments');
  const json = flags.values['json'] === true;

  const loaded = loadContextProject(flags, io, 'context validate', json);
  if (loaded === undefined) return 1;
  return emitDiagnostics('context validate', validateContextPackage(loaded), io, json);
}

// ---------------------------------------------------------------------------
// fde context freeze
// ---------------------------------------------------------------------------

function contextFreeze(args: string[], io: Sink): number {
  const flags = parseFlags(args, {
    strings: ['package', 'actor', 'source-commit', 'workspace', 'platform'],
    booleans: ['json'],
  });
  if (flags.errors.length > 0) return usageError(io, flags.errors[0] ?? 'invalid arguments');
  const json = flags.values['json'] === true;

  const actor = stringFlag(flags, 'actor');
  if (actor === undefined) return usageError(io, 'missing required flag --actor');
  const sourceCommit = stringFlag(flags, 'source-commit');
  if (sourceCommit !== undefined && !CommitIdSchema.safeParse(sourceCommit).success) {
    return usageError(io, `--source-commit must be a commit id (got "${sourceCommit}")`);
  }

  const loaded = loadContextProject(flags, io, 'context freeze', json);
  if (loaded === undefined) return 1;

  const result = freezeContextPackage(loaded, {
    actor,
    now: new Date(),
    ...(sourceCommit === undefined ? {} : { sourceCommit }),
  });
  if (result.status === 'refused') {
    return emitDiagnostics('context freeze', { errors: result.errors, warnings: [] }, io, json);
  }

  const relativePath = result.revisionPath.startsWith(loaded.dir)
    ? result.revisionPath.slice(loaded.dir.length + 1)
    : result.revisionPath;
  if (json) {
    io.out(
      JSON.stringify({
        command: 'context freeze',
        ok: true,
        status: result.status,
        revision: relativePath,
        digest: result.revision.spec.digest,
        errors: [],
        warnings: [],
      }),
    );
  } else if (result.status === 'unchanged') {
    io.out(`${loaded.manifest?.metadata.name}@${loaded.manifest?.metadata.version} is already frozen at ${result.revision.spec.digest}`);
  } else {
    io.out(`froze ${loaded.manifest?.metadata.name}@${loaded.manifest?.metadata.version} at ${result.revision.spec.digest} -> ${relativePath}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// fde context ingest
// ---------------------------------------------------------------------------

const INGEST_MODES: ReadonlyArray<IngestMode> = ['incremental', 'backfill', 'rebuild'];

async function contextIngest(args: string[], io: Sink): Promise<number> {
  const flags = parseFlags(args, {
    strings: ['package', 'context-service', 'deployment', 'solution', 'jobs-key', 'kid', 'mode', 'workspace', 'platform'],
    arrays: ['source'],
    booleans: ['json'],
  });
  if (flags.errors.length > 0) return usageError(io, flags.errors[0] ?? 'invalid arguments');
  const json = flags.values['json'] === true;

  const baseUrl = stringFlag(flags, 'context-service');
  const deploymentId = stringFlag(flags, 'deployment');
  const solutionId = stringFlag(flags, 'solution');
  const jobsKeyPath = stringFlag(flags, 'jobs-key');
  if (stringFlag(flags, 'package') === undefined) return usageError(io, 'missing required flag --package');
  if (baseUrl === undefined) return usageError(io, 'missing required flag --context-service');
  if (deploymentId === undefined) return usageError(io, 'missing required flag --deployment');
  if (solutionId === undefined) return usageError(io, 'missing required flag --solution');
  if (jobsKeyPath === undefined) return usageError(io, 'missing required flag --jobs-key');
  if (!DeploymentIdSchema.safeParse(deploymentId).success) {
    return usageError(io, `--deployment must be dep_<ULID> (got "${deploymentId}")`);
  }
  if (!SolutionIdSchema.safeParse(solutionId).success) {
    return usageError(io, `--solution must be a Solution id (got "${solutionId}")`);
  }

  const modeArg = stringFlag(flags, 'mode') ?? 'incremental';
  const mode = INGEST_MODES.find((candidate) => candidate === modeArg);
  if (mode === undefined) return usageError(io, `--mode must be one of ${INGEST_MODES.join(', ')} (got "${modeArg}")`);

  const loaded = loadContextProject(flags, io, 'context ingest', json);
  if (loaded === undefined) return 1;
  const manifest = loaded.manifest;
  if (manifest === undefined) {
    return emitDiagnostics('context ingest', { errors: loaded.errors, warnings: [] }, io, json);
  }

  // The runtime only ever materializes semantics that were frozen: the digest in
  // the job request must be the one the revision recorded.
  const report = validateContextPackage(loaded);
  if (report.errors.length > 0) return emitDiagnostics('context ingest', report, io, json);
  if (loaded.revision === undefined || loaded.digest === undefined || loaded.revision.spec.digest !== loaded.digest) {
    return emitDiagnostics(
      'context ingest',
      {
        errors: [
          diagnostic(
            'context_package_not_frozen',
            `${manifest.metadata.name}@${manifest.metadata.version} has no frozen revision matching its content`,
            {
              path: `revisions/${manifest.metadata.version}.yaml`,
              remediation: 'run `fde context freeze` first; ingest only accepts a frozen, content-addressed package',
            },
          ),
        ],
        warnings: [],
      },
      io,
      json,
    );
  }

  const declaredSources = new Set(
    (loaded.documents.semanticModel?.spec.sources ?? []).map((source) => source.ref),
  );
  const requested = flags.lists['source'] ?? [];
  const unknown = requested.filter((source) => !declaredSources.has(source));
  if (unknown.length > 0) {
    return emitDiagnostics(
      'context ingest',
      {
        errors: unknown.map((source) =>
          diagnostic('context_reference_unknown', `--source ${source} is not a Context Source this package declares`, {
            path: '--source',
            remediation: `declare the source, or use one of ${[...declaredSources].sort().join(', ') || 'the package sources'}`,
          }),
        ),
        warnings: [],
      },
      io,
      json,
    );
  }

  const pem = readJobsKeyFile(jobsKeyPath);
  if (pem.pem === undefined) return emitDiagnostics('context ingest', { errors: pem.errors, warnings: [] }, io, json);
  const key = loadJobsKey(pem.pem, stringFlag(flags, 'kid'));
  if (key.key === undefined || key.kid === undefined) {
    return emitDiagnostics('context ingest', { errors: key.errors, warnings: [] }, io, json);
  }

  const outcome = await runIngest({
    baseUrl,
    identity: {
      key: key.key,
      kid: key.kid,
      deploymentId,
      solutionId,
      tenantId: manifest.metadata.customer,
    },
    request: {
      package: { name: manifest.metadata.name, version: manifest.metadata.version, digest: loaded.revision.spec.digest },
      mode,
      ...(requested.length === 0 ? {} : { sources: [...new Set(requested)].sort() }),
    },
    traceId: newTraceId(),
    now: new Date(),
  });

  if (outcome.result === undefined) return emitDiagnostics('context ingest', { errors: outcome.errors, warnings: [] }, io, json);

  const result = outcome.result;
  const warnings: Diagnostic[] =
    result.status === 'degraded'
      ? [
          {
            code: 'context_ingest_degraded',
            message: `the job finished degraded: ${result.sources.filter((source) => source.status !== 'ok').map((source) => `${source.source} ${source.status}`).join(', ') || (result.message ?? 'no reason given')}; retrieve returns degraded=true until it is re-run`,
          },
        ]
      : [];
  const errors: Diagnostic[] =
    result.status === 'failed' ? [diagnostic('context_ingest_failed', result.message ?? 'the ingest job failed')] : [];

  if (json) {
    io.out(JSON.stringify({ command: 'context ingest', ok: result.status !== 'failed', result, trace_id: outcome.traceId, errors, warnings }));
  } else {
    for (const warning of warnings) io.err(`warning[${warning.code}] ${warning.message}`);
    for (const error of errors) {
      io.err(`error[${error.code}] ${error.message}`);
      if (error.remediation !== undefined) io.err(`  remediation: ${error.remediation}`);
    }
    io.out(
      `${result.job_id} ${result.status} (${result.mode}) over ${result.sources.length} source(s), trace ${outcome.traceId}${
        result.status === 'failed' ? '; the graph was not updated' : ''
      }`,
    );
  }
  return result.status === 'failed' ? 1 : 0;
}

/** Load the package + workspace both `validate` and `freeze` need, or report why not. */
function loadContextProject(flags: ParsedFlags, io: Sink, command: string, json: boolean): ContextPackageProject | undefined {
  const packageArg = stringFlag(flags, 'package') as string;
  const dir = resolve(io.cwd, packageArg);
  if (!isDirectory(dir)) {
    emitDiagnostics(
      command,
      {
        errors: [
          diagnostic('context_package_missing', `package directory ${dir} does not exist`, {
            path: dir,
            remediation: 'pass --package with a Customer Context Package directory, or run `fde context init`',
          }),
        ],
        warnings: [],
      },
      io,
      json,
    );
    return undefined;
  }

  const workspace = resolveWorkspace(flags, io, dir, command, json);
  if (workspace === undefined) return undefined;
  return loadContextPackage({ dir, workspace });
}

// ---------------------------------------------------------------------------
// fde build
// ---------------------------------------------------------------------------

function buildCommand(args: string[], io: Sink): number {
  if (args.includes('--help') || args.includes('-h')) {
    io.out(USAGE);
    return 0;
  }
  const flags = parseFlags(args, {
    strings: ['spec', 'out', 'target', 'environment', 'deployment', 'workspace', 'platform'],
    booleans: ['json'],
  });
  if (flags.errors.length > 0) return usageError(io, flags.errors[0] ?? 'invalid arguments');
  const json = flags.values['json'] === true;

  if (stringFlag(flags, 'spec') === undefined) return usageError(io, 'missing required flag --spec');
  const outArg = stringFlag(flags, 'out');
  if (outArg === undefined) return usageError(io, 'missing required flag --out');
  const deploymentId = stringFlag(flags, 'deployment');
  if (deploymentId !== undefined && !DeploymentIdSchema.safeParse(deploymentId).success) {
    return usageError(io, `--deployment must be dep_<ULID> (got "${deploymentId}")`);
  }

  const targetArg = stringFlag(flags, 'target') ?? 'compose';
  const target = BUILD_TARGETS.find((candidate) => candidate === targetArg) as BuildTarget | undefined;
  if (target === undefined) {
    return emitDiagnostics(
      'build',
      {
        errors: [
          diagnostic('build_target_unsupported', `v0 builds the compose target only (asked for ${targetArg})`, {
            path: '--target',
            remediation: 'pass --target compose; Helm and the airgap bundle are Slice 2.6',
          }),
        ],
        warnings: [],
      },
      io,
      json,
    );
  }

  const specDir = resolveSpecDir(flags, io, 'build', json);
  if (specDir === undefined) return 1;

  const workspace = resolveWorkspace(flags, io, specDir, 'build', json);
  if (workspace === undefined) return 1;

  const out = resolve(io.cwd, outArg);
  if (existsSync(out) && (!isDirectory(out) || readdirSync(out).length > 0)) {
    return emitDiagnostics(
      'build',
      {
        errors: [
          diagnostic('output_not_empty', `${out} is not an empty directory`, {
            path: out,
            remediation: 'choose an empty --out directory; `fde build` never overwrites a bundle',
          }),
        ],
        warnings: [],
      },
      io,
      json,
    );
  }

  const environment = stringFlag(flags, 'environment');
  const loaded = loadLockedBuildInput({
    specDir,
    workspace,
    ...(environment === undefined ? {} : { environment }),
  });
  if (!loaded.ok) return emitDiagnostics('build', { errors: loaded.errors, warnings: loaded.warnings }, io, json);

  const built = buildBundle(loaded.value, { ...(deploymentId === undefined ? {} : { deploymentId }), target });
  if (!built.ok) return emitDiagnostics('build', { errors: built.errors, warnings: built.warnings }, io, json);

  mkdirSync(dirname(out), { recursive: true });
  const staging = mkdtempSync(join(dirname(out), '.fde-build-'));
  try {
    for (const file of built.value.files) {
      const path = join(staging, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content, { mode: file.mode });
    }
    if (existsSync(out)) rmSync(out, { recursive: true, force: true });
    renameSync(staging, out);
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }

  const manifestPath = join(out, 'bundle.json');
  if (json) {
    io.out(
      JSON.stringify({
        command: 'build',
        ok: true,
        bundle: {
          digest: built.value.digest,
          sourceDigest: built.value.sourceDigest,
          out,
          manifest: manifestPath,
          artifacts: built.value.manifest.artifacts.length,
          licenseGate: built.value.manifest.licenseGate.ok,
          deploymentBound: built.value.manifest.solution.deploymentBound,
        },
        errors: [],
        warnings: built.value.warnings,
      }),
    );
  } else {
    for (const warning of built.value.warnings) printDiagnostic(io, 'warning', warning);
    io.out(
      `built ${built.value.digest} (source ${built.value.sourceDigest}) -> ${out}; ${count(
        built.value.manifest.artifacts.length,
        'artifact',
      )}, ${count(built.value.warnings.length, 'warning')}${
        built.value.manifest.solution.deploymentBound ? '' : ' (unbound: placeholder deployment names)'
      }`,
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// fde install keys
// ---------------------------------------------------------------------------

function installKeysCommand(args: string[], io: Sink): number {
  if (args.includes('--help') || args.includes('-h')) {
    io.out(USAGE);
    return 0;
  }
  const flags = parseFlags(args, {
    strings: ['bundle', 'out', 'deployment'],
    booleans: ['json'],
  });
  if (flags.errors.length > 0) return usageError(io, flags.errors[0] ?? 'invalid arguments');
  const json = flags.values['json'] === true;

  const bundleArg = stringFlag(flags, 'bundle');
  const outArg = stringFlag(flags, 'out');
  if (bundleArg === undefined) return usageError(io, 'missing required flag --bundle');
  if (outArg === undefined) return usageError(io, 'missing required flag --out');
  const deploymentId = stringFlag(flags, 'deployment');
  if (deploymentId !== undefined && !DeploymentIdSchema.safeParse(deploymentId).success) {
    return usageError(io, `--deployment must be dep_<ULID> (got "${deploymentId}")`);
  }

  const out = resolve(io.cwd, outArg);
  const result = installKeys({
    bundleDir: resolve(io.cwd, bundleArg),
    outDir: out,
    ...(deploymentId === undefined ? {} : { deploymentId }),
  });
  if (result.errors.length > 0 || result.manifest === undefined) {
    return emitDiagnostics('install keys', { errors: result.errors, warnings: [] }, io, json);
  }

  const createdKeys = result.created.filter((path) => path.endsWith('.pem'));
  if (json) {
    io.out(
      JSON.stringify({
        command: 'install keys',
        ok: true,
        deploymentId: result.manifest.deploymentId,
        out,
        issuers: result.manifest.issuers.map((issuer) => ({
          issuer: issuer.issuer,
          iss: issuer.iss,
          kid: issuer.kid,
          signingKey: issuer.signingKey.file,
          publicKey: issuer.publicKey.file,
        })),
        created: result.created,
        errors: [],
        warnings: [],
      }),
    );
  } else if (createdKeys.length === 0) {
    io.out(`kept the ${result.manifest.issuers.length} key pairs in ${out} for ${result.manifest.deploymentId}`);
  } else {
    io.out(`generated ${count(createdKeys.length, 'key file')} in ${out} for ${result.manifest.deploymentId}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// fde install verify
// ---------------------------------------------------------------------------

function installVerifyCommand(args: string[], io: Sink): number {
  if (args.includes('--help') || args.includes('-h')) {
    io.out(USAGE);
    return 0;
  }
  const flags = parseFlags(args, {
    strings: ['bundle', 'signature', 'public-key', 'release', 'release-signature', 'release-public-key', 'license-catalog'],
    booleans: ['json'],
  });
  if (flags.errors.length > 0) return usageError(io, flags.errors[0] ?? 'invalid arguments');
  const json = flags.values['json'] === true;

  const required = {
    bundle: '--bundle',
    signature: '--signature',
    'public-key': '--public-key',
    release: '--release',
    'release-signature': '--release-signature',
    'release-public-key': '--release-public-key',
    'license-catalog': '--license-catalog',
  } as const;
  for (const [flag, label] of Object.entries(required)) {
    if (stringFlag(flags, flag) === undefined) return usageError(io, `missing required flag ${label}`);
  }

  const result = verifyInstall({
    bundleDir: resolve(io.cwd, stringFlag(flags, 'bundle') as string),
    signaturePath: resolve(io.cwd, stringFlag(flags, 'signature') as string),
    publicKeyPath: resolve(io.cwd, stringFlag(flags, 'public-key') as string),
    releasePath: resolve(io.cwd, stringFlag(flags, 'release') as string),
    releaseSignaturePath: resolve(io.cwd, stringFlag(flags, 'release-signature') as string),
    releasePublicKeyPath: resolve(io.cwd, stringFlag(flags, 'release-public-key') as string),
    licenseCatalogPath: resolve(io.cwd, stringFlag(flags, 'license-catalog') as string),
  });

  if (json) {
    io.out(
      JSON.stringify({
        command: 'install verify',
        ok: result.ok,
        bundle: result.bundle,
        release: result.release,
        errors: result.errors,
        warnings: result.warnings,
      }),
    );
    return result.ok ? 0 : 1;
  }

  for (const warning of result.warnings) printDiagnostic(io, 'warning', warning);
  if (!result.ok) {
    for (const error of result.errors) printDiagnostic(io, 'error', error);
    io.out(`fde install verify: ${count(result.errors.length, 'error')}, ${count(result.warnings.length, 'warning')}`);
    return 1;
  }

  const bundle = result.bundle as NonNullable<typeof result.bundle>;
  io.out(
    `verified ${bundle.digest} — ${bundle.customer}/${bundle.solution} in ${bundle.environment} (${bundle.deploymentId}), ${count(bundle.files, 'artifact')}`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

interface FlagSpec {
  strings: string[];
  booleans: string[];
  /** Repeatable string flags; each occurrence appends to `lists`. */
  arrays?: string[];
}

interface ParsedFlags {
  values: Flags;
  lists: Record<string, string[]>;
  errors: string[];
}

function parseFlags(args: string[], spec: FlagSpec): ParsedFlags {
  const values: Flags = {};
  const lists: Record<string, string[]> = {};
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
    const repeatable = spec.arrays?.includes(name) ?? false;
    if (!repeatable && !spec.strings.includes(name)) {
      errors.push(`unknown flag --${name}`);
      break;
    }
    if (equals >= 0) {
      const value = arg.slice(equals + 1);
      if (repeatable) lists[name] = [...(lists[name] ?? []), value];
      else values[name] = value;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      errors.push(`--${name} needs a value`);
      break;
    }
    if (repeatable) lists[name] = [...(lists[name] ?? []), value];
    else values[name] = value;
    index += 1;
  }

  return { values, lists, errors };
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
