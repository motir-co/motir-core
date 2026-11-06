// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFormatter, createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import { MotirAiUnavailableError } from '@/lib/ai/errors';
import type {
  PlannerFindingGroupRowDTO,
  PlannerFindingListDTO,
  PlannerFindingRowDTO,
} from '@/lib/dto/plannerFindings';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { renderFirstFlush, renderToHtml } from '../helpers/serverPageHarness';

/**
 * The planner findings GROUPED view and a group's page (Story MOTIR-10353 ·
 * MOTIR-10523, design MOTIR-10362). The read service is stubbed at its module
 * and the staff gate at the page gate; next-intl serves the real `en` catalogue.
 */

class NotFoundSentinel extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}

const gate = vi.hoisted(() => ({ principal: null as PlatformPrincipal | null }));
const svc = vi.hoisted(() => ({
  list: vi.fn(),
  listGroups: vi.fn(),
  getGroup: vi.fn(),
  listGroupFindings: vi.fn(),
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
  return { ...actual, plannerFindingsService: svc };
});
vi.mock('next/navigation', async () => ({
  ...(await import('../helpers/serverPageHarness')).navigationHooks(),
  notFound: () => {
    throw new NotFoundSentinel();
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as 'platformAdmin' }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));

const { default: ListPage } = await import('@/app/(admin)/admin/planner-findings/page');
const { default: GroupPage } =
  await import('@/app/(admin)/admin/planner-findings/groups/[fingerprint]/page');
const { groupHref, groupBackHref } =
  await import('@/app/(admin)/admin/planner-findings/_components/groupLinks');

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
    planId: 'plan_1',
    planTitle: 'Plan one',
    status: 'new',
    fingerprint: 'fp_a',
    lessonId: null,
    bugKey: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    ...over,
  };
}

function group(over: Partial<PlannerFindingGroupRowDTO> = {}): PlannerFindingGroupRowDTO {
  return { fingerprint: 'fp_a', findingCount: 3, planCount: 2, latest: row(), ...over };
}

const RETENTION = { days: 90, cutoff: null };

function findings(rows: PlannerFindingRowDTO[], nextCursor: string | null = null) {
  return { findings: rows, nextCursor, retention: RETENTION } satisfies PlannerFindingListDTO;
}

