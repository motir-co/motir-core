import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  FRAME_DISPOSITIONS,
  isKnownFrameKind,
  PLAN_CHANGE_FRAME_KINDS,
  SWEEP_FALSE_MATCHES,
} from '@/lib/planning/planChangeFrames';
import {
  generatePlanChangeFrameKinds,
  PLAN_CHANGE_FRAME_KINDS_FILE,
  readCommittedPlanChangeFrameKinds,
} from '../../scripts/generatePlanChangeFrameKinds';
import { kindsInGrepOutput, sweepFrameKinds } from '../helpers/frameKindSweep';

// PARITY WITH motir-ai (MOTIR-8158). An unlisted frame kind used to be drawn raw
// on the rail as `frame: <name>`; it now draws nothing, which would make a NEW
// kind invisible without a trace. This test is what catches it instead: every
// kind motir-ai can emit must have a disposition here.
//
// The kinds come from a CHECKED-IN copy (`tests/fixtures/plan-change/
// motir-ai-frame-kinds.json`, its header says how to refresh it). When a motir-ai
// checkout sits beside this one (or `MOTIR_AI_CHECKOUT` names one) the second
// test also sweeps it live, so drift is caught before the copy is refreshed.
//
// ⚠️ NEITHER OF THOSE RUNS WHERE A NEW KIND IS WRITTEN (MOTIR-10427). The copy
// went stale for four weeks and six real kinds shipped unlisted, because motir-ai
// is not checked out in core's CI. So core also PUBLISHES what it accepts
// (`contracts/plan-change-frame-kinds.json`) and motir-ai's CI sweeps its own
// source against core's `main` copy. This file holds that published copy FRESH,
// and drives the sweep pattern both sides share over planted source.

const KINDS_FILE = path.resolve(__dirname, '../fixtures/plan-change/motir-ai-frame-kinds.json');
const emitted = JSON.parse(readFileSync(KINDS_FILE, 'utf8')) as { kinds: string[] };

describe('every frame kind motir-ai emits has a disposition in core', () => {
  it('the checked-in list of emitted kinds is all accounted for', () => {
    const unlisted = emitted.kinds.filter((kind) => !isKnownFrameKind(kind));
    expect(unlisted, 'add these to PLAN_CHANGE_FRAME_KINDS and give each a disposition').toEqual(
      [],
    );
  });

  it('the lookup frames are quiet', () => {
    for (const kind of ['retrieval', 'search', 'drill', 'tool_call', 'tool_call_failed']) {
      expect(FRAME_DISPOSITIONS[kind as keyof typeof FRAME_DISPOSITIONS], kind).toHaveProperty(
        'quiet',
      );
    }
  });

  it('the five kinds the live rail used to draw raw are quiet, each with a reason', () => {
    for (const kind of [
      'model_stop',
      'session_summary',
      'gap',
      'planning_record_not_filed',
      'planning_failure_filed',
    ]) {
      const disposition = FRAME_DISPOSITIONS[kind as keyof typeof FRAME_DISPOSITIONS];
      expect(disposition, kind).toHaveProperty('quiet');
      expect((disposition as { quiet: string }).quiet.length, kind).toBeGreaterThan(10);
    }
  });

  it('the six kinds the 2026-11-05 sweep found unlisted are quiet, each with a reason', () => {
    for (const kind of [
      'walk_position',
      'resume_seeded',
      'level_closed_empty',
      'post_merge_moved',
      'post_merge_move_refused',
      'validity_unfixable',
    ]) {
      const disposition = FRAME_DISPOSITIONS[kind as keyof typeof FRAME_DISPOSITIONS];
      expect(disposition, kind).toHaveProperty('quiet');
      expect((disposition as { quiet: string }).quiet.length, kind).toBeGreaterThan(10);
    }
  });

  it('lay_stopped, which landed on motir-ai main after that sweep, is quiet with a reason', () => {
    const disposition = FRAME_DISPOSITIONS.lay_stopped;
    expect(disposition).toHaveProperty('quiet');
    expect((disposition as { quiet: string }).quiet).toMatch(/error/);
  });

  it('amend, check and repair (MOTIR-11256) are emitted, and each draws its own act', () => {
    for (const [kind, show] of [
      ['amend', 'amending'],
      ['check', 'checking'],
      ['repair', 'repairing'],
    ] as const) {
      expect(emitted.kinds, kind).toContain(kind);
      expect(FRAME_DISPOSITIONS[kind], kind).toEqual({ show });
    }
  });

  const checkout = process.env.MOTIR_AI_CHECKOUT ?? path.resolve(process.cwd(), '..', 'motir-ai');
  const live = existsSync(path.join(checkout, 'src')) ? it : it.skip;
  live('a live sweep of the motir-ai checkout finds no kind core has not listed', () => {
    const swept = sweepFrameKinds(checkout);
    const unlisted = [...swept].filter(
      (kind) => !isKnownFrameKind(kind) && !Object.hasOwn(SWEEP_FALSE_MATCHES, kind),
    );
    expect(unlisted.sort(), 'give each a disposition in lib/planning/planChangeFrames.ts').toEqual(
      [],
    );
  });
  live('every false match it excludes is still found by the live sweep', () => {
    const swept = sweepFrameKinds(checkout);
    const stale = Object.keys(SWEEP_FALSE_MATCHES).filter((kind) => !swept.has(kind));
    expect(stale, 'remove these from SWEEP_FALSE_MATCHES: the sweep no longer finds them').toEqual(
      [],
    );
  });
});

