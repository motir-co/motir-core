// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFormatter, createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import { MotirAiUnavailableError, PlannerFindingNotFoundError } from '@/lib/ai/errors';
import type { PlannerFindingDetailDTO } from '@/lib/dto/plannerFindings';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { renderToHtml } from '../helpers/serverPageHarness';

/**
 * One planner finding's page (Story MOTIR-10353 · MOTIR-10524, design
 * MOTIR-10362 Panels 9 and 11). The read service is stubbed at its module, the
 * gate at the page gate, `notFound` throws a sentinel, and next-intl serves the
 * real `en` catalogue.
 */

class NotFoundSentinel extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}

const gate = vi.hoisted(() => ({ principal: null as PlatformPrincipal | null }));
const get = vi.hoisted(() => vi.fn());

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
  return { ...actual, plannerFindingsService: { get } };
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

const { default: DetailPage } = await import('@/app/(admin)/admin/planner-findings/[id]/page');
const { formatCostMicroUsd } =
  await import('@/app/(admin)/admin/planner-findings/_components/costFormat');
const { PLANNER_FINDING_NO_PLAN_ID } = await import('@/lib/services/plannerFindingsService');

const pf = en.platformAdmin.plannerFindings;
const SUPPORT: PlatformPrincipal = { userId: 'u_sp', email: 'sp@moooon.net', role: 'support' };

function detail(over: Partial<PlannerFindingDetailDTO> = {}): PlannerFindingDetailDTO {
  return {
    id: 'pf_1',
    source: 'in_loop',
    planner: 'hosted',
    attribution: 'corpus',
    outcome: 'fixed',
    prediction: 'STOPS',
    site: 'leaf:MOTIR-12',
    planId: 'plan_nowhere_7',
    planTitle: 'A plan only motir-ai remembers',
    status: 'new',
    fingerprint: 'fp_1',
    lessonId: null,
    bugKey: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    whatHappened: 'The leaf named a file that does not exist.',
    evidence: 'read_file lib/x.ts → not found',
    correction: 'Name the real file.',
    rule: 'context-refs-exist',
    why: 'The pack never says to read the path.',
    hostedCell: 'leaf.code',
    planpyCell: 'leaf/code',
    fixDirection: 'Add the read rule to the pack.',
    cardRef: 'MOTIR-12',
    coreProjectId: 'pj_1',
    authorModel: 'model-a',
    baselineBranch: 'main',
    baselineCommit: 'abcdef1234567890',
    triageNote: null,
    triagedBy: null,
    triagedAt: null,
    cost: {
      findingsMade: 4,
      findingsFixed: 3,
      lines: [
        {
          stage: 'review',
          model: 'model-a',
          inputTokens: 12000,
          outputTokens: 800,
          sessions: 1,
          costMicroUsd: 1_250_000,
        },
        {
          stage: 'repair',
          model: 'model-a',
          inputTokens: 3000,
          outputTokens: 400,
          sessions: 2,
          costMicroUsd: 500_000,
        },
      ],
    },
    ...over,
  };
}

