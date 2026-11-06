// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import { MotirAiUnavailableError } from '@/lib/ai/errors';
import type { PlannerFindingListDTO, PlannerFindingRowDTO } from '@/lib/dto/plannerFindings';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { renderToHtml } from '../helpers/serverPageHarness';
import { renderWithIntl } from '../helpers/renderWithIntl';

/**
 * The console's PLANNER FINDINGS list page (Story MOTIR-10353 · MOTIR-10522,
 * design MOTIR-10362). The read service is stubbed at its module and the staff
 * gate at the page gate; next-intl serves the real `en` catalogue, so every
 * assertion reads the copy a reader sees. The client islands (filters, view
 * switch, retry) are driven with Testing Library against a mocked router.
 */

class NotFoundSentinel extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}

const gate = vi.hoisted(() => ({ principal: null as PlatformPrincipal | null }));
const list = vi.hoisted(() => vi.fn());
const nav = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  pathname: '/admin/planner-findings',
  search: '',
}));

vi.mock('@/lib/platform/pageGate', () => ({
  requirePlatformStaffPage: vi.fn(async () => {
    if (!gate.principal) throw new NotFoundSentinel();
    return gate.principal;
  }),
}));
vi.mock('@/lib/services/plannerFindingsService', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/plannerFindingsService')>(
    '@/lib/services/plannerFindingsService',
  );
  return { ...actual, plannerFindingsService: { list } };
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, refresh: nav.refresh, prefetch: () => {} }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  notFound: () => {
    throw new NotFoundSentinel();
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as 'platformAdmin' }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));

const { default: Page } = await import('@/app/(admin)/admin/planner-findings/page');
const { toListFilters } =
  await import('@/app/(admin)/admin/planner-findings/_components/listFilters');
const { findingsView } =
  await import('@/app/(admin)/admin/planner-findings/_components/filterKeys');
const { FindingFilters } =
  await import('@/app/(admin)/admin/planner-findings/_components/FindingFilters');
const { FindingsViewSwitch } =
  await import('@/app/(admin)/admin/planner-findings/_components/FindingsViewSwitch');
const { FindingsUnavailable } =
  await import('@/app/(admin)/admin/planner-findings/_components/FindingsUnavailable');
const { FindingsSkeleton } =
  await import('@/app/(admin)/admin/planner-findings/_components/FindingsSkeleton');
const { PLANNER_FINDING_NO_PLAN_ID } = await import('@/lib/services/plannerFindingsService');

const pf = en.platformAdmin.plannerFindings;
const SUPPORT: PlatformPrincipal = { userId: 'u_sp', email: 'sp@moooon.net', role: 'support' };

function row(over: Partial<PlannerFindingRowDTO> = {}): PlannerFindingRowDTO {
  return {
    id: 'pf_1',
    source: 'in_loop',
    planner: 'hosted',
    attribution: 'corpus',
    outcome: 'fixed',
    prediction: 'STOPS',
    site: 'leaf:MOTIR-12',
    planId: 'plan_gone_1',
    planTitle: 'A plan nobody has any more',
    status: 'new',
    fingerprint: 'fp_1',
    lessonId: null,
    bugKey: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    ...over,
  };
}

function page(
  findings: PlannerFindingRowDTO[],
  nextCursor: string | null = null,
): PlannerFindingListDTO {
  return { findings, nextCursor, retention: { days: 90, cutoff: null } };
}

