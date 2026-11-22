import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanStepRunSites, type StepRunSite } from './stepResultShapes';
import { FORWARDING_SEAMS, LIVE_STEP_SHAPES, RETIRED_STEP_IDS } from './stepResultShapePins';

// MOTIR-5022 — a memoized step's ID names its result's SHAPE.
//
// ── The defect this is the guard for ────────────────────────────────────────
// `lib/jobs/engine/step.ts`: look up `(run_id, id)` in `job_step`, and if a row
// exists return its stored result WITHOUT executing. Everything written about
// that contract — in the shim, in `docs/jobs.md`, in
// `docs/decisions/job-queue-foundation.md` §13 — is about which calls may be
// memoized and which may be re-run. None of it was about the stored value's
// SHAPE, and a step id outlives the revision that wrote its rows.
//
// So: MOTIR-4652 replaced `resolve-target`'s `projectIds: string[]` with
// `anchorProjectId: string` and kept the id. A supervision in flight across
// that deploy resumed, replayed the old row, carried `anchorProjectId:
// undefined` to the run-credential mint, and every code-graph refresh in the
// estate failed — while the ledger recorded `succeeded`, because the run had
// consumed a memo rather than failed a step (MOTIR-5020).
//
// ── Why a snapshot rather than a runtime narrowing ──────────────────────────
// The card names both and asks which. They are not substitutes and this is the
// authoring-time half:
//
//   • A NARROWING (`requireCurrentIndexTarget`) rejects a stale value AT
//     REPLAY, in production, at one boundary. MOTIR-5020 shipped exactly one,
//     for `IndexTarget`, and that is the right instrument for a step whose id
//     may NOT be bumped because re-executing it would provision something twice.
//   • A SNAPSHOT fails HERE, before the deploy, over the whole population. It
//     cannot know whether a shape change is safe — only that one happened and
//     that a human owes the id decision. That is the thing nobody was being
//     asked, which is why it is what this card builds.
//
// ── The four things asserted, and the control that proves they BITE ─────────
// A guard that scans nothing passes exactly like a guard that finds nothing —
// the trap the structural-guard lane's own header records — so the last test
// drives the identical scanner over a synthetic tree, including the exact
// revert the card asks for.

const sites = scanStepRunSites();
const pinnable = sites.filter((s) => s.idKind !== 'forwarded');

const describeSite = (s: StepRunSite): string => `${s.file}:${s.line} (${s.stepId})`;

