import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-3448 — allocation rows 11–14: the four heavy pages outside the project
// rail. Two of them stop reading in series, and one of THOSE is the route the
// whole in-page decision was measured on.

const ROOT = resolve(__dirname, '..', '..');
/** Source with comments stripped — a claim in prose is not a claim in code. */
const code = (rel: string) =>
  readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const S = 'app/(authed)/settings';
const ROWS = [
  { row: 11, rel: `${S}/workspace/jobs/page.tsx`, width: '60rem' },
  // ⚠️ ROW 12 MOVED A TIER (MOTIR-4680). It was `workspace/gitlab/page.tsx`; the
  // git connect surface is the ORGANISATION's now — one route for both providers,
  // with the provider as a search param — and both workspace addresses are
  // permanent redirects. The ROW is kept rather than renumbered: the numbers are
  // MOTIR-3448's allocation and renumbering them would break every reference to
  // that card's own measurements.
  { row: 12, rel: `${S}/organization/git/page.tsx`, width: null },
  { row: 13, rel: `${S}/organization/page.tsx`, width: '45rem' },
  // Row 14 has no page-level column since MOTIR-9403: BillingClient caps each
  // view at 64rem itself, except the Motir AI plans view, which takes the full
  // page width (design/billing § "Amendment 2026-10-23 — the Host plan").
  { row: 14, rel: `${S}/organization/billing/page.tsx`, width: null },
  // Story MOTIR-1215 · MOTIR-3646 — the org Security pane. Not one of the four
  // pages MOTIR-3448 measured; it JOINS their contract, because a new
  // `settings/**` route owes the same arrival and the same boundary rule the
  // moment it exists rather than the next time somebody audits the family.
  // 45rem matches `organization/page.tsx`: one centred card, same column.
  { row: 15, rel: `${S}/organization/security/page.tsx`, width: '45rem' },
  // Story MOTIR-1215 · MOTIR-3647 — the workspace Security pane. 42rem matches
  // `workspace/page.tsx`, the area it belongs to.
  { row: 16, rel: `${S}/workspace/security/page.tsx`, width: '42rem' },
] as const;

describe('every settings pane mounts the shared frame (MOTIR-3448; MOTIR-3646 joins)', () => {
  it.each(ROWS)(
    'row $row · $rel mounts SettingsPaneFrame and draws no frame of its own',
    ({ rel }) => {
      const src = code(rel);
      expect(src).toMatch(/from '@\/components\/settings\/SettingsPaneFrame'/);
      expect(src).toMatch(/fallback=\{<SettingsPaneFrame\s*\/>\}/);
      expect(src).not.toMatch(/animate-pulse/);
    },
  );

  it.each(ROWS)('row $row · adds NO route-level loading.tsx', ({ rel }) => {
    expect(code(rel)).not.toMatch(/loading\.tsx/);
  });

  it.each(ROWS.filter((r) => r.width !== null))(
    'row $row · keeps its own centred column at $width',
    ({ rel, width }) => {
      // The frame carries no width — the column is the page's, so a stale entry
      // in the asset's width table cannot move the content.
      expect(code(rel)).toContain(`max-w-[${width!}]`);
    },
  );

  it('row 12 · the boundary sits INSIDE GitSettingsShell, whose header is pure t(...)', () => {
    // ⚠️ MATCHED STRUCTURALLY, NOT BY AN EXACT LINE (MOTIR-4680). The old
    // assertion pinned the literal `<GitSettingsShell provider="gitlab">` and the
    // banner variable that followed it, which is a shape only that page ever had.
    // What the RULE is about survives the move: the shell's header is pure
    // translation (nothing in it awaits a read), so the boundary belongs INSIDE
    // it — the title and the provider Segmented paint immediately and only the
    // reads wait.
    const src = code(`${S}/organization/git/page.tsx`);
    const shell = src.indexOf('<GitSettingsShell');
    expect(shell).toBeGreaterThan(-1);
    expect(src.indexOf('<Suspense')).toBeGreaterThan(shell);
    // …and the shell's own header takes no read-derived value beyond the
    // translated subtitle, so nothing above the boundary can block on a query.
    expect(src).not.toMatch(/<GitSettingsShell[^>]*\bawait\b/);
  });
});

describe('⚠️ row 14 is a DECIDER — the route the boundary decision was measured on', () => {
  const src = code(`${S}/organization/billing/page.tsx`);

  it('notFound() is the FIRST statement, and the boundary comes after it', () => {
    // Off-cloud this route 404s, and `tests/e2e/billing-selfhost.spec.ts` asserts
    // it. With a route-level boundary above it that 404 came back 200 — the A/B
    // in `motir-core/CLAUDE.md`. Nothing may flush before the status is settled.
    const gate = src.indexOf('if (!isCloudBilling()) notFound()');
    expect(gate).toBeGreaterThan(-1);
    expect(src.indexOf('<Suspense')).toBeGreaterThan(gate);
    // …and it really is first: no await precedes it.
    expect(src.slice(0, gate)).not.toMatch(/await /);
  });

  it('no loading.tsx sits beside it', () => {
    expect(src).not.toMatch(/loading\.tsx/);
  });
});