function decode(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function render(params: Record<string, string | string[]> = {}): Promise<string> {
  return decode(await renderToHtml(await Page({ searchParams: Promise.resolve(params) })));
}

beforeEach(() => {
  vi.clearAllMocks();
  gate.principal = SUPPORT;
  nav.pathname = '/admin/planner-findings';
  nav.search = '';
  list.mockResolvedValue(page([row()]));
});

afterEach(cleanup);

describe('the gate', () => {
  it('answers the 404 to a non-staff request before reading anything', async () => {
    gate.principal = null;
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(
      NotFoundSentinel,
    );
    expect(list).not.toHaveBeenCalled();
  });
});

describe('findingsView', () => {
  it('reads view=all as all and anything else, or nothing, as grouped', () => {
    expect(findingsView({ view: 'all' })).toBe('all');
    expect(findingsView({ view: ['all'] })).toBe('all');
    expect(findingsView({ view: 'grouped' })).toBe('grouped');
    expect(findingsView({})).toBe('grouped');
  });
});

describe('toListFilters', () => {
  it('passes the four value filters through, trimmed', () => {
    expect(
      toListFilters({
        source: ' in_loop ',
        planner: 'plan_py',
        outcome: 'fix_failed',
        attribution: 'model',
      }),
    ).toEqual({
      source: 'in_loop',
      planner: 'plan_py',
      outcome: 'fix_failed',
      attribution: 'model',
    });
  });

  it.each([
    [undefined, {}],
    ['dismissed', { status: 'dismissed' }],
    ['all', { status: 'all' }],
    ['new', {}],
    ['', {}],
  ])('state %s maps to %j', (state, expected) => {
    expect(toListFilters(state === undefined ? {} : { state })).toEqual(expected);
  });

  it('takes the first entry of an array value and carries the cursor', () => {
    expect(toListFilters({ source: ['check_plan', 'in_loop'], cursor: 'c2' })).toEqual({
      source: 'check_plan',
      cursor: 'c2',
    });
  });

  it('omits absent and blank keys, never sending an empty string', () => {
    expect(toListFilters({})).toEqual({});
    expect(toListFilters({ source: '  ', cursor: '' })).toEqual({});
  });
});

describe('the page', () => {
  it('draws the header, the card and the view switch, and reads with the URL filters only', async () => {
    const html = await render({ source: 'in_loop', state: 'dismissed', view: 'all', q: 'x' });
    expect(html).toContain(pf.breadcrumb);
    expect(html).toContain(`<h1 class="font-serif text-2xl text-(--el-text)">${pf.title}</h1>`);
    expect(html).toContain(pf.infoLead);
    expect(html).toContain(pf.card.title);
    expect(html).toContain(pf.card.subtitleAll);
    expect(html).toContain('data-testid="planner-findings-view-switch"');
    expect(list).toHaveBeenCalledWith(SUPPORT, { source: 'in_loop', status: 'dismissed' });
  });

  it('lists a finding whose plan exists nowhere in motir-core, from what motir-ai stored', async () => {
    const html = await render();
    expect(html).toContain('A plan nobody has any more');
    expect(html).toContain('href="/admin/planner-findings/pf_1"');
    expect(html).toContain('aria-label="Open leaf:MOTIR-12"');
    expect(html).toContain('<caption class="sr-only">All findings</caption>');
    for (const header of [
      'Site',
      'Source',
      'Planner',
      'Outcome',
      'Plan',
      'Attribution',
      'State',
      'Date',
    ]) {
      expect(html).toContain(`>${header}</th>`);
    }
    expect(html).toContain(pf.source.in_loop);
    expect(html).toContain(pf.planner.hosted);
    expect(html).toContain(pf.outcome.fixed);
    expect(html).toContain(pf.attribution.corpus);
    expect(html).toContain(pf.status.new);
    expect(html).toContain('Nov 1, 2026');
  });

  it('shows a value the catalogue does not know as it came, and the bug key on a recorded bug', async () => {
    list.mockResolvedValue(
      page([
        row({
          id: 'pf_2',
          source: 'future_source',
          attribution: 'someone',
          status: 'filed_as_bug',
          bugKey: 'MOTIR-42',
        }),
        row({ id: 'pf_3', status: 'archived_later', outcome: 'unknown_outcome' }),
      ]),
    );
    const html = await render();
    expect(html).toContain('>future_source<');
    expect(html).toContain('someone');
    expect(html).toContain('Bug MOTIR-42');
    expect(html).toContain('archived_later');
    expect(html).toContain('unknown_outcome');
  });

  it('draws the plan cell for an untitled plan and for no plan, never the sentinel', async () => {
    list.mockResolvedValue(
      page([
        row({ id: 'pf_4', planTitle: null }),
        row({ id: 'pf_5', planId: PLANNER_FINDING_NO_PLAN_ID, planTitle: null }),
        row({ id: 'pf_6', planId: '', planTitle: 'ignored' }),
        row({ id: 'pf_7', status: 'dismissed', attribution: 'unattributed' }),
        row({
          id: 'pf_8',
          status: 'promoted_to_lesson',
          outcome: 'fix_failed',
          attribution: 'code',
        }),
        row({ id: 'pf_9', status: 'filed_as_bug', outcome: 'reported', attribution: 'model' }),
      ]),
    );
    const html = await render();
    expect(html).toContain(pf.row.untitledPlan);
    expect(html.split(`>${pf.row.noPlan}<`).length - 1).toBe(2);
    expect(html).not.toContain(PLANNER_FINDING_NO_PLAN_ID);
    expect(html).toContain(pf.status.dismissed);
    expect(html).toContain('opacity-60');
    expect(html).toContain(pf.status.promoted_to_lesson);
    expect(html).toContain(pf.status.filed_as_bug);
  });
});

describe('empty and no match', () => {
  it('no filter, no cursor, no rows: the empty state only', async () => {
    list.mockResolvedValue(page([]));
    const html = await render();
    expect(html).toContain('data-testid="planner-findings-empty"');
    expect(html).toContain(pf.empty.title);
    expect(html).not.toContain('planner-findings-no-match');
    expect(html).not.toContain('<table');
  });

  it('a filter and no rows: no match, with the Clear filters link', async () => {
    list.mockResolvedValue(page([]));
    const html = await render({ outcome: 'reported' });
    expect(html).toContain('data-testid="planner-findings-no-match"');
    expect(html).toContain(pf.noMatch.title);
    expect(html).toContain(`href="/admin/planner-findings">${pf.noMatch.action}`);
    expect(html).not.toContain('planner-findings-empty');
  });

  it('a cursor and no rows: no match', async () => {
    list.mockResolvedValue(page([]));
    const html = await render({ cursor: 'c2' });
    expect(html).toContain('planner-findings-no-match');
    expect(html).not.toContain('planner-findings-empty');
  });

  it('rows present: neither state', async () => {
    const html = await render({ outcome: 'fixed' });
    expect(html).not.toContain('planner-findings-no-match');
    expect(html).not.toContain('planner-findings-empty');
  });
});

describe('unavailable, never empty', () => {
  it('a motir-ai error is the unavailable card with Retry and no list', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    list.mockRejectedValue(new MotirAiUnavailableError('down'));
    const html = await render();
    expect(html).toContain('data-testid="planner-findings-unavailable"');
    expect(html).toContain(pf.unavailable.title);
    expect(html).toContain(pf.unavailable.retry);
    expect(html).not.toContain('planner-findings-empty');
    expect(html).not.toContain('planner-findings-no-match');
    expect(html).not.toContain('<table');
    expect(error).toHaveBeenCalledWith(
      '[admin] planner findings could not be read',
      expect.any(MotirAiUnavailableError),
    );
  });

  it('any other error is rethrown', async () => {
    list.mockRejectedValue(new NotPlatformStaffError());
    await expect(render()).rejects.toBeInstanceOf(NotPlatformStaffError);
  });

  it('Retry re-runs the server read', () => {
    renderWithIntl(<FindingsUnavailable />);
    fireEvent.click(screen.getByRole('button', { name: pf.unavailable.retry }));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('the cursor pager', () => {
  it('a single page shows no pager', async () => {
    expect(await render()).not.toContain('planner-findings-pager');
  });

  it('walks three pages forward and back, keeping the filters and the view', async () => {
    list.mockImplementation(async (_p: unknown, filters: { cursor?: string }) => {
      if (!filters.cursor) return page([row()], 'c2');
      if (filters.cursor === 'c2') return page([row({ id: 'pf_b' })], 'c3');
      return page([row({ id: 'pf_c' })], null);
    });
    const keep = 'source=in_loop&view=all';

    const one = await render({ source: 'in_loop', view: 'all' });
    expect(one).toContain('data-testid="planner-findings-pager"');
    expect(one).toContain('Page 1');
    expect(one).toContain('Newest first · 50 a page');
    expect(one).toContain(`href="/admin/planner-findings?${keep}&cursor=c2">Next`);
    expect(one).not.toContain('>Previous<');

    const two = await render({ source: 'in_loop', view: 'all', cursor: 'c2' });
    expect(two).toContain('Page 2');
    expect(two).toContain(`href="/admin/planner-findings?${keep}">Previous`);
    expect(two).toContain(`href="/admin/planner-findings?${keep}&cursor=c3&trail=c2">Next`);

    const three = await render({ source: 'in_loop', view: 'all', cursor: 'c3', trail: 'c2' });
    expect(three).toContain('Page 3');
    expect(three).toContain(`href="/admin/planner-findings?${keep}&cursor=c2">Previous`);
    expect(three).not.toContain('>Next<');
  });
});

describe('the loading frame', () => {
  it('is one status region named for the load, with the card head painted', () => {
    renderWithIntl(<FindingsSkeleton title={pf.card.title} label={pf.loading.label} />);
    const status = screen.getByRole('status', { name: pf.loading.label });
    expect(status.textContent).toContain(pf.card.title);
  });
});

describe('the filter bar', () => {
  function pick(combobox: string, option: string) {
    fireEvent.click(screen.getByRole('combobox', { name: combobox }));
    fireEvent.click(screen.getByRole('option', { name: option }));
  }

  it('offers the closed value sets, with the triage-state default first', () => {
    renderWithIntl(<FindingFilters />);
    fireEvent.click(screen.getByRole('combobox', { name: pf.filter.state }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      pf.filter.stateDefault,
      pf.status.dismissed,
      pf.filter.stateAll,
    ]);
  });

  it('a change keeps the other filters and the view, and drops the cursor walk', () => {
    nav.search = 'source=in_loop&view=all&cursor=c3&trail=c2';
    renderWithIntl(<FindingFilters />);
    pick(pf.filter.outcome, pf.outcome.fix_failed);
    expect(nav.push).toHaveBeenCalledWith(
      '/admin/planner-findings?source=in_loop&outcome=fix_failed&view=all',
    );
  });

  it('shows a chip per set filter; removing one and clearing all keep only the view', async () => {
    nav.search = 'planner=plan_py&attribution=code&state=all&view=all&cursor=c2';
    renderWithIntl(<FindingFilters />);
    expect(screen.getByTestId('planner-findings-filter-chips').textContent).toContain('3 filters');
    expect(screen.getByText(`${pf.filter.planner}: ${pf.planner.plan_py}`)).toBeTruthy();
    expect(screen.getByText(`${pf.filter.state}: ${pf.filter.stateAll}`)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: `Remove ${pf.filter.attribution}` }));
    expect(nav.push).toHaveBeenLastCalledWith(
      '/admin/planner-findings?planner=plan_py&state=all&view=all',
    );

    fireEvent.click(screen.getByRole('button', { name: pf.filter.clearAll }));
    expect(nav.push).toHaveBeenLastCalledWith('/admin/planner-findings?view=all');
  });

  it('shows no chip strip when nothing is set, and clear all to the bare path without a view', () => {
    renderWithIntl(<FindingFilters />);
    expect(screen.queryByTestId('planner-findings-filter-chips')).toBeNull();
    cleanup();
    nav.search = 'source=check_plan';
    renderWithIntl(<FindingFilters />);
    fireEvent.click(screen.getByRole('button', { name: pf.filter.clearAll }));
    expect(nav.push).toHaveBeenLastCalledWith('/admin/planner-findings');
  });

  it('collapses into the Filters sheet, which closes on Done', async () => {
    nav.search = 'source=check_plan';
    renderWithIntl(<FindingFilters />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: `${pf.filter.sheetButton} · 1` }));
    });
    const dialog = await screen.findByRole('dialog', { name: pf.filter.sheetTitle });
    expect(dialog).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: pf.filter.sheetDone }));
    });
    expect(screen.queryByRole('dialog', { name: pf.filter.sheetTitle })).toBeNull();
  });
});

