import { describe, expect, it } from 'vitest';
import { canvasStatusMeta } from '@/lib/workflows/canvasStatusMeta';
import { DEFAULT_STATUSES } from '@/lib/workflows/defaultWorkflow';

// THE CANVAS STATUS CHIP — the flat `--el-tint-*` language, per status key.
//
// MOTIR-3170 is why this file asserts rather than assumes: three hand-copied
// six-member status literals coerced every unrecognised workflow status to
// `todo`, so `implemented` and `planning` both rendered as To Do on every
// canvas. A card whose pull request is open reading as NOT STARTED is worse
// than a gap — a gap invites a second look and a confident wrong answer does
// not. The remedy was one resolver; these are its properties.

describe('every DEFAULT status resolves to a chip of its own', () => {
  it('gives each key a distinct treatment, bar the two deliberately neutral ones', () => {
    const seen = new Map<string, string[]>();
    for (const status of DEFAULT_STATUSES) {
      const meta = canvasStatusMeta(status.key, status.category);
      const signature = `${meta.icon.displayName ?? meta.icon.name}|${meta.tint}`;
      seen.set(signature, [...(seen.get(signature) ?? []), status.key]);
    }
    // `todo` and `cancelled` share the quiet chip's TINT on purpose (they differ
    // by glyph), and nothing else may share one at all.
    for (const [signature, keys] of seen) {
      expect(keys, `${signature} is shared by ${keys.join(' + ')}`).toHaveLength(1);
    }
  });
});

describe('TO PLAN takes the EIGHTH tint (MOTIR-12174)', () => {
  it('resolves by KEY to clay and CirclePause, not the in_progress fallback', () => {
    const toPlan = canvasStatusMeta('to_plan', 'in_progress');
    const inProgress = canvasStatusMeta('in_progress', 'in_progress');
    expect(toPlan.tint).toBe('bg-(--el-tint-clay)');
    expect(toPlan.text).toBe('text-(--el-text-strong)');
    expect(toPlan.icon.displayName ?? toPlan.icon.name).toMatch(/CirclePause/);
    expect(toPlan.tint).not.toBe(inProgress.tint);
  });

  it('does not borrow a tint another status already holds', () => {
    const tint = canvasStatusMeta('to_plan', 'in_progress').tint;
    for (const status of DEFAULT_STATUSES) {
      if (status.key === 'to_plan') continue;
      expect(canvasStatusMeta(status.key, status.category).tint).not.toBe(tint);
    }
  });
});

describe('APPROVED takes the SEVENTH tint (MOTIR-5141)', () => {
  it('resolves by KEY and not through the in_progress category fallback', () => {
    // The defect this prevents is MOTIR-3170's exactly: `approved` is an
    // in_progress-category status, so without its own row it would render as
    // In Progress on the canvas.
    const approved = canvasStatusMeta('approved', 'in_progress');
    const inProgress = canvasStatusMeta('in_progress', 'in_progress');
    expect(approved.tint).toBe('bg-(--el-tint-sage)');
    expect(approved.tint).not.toBe(inProgress.tint);
    expect(approved.icon).not.toBe(inProgress.icon);
  });

  it('does not borrow a tint another status already holds', () => {
    // The third option the module's header forbids, asserted: borrowing is what
    // re-creates two statuses rendering as one.
    const approvedTint = canvasStatusMeta('approved', 'in_progress').tint;
    for (const status of DEFAULT_STATUSES) {
      if (status.key === 'approved') continue;
      expect(canvasStatusMeta(status.key, status.category).tint).not.toBe(approvedTint);
    }
  });

  it('is tellable from DONE — the pair that both mean "yes"', () => {
    const approved = canvasStatusMeta('approved', 'in_progress');
    const done = canvasStatusMeta('done', 'done');
    expect(approved.tint).not.toBe(done.tint);
    expect(approved.icon).not.toBe(done.icon);
  });

  it('leaves the fallbacks intact — a custom key still reads as its category', () => {
    // The inertness half: this card added a row, it did not change resolution.
    expect(canvasStatusMeta('bespoke', 'in_progress').tint).toBe(
      canvasStatusMeta('in_progress', 'in_progress').tint,
    );
    expect(canvasStatusMeta('bespoke', 'todo').tint).toBe('bg-(--el-muted)');
    expect(canvasStatusMeta(null, null).tint).toBe('bg-(--el-muted)');
  });
});
