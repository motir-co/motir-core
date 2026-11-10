import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLAN_STATUS_DTO_VALUES, type PlanStatusDto } from '@/lib/dto/plans';

// THE STORY'S CONTRACT GUARDS (MOTIR-4025) — the guarantees a coverage
// percentage cannot see.
//
// Neither of these asserts a behaviour: both assert that a LATER change cannot
// quietly leave a surface half-done. They are cheap, they are total over a set the
// compiler owns, and each is here because this story shipped a case where the
// half-done version looked exactly like the finished one.

const ROOT = process.cwd();

// ── 1 · THE RAIL'S FOOTER IS TOTAL OVER `PlanStatus` ─────────────────────────
//
// MOTIR-4023 moved the decision out of the scrolling transcript into a pinned
// footer, and a footer is a fixed band: a status with no arm is not a missing
// paragraph, it is a blank strip at the bottom of the rail. `PlanReviewRail`
// answers the question in two places — the gate for a live plan, `DecidedOutcome`
// for a decided one — so a sixth member has to be routed to one of them.
//
// The mechanism is the same one `PlanProposalList` uses for its three ops
// (`AssertTotalListOps`): the map is asserted TOTAL at BUILD time, so adding a
// member to `PlanStatusDto` without adding it here is a compile error rather than
// a test somebody has to remember to widen.
const FOOTER_ARM: Record<PlanStatusDto, 'gate' | 'outcome'> = {
  generating: 'gate', // Approve disabled · Discard · `discardHint`
  planned: 'gate', // Approve · Decline · the approve hint
  approving: 'gate', // MOTIR-9006 — Approve and Decline disabled while it is written
  stale: 'gate', // Approve live · Decline live · the stale OUTCOME line, then the hint
  approved: 'outcome', // `DecidedOutcome` — no gate, band and padding kept
  declined: 'outcome', // `DecidedOutcome` — same
};

type AssertFooterTotal = [Exclude<PlanStatusDto, keyof typeof FOOTER_ARM>] extends [never]
  ? true
  : never;
const _footerTotal: AssertFooterTotal = true;
void _footerTotal;

describe('the rail’s footer is TOTAL over PlanStatus (MOTIR-4025)', () => {
  it('routes every shipped status to an arm', () => {
    // The runtime half of the same claim, so the guard is legible in a test run
    // and not only in a type error.
    for (const status of PLAN_STATUS_DTO_VALUES) {
      expect(FOOTER_ARM[status], `\`${status}\` has no footer arm`).toBeDefined();
    }
    expect(Object.keys(FOOTER_ARM).sort()).toEqual([...PLAN_STATUS_DTO_VALUES].sort());
  });

  it('keeps the two decided members on the OUTCOME arm', () => {
    // `DecidedOutcome` moves INTO the footer rather than being exempted from it,
    // so the rail's shape does not change under the reader (Part XIII §8). If a
    // later edit exempts a decided plan from the band, this is what says so.
    expect(FOOTER_ARM.approved).toBe('outcome');
    expect(FOOTER_ARM.declined).toBe('outcome');
  });
});

// ── 2 · NO SEARCHABLE CANVAS MOUNT INHERITS THE ROADMAP'S WORDS ──────────────
//
// `ProjectRoadmapCanvas`'s props already make `searchLabel` required exactly when
// `searchable` is true, so this cannot regress through an ordinary prop. What it
// CAN regress through is a spread — `{...props}`, `{...(cond ? a : b)}` — which
// satisfies the type from a variable the reader cannot see. Two of the five
// mounts already spread (`OnboardingCanvas`, `WorkItemRoadmap`), because their
// `searchable` is a runtime boolean.
//
// (That count said "five" while the census below pinned FOUR — it was written a
// mount early. `RunCanvasPane` made it true on 2026-08-31; the spread count of
// two was right all along and is now named rather than counted.)
//
// So this enumerates the call sites from the FILESYSTEM, the same technique the
// settings route↔registry guard uses: a surface that mounts the canvas is ruled
// on the day it lands, whether or not anybody remembered this file existed.
//
// ⚠️ WHAT IS DERIVED AND WHAT IS NOT, because the two are one screen apart. The
// RULE below sweeps the tree, so a new mount is covered automatically. The
// CENSUS is a written list, so a new mount also has to be NAMED — deliberately:
// it is what stops the sweep passing vacuously if the walk ever returns nothing,
// and it makes joining this population a thing somebody states rather than a
// thing that happens. Adding a mount is therefore TWO edits, and the second one
// is this test going red.
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith('.tsx')) out.push(path);
  }
  return out;
}

interface Mount {
  file: string;
  source: string;
}

const mounts: Mount[] = [...walk(join(ROOT, 'components')), ...walk(join(ROOT, 'app'))]
  .map((file) => ({
    file: relative(ROOT, file).split(sep).join('/'),
    source: readFileSync(file, 'utf8'),
  }))
  .filter((m) => m.source.includes('<ProjectRoadmapCanvas'));

describe('every searchable canvas mount says what it SEARCHES (MOTIR-4025)', () => {
  it('finds the mounts to rule on', () => {
    // `RunCanvasPane`, `PlanReviewCanvas`, `PlanChangeCanvas`, `OnboardingCanvas`,
    // `WorkItemRoadmap`.
    //
    // ⚠️ `RunCanvasPane` joined on 2026-08-31 (MOTIR-4047) and is the FIFTH this
    // header anticipated. It arrived the hard way, which is worth recording: the
    // run canvas mounted `searchable` with NO label at all, and because
    // MOTIR-4025 had just made the pair required, `main` stopped typechecking —
    // so the mount was born failing the props type rather than this guard. The
    // guard then caught it a second time, here, for not being STATED.
    expect(mounts.map((m) => m.file).sort()).toEqual([
      'app/(authed)/runs/_components/RunCanvasPane.tsx',
      'components/onboarding/OnboardingCanvas.tsx',
      'components/planning/PlanChangeCanvas.tsx',
      'components/planning/PlanReviewCanvas.tsx',
      'components/planning/WorkItemRoadmap.tsx',
    ]);
  });

  it('pairs `searchable` with a `searchLabel` at every one of them', () => {
    const unpaired = mounts
      .filter((m) => /\bsearchable\b/.test(m.source) && !/\bsearchLabel\b/.test(m.source))
      .map((m) => `${m.file} mounts the canvas searchable and supplies no searchLabel`);
    expect(
      unpaired,
      'The canvas has five searchable mounts and exactly ONE of them is the roadmap. ' +
        'A default is how one sentence — "Search the roadmap" — came to greet a reader ' +
        'on /plans/[id], on the plan-change canvas and in onboarding (MOTIR-4021). The ' +
        'props type enforces the pair for an ordinary prop; this catches a SPREAD, ' +
        'which satisfies the type from a value the reader cannot see.',
    ).toEqual([]);
  });

  it('leaves the foundation with no reference to the roadmap’s own key', () => {
    // Comments are stripped first: the props doc EXPLAINS the retirement and
    // names the key, and a guard that failed on its own explanation would be
    // unusable. What must be gone is the CALL.
    const canvas = readFileSync(join(ROOT, 'components/planning/ProjectRoadmapCanvas.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(canvas).not.toContain("t('search')");
    expect(canvas).not.toContain('roadmap.canvas.search');
  });
});