describe('the view switch', () => {
  it('a bare URL marks Grouped checked; both links keep the filters and drop the cursor', () => {
    nav.search = 'source=in_loop&cursor=c2&trail=c1';
    renderWithIntl(<FindingsViewSwitch />);
    const group = screen.getByRole('radiogroup', { name: pf.view.label });
    expect(group).toBeTruthy();
    const grouped = screen.getByRole('radio', { name: pf.view.grouped });
    const all = screen.getByRole('radio', { name: pf.view.all });
    expect(grouped.getAttribute('aria-checked')).toBe('true');
    expect(all.getAttribute('aria-checked')).toBe('false');
    expect(grouped.getAttribute('href')).toBe('/admin/planner-findings?source=in_loop');
    expect(all.getAttribute('href')).toBe('/admin/planner-findings?source=in_loop&view=all');
    expect(grouped.getAttribute('tabindex')).toBe('0');
    expect(all.getAttribute('tabindex')).toBe('-1');
  });

  it('view=all marks All findings checked, and the arrow keys move the choice', () => {
    nav.search = 'view=all';
    renderWithIntl(<FindingsViewSwitch />);
    const all = screen.getByRole('radio', { name: pf.view.all });
    expect(all.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: pf.view.grouped }).getAttribute('href')).toBe(
      '/admin/planner-findings',
    );
    fireEvent.keyDown(all, { key: 'ArrowLeft' });
    expect(nav.push).toHaveBeenLastCalledWith('/admin/planner-findings');
    fireEvent.keyDown(all, { key: 'ArrowDown' });
    expect(nav.push).toHaveBeenLastCalledWith('/admin/planner-findings');
    fireEvent.keyDown(all, { key: 'Enter' });
    expect(nav.push).toHaveBeenCalledTimes(2);
  });
});
