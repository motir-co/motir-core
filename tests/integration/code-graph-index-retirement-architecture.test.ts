import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// THE RETIREMENT GATE'S ARCHITECTURE GUARD (MOTIR-12042 · Story MOTIR-11026),
// seam 5 of `code-graph-index-retirement-gate.test.ts`: nothing in the tracked
// tree imports a module or symbol the story deleted, and no line names the
// retired kind, its pauses or its variables outside migration history, past-tense
// decision records, design records and the kept hits below.
//
// It reads every tracked `.md` — `docs/**` included — so a documentation-only
// pull request can falsify it, and it runs in the docs-guard lane
// (`tests/helpers/docsGuardLane.ts`). That is why it lives apart from the gate:
// it opens no database and imports nothing from `lib/`.

/** The modules the story deleted (`git diff --diff-filter=D` over its branch). */
const DELETED_MODULES = [
  'lib/awsServices/ecrRegistryCredential',
  'lib/dto/indexRebuildStreak',
  'lib/jobs/indexFleetSteps',
  'lib/services/codeGraphIndexAdmissionService',
  'lib/services/codeGraphIndexDispatchService',
  'lib/services/indexRebuildStreakService',
  'packages/orchestrator/src/adapters/aws/indexUserData',
  'packages/orchestrator/src/adapters/fly/indexImage',
  'tests/helpers/fleetIndexJobs',
  'tests/helpers/indexSizeRefusal',
];

/** The symbols the story deleted from files it kept, or with the modules above:
 *  admission and dispatch, the fleet steps, the index image reader, the capacity
 *  pauses, the per-container draw and the run-credential client calls. */
const DELETED_SYMBOLS = [
  'codeGraphIndexAdmissionService',
  'codeGraphIndexDispatchService',
  'runIndexFleetSteps',
  'flyIndexerImage',
  'requireFlyIndexerImage',
  'isFlyIndexerImageConfigured',
  'INDEX_POOL_FULL_PAUSE_REASON',
  'INDEX_NO_ACCOUNT_PAUSE_REASON',
  'INDEX_CAPACITY_PAUSE_REASONS',
  'isIndexCapacityPause',
  'drawIndexAllowance',
  'indexDrawKey',
  'mintCodeGraphRunCredential',
  'fetchCodeGraphRunVerdict',
  'indexFleetConfig',
  'buildIndexUserData',
  'createEcrRegistryCredentialReader',
  'indexRebuildStreakService',
];

/** What no line may name outside the kept hits. */
const RETIRED_LITERALS =
  /code_graph_index|paused_index_pool_full|paused_index_no_indexer_account|MOTIR_INDEXER_IMAGE|MOTIR_INDEX_FLEET_PROVIDER|MOTIR_AWS_INDEXER_AMI_ID/;

/** Where a line may still name them: migration history, past-tense decision
 *  records and the design records. */
const HISTORY_PREFIXES = ['prisma/migrations/', 'docs/decisions/', 'design/'];

/** The kept hits, by path, with why. The list the kind deletion (MOTIR-12041)
 *  named, plus this suite and the story E2E (MOTIR-12043). */
const KEPT_HITS: Record<string, string> = {
  'infra/ci-runner-aws/README.md': 'the AMI build notes record the retired indexer AMI as history',
  'lib/dto/fleetCapacityRequest.ts':
    'a past capacity request stores the retired kind and is still read',
  'tests/billing/fleetUseMappers.test.ts': 'past code_graph_index capacity requests map as history',
  'tests/billing/fleetUseService.test.ts': 'the agent hoster keeps its past index requests',
  'tests/components/FleetUseSection.test.tsx': 'a past index request renders as history',
  'tests/integration/fleetUse/fleetUseStoryGate.test.ts':
    'the billing story gate seeds a past request',
  'tests/jobs/stepResultShapePins.ts': 'RETIRED_STEP_IDS pins retired step shapes as history',
  'tests/helpers/retiredFleetKind.ts':
    'the one helper that names the kind and its pauses for tests of the past',
  'tests/ciFleet/retiredFleetKind.test.ts': 'names the retirement migration directory it runs',
  'tests/integration/code-graph-index-retirement-gate.test.ts':
    'the retirement gate seeds past-history rows of the kind',
  'tests/integration/code-graph-index-retirement-architecture.test.ts':
    'this guard, which names the literals it searches for',
  'tests/e2e/acceptance-index-fleet-retired.spec.ts':
    'the story E2E’s search for the retired names',
};

interface SourceFile {
  path: string;
  text: string;
}

