import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-3443 — allocation rows 1–5: the five core project-settings panes.
//
// These are SOURCE assertions, and deliberately so. What this card changes is
// WHERE the wait is drawn and WHEN the reads are issued — neither of which a
// rendered unit test can see: a page whose reads went back to being serial
// renders the same regions with the same props, and a boundary that drifted
// above the header produces identical markup once everything has resolved. The
// only thing that knows is the source.
//
// The four claims worth pinning, one per failure this card exists to prevent:
//   1. Every pane mounts the SHARED frame — a hand-rolled copy is the drift that
//      put IssueTreeSkeleton 272px behind its table for eighty days.
//   2. The boundary sits BELOW the gate. Above it, the response head flushes
//      before the page has decided the status.
//   3. The boundary sits BELOW the real header — except on `repositories`, whose
//      lead line branches on the pending read and is therefore tier 2 by the
//      asset's own allocation.
//   4. Rows 2 and 3 read CONCURRENTLY, and row 4 deliberately does not.

const ROOT = resolve(__dirname, '..', '..');
/** Source with comments stripped — a claim in prose is not a claim in code. */
const code = (rel: string) =>
  readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

/** The page component's own body — from its declaration to the next TOP-LEVEL
 *  declaration. Sibling components declared after it are excluded, which is what
 *  makes a positional assertion mean render order rather than file order.
 *
 *  ⚠️ Not bounded by the first `\n}`: these pages destructure their props with a
 *  multi-line type annotation, so that closes the PARAMETER object and cuts the
 *  body off at zero characters — silently, as an empty slice that finds nothing. */