describe('the sweep both repositories run', () => {
  // A throwaway git repository holding one file per call shape motir-ai emits
  // through. `git grep` reads tracked files only, so each is staged.
  const planted = mkdtempSync(path.join(tmpdir(), 'frame-kind-sweep-'));
  afterAll(() => rmSync(planted, { recursive: true, force: true }));
  const plant = (files: Record<string, string>): string => {
    const root = mkdtempSync(path.join(planted, 'repo-'));
    execFileSync('git', ['init', '-q', root]);
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), body);
    }
    execFileSync('git', ['-C', root, 'add', '.']);
    return root;
  };

  it('finds a kind sent through every call shape motir-ai uses', () => {
    const root = plant({
      'src/a.ts': [
        "await ctx.emit?.('a_plain', {});",
        "await ctx.emit('a_direct', {});",
        "await sink.signal?.('a_signal', {});",
        "await safeEmit('a_safe', {});",
        "await safeEmit(failure ? 'a_ternary_yes' : 'a_ternary_no', { key });",
        "await quietly('a_quietly', { callId });",
        "await emitQuietly(deps.emit, 'a_emit_quietly', start, tool);",
        "yield { event: 'a_literal', data };",
      ].join('\n'),
    });
    expect([...sweepFrameKinds(root)].sort()).toEqual([
      'a_direct',
      'a_emit_quietly',
      'a_literal',
      'a_plain',
      'a_quietly',
      'a_safe',
      'a_signal',
      'a_ternary_no',
      'a_ternary_yes',
    ]);
  });

  it('reads only the swept paths, and only tracked files', () => {
    const root = plant({ 'tests/a.ts': "ctx.emit('in_tests', {});" });
    writeFileSync(path.join(root, 'untracked.ts'), "ctx.emit('untracked', {});");
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'untracked.ts'), "ctx.emit('untracked_src', {});");
    expect(sweepFrameKinds(root).size).toBe(0);
  });

  it('does not take a non-emitting call for a frame', () => {
    const root = plant({
      'src/a.ts': "logger.info('not_a_frame'); runQuietly('nor_this'); remit('nor_that');",
    });
    expect([...sweepFrameKinds(root)]).toEqual([]);
  });

  it('matches the pg LISTEN typings it excludes, which is why they are excluded', () => {
    const root = plant({
      'src/pool/jobQueuedChannel.ts': [
        "  on(event: 'notification', fn: (msg: unknown) => void): unknown;",
        "  on(event: 'end', fn: () => void): unknown;",
      ].join('\n'),
    });
    expect([...sweepFrameKinds(root)].sort()).toEqual(Object.keys(SWEEP_FALSE_MATCHES).sort());
  });

  it('throws on a checkout git cannot read, rather than reading it as empty', () => {
    expect(() => sweepFrameKinds(path.join(planted, 'not-a-repo'))).toThrow();
  });

  it('unquotes and de-duplicates what git grep printed', () => {
    expect([...kindsInGrepOutput("emit('a'\nevent: 'a'\nsignal('b'")]).toEqual(['a', 'b']);
    expect(kindsInGrepOutput('').size).toBe(0);
  });
});

describe('what the sweep excludes', () => {
  it('names nothing core lists as a kind', () => {
    expect(Object.keys(SWEEP_FALSE_MATCHES).filter((kind) => isKnownFrameKind(kind))).toEqual([]);
  });

  it('says, for each, where the false match is and why it is not a frame', () => {
    for (const [kind, reason] of Object.entries(SWEEP_FALSE_MATCHES)) {
      expect(reason, kind).toMatch(/^src\/\S+\.ts /);
      expect(reason, kind).toContain(`'${kind}'`);
    }
  });
});

describe('the published contract motir-ai checks against', () => {
  const root = path.resolve(__dirname, '../..');

  it('is byte-identical to what the generator produces right now', async () => {
    expect(
      await readCommittedPlanChangeFrameKinds(root),
      'Run `pnpm generate:plan-change-frame-kinds` and commit the result.',
    ).toBe(await generatePlanChangeFrameKinds());
  });

  it('is byte-identical across two runs, so the guard cannot flap', async () => {
    const [first, second] = await Promise.all([
      generatePlanChangeFrameKinds(),
      generatePlanChangeFrameKinds(),
    ]);
    expect(first).toBe(second);
  });

  it('carries every listed kind, sorted, plus the exclusions and the sweep', async () => {
    const contract = JSON.parse(await generatePlanChangeFrameKinds()) as {
      kinds: string[];
      sweepFalseMatches: Record<string, string>;
      sweep: { pattern: string; paths: string[] };
    };
    expect(contract.kinds).toEqual([...PLAN_CHANGE_FRAME_KINDS].sort());
    expect(contract.sweepFalseMatches).toEqual(SWEEP_FALSE_MATCHES);
    expect(contract.sweep.paths).toEqual(['src']);
    expect(contract.sweep.pattern).toContain('emitQuietly');
  });

  it('reads a missing committed file as null', async () => {
    expect(await readCommittedPlanChangeFrameKinds('/nonexistent-motir-root')).toBeNull();
  });

  it('lives at the path motir-ai fetches it from', () => {
    expect(PLAN_CHANGE_FRAME_KINDS_FILE).toBe('contracts/plan-change-frame-kinds.json');
  });
});

// The fixture is read as JSON; make a stray edit that empties it loud.
describe('the checked-in list', () => {
  it('is non-empty, sorted and duplicate-free', () => {
    const raw = emitted;
    expect(raw.kinds.length).toBeGreaterThan(40);
    expect(raw.kinds).toEqual([...new Set(raw.kinds)].sort());
  });

  it('carries none of the sweep’s false matches', () => {
    expect(emitted.kinds.filter((kind) => Object.hasOwn(SWEEP_FALSE_MATCHES, kind))).toEqual([]);
  });
});