describe('a memoized step id names its result shape', () => {
  it('finds the step call sites — a scan that finds nothing passes vacuously', () => {
    // A floor, not the count: the guard must never be silently reading an empty
    // tree. The exact population lives in the pins, which are asserted tight
    // below.
    expect(sites.length).toBeGreaterThan(50);
    expect(pinnable.length).toBeGreaterThan(50);
  });

  it('resolves every result type — a shape that degraded to `any` can never change again', () => {
    // The structural-guard lane provisions no database and no generated Prisma
    // client, deliberately. Every live shape is byte-identical with and without
    // `generated/prisma` — verified on MOTIR-5022 — and this is what keeps that
    // true: a module that stops resolving turns its shape into `any`, which
    // would then compare equal to its pin for ever.
    //
    // ⚠️ `any` ONLY, AND `unknown` DELIBERATELY NOT. An unresolved import gives
    // the checker's error type, which prints as `any` — so `any` is the whole
    // degradation signature and nothing is lost by leaving `unknown` alone.
    // `unknown` means the opposite: a field somebody DECLARED opaque, like
    // `JobRunDTO.output`, which is the ledger's own free-form column. It is
    // visible in the pin like every other member, so a change to it moves the
    // fingerprint anyway.
    const degraded = pinnable.filter((s) => /(^|\W)any(\W|$)/.test(s.shape));
    expect(
      degraded.map(describeSite),
      'a step result resolved to `any` — the program is missing a dependency, so this ' +
        'fingerprint would compare equal to its pin for ever',
    ).toEqual([]);
  });

  it('pins every live step id, and pins nothing that is gone', () => {
    const live = new Set(pinnable.map((s) => s.stepId));
    const pinned = new Set(Object.keys(LIVE_STEP_SHAPES));

    const unpinned = [...live].filter((id) => !pinned.has(id)).sort();
    expect(
      unpinned,
      'a new memoized step: add it to `LIVE_STEP_SHAPES` with the shape from this run',
    ).toEqual([]);

    const orphaned = [...pinned].filter((id) => !live.has(id)).sort();
    expect(
      orphaned,
      'a pinned id no longer appears in the tree. It is not deleted — MOVE it to ' +
        '`RETIRED_STEP_IDS`, so it cannot come back carrying a different shape',
    ).toEqual([]);
  });

  it('every site of a shared id agrees about the shape', () => {
    const byId = new Map<string, StepRunSite[]>();
    for (const site of pinnable) byId.set(site.stepId, [...(byId.get(site.stepId) ?? []), site]);

    const disagreeing = [...byId.entries()]
      .filter(([, group]) => new Set(group.map((s) => s.shape)).size > 1)
      .map(([id, group]) => `${id}: ${group.map(describeSite).join(' vs ')}`);

    expect(
      disagreeing,
      'one step id, two result shapes. Within a run the memo key is the id alone, so ' +
        'whichever branch runs first decides what the other one reads back',
    ).toEqual([]);
  });

  it('the pinned shape is the shape the tree computes', () => {
    const drifted = pinnable.flatMap((s) => {
      const pin = LIVE_STEP_SHAPES[s.stepId];
      if (!pin || pin.shape === s.shape) return [];
      return [`\n${describeSite(s)}\n  pinned:   ${pin.shape}\n  computed: ${s.shape}`];
    });

    expect(
      drifted,
      "a memoized step's RESULT SHAPE changed while its id did not. A run that resumes across " +
        'this deploy will replay the OLD value into the new reader. Either bump the id and ' +
        'retire the old one, or — if the members are unchanged and only their spelling moved — ' +
        'paste the computed shape over the pin. `tests/jobs/stepResultShapePins.ts` has both.',
    ).toEqual([]);
  });

  it('pins the file each id is written in', () => {
    const moved = pinnable.flatMap((s) => {
      const pin = LIVE_STEP_SHAPES[s.stepId];
      if (!pin || pin.file === s.file || pin.alsoIn?.includes(s.file)) return [];
      return [`${s.stepId}: pinned in ${pin.file}, found in ${s.file}`];
    });
    expect(moved, 'a step id moved file — update its pin').toEqual([]);
  });

  it('refuses a RETIRED step id', () => {
    const resurrected = pinnable.flatMap((s) => {
      const retired = RETIRED_STEP_IDS[s.stepId];
      if (!retired) return [];
      return [
        `${describeSite(s)} — retired in favour of ${retired.supersededBy}: ${retired.reason}`,
      ];
    });
    expect(
      resurrected,
      'this id has memos in `job_step` carrying an OLD shape. Using it again makes those rows ' +
        'readable by a reader that does not expect them',
    ).toEqual([]);
  });

  it('declares every forwarding seam', () => {
    const undeclared = sites
      .filter((s) => s.idKind === 'forwarded' && !FORWARDING_SEAMS[s.file])
      .map(describeSite);
    expect(
      undeclared,
      'a `step.run(id, …)` whose id is a parameter. If it is a seam that forwards to real, ' +
        'pinned call sites, declare it in `FORWARDING_SEAMS` with that reason; otherwise it is ' +
        'a memoized step whose id — and therefore whose shape — nothing can check',
    ).toEqual([]);

    const stale = Object.keys(FORWARDING_SEAMS)
      .filter((file) => !sites.some((s) => s.idKind === 'forwarded' && s.file === file))
      .sort();
    expect(stale, 'a declared forwarding seam that no longer exists — drop the entry').toEqual([]);
  });
});

// ── The CONTROL ─────────────────────────────────────────────────────────────
// The same scanner, over a tree written for the occasion, so a green run above
// means "no drift" rather than "no scan".

function fixtureRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'step-shape-fixture-'));
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
      },
    }),
  );
  for (const [name, source] of Object.entries(files)) writeFileSync(join(root, name), source);
  return root;
}

const STEP_API = `
declare const step: { run<T>(id: string, fn: () => Promise<T>): Promise<T> };
`;

/** `IndexTarget` as it stood at `83c0e8a34^`, and as it stands now. */
const OLD_TARGET = `
type GitProviderId = 'github' | 'gitlab';
type IndexSkipReason = 'installation_missing' | 'no_projects' | 'provider_cannot_index' | 'workspace_missing';
export type IndexTarget =
  | { indexed: false; reason: IndexSkipReason }
  | { indexed: true; repoRef: string; providerId: GitProviderId; organizationId: string; projectIds: string[] };
`;
const NEW_TARGET = OLD_TARGET.replace('projectIds: string[]', 'anchorProjectId: string');