function pageBody(src: string): string {
  const start = src.indexOf('export default async function');
  expect(start, 'no default-exported page component').toBeGreaterThan(-1);
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\n(?:async function|function |\/\*\*)/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

const DIR = 'app/(authed)/settings/project';
const ROWS = [
  { row: 1, rel: `${DIR}/page.tsx`, width: '42rem' },
  { row: 2, rel: `${DIR}/board/page.tsx`, width: '52rem' },
  { row: 3, rel: `${DIR}/workflow/page.tsx`, width: '48rem' },
  { row: 4, rel: `${DIR}/automation/page.tsx`, width: '46rem' },
  { row: 5, rel: `${DIR}/repositories/page.tsx`, width: '46rem' },
] as const;

describe('the five panes mount the shared frame, below their gate (MOTIR-3443)', () => {
  it.each(ROWS)(
    'row $row · $rel mounts SettingsPaneFrame and draws no frame of its own',
    ({ rel }) => {
      const src = code(rel);
      expect(src).toMatch(/from '@\/components\/settings\/SettingsPaneFrame'/);
      expect(src).toMatch(/fallback=\{<SettingsPaneFrame\s*\/>\}/);
      // No hand-rolled pulse: the frame is composed, never copied.
      expect(src).not.toMatch(/animate-pulse/);
    },
  );

  it.each(ROWS)('row $row · the boundary is BELOW the gate', ({ rel }) => {
    const src = code(rel);
    const gate = src.indexOf('guardSettingsPage');
    const boundary = src.indexOf('<Suspense');
    expect(gate).toBeGreaterThan(-1);
    expect(boundary).toBeGreaterThan(gate);
  });

  it.each(ROWS)(
    'row $row · the page keeps its OWN centred column at width $width',
    ({ rel, width }) => {
      // The frame carries no width; the column is the page's, so the two cannot
      // disagree and the content never slides sideways on settle.
      expect(code(rel)).toContain(`max-w-[${width}]`);
    },
  );

  it('rows 1–4 paint their whole header ABOVE the boundary', () => {
    // ⚠️ Compared inside the PAGE COMPONENT's own body, not over the whole file.
    // Source position is not render order: row 2's header is a component declared
    // BELOW the page that renders it, so a file-wide indexOf reads backwards.
    for (const { rel, row } of ROWS.filter((r) => r.row !== 5)) {
      const body = pageBody(code(rel));
      const header = body.indexOf(row === 2 ? '<BoardSettingsHeader' : '<header');
      const boundary = body.indexOf('<Suspense');
      expect(header, `${rel}: header not found in the page body`).toBeGreaterThan(-1);
      expect(boundary, `${rel}: boundary not found in the page body`).toBeGreaterThan(-1);
      expect(boundary, `${rel}: the boundary must follow the header`).toBeGreaterThan(header);
    }
  });

  it('row 5 · repositories paints only its <h1> above the boundary, by the asset’s allocation', () => {
    // "The lead line is tier 2, because which of two strings it uses depends on
    // `view.rows.length`." So the header is SPLIT here and only here.
    const src = code(`${DIR}/repositories/page.tsx`);
    const header = src.indexOf('<header');
    const boundary = src.indexOf('<Suspense');
    expect(header).toBeLessThan(boundary);
    // The <h1> is above; both paragraphs moved below.
    expect(src.slice(header, boundary)).toMatch(/<h1/);
    expect(src.slice(header, boundary)).not.toMatch(/t\('lead'/);
    expect(src.slice(boundary)).toMatch(/t\('lead'/);
    expect(src.slice(boundary)).toMatch(/t\('summary', counts\)/);
  });
});

describe('the reads (MOTIR-3443)', () => {
  it('row 2 · board reads the board, the statuses and the filter lookups in ONE wave', () => {
    const src = code(`${DIR}/board/page.tsx`);
    // MOTIR-11334 added the stored-filter editor's builder lookups as a third
    // arm. They need no board, so they start at the page too and join the wave.
    expect(src).toMatch(
      /allSettledOrThrow\(\[\s*boardPromise,\s*statusesPromise,\s*lookupsPromise,?\s*\]\)/,
    );
    expect(src).toMatch(/const lookupsPromise = allSettledOrThrow\(\[/);
    // The promise is STARTED at the page and awaited nowhere on that line, so the
    // crumb boundary and the body boundary share one `getBoard`.
    expect(src).toMatch(/const boardPromise = boardsService\.getBoard\(/);
    expect(src).toMatch(/const statusesPromise = workflowsService\.listStatusesByProject\(/);
    expect((src.match(/boardsService\.getBoard\(/g) ?? []).length).toBe(1);
  });

  it('row 2 · the crumb has its OWN boundary, and its fallback reserves the line', () => {
    // The family's one no-shift hazard: the crumb is tier-2 CONTENT in a tier-1
    // POSITION. Its fallback is an h-4 block in the same place, so the title
    // does not jump when the board name lands.
    const src = code(`${DIR}/board/page.tsx`);
    expect(src).toMatch(/<Suspense fallback=\{<div className="h-4 [^"]*bg-\(--el-muted\)"/);
    expect(src).toMatch(/<BoardCrumb projectName=\{projectName\} boardName=\{boardName\} \/>/);
  });

  it('row 3 · workflow reads the workflow and the status automation in ONE wave', () => {
    const src = code(`${DIR}/workflow/page.tsx`);
    expect(src).toMatch(/allSettledOrThrow\(\[\s*workflowsService\.getWorkflow\(/);
    expect(src).toMatch(/projectStatusAutomationService\.getStatusAutomation\(/);
  });

  it('row 4 · automation KEEPS its two waves — the second needs the first’s label ids', () => {
    // A page reported as correctly two-wave is a result, not a gap. Collapsing
    // this would be a change in behaviour dressed as a win.
    const src = code(`${DIR}/automation/page.tsx`);
    const rules = src.indexOf('const rules = await automationRulesService.list(');
    const referents = src.indexOf('const referencedLabelIds');
    const fanout = src.indexOf('allSettledOrThrow([');
    expect(rules).toBeGreaterThan(-1);
    expect(referents).toBeGreaterThan(rules);
    expect(fanout).toBeGreaterThan(referents);
    expect(src).toMatch(/labelsService\.resolveByIds\(projectKey, referencedLabelIds, wsCtx\)/);
  });

  it('every multi-arm read uses allSettledOrThrow, never a bare Promise.all', () => {
    // Each arm opens a transaction, so a rejection on one must not leave the
    // others running unobserved (MOTIR-3066). Row 1's pair is the exception the
    // repo already made: it was `Promise.all` before this card and its arms are
    // the same two reads, unchanged — this card only moved them below the
    // boundary.
    for (const { rel } of ROWS.filter((r) => r.row !== 1)) {
      expect(code(rel), rel).not.toMatch(/await Promise\.all\(\[/);
    }
  });

  it('no route-level loading.tsx exists anywhere under settings/project', () => {
    // The family's frame is in-page precisely because a route-level fallback
    // flushes a 200 head above the routes that decide existence.
    for (const { rel } of ROWS) {
      expect(code(rel)).not.toMatch(/loading\.tsx/);
    }
  });
});
