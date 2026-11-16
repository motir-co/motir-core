// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderToHtml } from '../../helpers/serverPageHarness';
import { renderWithIntl as render } from '../../helpers/renderWithIntl';
import type { ProviderReconciliationDTO } from '@/lib/dto/platform';
import en from '@/messages/en.json';
import { PROVIDER_RECONCILIATION } from '../../fixtures/motirAiContract/platformReads';

// USAGE & COST · PROVIDER BILLS (MOTIR-11376; design MOTIR-11375, `platform-admin/
// design-notes.md` § AMENDMENT 2026-11-15 — Usage & cost · Provider bills). The
// section renders to HTML over the real `en` catalogue, one case per state the
// delta mock draws; the per-model disclosure is driven in happy-dom.

vi.mock('next-intl/server', async () => {
  const { createTranslator, createFormatter } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
    getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
    getLocale: async () => 'en',
  };
});
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }), usePathname: () => '/' }));

const { ProviderReconciliationSection } =
  await import('@/app/(admin)/admin/usage/_components/ProviderReconciliationSection');
const { ReconciliationDayRow } =
  await import('@/app/(admin)/admin/usage/_components/ReconciliationDayRow');
const { ReconciliationUnavailable } =
  await import('@/app/(admin)/admin/usage/_components/ReconciliationUnavailable');

const r = en.platformAdmin.usage.reconciliation;

afterEach(() => {
  cleanup();
  refresh.mockClear();
});

async function section(
  reconciliation: Parameters<typeof ProviderReconciliationSection>[0]['reconciliation'],
  period = '2026-09',
) {
  const div = document.createElement('div');
  div.innerHTML = await renderToHtml(
    await ProviderReconciliationSection({ reconciliation, period }),
  );
  return div;
}

const q = (root: Element, sel: string) => root.querySelector(sel);
const qa = (root: Element, sel: string) => [...root.querySelectorAll(sel)];
const dayRow = (root: Element, provider: string, day: string) =>
  q(root, `[data-testid="provider-days-${provider}"] tr[data-day="${day}"]`)!;

