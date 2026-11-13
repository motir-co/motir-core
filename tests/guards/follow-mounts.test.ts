import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// WHERE FOLLOWING AND A CARD BEING WRITTEN MAY BE MOUNTED (MOTIR-8596, Story
// MOTIR-8590; design `design/ai-planning/design-notes.md` Part XXVIII §28.2,
// §28.10 — and MOTIR-11201, Story MOTIR-11190, Part XXIX §29.5, which replaced
// the replay this file first pinned with the live draft).
//
// The design is explicit that both behaviours live in ONE place: the planning
// overlay's proposed-plan pane while the plan is written. The plan page
// (`PlanDetail`) renders the same `PlanProposalViews` over a generating plan and
// must never be driven; the pre-plan roadmap canvas (`PlanChangeCanvas`) keeps
// MOTIR-6154's own follow-move and must never be handed the driven mode; and a
// committed card's quick view must never show a partial. The integration gate
// (`tests/integration/planning/followThePlannerGate.test.tsx`) proves each of
// those at runtime for the mounts that exist TODAY. This file is the other half:
// it pins the mount sites themselves, so a NEW site — a second host passing
// `followMode`, a canvas card rendering `LiveDraftField` — fails here by name rather
// than shipping a behaviour nobody designed for that surface.
//
// The lists are asserted EXACT in both directions: a site that disappears fails
// as loudly as one that appears, so the pin can never quietly go stale.
//
// It walks `app/` and `components/` itself and imports nothing from either (the
// structural-guard lane's rule — `tests/helpers/structuralGuardLane.ts`).

const ROOT = resolve(__dirname, '..', '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = ['app', 'components'].flatMap((d) => sources(join(ROOT, d)));
const read = (file: string) => readFileSync(file, 'utf8');
const rel = (file: string) => relative(ROOT, file).split(sep).join('/');
/** The files whose source matches `re`, repository-relative and sorted. */
const sitesOf = (re: RegExp) =>
  FILES.filter((f) => re.test(read(f)))
    .map(rel)
    .sort();

/** Every JSX opening element `<Name …>` / `<Name … />` in `src`, as source text. */
function jsxElements(src: string, name: string): string[] {
  const out: string[] = [];
  const open = new RegExp(`<${name}[\\s>/]`, 'g');
  for (let m = open.exec(src); m; m = open.exec(src)) {
    // Scan to the tag's end, skipping `{ … }` expressions (which can hold `>`).
    let depth = 0;
    let i = m.index + 1;
    for (; i < src.length; i += 1) {
      const c = src[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) break;
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}

const HOST = 'components/planning/PlanningWorkspaceHost.tsx';

describe('a card being written is shown in one place', () => {
  it('only the quick-view panel renders LiveDraftField', () => {
    expect(sitesOf(/<LiveDraftField[\s>/]/)).toEqual([
      'app/(authed)/items/_components/IssueQuickViewPanel.tsx',
    ]);
  });

  it('only the proposal peek hands the panel a live draft', () => {
    expect(sitesOf(/<IssueQuickViewPanel[^>]*\blive=\{/)).toEqual([
      'components/planning/ProposalPeek.tsx',
    ]);
  });

  it('the drafts are passed by the overlay host, and forwarded down the views to the peek only', () => {
    expect(sitesOf(/\binFlightDrafts=\{/)).toEqual([HOST]);
    expect(sitesOf(/\bliveDrafts=\{/)).toEqual([
      'components/planning/PlanProposalList.tsx',
      'components/planning/PlanProposalViews.tsx',
      'components/planning/PlanReviewCanvas.tsx',
    ]);
  });
});

describe('following is mounted in one place', () => {
  it('followMode is passed by the overlay host, and forwarded by the two views beneath it only', () => {
    expect(sitesOf(/\bfollowMode=\{/)).toEqual([
      'components/planning/PlanProposalViews.tsx',
      'components/planning/PlanReviewCanvas.tsx',
      HOST,
    ]);
  });

  it('the follow control and the lifted reading are handed down the same path only', () => {
    expect(sitesOf(/\bfollowControl=\{/)).toEqual([
      'components/planning/PlanProposalViews.tsx',
      'components/planning/PlanReviewCanvas.tsx',
      HOST,
    ]);
    expect(sitesOf(/\bprogressReading=\{/)).toEqual([HOST]);
  });

  it('in the host, only the PlanProposalViews mount carries them — never PlanChangeCanvas', () => {
    const src = read(join(ROOT, HOST));
    const views = jsxElements(src, 'PlanProposalViews');
    expect(views).toHaveLength(1);
    expect(views[0]).toMatch(/\bfollowMode=\{/);
    expect(views[0]).toMatch(/\bfollowControl=\{/);
    const canvases = jsxElements(src, 'PlanChangeCanvas');
    expect(canvases.length).toBeGreaterThan(0);
    for (const el of canvases) {
      expect(el).not.toMatch(/\bfollowMode=|\bfollowControl=|\bprogressReading=/);
    }
  });

  it('the plan page passes none of them', () => {
    const src = read(join(ROOT, 'components/planning/PlanDetail.tsx'));
    expect(src).not.toMatch(
      /\bfollowMode=|\bfollowControl=|\bprogressReading=|\binFlightDrafts=|\bliveDrafts=/,
    );
  });
});

describe('the scanner is not vacuous', () => {
  it('walks the tree and parses a real element', () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(jsxElements('<A b={x > 1 ? 2 : 3} c="d" />\n<A/>', 'A').map((s) => s.length)).toEqual([
      29, 4,
    ]);
  });
});
