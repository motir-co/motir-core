// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import { MotirAiUnavailableError, PlannerFindingRecordNotFoundError } from '@/lib/ai/errors';
import type {
  PlannerFindingRecordDTO,
  PlannerFindingRecordFindingDTO,
  PlannerFindingRecordListDTO,
  PlannerFindingRecordRowDTO,
} from '@/lib/dto/plannerFindings';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { renderToHtml } from '../helpers/serverPageHarness';
import { renderWithIntl } from '../helpers/renderWithIntl';

/**
 * The console's planner finding RECORDS — the Records view of the list page and
 * the record page (Story MOTIR-11455 · MOTIR-11463; designs MOTIR-11470,
 * MOTIR-11509, MOTIR-11591). The records console service is stubbed at its
 * module, the key actions at theirs, and the staff gate at the page gate;
 * next-intl serves the real `en` catalogue, so the assertions read the copy a
 * reader sees. The key cell is driven with Testing Library.
 */

class NotFoundSentinel extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}

const gate = vi.hoisted(() => ({ principal: null as PlatformPrincipal | null }));
const svc = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
const findings = vi.hoisted(() => ({ list: vi.fn() }));
const actions = vi.hoisted(() => ({ linkKey: vi.fn(), removeKey: vi.fn() }));
const nav = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  pathname: '/admin/planner-findings',
  search: 'view=records',
}));

vi.mock('@/lib/platform/pageGate', () => ({
  requirePlatformStaffPage: vi.fn(async () => {
    if (!gate.principal) throw new NotFoundSentinel();
    return gate.principal;
  }),
}));
vi.mock('@/lib/services/plannerFindingRecordsConsoleService', () => ({
  plannerFindingRecordsConsoleService: svc,
}));
vi.mock('@/lib/services/plannerFindingsService', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/plannerFindingsService')>(
    '@/lib/services/plannerFindingsService',
  );
  return { ...actual, plannerFindingsService: findings };
});
vi.mock('@/app/(admin)/admin/planner-findings/_components/findingKeyActions', () => actions);
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

const { default: ListPage } = await import('@/app/(admin)/admin/planner-findings/page');
const { default: RecordPage } =
  await import('@/app/(admin)/admin/planner-findings/records/[id]/page');
const { FindingKeyCell } =
  await import('@/app/(admin)/admin/planner-findings/_components/FindingKeyCell');
const { RecordCommand } =
  await import('@/app/(admin)/admin/planner-findings/_components/RecordCommand');
const { recordHref } =
  await import('@/app/(admin)/admin/planner-findings/_components/RecordsTable');
const { findingsView, hasRecordFilter } =
  await import('@/app/(admin)/admin/planner-findings/_components/filterKeys');
const { PLANNER_FINDING_NO_PLAN_ID } = await import('@/lib/services/plannerFindingsService');

const pf = en.platformAdmin.plannerFindings;
const SUPPORT: PlatformPrincipal = { userId: 'u_sp', email: 'sp@moooon.net', role: 'support' };
const OPERATOR: PlatformPrincipal = { userId: 'u_op', email: 'op@moooon.net', role: 'operator' };

function recordRow(over: Partial<PlannerFindingRecordRowDTO> = {}): PlannerFindingRecordRowDTO {
  return { ...record(), findingCount: 3, attributedCount: 1, ...over };
}

function record(over: Partial<PlannerFindingRecordDTO> = {}): PlannerFindingRecordDTO {
  return {
    id: 'rec_1',
    source: 'check_plan',
    planner: 'hosted',
    planId: 'plan_1',
    planTitle: 'Plan one',
    planSessionId: 'ps_1',
    jobId: 'job_1',
    authorModel: 'model-a',
    baselineBranch: 'main',
    baselineCommit: 'abc1234def5678ffff',
    verdictState: 'attributed',
    verdictBy: 'u_sam',
    verdictAt: '2026-11-16T12:40:00.000Z',
    runThroughAnswer: 'THRU',
    runThroughStopCards: [],
    createdAt: '2026-11-16T10:00:00.000Z',
    ...over,
  };
}

function finding(
  over: Partial<PlannerFindingRecordFindingDTO> = {},
): PlannerFindingRecordFindingDTO {
  return {
    id: 'pf_1',
    site: 'lay.story.children',
    prediction: 'STOPS',
    outcome: 'reported',
    attribution: 'corpus',
    why: 'The pack did not carry it.',
    hostedCell: 'lay/story',
    planpyCell: 'PART 2 story',
    bugKey: 'MOTIR-11602',
    ...over,
  };
}