describe('the populated month', () => {
  it('draws each provider’s days with recorded, billed, gap, source tag and status mark', async () => {
    const dom = await section(PROVIDER_RECONCILIATION);
    expect(q(dom, 'h2#usage-provider-bills')!.textContent).toBe(r.title);
    const cells = qa(dayRow(dom, 'anthropic', '2026-09-01'), 'td').map((td) => td.textContent);
    expect(cells[0]).toBe('Tue, Sep 1');
    expect(cells[1]).toBe('$2.00');
    expect(cells[2]).toBe('$3.00');
    expect(cells[3]).toContain('+$1.00');
    expect(cells[4]).toBe(r.source.api);
    expect(cells[5]).toBe(r.status.reconciled);
    expect(qa(dom, '[data-testid="source-tag"]').map((e) => e.getAttribute('data-source'))).toEqual(
      expect.arrayContaining(['api', 'balance_snapshot', 'export', 'none']),
    );
    expect(dayRow(dom, 'deepseek', '2026-09-01').textContent).toContain(r.source.balance_snapshot);
    expect(dayRow(dom, 'igate-export', '2026-09-01').textContent).toContain(r.source.export);
  });

  it('marks a past-tolerance day on its row and counts it on the provider summary', async () => {
    const dom = await section(PROVIDER_RECONCILIATION);
    const past = dayRow(dom, 'anthropic', '2026-09-01');
    expect(past.getAttribute('data-past-tolerance')).toBe('true');
    expect(q(past, '[data-testid="past-tolerance"]')!.textContent).toBe(r.pastTolerance);
    expect(dayRow(dom, 'deepseek', '2026-09-01').getAttribute('data-past-tolerance')).toBeNull();
    const card = q(dom, '[data-provider="anthropic"]')!;
    expect(q(card, '[data-testid="days-past-tolerance"]')!.textContent).toBe(
      '1 day past tolerance',
    );
    expect(q(card, '[data-testid="provider-summary"]')!.textContent).toContain(
      'Past tolerance when the gap is over 5% of the bill and over $0.50',
    );
    // A provider that needs eyes opens by default; a quiet one stays closed.
    expect(q(card, 'details')!.hasAttribute('open')).toBe(true);
    expect(q(q(dom, '[data-provider="igate-export"]')!, 'details')!.hasAttribute('open')).toBe(
      false,
    );
  });

  it('draws reconciled, failed and unreconciled days as three distinct marks; a missing bill is an em dash', async () => {
    const dom = await section(PROVIDER_RECONCILIATION);
    const mark = (p: string, d: string) => q(dayRow(dom, p, d), '[data-testid="status-mark"]')!;
    expect(mark('anthropic', '2026-09-01').getAttribute('data-status')).toBe('reconciled');
    const noRecord = mark('anthropic', '2026-09-02');
    expect(noRecord.getAttribute('data-status')).toBe('failed');
    expect(noRecord.textContent).toBe(r.status.notRecorded);
    const failedRead = mark('deepseek', '2026-09-02');
    expect(failedRead.textContent).toContain(r.status.failed);
    expect(failedRead.textContent).toContain('Tried Sep 3, 03:00 UTC');
    const unreconciled = mark('moonshotai', '2026-09-01');
    expect(unreconciled.getAttribute('data-status')).toBe('unreconciled');
    expect(unreconciled.textContent).toBe(r.status.unreconciled);
    const billed = qa(dayRow(dom, 'moonshotai', '2026-09-01'), 'td')[2]!;
    expect(billed.textContent).toBe('—');
    expect(billed.querySelector('[aria-label]')!.getAttribute('aria-label')).toBe(r.none);
    expect(q(dom, '[data-provider="moonshotai"]:not(li)')!.textContent).toContain(
      r.summary.noneRead,
    );
  });

  it('shows the estimated-row count beside a gap and the per-model expander only where a breakdown exists', async () => {
    const dom = await section(PROVIDER_RECONCILIATION);
    expect(
      q(dayRow(dom, 'anthropic', '2026-09-01'), '[data-testid="estimated-rows"]')!.textContent,
    ).toBe('3 rows estimated');
    expect(q(dayRow(dom, 'deepseek', '2026-09-01'), '[data-testid="estimated-rows"]')).toBeNull();
    expect(
      q(dayRow(dom, 'anthropic', '2026-09-01'), 'button[aria-expanded="false"]'),
    ).not.toBeNull();
    expect(q(dayRow(dom, 'deepseek', '2026-09-01'), 'button')).toBeNull();
  });

  it('lists the findings with both figures, models, estimated rows and the differing side', async () => {
    const dom = await section(PROVIDER_RECONCILIATION);
    const table = q(dom, '[data-testid="usage-reconciliation-findings"]')!;
    const anthropic = q(table, '[data-finding="anthropic:2026-09-01"]')!;
    const cells = qa(anthropic, 'td').map((td) => td.textContent);
    expect(cells).toEqual([
      'Tue, Sep 1',
      'Anthropic',
      '$2.00',
      '$3.00',
      '+$1.00',
      'claude-a +$1.00',
      '3',
      r.side['motir-ai'],
    ]);
    const openai = q(table, '[data-finding="openai:2026-09-01"]')!;
    expect(openai.textContent).toContain(r.findings.noModels);
    expect(q(openai, '[data-testid="differing-side"]')!.textContent).toBe(r.side.unnamed);
  });

  it('lists every unreconciled provider, never filtering one out', async () => {
    const recon: ProviderReconciliationDTO = {
      ...PROVIDER_RECONCILIATION,
      unreconciledProviders: ['moonshotai', 'z-ai', 'brand-new-provider'],
    };
    const dom = await section(recon);
    const list = q(dom, '[data-testid="usage-unreconciled-providers"]')!;
    expect(qa(list, 'li').map((li) => li.getAttribute('data-provider'))).toEqual([
      'moonshotai',
      'z-ai',
      'brand-new-provider',
    ]);
    expect(list.textContent).toContain('Moonshot AI(moonshotai)');
    expect(list.textContent).toContain('brand-new-provider');
  });

  it('says so when no day is past tolerance, and draws no unreconciled list when there is none', async () => {
    const dom = await section({
      ...PROVIDER_RECONCILIATION,
      findings: [],
      unreconciledProviders: [],
    });
    expect(q(dom, '[data-testid="findings-none"]')!.textContent).toBe(
      'No gaps past tolerance in September 2026.',
    );
    expect(q(dom, '[data-testid="usage-unreconciled-providers"]')).toBeNull();
  });

  it('sums a provider’s period over the days read, and names what was recorded on them', async () => {
    const dom = await section(PROVIDER_RECONCILIATION);
    const summary = q(q(dom, '[data-provider="deepseek"]')!, '[data-testid="provider-summary"]')!;
    expect(summary.textContent).toContain('$1.70'); // recorded, both days
    expect(summary.textContent).toContain('$0.90 on the days read');
    expect(summary.textContent).toContain('$0.91'); // billed, the one day read
    expect(summary.textContent).toContain('over 1 of 2 days read');
    expect(summary.textContent).toContain('+$0.01');
    const noTolerance = q(dom, '[data-provider="igate-export"]')!;
    expect(noTolerance.textContent).toContain(r.summary.noTolerance);
    expect(noTolerance.textContent).toContain('$0.00');
  });

  it('offers no control that writes: the only buttons are the per-model disclosures', async () => {
    const dom = await section(PROVIDER_RECONCILIATION);
    expect(qa(dom, 'form, input, select, textarea, a')).toEqual([]);
    for (const b of qa(dom, 'button')) expect(b.getAttribute('aria-expanded')).not.toBeNull();
  });
});

