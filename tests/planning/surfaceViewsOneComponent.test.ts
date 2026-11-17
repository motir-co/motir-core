import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-6186 — ONE component, two hosts. The architecture half, which a coverage
// percentage cannot see.
//
// The story's promise is that the planning surface and the plan page can never
// disagree about what a plan contains, and the only thing that makes that TRUE is
// that neither builds its own list, its own review canvas or its own edge
// computation. Both mount `PlanProposalViews`; `PlanProposalViews` mounts the
// bodies; `PlanReviewCanvas` owns the one edge engine, `mergePlanLevel`.
//
// A future edit that reaches past the shared component — "just render the list
// here, it's only one line" — reintroduces the second copy with nothing failing,
// because both copies would render correctly. That is what this asserts.
//
// It is a STATIC read of the source rather than a render: what is being ruled on
// is which modules a file depends on, and a render cannot see an import that a
// branch happened not to take.

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Does `source` IMPORT `module`? Comments and JSX prose do not count. */
function importsModule(source: string, module: string): boolean {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const pattern = new RegExp(`^\\s*import[^;]*from\\s*['"]${module}['"]`, 'm');
  return pattern.test(withoutComments);
}

const HOSTS = [
  'components/planning/PlanningWorkspaceHost.tsx',
  'components/planning/PlanDetail.tsx',
] as const;

describe('the plan review is ONE component, mounted by two hosts (MOTIR-6186)', () => {
  it.each(HOSTS)('%s mounts the shared component', (host) => {
    const source = read(host);
    expect(importsModule(source, '@/components/planning/PlanProposalViews')).toBe(true);
    expect(source).toContain('<PlanProposalViews');
  });

  it.each(HOSTS)('%s imports NEITHER body directly', (host) => {
    const source = read(host);

    expect(
      importsModule(source, '@/components/planning/PlanProposalList'),
      `${host} imports PlanProposalList directly — mount PlanProposalViews instead, or the ` +
        'two hosts grow a second list that can disagree with the first.',
    ).toBe(false);
    expect(
      importsModule(source, '@/components/planning/PlanReviewCanvas'),
      `${host} imports PlanReviewCanvas directly — mount PlanProposalViews instead.`,
    ).toBe(false);
  });

  it('only the shared component mounts the two bodies', () => {
    const views = read('components/planning/PlanProposalViews.tsx');
    expect(importsModule(views, '@/components/planning/PlanProposalList')).toBe(true);
    expect(importsModule(views, '@/components/planning/PlanReviewCanvas')).toBe(true);
  });

  it('⭐ ONE edge engine — nothing but `PlanReviewCanvas` merges a plan level', () => {
    // `mergePlanLevel` is the single place a proposal's edges are computed: the
    // committed edges minus the ones the plan removes, the edges to re-parented
    // cards, the proposal's own pending edges, and the off-level anchors. A
    // second caller is a second answer to "what does this plan connect".
    const callers = [
      'components/planning/PlanReviewCanvas.tsx',
      'components/planning/PlanProposalViews.tsx',
      'components/planning/PlanDetail.tsx',
      'components/planning/PlanningWorkspaceHost.tsx',
    ].filter((f) => importsModule(read(f), '@/components/planning/planLevel'));

    expect(callers).toEqual(['components/planning/PlanReviewCanvas.tsx']);
  });

  it('⭐ the planning surface draws its pane with ONE mount, before a plan exists and after (MOTIR-11513)', () => {
    // The surface used to render a second component for the "no plan" state and
    // swap the shared one in when the plan's first read landed, which remounted
    // the canvas under the reader. One mount, with the pre-plan state as a prop,
    // is what lets React keep the same canvas — so a second canvas mount in the
    // host fails here by name.
    const host = read('components/planning/PlanningWorkspaceHost.tsx');
    expect(host.match(/<PlanProposalViews\b/g)).toHaveLength(1);
    expect(host).toMatch(/\bprePlan=\{panePrePlan\}/);
    expect(host).not.toMatch(/<(PlanReviewCanvas|ProjectRoadmapCanvas)\b/);
  });
});