describe('the reads (MOTIR-3448)', () => {
  it('row 11 · jobs reads the role, the DLQ count and the list in ONE wave', () => {
    // ⚠️ THE WAVE GREW A FOURTH READ, AND STILL IS ONE WAVE (MOTIR-8083). On the
    // System tab alone the pane also reads the workspace-less dead letters; it is
    // the 4th element of the SAME `allSettledOrThrow([...])`, not a second await
    // after it, and it is `Promise.resolve(null)` on every other tab — so a
    // tenant's tabs pay nothing for it. The claim this case guards, one wave and
    // no serial read, is unchanged; only the tuple's width moved.
    // The asset expected TWO waves, with the role preceding the others because
    // "the role selects which list is fetched". Measured: it does not — the tab
    // is narrowed by `showSystemTab`, an env var compared against the session
    // email, with no read behind it. All three are independent.
    // ⚠️ THE WAVE MOVED FILE, AND THE CLAIM DID NOT (Story MOTIR-4843 ·
    // MOTIR-4849). It was inline in `workspace/jobs/page.tsx`; it is now
    // `_components/JobsPane.tsx`, because this surface gained a SECOND door —
    // the fold-in on `/settings/organization` — and the fold-in had its own copy
    // of these reads, pinned to the default view, which is how it shipped with
    // every link inside it pointing at a 404.
    //
    // So the read is shared rather than duplicated, and this case follows it
    // rather than being deleted: MOTIR-3448 row 11's measurement — role, DLQ
    // count and the list in ONE wave — is exactly as true and exactly as worth
    // guarding at its new address, and it now covers both doors at once.
    const src = code(`${S}/workspace/jobs/_components/JobsPane.tsx`);
    expect(src).toMatch(/const \[role, dlqCount, list, systemDlq\] = await allSettledOrThrow\(\[/);
    expect(src).toMatch(/workspacesService\.getMemberRole\(userId, workspaceId\)/);
    expect(src).toMatch(/jobsDashboardService\.countDLQ\(/);
    // The tab is still chosen ABOVE the wave — by `parseJobsParams`, in the HOST,
    // which is what makes it one answer for both doors instead of two.
    expect(code(`${S}/workspace/jobs/page.tsx`)).toMatch(/parseJobsParams\(/);
    // Three CALL sites, and they are the three arms of ONE ternary — so exactly
    // one read is issued, not three. Matched on the call form `list…({` so the
    // two `typeof jobsDashboardService.listX` type positions below do not count.
    const calls = src.match(/jobsDashboardService\.list\w+\(\{/g) ?? [];
    expect(calls).toHaveLength(3);
    expect(src).toMatch(/tab === 'dlq'\s*\?\s*jobsDashboardService\.listDLQ\(/);
    // …and all three sit inside the wave, so none is a second, earlier read.
    const wave = src.slice(src.indexOf('allSettledOrThrow(['), src.indexOf('const dlq ='));
    expect(wave.match(/jobsDashboardService\.list\w+\(\{/g) ?? []).toHaveLength(3);
    // The System tab's dead-letter read is the wave's 4th arm: inside it, gated to
    // the one tab that draws it, and a resolved null everywhere else.
    expect(wave).toMatch(
      /tab === 'system' \? jobsDashboardService\.listSystemDlq\(\) : Promise\.resolve\(null\)/,
    );
  });

  it('row 13 · organization has ONE pane read — its AI-access arm left with the card', () => {
    // ⚠️ THIS CASE USED TO ASSERT A TWO-ARM WAVE, `listMembers` + `getAiAccess`.
    // The second arm's only consumer was the acceptance-video card, which
    // MOTIR-5172 removed when the switch moved to the project tier — so a
    // surviving `getAiAccess` here would be a read with nothing reading it.
    const src = code(`${S}/organization/page.tsx`);
    expect((src.match(/organizationsService\.listMembers\(/g) ?? []).length).toBe(1);
    expect(src).not.toMatch(/billingService\.getAiAccess\(/);
    // `resolveActiveOrganization` stays ABOVE: it decides the no-active-org state
    // and supplies the org name the header interpolates.
    const resolve_ = src.indexOf('resolveActiveOrganization');
    expect(src.indexOf('<Suspense')).toBeGreaterThan(resolve_);
  });

  it('row 14 has ONE read — nothing to make concurrent', () => {
    // ⚠️ ROW 12 LEFT THIS CASE (MOTIR-4680). The pane it named had one read; the
    // organisation's Git page has FOUR — the inventory, its usage fan-in, the
    // connection and the actor's org role — so "nothing to make concurrent" is no
    // longer true of it and asserting it would be asserting the old page. Its
    // concurrency is covered by the `allSettledOrThrow` case below, which is the
    // claim that actually binds a multi-arm read.
    const billing = code(`${S}/organization/billing/page.tsx`);
    expect((billing.match(/organizationsService\.listMembers\(/g) ?? []).length).toBe(1);
  });

  it('row 12 makes its FOUR reads concurrent', () => {
    // The other half of the case above: the page that stopped having one read had
    // better not be doing them in series.
    const src = code(`${S}/organization/git/page.tsx`);
    expect(src).toMatch(/allSettledOrThrow\(\[/);
  });

  it('every multi-arm read uses allSettledOrThrow, never a bare Promise.all', () => {
    // Each arm opens a transaction (MOTIR-3066). Row 13's GATE keeps its existing
    // `Promise.all` — it predates this card and its arms are unchanged.
    for (const { rel } of ROWS) {
      const below = code(rel).split('<Suspense')[1] ?? '';
      expect(below, rel).not.toMatch(/await Promise\.all\(\[/);
    }
  });
});