describe('the states', () => {
  it('All time asks for a month instead of a grid', async () => {
    const dom = await section('month_required', 'all');
    expect(q(dom, '[data-testid="usage-reconciliation-pick-month"]')!.textContent).toBe(r.allTime);
    expect(q(dom, 'table')).toBeNull();
  });

  it('motir-ai not answering shows the section’s own error state', async () => {
    const dom = await section(null);
    expect(dom.textContent).toContain(r.error.title);
    expect(dom.textContent).toContain(r.error.description);
    expect(q(dom, 'table')).toBeNull();
  });

  it('a month the job has not recorded yet is the empty state, not a grid of failed reads', async () => {
    const unrecorded = {
      day: '2026-11-01',
      recordedMicroUsd: null,
      billedMicroUsd: null,
      source: 'none' as const,
      status: 'failed' as const,
      readAt: null,
      gapMicroUsd: null,
      pastTolerance: false,
      perModel: [],
      estimatedRowCount: null,
    };
    const dom = await section(
      {
        period: '2026-11',
        providers: [
          {
            provider: 'openai',
            relativeTolerance: 0.05,
            absoluteToleranceMicroUsd: 1,
            days: [unrecorded],
          },
          { provider: 'qwen', relativeTolerance: 0.05, absoluteToleranceMicroUsd: 1, days: [] },
        ],
        findings: [],
        unreconciledProviders: [],
      },
      '2026-11',
    );
    expect(q(dom, '[data-testid="usage-reconciliation-empty"]')!.textContent).toContain(
      'Nothing recorded for November 2026 yet',
    );
    expect(q(dom, 'table')).toBeNull();
  });
});

describe('the client parts', () => {
  it('a day’s disclosure opens and closes its per-model breakdown', () => {
    render(
      <table>
        <tbody>
          <ReconciliationDayRow
            day="2026-09-01"
            dayLabel="Tue, Sep 1"
            expandLabel="Show the bill for Tue, Sep 1 by model"
            pastTolerance
            cellClassName=""
            cells={<td>cells</td>}
            breakdown={<span>claude-a breakdown</span>}
          />
        </tbody>
      </table>,
    );
    const button = screen.getByRole('button', { name: 'Show the bill for Tue, Sep 1 by model' });
    expect(screen.queryByTestId('per-model')).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('per-model').textContent).toBe('claude-a breakdown');
    fireEvent.click(button);
    expect(screen.queryByTestId('per-model')).toBeNull();
  });

  it('the error state’s Try again re-reads the page', () => {
    render(<ReconciliationUnavailable title="t" description="d" />);
    fireEvent.click(screen.getByRole('button'));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