function listOf(
  records: PlannerFindingRecordRowDTO[],
  nextCursor: string | null = null,
): PlannerFindingRecordListDTO {
  return { records, nextCursor };
}

function decode(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function renderList(params: Record<string, string> = {}): Promise<string> {
  const searchParams = Promise.resolve({ view: 'records', ...params });
  return decode(await renderToHtml(await ListPage({ searchParams })));
}

async function renderRecord(id = 'rec_1'): Promise<string> {
  return decode(await renderToHtml(await RecordPage({ params: Promise.resolve({ id }) })));
}

function view(
  rec: Partial<PlannerFindingRecordDTO> = {},
  rows: PlannerFindingRecordFindingDTO[] = [finding()],
  verdictByName: string | null = 'Sam',
) {
  return { detail: { record: record(rec), findings: rows }, verdictByName };
}

beforeEach(() => {
  vi.clearAllMocks();
  gate.principal = SUPPORT;
  nav.search = 'view=records';
  svc.list.mockResolvedValue(listOf([recordRow()]));
  svc.get.mockResolvedValue(view());
});

afterEach(cleanup);

describe('the view key', () => {
  it('reads records, and a record filter is not the verdict-free findings filter', () => {
    expect(findingsView({ view: 'records' })).toBe('records');
    expect(hasRecordFilter({ verdict: 'open' })).toBe(true);
    expect(hasRecordFilter({ state: 'new' })).toBe(false);
    expect(recordHref('rec 1')).toBe('/admin/planner-findings/records/rec%201');
  });
});

describe('the Records view', () => {
  it('is gated before any read', async () => {
    gate.principal = null;
    await expect(
      ListPage({ searchParams: Promise.resolve({ view: 'records' }) }),
    ).rejects.toBeInstanceOf(NotFoundSentinel);
    expect(svc.list).not.toHaveBeenCalled();
    expect(findings.list).not.toHaveBeenCalled();
  });

  it('reads the records once with only the record filters, and never the findings', async () => {
    const html = await renderList({ verdict: 'attributed', state: 'new', planner: 'hosted' });
    expect(svc.list).toHaveBeenCalledTimes(1);
    expect(svc.list).toHaveBeenCalledWith(SUPPORT, { verdict: 'attributed', planner: 'hosted' });
    expect(findings.list).not.toHaveBeenCalled();
    expect(html).toContain('data-testid="planner-finding-records-card"');
    expect(html).toContain(pf.records.title);
    expect(html).toContain('data-testid="planner-finding-record-row-rec_1"');
    expect(html).toContain('href="/admin/planner-findings/records/rec_1"');
    expect(html).toContain('Open record rec_1');
    expect(html).toContain(pf.records.verdict.attributed);
    expect(html).toContain(pf.view.records);
  });

  it('draws the empty state with no filter, and the no-match state with one', async () => {
    svc.list.mockResolvedValue(listOf([]));
    const empty = await renderList();
    expect(empty).toContain('data-testid="planner-finding-records-empty"');
    expect(empty).toContain(pf.records.empty.title);

    const none = await renderList({ verdict: 'open' });
    expect(none).toContain('data-testid="planner-finding-records-no-match"');
    expect(none).toContain('href="/admin/planner-findings?view=records"');
    expect(none).toContain(pf.records.noMatch.action);
  });

  it('draws the records copy of the unavailable state on an outage', async () => {
    svc.list.mockRejectedValue(new MotirAiUnavailableError('down'));
    const html = await renderList();
    expect(html).toContain('data-testid="planner-findings-unavailable"');
    expect(html).toContain(pf.records.unavailable.title);
  });

  it('answers the 404 when the platform refuses the read', async () => {
    svc.list.mockRejectedValue(new NotPlatformStaffError());
    await expect(renderList()).rejects.toBeInstanceOf(NotFoundSentinel);
  });

  it('pages within the view and keeps only the record filters', async () => {
    svc.list.mockResolvedValue(listOf([recordRow()], 'c_next'));
    const html = await renderList({ verdict: 'open', state: 'new' });
    expect(html).toContain('data-testid="planner-findings-pager"');
    const next = /href="([^"]*cursor=c_next[^"]*)"/.exec(html)?.[1] ?? '';
    const params = new URLSearchParams(next.split('?')[1]);
    expect(params.get('view')).toBe('records');
    expect(params.get('verdict')).toBe('open');
    expect(params.has('state')).toBe(false);
  });

  it('names a plan-less row without a plan link', async () => {
    svc.list.mockResolvedValue(
      listOf([
        recordRow({ planId: PLANNER_FINDING_NO_PLAN_ID, planTitle: null, verdictState: 'open' }),
      ]),
    );
    const html = await renderList();
    expect(html).toContain(pf.row.noPlan);
    expect(html).toContain(pf.records.verdict.open);
  });
});

describe('the records table', () => {
  it('names an untitled plan and an empty id as such, and an unknown verdict by its value', async () => {
    svc.list.mockResolvedValue(
      listOf([
        recordRow({ id: 'rec_a', planTitle: null, verdictState: 'withdrawn' }),
        recordRow({ id: 'rec_b', planId: '' }),
      ]),
    );
    const html = await renderList();
    expect(html).toContain(pf.row.untitledPlan);
    expect(html).toContain('withdrawn');
    expect(html).toContain(pf.row.noPlan);
  });
});

describe('the record page', () => {
  it('is force-dynamic, and its only Server Action module is the key actions', () => {
    const dir = 'app/(admin)/admin/planner-findings';
    const page = readFileSync(`${dir}/records/[id]/page.tsx`, 'utf8');
    expect(page).toContain("export const dynamic = 'force-dynamic'");
    expect(page).not.toMatch(/import \{ Suspense|\/actions'/);
    const cell = readFileSync(`${dir}/_components/FindingKeyCell.tsx`, 'utf8');
    expect(cell).toContain("from './findingKeyActions'");
    expect(cell).not.toMatch(/\.\.\/actions'|'\.\/actions'/);
    const keyActions = readFileSync(`${dir}/_components/findingKeyActions.ts`, 'utf8');
    expect(keyActions.startsWith("'use server'")).toBe(true);
  });

  it('is gated before the read', async () => {
    gate.principal = null;
    await expect(RecordPage({ params: Promise.resolve({ id: 'rec_1' }) })).rejects.toBeInstanceOf(
      NotFoundSentinel,
    );
    expect(svc.get).not.toHaveBeenCalled();
  });

  it('answers the 404 for an unknown id and for a platform refusal', async () => {
    svc.get.mockRejectedValueOnce(new PlannerFindingRecordNotFoundError('nope'));
    await expect(renderRecord('nope')).rejects.toBeInstanceOf(NotFoundSentinel);
    svc.get.mockRejectedValueOnce(new NotPlatformStaffError());
    await expect(renderRecord()).rejects.toBeInstanceOf(NotFoundSentinel);
  });

  it('draws the unavailable state — not the 404 — when the store cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    svc.get.mockRejectedValue(new MotirAiUnavailableError('down'));
    const html = await renderRecord();
    expect(html).toContain('data-testid="planner-findings-unavailable"');
    expect(html).toContain(pf.records.unavailable.title);
    expect(html).toContain(pf.record.back);
  });

  it('rethrows an error that is not the store’s', async () => {
    svc.get.mockRejectedValue(new Error('boom'));
    await expect(renderRecord()).rejects.toThrow('boom');
  });

  it('reads once and draws its sections in order', async () => {
    const html = await renderRecord();
    expect(svc.get).toHaveBeenCalledTimes(1);
    expect(svc.get).toHaveBeenCalledWith(SUPPORT, 'rec_1');
    const order = [
      pf.record.crumb,
      pf.record.back,
      'data-testid="record-plan-context"',
      'data-testid="record-run-through"',
      'data-testid="record-findings"',
    ].map((needle) => html.indexOf(needle));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('href="/admin/planner-findings?view=records"');
    // Plan context: title and id, the 12-character commit, the verdict by and at.
    expect(html).toContain('Plan one');
    expect(html).toContain('abc1234def56');
    expect(html).not.toContain('abc1234def5678');
    expect(html).toContain('data-testid="record-verdict-by"');
    expect(html).toContain('Attributed by Sam');
    // An attributed record carries no command.
    expect(html).not.toContain('data-testid="record-command"');
  });

  it('draws a quiet none for missing context, and an em dash for a gone verdict giver', async () => {
    svc.get.mockResolvedValue(
      view(
        {
          planId: PLANNER_FINDING_NO_PLAN_ID,
          planSessionId: null,
          jobId: null,
          authorModel: '  ',
          baselineBranch: null,
          baselineCommit: null,
        },
        [],
        null,
      ),
    );
    const html = await renderRecord();
    expect(html).toContain(pf.row.noPlan);
    expect(html.split(pf.record.field.none).length - 1).toBeGreaterThanOrEqual(4);
    expect(html).toContain('Attributed by —');
    expect(html).toContain('data-testid="record-findings-empty"');
    expect(html).toContain(pf.record.findings.empty);
  });

  it('names an untitled plan, and a branch alone as the baseline', async () => {
    svc.get.mockResolvedValue(view({ planTitle: null, baselineCommit: null }));
    const html = await renderRecord();
    expect(html).toContain(pf.row.untitledPlan);
    expect(html).toContain('>main</code>');
  });

  it('draws an unknown verdict state by its value, without the by line', async () => {
    svc.get.mockResolvedValue(view({ verdictState: 'withdrawn' }));
    const html = await renderRecord();
    expect(html).toContain('withdrawn');
    expect(html).not.toContain('data-testid="record-verdict-by"');
  });

  it.each([
    ['THRU', [], 'thru', pf.recordPage.runThrough.answer.thru],
    ['STOPS', ['MOTIR-9', 'MOTIR-3'], 'stops', pf.recordPage.runThrough.answer.stops],
    ['STOPS', [], 'stops', pf.recordPage.runThrough.cards.none],
    [null, [], 'none', pf.recordPage.runThrough.answer.none],
    ['MAYBE', [], 'none', pf.recordPage.runThrough.answer.none],
  ] as const)(
    'reads the answer %s with %j as the %s reading, on an open and an attributed record',
    async (answer, cards, reading, copy) => {
      for (const verdictState of ['open', 'attributed']) {
        svc.get.mockResolvedValue(
          view({ verdictState, runThroughAnswer: answer, runThroughStopCards: [...cards] }),
        );
        const html = await renderRecord();
        expect(html).toContain(`data-reading="${reading}"`);
        expect(html).toContain(copy);
        if (cards.length) {
          expect(html.indexOf('MOTIR-9')).toBeLessThan(html.indexOf('MOTIR-3'));
        }
        if (reading !== 'thru') expect(html).not.toContain(pf.recordPage.runThrough.answer.thru);
      }
    },
  );

  it('draws none of the verdict outputs on an open record, and the command', async () => {
    svc.get.mockResolvedValue(view({ verdictState: 'open', verdictBy: null, verdictAt: null }));
    const html = await renderRecord();
    expect(html).toContain('data-testid="record-findings-open-line"');
    expect(html).toContain(pf.recordPage.findingKey.openRecord);
    expect(html).not.toContain('The pack did not carry it.');
    expect(html).not.toContain('lay/story');
    expect(html).not.toContain('PART 2 story');
    expect(html).not.toContain(pf.attribution.corpus);
    expect(html).not.toContain('data-testid="record-verdict-by"');
    // The key is drawn as text, with no input, even for an operator.
    expect(html).toContain('MOTIR-11602');
    expect(html).not.toContain('data-testid="finding-key-cell-pf_1"');
    expect(html).toContain('data-testid="record-command"');
    expect(html).toContain('motir check planner finding rec_1');
  });

  it('draws the verdict outputs on an attributed record, the site as its only link', async () => {
    const html = await renderRecord();
    expect(html).not.toContain('data-testid="record-findings-open-line"');
    expect(html).toContain('The pack did not carry it.');
    expect(html).toContain('lay/story');
    expect(html).toContain('PART 2 story');
    expect(html).toContain('href="/admin/planner-findings/pf_1"');
    const row = /data-testid="record-finding-row-pf_1"[\s\S]*?<\/tr>/.exec(html)?.[0] ?? '';
    expect(row.match(/<a /g)).toHaveLength(1);
  });

  it('draws an em dash for a missing attribution, why and cells on an attributed record', async () => {
    svc.get.mockResolvedValue(
      view({}, [
        finding({ attribution: null, why: ' ', hostedCell: null, planpyCell: '', bugKey: null }),
      ]),
    );
    const html = await renderRecord();
    const row = /data-testid="record-finding-row-pf_1"[\s\S]*?<\/tr>/.exec(html)?.[0] ?? '';
    expect(row.split(pf.record.field.none).length - 1).toBe(4);
    expect(row).toContain(pf.recordPage.findingKey.a11y.empty);
  });

  it('gives an operator the key form on an attributed record, and a support reader none', async () => {
    const reader = await renderRecord();
    expect(reader).not.toContain('data-testid="finding-key-cell-pf_1"');
    expect(reader).toContain('data-testid="finding-key-value-pf_1"');

    gate.principal = OPERATOR;
    const writer = await renderRecord();
    expect(writer).toContain('data-testid="finding-key-cell-pf_1"');
    expect(writer).toContain(pf.recordPage.findingKey.link);
    expect(writer).toContain('Remove the planning bug key from lay.story.children');
  });

  it('draws a prediction it does not know by its value', async () => {
    svc.get.mockResolvedValue(view({}, [finding({ prediction: 'ODD' })]));
    expect(await renderRecord()).toContain('>ODD<');
  });
});

describe('the key cell', () => {
  function cell(bugKey: string | null = null, site = 'lay.story.children') {
    return renderWithIntl(<FindingKeyCell findingId="pf_1" site={site} bugKey={bugKey} canWrite />);
  }
  const input = () => screen.getByLabelText(/Planning bug/) as HTMLInputElement;
  const alert = () => screen.getByTestId('finding-key-alert-pf_1');
  const status = () => screen.getByTestId('finding-key-status-pf_1');

  it('draws the value alone without write access', () => {
    renderWithIntl(<FindingKeyCell findingId="pf_1" site="s" bugKey="MOTIR-1" canWrite={false} />);
    expect(screen.getByTestId('finding-key-value-pf_1').textContent).toBe('MOTIR-1');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('refuses a malformed key in its own row without calling the action', () => {
    cell();
    fireEvent.change(input(), { target: { value: 'not a key' } });
    fireEvent.click(screen.getByRole('button', { name: pf.recordPage.findingKey.link }));
    expect(actions.linkKey).not.toHaveBeenCalled();
    expect(alert().textContent).toContain(pf.bug.invalid);
    expect(input().value).toBe('not a key');
    expect(input().getAttribute('aria-invalid')).toBe('true');
    // No Remove without a stored key.
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
  });

  it('links a normalized key on Enter and says so quietly', async () => {
    actions.linkKey.mockResolvedValue({ ok: true, finding: { id: 'pf_1', bugKey: 'MOTIR-7' } });
    cell();
    fireEvent.change(input(), { target: { value: ' motir-7 ' } });
    await act(async () => {
      fireEvent.keyDown(input(), { key: 'Enter' });
    });
    expect(actions.linkKey).toHaveBeenCalledWith('pf_1', 'MOTIR-7');
    expect(status().textContent).toContain('Linked MOTIR-7.');
    expect(alert().textContent).toBe('');
  });

  it('says nothing changed when the stored key is linked again', async () => {
    actions.linkKey.mockResolvedValue({ ok: true, finding: { id: 'pf_1', bugKey: 'MOTIR-7' } });
    cell('MOTIR-7');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: pf.recordPage.findingKey.link }));
    });
    expect(status().textContent).toContain('Already linked to MOTIR-7. Nothing changed.');
  });

  it('draws a key outside the project as a refusal, keeping the typed key', async () => {
    actions.linkKey.mockResolvedValue({ ok: false, code: 'REFUSED', reason: 'not_a_work_item' });
    cell();
    fireEvent.change(input(), { target: { value: 'ACME-4' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: pf.recordPage.findingKey.link }));
    });
    expect(alert().textContent).toContain('ACME-4 is not a work item');
    expect(input().value).toBe('ACME-4');
    expect(status().textContent).toBe('');
  });

  it('draws a server INVALID as the shape refusal', async () => {
    actions.linkKey.mockResolvedValue({ ok: false, code: 'INVALID' });
    cell();
    fireEvent.change(input(), { target: { value: 'MOTIR-8' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: pf.recordPage.findingKey.link }));
    });
    expect(alert().textContent).toContain(pf.bug.invalid);
  });

  it('removes the key, and offers Retry after a failure', async () => {
    actions.removeKey
      .mockResolvedValueOnce({ ok: false, code: 'FAILED' })
      .mockResolvedValueOnce({ ok: true, finding: { id: 'pf_1', bugKey: null } });
    cell('MOTIR-7');
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Remove the planning bug key from lay.story.children' }),
      );
    });
    expect(actions.removeKey).toHaveBeenCalledWith('pf_1', 'MOTIR-7');
    expect(alert().textContent).toContain(pf.refused.failed);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: pf.triage.retry }));
    });
    expect(actions.removeKey).toHaveBeenCalledTimes(2);
    expect(status().textContent).toContain(pf.recordPage.findingKey.removed);
    expect(input().value).toBe('');
  });

  it('re-seeds the input from a fresh read', () => {
    const { rerender } = cell('MOTIR-1');
    expect(input().value).toBe('MOTIR-1');
    rerender(<FindingKeyCell findingId="pf_1" site="s" bugKey="MOTIR-2" canWrite />);
    expect(input().value).toBe('MOTIR-2');
  });
});

describe('the record command', () => {
  it('copies the command line', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderWithIntl(<RecordCommand recordId="rec_9" />);
    expect(screen.getByTestId('record-command').textContent).toContain(
      'motir check planner finding rec_9',
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: pf.record.command.copyLabel }));
    });
    expect(writeText).toHaveBeenCalledWith('motir check planner finding rec_9');
  });
});
