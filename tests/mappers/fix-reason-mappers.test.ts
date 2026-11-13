import { describe, expect, it } from 'vitest';
import { toFixDetailDto } from '@/lib/mappers/fixReasonMappers';

// `WorkItem.fixDetail` is JSON, so the mapper is the one place it is narrowed. A dead
// run (MOTIR-6880) added the richest fields — a repair of `continue` / `none`, a
// branch list, a pushed flag, a died reason — and each must read as `null` (or be
// dropped) when the stored value is not the shape it claims, never arrive `undefined`.

const DIED = {
  repair: 'continue',
  lastHeardAt: '2026-09-28T20:00:00.000Z',
  ranByName: 'Mara S.',
  branch: 'subtask/PROD-42-work',
  branches: [
    { repository: 'web', branch: 'subtask/PROD-42-work' },
    { repository: null, branch: 'subtask/PROD-42-api' },
  ],
  pushed: true,
  continueKey: 'PROD-12',
  diedReason: 'lapsed',
  affected: 0,
  total: 0,
};

describe('toFixDetailDto', () => {
  it('maps a dead run detail field by field', () => {
    expect(toFixDetailDto('run_died', DIED)).toEqual({
      // A row stored before MOTIR-7589 has no entry key; it reads as null.
      groupKey: null,
      repair: 'continue',
      check: null,
      queueReason: null,
      base: null,
      reviewerName: null,
      notePreview: null,
      gate: null,
      reviewRef: null,
      lastHeardAt: '2026-09-28T20:00:00.000Z',
      ranByName: 'Mara S.',
      branch: 'subtask/PROD-42-work',
      branches: [
        { repository: 'web', branch: 'subtask/PROD-42-work' },
        { repository: null, branch: 'subtask/PROD-42-api' },
      ],
      pushed: true,
      continueKey: 'PROD-12',
      diedReason: 'lapsed',
      affected: 0,
      total: 0,
      // A row stored before Fixing existed (MOTIR-10307) reads as not Fixing, no heads.
      fixing: false,
      raisedHeads: null,
    });
  });

  it('carries Fixing and the recorded heads, dropping a head that is not a string', () => {
    expect(
      toFixDetailDto('ci_failed', {
        fixing: true,
        raisedHeads: { pr1: 'a'.repeat(40), pr2: 7 },
      }),
    ).toMatchObject({ fixing: true, raisedHeads: { pr1: 'a'.repeat(40) } });
    for (const raisedHeads of [['a'], 'a', null]) {
      expect(toFixDetailDto('ci_failed', { fixing: 'yes', raisedHeads })).toMatchObject({
        fixing: false,
        raisedHeads: null,
      });
    }
  });

  it('carries the send-back review ref (MOTIR-11234), dropping one that is not the shape', () => {
    for (const ref of [
      { kind: 'record', id: 'rec_1' },
      { kind: 'gate', id: 'gate_1' },
    ]) {
      expect(toFixDetailDto('changes_requested', { reviewRef: ref })?.reviewRef).toEqual(ref);
    }
    expect(
      toFixDetailDto('changes_requested', { reviewRef: { kind: 'gate', id: 'g', extra: 1 } })
        ?.reviewRef,
    ).toEqual({ kind: 'gate', id: 'g' });
    for (const reviewRef of [
      undefined,
      null,
      'rec_1',
      ['rec_1'],
      { kind: 'pass', id: 'rec_1' },
      { kind: 'record', id: '' },
      { kind: 'record', id: 7 },
      { kind: 'record' },
    ]) {
      expect(toFixDetailDto('changes_requested', { reviewRef })?.reviewRef).toBeNull();
    }
  });

  it.each(['fix', 'run', 'continue', 'none'] as const)('keeps a known repair: %s', (repair) => {
    expect(toFixDetailDto('run_died', { repair })?.repair).toBe(repair);
  });

  it.each([undefined, 'rebase', 7])('reads an unknown repair %j as fix', (repair) => {
    expect(toFixDetailDto('ci_failed', { repair })?.repair).toBe('fix');
  });

  it.each(['lapsed', 'interrupted', 'failed', 'cancelled', 'stalled', 'backstop'] as const)(
    'keeps a known died reason: %s',
    (diedReason) => {
      expect(toFixDetailDto('run_died', { diedReason })?.diedReason).toBe(diedReason);
    },
  );

  it('reads an unknown or mistyped died reason as null', () => {
    expect(toFixDetailDto('run_died', { diedReason: 'exploded' })?.diedReason).toBeNull();
    expect(toFixDetailDto('run_died', { diedReason: 3 })?.diedReason).toBeNull();
  });

  it('reads a non-boolean pushed as null, and keeps false', () => {
    expect(toFixDetailDto('run_died', { pushed: 'yes' })?.pushed).toBeNull();
    expect(toFixDetailDto('run_died', { pushed: false })?.pushed).toBe(false);
  });

  it('drops a branch entry without a branch name, and reads a non-array as null', () => {
    expect(
      toFixDetailDto('run_died', {
        branches: [null, { repository: 'web' }, { repository: 5, branch: 'b' }, 'x'],
      })?.branches,
    ).toEqual([{ repository: null, branch: 'b' }]);
    expect(toFixDetailDto('run_died', { branches: 'b' })?.branches).toBeNull();
  });

  it('keeps a known gate and nulls anything else', () => {
    expect(toFixDetailDto('changes_requested', { gate: 'acceptance_result' })?.gate).toBe(
      'acceptance_result',
    );
    expect(toFixDetailDto('changes_requested', { gate: 'pull_request_approval' })?.gate).toBe(
      'pull_request_approval',
    );
    expect(toFixDetailDto('changes_requested', { gate: 'design_result' })?.gate).toBeNull();
  });

  it('reads a negative, fractional or mistyped count as 0', () => {
    const d = toFixDetailDto('conflicted', { affected: -1, total: 1.5 });
    expect(d?.affected).toBe(0);
    expect(d?.total).toBe(0);
    expect(toFixDetailDto('conflicted', { affected: '2', total: 3 })?.total).toBe(3);
  });

  it('is null whenever the reason is, or the column is not an object', () => {
    expect(toFixDetailDto(null, DIED)).toBeNull();
    expect(toFixDetailDto('run_died', null)).toBeNull();
    expect(toFixDetailDto('run_died', 'detail')).toBeNull();
    expect(toFixDetailDto('run_died', [DIED])).toBeNull();
  });
});