/** Every module specifier a file names: static and dynamic imports, re-exports,
 *  `require` and `vi.mock`. */
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bvi\.(?:do)?mock\s*\(\s*|^\s*import\s+)(['"])([^'"]+)\1/gm;
/** The names a `{ … }` import or re-export binds. */
const NAMED_BINDING = /\b(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g;

function resolvesTo(file: string, specifier: string): string | null {
  const strip = (p: string) => p.replace(/\.(?:[cm]?[jt]sx?)$/, '').replace(/\/index$/, '');
  if (specifier.startsWith('@/')) return strip(specifier.slice(2));
  if (specifier.startsWith('.')) {
    return strip(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
  }
  return null;
}

function importViolations(files: SourceFile[]): string[] {
  const deleted = new Set(DELETED_MODULES);
  const symbols = new Set(DELETED_SYMBOLS);
  const out: string[] = [];
  for (const file of files) {
    if (!/\.(?:ts|tsx|mjs)$/.test(file.path)) continue;
    for (const m of file.text.matchAll(SPECIFIER)) {
      const target = resolvesTo(file.path, m[2]!);
      if (target && deleted.has(target)) out.push(`${file.path}: imports deleted module ${m[2]}`);
    }
    for (const m of file.text.matchAll(NAMED_BINDING)) {
      for (const part of m[1]!.split(',')) {
        const name = part
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0]!
          .trim();
        if (symbols.has(name)) out.push(`${file.path}: imports deleted symbol ${name}`);
      }
    }
  }
  return out;
}

function literalViolations(files: SourceFile[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    if (HISTORY_PREFIXES.some((p) => file.path.startsWith(p)) || file.path in KEPT_HITS) continue;
    file.text.split('\n').forEach((line, i) => {
      if (RETIRED_LITERALS.test(line)) out.push(`${file.path}:${i + 1}: ${line.trim()}`);
    });
  }
  return out;
}

/** The tree as git tracks it: a working-tree artifact can neither pass nor fail. */
function trackedSources(): SourceFile[] {
  const listed = execFileSync('git', ['ls-files', '-z'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return listed
    .split('\0')
    .filter((p) => /\.(?:ts|tsx|mjs|json|md|sql)$/.test(p))
    .flatMap((p) => {
      try {
        return [{ path: p, text: readFileSync(path.join(process.cwd(), p), 'utf8') }];
      } catch {
        return []; // listed but deleted in the working tree
      }
    });
}

describe('the architecture guard', () => {
  let tracked: SourceFile[];
  beforeAll(() => {
    tracked = trackedSources();
  });

  it('walks the tracked tree', () => {
    expect(tracked.length).toBeGreaterThan(1_000);
    expect(tracked.some((f) => f.path === 'lib/jobs/indexHandoffSteps.ts')).toBe(true);
  });

  it('finds no import of a module or symbol the story deleted', () => {
    expect(importViolations(tracked)).toEqual([]);
  });

  it('finds every line naming the retired kind or variables in history or a kept hit', () => {
    expect(literalViolations(tracked)).toEqual([]);
  });

  it('every kept hit still exists, so the list cannot rot silently', () => {
    const paths = new Set(tracked.map((f) => f.path));
    const missing = Object.keys(KEPT_HITS).filter((p) => !paths.has(p));
    expect(missing).toEqual([]);
  });

  it('fails on a planted fixture: a deleted module, a deleted symbol and a stray literal', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'retire-gate-'));
    try {
      const fixture = path.join(dir, 'planted.ts');
      writeFileSync(
        fixture,
        [
          [
            'import { codeGraphIndexDispatchService }',
            'from',
            "'@/lib/services/codeGraphIndexDispatchService';",
          ].join(' '),
          ['import { isIndexCapacityPause }', 'from', "'@/lib/ciFleet/indexAllowance';"].join(' '),
          ['vi.mock(', "'../../lib/jobs/indexFleetSteps'", ');'].join(' '),
          `const kind = 'code_graph_index';`,
        ].join('\n'),
      );
      const planted: SourceFile[] = [
        { path: 'tests/ciFleet/planted.ts', text: readFileSync(fixture, 'utf8') },
      ];
      expect(importViolations(planted)).toEqual([
        'tests/ciFleet/planted.ts: imports deleted module @/lib/services/codeGraphIndexDispatchService',
        'tests/ciFleet/planted.ts: imports deleted module ../../lib/jobs/indexFleetSteps',
        'tests/ciFleet/planted.ts: imports deleted symbol codeGraphIndexDispatchService',
        'tests/ciFleet/planted.ts: imports deleted symbol isIndexCapacityPause',
      ]);
      expect(literalViolations(planted)).toEqual([
        `tests/ciFleet/planted.ts:4: const kind = 'code_graph_index';`,
      ]);
      // The same fixture under a kept path is history, not a violation.
      expect(literalViolations([{ ...planted[0]!, path: 'docs/decisions/planted.md' }])).toEqual(
        [],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
