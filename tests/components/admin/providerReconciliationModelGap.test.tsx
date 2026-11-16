// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToHtml } from '../../helpers/serverPageHarness';
import type { ProviderReconciliationDTO } from '@/lib/dto/platform';
import { PROVIDER_RECONCILIATION } from '../../fixtures/motirAiContract/platformReads';

// USAGE & COST · PROVIDER BILLS — the per-model gap (MOTIR-11376, story MOTIR-11350
// review). motir-core computes no gap: each breakdown row shows the `gapMicroUsd`
// motir-ai stored, carried through the DTO. The day row's disclosure is opened here so
// the server render includes its breakdown.

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
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/',
}));
vi.mock('@/app/(admin)/admin/usage/_components/ReconciliationDayRow', () => ({
  ReconciliationDayRow: ({ cells, breakdown }: { cells: ReactNode; breakdown: ReactNode }) => (
    <>
      <tr>{cells}</tr>
      {breakdown ? (
        <tr>
          <td data-testid="per-model">{breakdown}</td>
        </tr>
      ) : null}
    </>
  ),
}));

const { ProviderReconciliationSection } =
  await import('@/app/(admin)/admin/usage/_components/ProviderReconciliationSection');

describe('the per-model breakdown', () => {
  it('shows the gap motir-ai stored for each model, never billed minus recorded', async () => {
    const reconciliation: ProviderReconciliationDTO = structuredClone(PROVIDER_RECONCILIATION);
    const day = reconciliation.providers[0]!.days[0]!;
    // A stored gap that is NOT billed − recorded ($1.00 here): only a carried figure
    // renders it.
    day.perModel[0]!.gapMicroUsd = 1_230_000;
    const div = document.createElement('div');
    div.innerHTML = await renderToHtml(
      await ProviderReconciliationSection({ reconciliation, period: '2026-09' }),
    );
    const rows = [...div.querySelectorAll('[data-testid="per-model"] tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent),
    );
    expect(rows).toEqual([
      ['claude-a', '$1.50', '$2.50', '+$1.23'],
      ['claude-b', '$0.50', '$0.50', '$0.00'],
    ]);
  });
});