function decode(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function list(params: Record<string, string> = {}): Promise<string> {
  return decode(await renderToHtml(await ListPage({ searchParams: Promise.resolve(params) })));
}

function groupPage(fingerprint: string, params: Record<string, string> = {}) {
  return GroupPage({
    params: Promise.resolve({ fingerprint }),
    searchParams: Promise.resolve(params),
  });
}

async function openGroup(fingerprint: string, params: Record<string, string> = {}) {
  return decode(await renderToHtml(await groupPage(fingerprint, params)));
}

beforeEach(() => {
  vi.clearAllMocks();
  gate.principal = SUPPORT;
  svc.listGroups.mockResolvedValue({
    groups: [
      group(),
      group({
        fingerprint: 'fp_b',
        findingCount: 1,
        planCount: 1,
        latest: row({ id: 'pf_9', site: 'shape:root', attribution: 'later_value', outcome: 'odd' }),
      }),
    ],
    nextCursor: null,
    retention: RETENTION,
  });
  svc.getGroup.mockResolvedValue(group());
  svc.listGroupFindings.mockResolvedValue(
    findings([row(), row({ id: 'pf_2', planId: 'plan_2', planTitle: 'Plan two' })]),
  );
});

describe('the grouped view', () => {
  it('is the default: one row per group with its counts, read with the URL filters', async () => {
    const html = await list({ source: 'in_loop', state: 'all' });
    expect(svc.listGroups).toHaveBeenCalledWith(SUPPORT, { source: 'in_loop', status: 'all' });
    expect(svc.list).not.toHaveBeenCalled();
    expect(html).toContain('data-testid="planner-findings-groups-table"');
    expect(html).toContain(`<caption class="sr-only">${pf.a11y.captionGroups}</caption>`);
    expect(html).toContain(pf.card.subtitleGrouped);
    expect(html).toContain('data-testid="planner-findings-group-row-fp_a"');
    expect(html).toContain('data-testid="planner-findings-group-row-fp_b"');
    expect(html).toContain('3 findings');
    expect(html).toContain('2 plans');
    expect(html).toContain('1 finding');
    expect(html).toContain('1 plan<');
    for (const header of ['Defect', 'Attribution', 'Outcome', 'Findings', 'Plans', 'Last seen']) {
      expect(html).toContain(`>${header}</th>`);
    }
    expect(html).toContain(pf.attribution.corpus);
    expect(html).toContain(pf.outcome.fixed);
    // A value the catalogue does not know shows as it came.
    expect(html).toContain('later_value');
    expect(html).toContain('>odd<');
    expect(html).toContain('Nov 1, 2026');
  });

  it('view=grouped is the grouped body too, and view=all is the flat list', async () => {
    await list({ view: 'grouped' });
    expect(svc.listGroups).toHaveBeenCalledTimes(1);
    svc.list.mockResolvedValue(findings([row()]));
    const flat = await list({ view: 'all' });
    expect(svc.list).toHaveBeenCalledTimes(1);
    expect(flat).not.toContain('planner-findings-groups-table');
    expect(flat).toContain(pf.card.subtitleAll);
  });

  it('each row opens its group with the filters, stretched over the row', async () => {
    const html = await list({ outcome: 'fixed', cursor: 'c2', trail: 'c1' });
    expect(html).toContain('href="/admin/planner-findings/groups/fp_a?outcome=fixed"');
    expect(html).toContain('aria-label="Open leaf:MOTIR-12"');
  });

  it('picks empty, no-match (filter or cursor) and the table by the list rules', async () => {
    svc.listGroups.mockResolvedValue({ groups: [], nextCursor: null, retention: RETENTION });
    const empty = await list();
    expect(empty).toContain('planner-findings-empty');
    expect(empty).not.toContain('planner-findings-no-match');
    const filtered = await list({ planner: 'plan_py' });
    expect(filtered).toContain('planner-findings-no-match');
    expect(filtered).not.toContain('planner-findings-empty');
    const paged = await list({ cursor: 'c2' });
    expect(paged).toContain('planner-findings-no-match');
    expect(paged).not.toContain('planner-findings-groups-table');
  });

  it('pages with view=grouped kept on every link', async () => {
    svc.listGroups.mockResolvedValue({ groups: [group()], nextCursor: 'g3', retention: RETENTION });
    const html = await list({ source: 'check_plan', cursor: 'g2' });
    expect(html).toContain('Page 2');
    expect(html).toContain(
      'href="/admin/planner-findings?source=check_plan&view=grouped">Previous',
    );
    expect(html).toContain(
      'href="/admin/planner-findings?source=check_plan&view=grouped&cursor=g3&trail=g2">Next',
    );
  });

  it('an unreadable motir-ai is the unavailable card, never an empty grouped list', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    svc.listGroups.mockRejectedValue(new MotirAiUnavailableError('down'));
    const html = await list();
    expect(html).toContain('data-testid="planner-findings-unavailable"');
    expect(html).toContain(pf.unavailable.retry);
    expect(html).not.toContain('planner-findings-empty');
    expect(html).not.toContain('planner-findings-no-match');
    expect(html).not.toContain('<table');
    expect(error).toHaveBeenCalled();
  });

  it('any other error is rethrown', async () => {
    svc.listGroups.mockRejectedValue(new NotPlatformStaffError());
    await expect(list()).rejects.toBeInstanceOf(NotPlatformStaffError);
  });
});

describe('groupLinks', () => {
  it('a bare group link, with every filter, and with a cursor and trail dropped', () => {
    expect(groupHref('fp a/1', {})).toBe('/admin/planner-findings/groups/fp%20a%2F1');
    expect(
      groupHref('fp_a', {
        source: 'in_loop',
        planner: 'hosted',
        outcome: 'fixed',
        attribution: 'code',
        state: 'all',
        view: 'grouped',
        cursor: 'c2',
        trail: 'c1',
      }),
    ).toBe(
      '/admin/planner-findings/groups/fp_a?source=in_loop&planner=hosted&outcome=fixed&attribution=code&state=all',
    );
    expect(groupBackHref({ state: 'dismissed', cursor: 'c4' })).toBe(
      '/admin/planner-findings?state=dismissed&view=grouped',
    );
  });
});

