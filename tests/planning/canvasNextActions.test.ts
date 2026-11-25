import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canvasNextActionsFor } from '@/lib/planning/canvasNextActions';

// THE CANVAS CARD'S NEXT-ACTION GATE (MOTIR-12233) — one rule every member-facing
// canvas reads, and a guard that every canvas of committed work-item cards either
// turns the button on or says in its code why it does not.

describe('canvasNextActionsFor', () => {
  it('a Visitor gets no button at all, AI or not', () => {
    expect(canvasNextActionsFor({ visitor: true, aiConfigured: true })).toBeNull();
    expect(canvasNextActionsFor({ visitor: true, aiConfigured: false })).toBeNull();
  });

  it('a member gets the button, with Plan only when the project’s AI is configured', () => {
    expect(canvasNextActionsFor({ visitor: false, aiConfigured: true })).toEqual({ plan: true });
    expect(canvasNextActionsFor({ visitor: false, aiConfigured: false })).toEqual({ plan: false });
  });
});

// Every file that draws committed work-item cards on a canvas does it through one
// of two doors: it mounts `WorkItemRoadmap`, or it builds a level with
// `buildWorkItemLevel`. Each such file must either hand the cards the next-action
// option or carry the marker comment that says why it deliberately does not.
const MARKER = 'NO NEXT-ACTION BUTTON';
const DOOR = /<WorkItemRoadmap\b|\bbuildWorkItemLevel\(/;

function canvasConsumers(): string[] {
  const out = execFileSync('git', ['ls-files', 'app', 'components'], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((f) => f.endsWith('.tsx'))
    .filter((f) => !f.endsWith('components/planning/workItemLevel.tsx'))
    .filter((f) => !f.endsWith('components/planning/WorkItemRoadmap.tsx'))
    .filter((f) => DOOR.test(readFileSync(resolve(process.cwd(), f), 'utf8')));
}

describe('every canvas of committed work-item cards decides about the button', () => {
  const files = canvasConsumers();

  it('finds the known consumers (the scan is not vacuous)', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'app/(authed)/items/[key]/_components/ChildPanel.tsx',
        'app/(authed)/runs/_components/RunCanvasPane.tsx',
        'components/onboarding/OnboardingCanvas.tsx',
        'components/planning/PlanReviewCanvas.tsx',
        'components/planning/RoadmapView.tsx',
      ]),
    );
  });

  it.each(files)('%s passes `nextActions` or says why not', (file) => {
    const src = readFileSync(resolve(process.cwd(), file), 'utf8');
    expect(/\bnextActions\b/.test(src) || src.includes(MARKER)).toBe(true);
  });

  it('the pages that mount a member-facing canvas read the one gate', () => {
    for (const page of ['app/(authed)/roadmap/_view.tsx', 'app/(authed)/items/[key]/_view.tsx']) {
      expect(readFileSync(resolve(process.cwd(), page), 'utf8')).toContain('canvasNextActionsFor(');
    }
  });
});