function decode(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function open(
  over: Partial<PlannerFindingDetailDTO> = {},
  triagedByName: string | null = null,
): Promise<string> {
  get.mockResolvedValue({ detail: detail(over), triagedByName });
  return decode(await renderToHtml(await DetailPage({ params: Promise.resolve({ id: 'pf_1' }) })));
}

beforeEach(() => {
  vi.clearAllMocks();
  gate.principal = SUPPORT;
});

describe('gate, 404 and shell', () => {
  it('answers a non-staff request with the 404 before reading anything', async () => {
    gate.principal = null;
    await expect(DetailPage({ params: Promise.resolve({ id: 'pf_1' }) })).rejects.toBeInstanceOf(
      NotFoundSentinel,
    );
    expect(get).not.toHaveBeenCalled();
  });

  it('an unknown id is the app 404', async () => {
    get.mockRejectedValue(new PlannerFindingNotFoundError('pf_x'));
    await expect(DetailPage({ params: Promise.resolve({ id: 'pf_x' }) })).rejects.toBeInstanceOf(
      NotFoundSentinel,
    );
    expect(get).toHaveBeenCalledWith(SUPPORT, 'pf_x');
  });

  it('is force-dynamic, reads in the body, and imports no action or loading frame', () => {
    const source = readFileSync('app/(admin)/admin/planner-findings/[id]/page.tsx', 'utf8');
    expect(source).toContain("export const dynamic = 'force-dynamic'");
    expect(source).not.toMatch(/import \{ Suspense|\/actions'|<button|<form/);
  });

  it('opens with the back link and the labelled detail region', async () => {
    const html = await open();
    expect(html).toContain(`href="/admin/planner-findings"`);
    expect(html).toContain(pf.detail.back);
    expect(html).toContain('data-testid="planner-finding-detail"');
    expect(html).toContain(`aria-label="${pf.a11y.detailRegion}"`);
  });
});

describe('fields', () => {
  it('shows every narrative block and provenance row of a full finding', async () => {
    const html = await open();
    expect(html).toContain('>leaf:MOTIR-12</h1>');
    for (const heading of [pf.detail.what, pf.detail.evidence, pf.detail.correction]) {
      expect(html).toContain(heading);
    }
    expect(html).toContain(pf.detail.fixDirection);
    expect(html).toContain(pf.detail.why);
    expect(html).toContain('The leaf named a file that does not exist.');
    expect(html).toContain('read_file lib/x.ts → not found');
    expect(html).toContain('Name the real file.');
    expect(html).toContain('Add the read rule to the pack.');
    expect(html).toContain('The pack never says to read the path.');
    expect(html).toContain('data-testid="planner-finding-provenance"');
    expect(html).toContain(pf.prediction.STOPS);
    expect(html).toContain(pf.source.in_loop);
    expect(html).toContain(pf.planner.hosted);
    expect(html).toContain(pf.outcome.fixed);
    expect(html).toContain(pf.attribution.corpus);
    expect(html).toContain('MOTIR-12');
    expect(html).toContain('model-a');
    expect(html).toContain('main @ abcdef123456');
    expect(html).not.toContain('abcdef1234567890');
    expect(html).toContain('Nov 1, 2026');
    // The rule is part of the fingerprint and is not shown.
    expect(html).not.toContain('context-refs-exist');
  });

  it('shows None recorded for blank text and leaves out empty provenance rows', async () => {
    const html = await open({
      correction: null,
      fixDirection: '  ',
      why: null,
      cardRef: null,
      authorModel: null,
      baselineBranch: null,
      baselineCommit: null,
    });
    expect(html.split(pf.detail.none).length - 1).toBe(3);
    expect(html).not.toContain(`>${pf.detail.workItem}<`);
    expect(html).not.toContain(`>${pf.detail.authorModel}<`);
    expect(html).not.toContain(`>${pf.detail.baseline}<`);
  });

  it('shows wire values the catalogue does not know as they came', async () => {
    const html = await open({ source: 'future_source', prediction: 'MAYBE', status: 'parked' });
    expect(html).toContain('future_source');
    expect(html).toContain('MAYBE');
    expect(html).toContain('parked');
  });
});

describe('affected planner cells', () => {
  it.each([
    ['hosted only', { planpyCell: null }, ['leaf.code'], ['leaf/code']],
    ['plan.py only', { hostedCell: ' ' }, ['leaf/code'], ['leaf.code']],
    ['both', {}, ['leaf.code', 'leaf/code'], []],
  ] as const)('%s', async (_name, over, shown, hidden) => {
    const html = await open(over);
    for (const cell of shown) expect(html).toContain(cell);
    for (const cell of hidden) expect(html).not.toContain(cell);
    expect(html).not.toContain(pf.detail.noCells);
  });

  it('neither shows the no-cells line', async () => {
    const html = await open({ hostedCell: null, planpyCell: null });
    expect(html).toContain(pf.detail.noCells);
    expect(html).not.toContain(`>${pf.detail.cellHosted}</dt>`);
  });
});

describe('the plan', () => {
  it('a plan that exists nowhere in motir-core opens with its stored title and id', async () => {
    const html = await open();
    expect(html).toContain('A plan only motir-ai remembers');
    expect(html).toContain('plan_nowhere_7');
    expect(html).not.toContain('href="/plans');
  });

  it('a title-less plan and a plan-less finding show their fallbacks, never the sentinel', async () => {
    expect(await open({ planTitle: null })).toContain(pf.row.untitledPlan);
    const planless = await open({ planId: PLANNER_FINDING_NO_PLAN_ID, planTitle: null });
    expect(planless).toContain(pf.row.noPlan);
    expect(planless).not.toContain(PLANNER_FINDING_NO_PLAN_ID);
    expect(await open({ planId: '' })).toContain(pf.row.noPlan);
  });
});

describe('cost', () => {
  it('a priced strip: made, fixed, and one line each for review and repair', async () => {
    const html = await open();
    expect(html).toContain('data-testid="planner-finding-cost"');
    expect(html.split('data-testid="planner-finding-cost-line"').length - 1).toBe(2);
    expect(html).toContain(pf.cost.made);
    expect(html).toContain(pf.cost.fixed);
    expect(html).toContain('>Review<');
    expect(html).toContain('>Repair<');
    expect(html).toContain('$1.25');
    expect(html).toContain('$0.50');
    expect(html).toContain('12,000 tokens in · 800 tokens out');
    expect(html).toContain('2 sessions');
    expect(html).not.toContain('$1.75');
  });

  it('an unpriced line says so and shows no amount', async () => {
    const html = await open({
      cost: {
        findingsMade: null,
        findingsFixed: 1,
        lines: [
          {
            stage: 'review',
            model: null,
            inputTokens: 10,
            outputTokens: 2,
            sessions: 1,
            costMicroUsd: null,
          },
        ],
      },
    });
    expect(html).toContain(pf.cost.unpriced);
    expect(html).not.toContain('$');
    expect(html).not.toContain(pf.cost.made);
    expect(html).toContain(pf.cost.fixed);
  });

  it('a null cost is Not metered, with the body only for a check plan finding, never a zero', async () => {
    const check = await open({ source: 'check_plan', cost: null });
    expect(check).toContain('data-testid="planner-finding-not-metered"');
    expect(check).toContain(pf.cost.notMeteredBody);
    expect(check).not.toContain('planner-finding-cost"');
    expect(check).not.toContain('$');

    const inLoop = await open({ cost: null });
    expect(inLoop).toContain(pf.cost.notMetered);
    expect(inLoop).not.toContain(pf.cost.notMeteredBody);
    expect(inLoop).not.toContain('$');
    expect(inLoop).not.toContain(`>0<`);
  });

  it('a cost with no counts and no lines draws an empty strip, never a zero', async () => {
    const html = await open({ cost: { findingsMade: null, findingsFixed: null, lines: [] } });
    expect(html).toContain('data-testid="planner-finding-cost"');
    expect(html).not.toContain('planner-finding-cost-line');
    expect(html).not.toContain(pf.cost.made);
    expect(html).not.toContain('$');
  });

  it('formats micro-dollars as US dollars and never converts null', () => {
    const format = createFormatter({ locale: 'en', timeZone: 'UTC' });
    expect(formatCostMicroUsd(null, format)).toBeNull();
    expect(formatCostMicroUsd(2_500_000, format)).toBe('$2.50');
    expect(formatCostMicroUsd(1_234, format)).toBe('$0.0012');
  });
});

describe('unavailable, never partial', () => {
  it('a motir-ai error is the back link and the unavailable card, no field', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    get.mockRejectedValue(new MotirAiUnavailableError('down'));
    const html = decode(
      await renderToHtml(await DetailPage({ params: Promise.resolve({ id: 'pf_1' }) })),
    );
    expect(html).toContain('data-testid="planner-findings-unavailable"');
    expect(html).toContain(pf.detail.back);
    expect(html).not.toContain('planner-finding-detail');
    expect(html).not.toContain(pf.detail.what);
    expect(html).not.toContain('planner-finding-cost');
    expect(error).toHaveBeenCalledWith(
      '[admin] planner finding could not be read',
      { id: 'pf_1' },
      expect.any(MotirAiUnavailableError),
    );
  });

  it('any other error is rethrown', async () => {
    get.mockRejectedValue(new NotPlatformStaffError());
    await expect(DetailPage({ params: Promise.resolve({ id: 'pf_1' }) })).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
  });
});

describe('triage state, read-only', () => {
  it('a new finding: the New badge and no last-triaged line', async () => {
    const html = await open();
    expect(html).toContain(pf.status.new);
    expect(html).not.toContain('Last triaged by');
    expect(html).not.toContain('planner-finding-lesson-link');
  });

  it('a promoted finding links its lesson', async () => {
    const html = await open(
      { status: 'promoted_to_lesson', lessonId: 'lsn_9', triagedAt: '2026-11-02T09:30:00.000Z' },
      'Ada Admin',
    );
    expect(html).toContain(pf.status.promoted_to_lesson);
    expect(html).toContain('data-testid="planner-finding-lesson-link"');
    expect(html).toContain('href="/admin/planning-lessons/lsn_9"');
    expect(html).toContain('Last triaged by Ada Admin · Nov 2, 2026');
  });

  it('a filed bug shows its key; a dismissed finding shows its note; an unknown triager is a dash', async () => {
    expect(await open({ status: 'filed_as_bug', bugKey: 'MOTIR-42' })).toContain('Bug MOTIR-42');
    const dismissed = await open(
      {
        status: 'dismissed',
        triageNote: 'Duplicate of an older finding.',
        triagedAt: '2026-11-03T00:00:00.000Z',
      },
      null,
    );
    expect(dismissed).toContain(pf.status.dismissed);
    expect(dismissed).toContain('“Duplicate of an older finding.”');
    expect(dismissed).toContain('Last triaged by — ·');
  });
});