const scanFixture = (files: Record<string, string>): StepRunSite[] =>
  scanStepRunSites({ root: fixtureRoot(files), files: Object.keys(files) });

/** The one site a single-call-site fixture must produce — asserted, not assumed. */
function onlySite(files: Record<string, string>): StepRunSite {
  const found = scanFixture(files);
  expect(found, 'the fixture should hold exactly one step call site').toHaveLength(1);
  const [site] = found;
  if (!site) throw new Error('unreachable: length was asserted above');
  return site;
}

/** The retired record for an id the pins must carry. */
function retired(id: string) {
  const entry = RETIRED_STEP_IDS[id];
  if (!entry) throw new Error(`\`${id}\` is not in RETIRED_STEP_IDS`);
  return entry;
}

describe('the scanner bites', () => {
  it('reads the members of a NAMED type, not its name', () => {
    // The predicate this guard turns on. `checker.typeToString` prints
    // `IndexTarget`, which moves only when the alias is RENAMED — the one
    // change that cannot break a replay.
    const site = onlySite({
      'lib/a.ts': `${OLD_TARGET}${STEP_API}
        declare function resolve(): Promise<IndexTarget>;
        export const go = async () => { const t = await step.run('resolve-target', () => resolve()); return t; };`,
    });
    expect(site.shape).toContain('projectIds: Array<string>');
    expect(site.shape).not.toBe('IndexTarget');
  });

  it('MOTIR-5020: the shape change that kept its id moves the fingerprint', () => {
    const of = (target: string) =>
      onlySite({
        'lib/a.ts': `${target}${STEP_API}
          declare function resolve(): Promise<IndexTarget>;
          export const go = async () => { const t = await step.run('resolve-target', () => resolve()); return t; };`,
      }).shape;

    const before = of(OLD_TARGET);
    const after = of(NEW_TARGET);

    expect(before).not.toBe(after);
    // And the pin is the one the outage was written under, so a tree still on
    // the old shape matches the retired record exactly.
    expect(before).toBe(retired('resolve-target').shape);
    expect(after).toContain('anchorProjectId: string');
  });

  it('REVERTING the `resolve-target-v2` bump is refused by name', () => {
    // Criterion 3, driven end to end: the tree type-checks, the reader is
    // happy, and the only thing that notices is the retired-id rule.
    const site = onlySite({
      'lib/a.ts': `${NEW_TARGET}${STEP_API}
        declare function resolve(): Promise<IndexTarget>;
        export const go = async () => { const t = await step.run('resolve-target', () => resolve()); return t; };`,
    });
    expect(site.stepId).toBe('resolve-target');
    expect(site.shape).not.toBe(retired(site.stepId).shape);
  });

  it('sees a `steps.run(…)` seam call, and a templated id, and a forwarder', () => {
    const sites = scanFixture({
      'lib/a.ts': `
        declare const steps: { run<T>(id: string, fn: () => Promise<T>): Promise<T> };
        declare const step: { run<T>(id: string, fn: () => Promise<T>): Promise<T> };
        declare const projectId: string;
        declare function boot(): Promise<{ containerId: string }>;
        export const viaSeam = async () => steps.run(\`index-boot:\${projectId}\`, () => boot());
        export const forward = <T,>(id: string, fn: () => Promise<T>) => step.run(id, fn);
      `,
    });
    expect(sites.map((s) => s.idKind).sort()).toEqual(['expression', 'forwarded']);
    expect(sites.find((s) => s.idKind === 'expression')?.stepId).toBe('`index-boot:${projectId}`');
    expect(sites.find((s) => s.idKind === 'expression')?.shape).toBe('{ containerId: string }');
  });

  it('classifies how the result is used', () => {
    const sites = scanFixture({
      'lib/a.ts': `${STEP_API}
        declare function work(): Promise<{ n: number }>;
        export const consumed = async () => { const r = await step.run('a', () => work()); return r.n; };
        export const returned = async () => { return step.run('b', () => work()); };
        export const discarded = async () => { await step.run('c', () => work()); };
      `,
    });
    expect(Object.fromEntries(sites.map((s) => [s.stepId, s.consumption]))).toEqual({
      a: 'consumed',
      b: 'returned',
      c: 'discarded',
    });
  });
});