describe('a group page', () => {
  it('answers the 404 to a non-staff request before reading anything', async () => {
    gate.principal = null;
    await expect(groupPage('fp_a')).rejects.toBeInstanceOf(NotFoundSentinel);
    await expect(ListPage({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(
      NotFoundSentinel,
    );
    expect(svc.getGroup).not.toHaveBeenCalled();
    expect(svc.listGroupFindings).not.toHaveBeenCalled();
    expect(svc.listGroups).not.toHaveBeenCalled();
  });

  it('reads the counts and the findings with the same fingerprint and filters', async () => {
    const html = await openGroup('fp_a', { state: 'all', source: 'in_loop', cursor: 'c2' });
    const filters = { source: 'in_loop', status: 'all', cursor: 'c2' };
    expect(svc.getGroup).toHaveBeenCalledWith(SUPPORT, 'fp_a', filters);
    expect(svc.listGroupFindings).toHaveBeenCalledWith(SUPPORT, 'fp_a', filters);
    expect(html).toContain('data-testid="planner-findings-group-page"');
    expect(html).toContain(`>${pf.group.title}</h1>`);
    expect(html).toContain('data-testid="planner-findings-group-summary"');
    expect(html).toContain('3 findings across 2 plans');
    expect(html).toContain(pf.group.findingsHeading);
    expect(html).toContain('href="/admin/planner-findings/pf_1"');
    expect(html).toContain('href="/admin/planner-findings/pf_2"');
    expect(html).toContain('href="/admin/planner-findings?source=in_loop&state=all&view=grouped"');
  });

  it('decodes the route segment, and takes a malformed one as written', async () => {
    await openGroup('fp%20a');
    expect(svc.getGroup).toHaveBeenLastCalledWith(SUPPORT, 'fp a', {});
    await openGroup('fp%zz');
    expect(svc.getGroup).toHaveBeenLastCalledWith(SUPPORT, 'fp%zz', {});
  });

  it('walks two pages by cursor; a one-page group shows no pager', async () => {
    expect(await openGroup('fp_a')).not.toContain('planner-findings-pager');

    svc.listGroupFindings.mockResolvedValue(findings([row()], 'c2'));
    const one = await openGroup('fp_a', { outcome: 'fixed' });
    expect(one).toContain(
      'href="/admin/planner-findings/groups/fp_a?outcome=fixed&cursor=c2">Next',
    );

    svc.listGroupFindings.mockResolvedValue(findings([row()], null));
    const two = await openGroup('fp_a', { outcome: 'fixed', cursor: 'c2' });
    expect(two).toContain('Page 2');
    expect(two).toContain('href="/admin/planner-findings/groups/fp_a?outcome=fixed">Previous');
    expect(two).not.toContain('>Next<');
  });

  it('a fingerprint that matches nothing is group.empty with the back link, not a 404', async () => {
    svc.getGroup.mockResolvedValue(null);
    svc.listGroupFindings.mockResolvedValue(findings([]));
    const html = await openGroup('fp_unknown');
    expect(html).toContain(pf.group.empty);
    expect(html).toContain('data-testid="planner-findings-group-empty"');
    expect(html).not.toContain('planner-findings-group-summary');
    expect(html).toContain(pf.group.back);
    expect(html).not.toContain('planner-findings-unavailable');
  });

  it.each(['getGroup', 'listGroupFindings'] as const)(
    'an unreadable %s is the unavailable card, never group.empty',
    async (method) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      svc[method].mockRejectedValue(new MotirAiUnavailableError('down'));
      const html = await openGroup('fp_a');
      expect(html).toContain('data-testid="planner-findings-unavailable"');
      expect(html).not.toContain(pf.group.empty);
      expect(html).not.toContain('<table');
      expect(html).not.toContain('planner-findings-group-summary');
    },
  );

  it('rethrows any other error', async () => {
    svc.getGroup.mockRejectedValue(new NotPlatformStaffError());
    await expect(openGroup('fp_a')).rejects.toBeInstanceOf(NotPlatformStaffError);
  });

  it('paints its header before the section resolves', async () => {
    let release: (value: PlannerFindingListDTO) => void = () => {};
    svc.listGroupFindings.mockReturnValue(
      new Promise<PlannerFindingListDTO>((resolve) => {
        release = resolve;
      }),
    );
    const flush = await renderFirstFlush(await groupPage('fp_a'));
    expect(flush.shell).toContain(pf.group.title);
    expect(flush.shell).toContain(pf.loading.label);
    expect(flush.shell).not.toContain('planner-findings-group-summary');
    release(findings([row()]));
    expect(await flush.complete()).toContain('planner-findings-group-summary');
  });
});
