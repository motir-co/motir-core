// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { RawPlatformUsage } from '@/lib/ai/motirAiClient';
import { CategoryModelSheet } from '@/app/(admin)/admin/tenants/[orgId]/_components/CategoryModelSheet';

/**
 * The org Usage tab's BY CATEGORY AND MODEL sheet (Story MOTIR-727 · MOTIR-7288),
 * over a recorded `GET /v1/platform/usage` response: the token categories expand
 * to their models and the model rows sum to the category; below the org, the
 * org-level categories say so instead of showing a zero.
 */

const zero = {
  usageQuantity: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheMissTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  credits: 0,
  costMicroUsd: 0,
};
const model = (name: string, credits: number, costMicroUsd: number) => ({
  model: name,
  inputTokens: 1000,
  outputTokens: 100,
  cacheMissTokens: 1000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  credits,
  costMicroUsd,
  orgs: null,
});

/** Recorded from the motir-ai categories gate's fixture shape (MOTIR-7286). */
const RECORDED: RawPlatformUsage = {
  period: '2026-09',
  level: 'organization',
  entityId: 'org_abc',
  categories: [
    {
      ...zero,
      category: 'planning_tokens',
      inputTokens: 3000,
      outputTokens: 300,
      credits: 90,
      costMicroUsd: 39_150,
    },
    {
      ...zero,
      category: 'agent_tokens',
      inputTokens: 1000,
      outputTokens: 100,
      credits: 12,
      costMicroUsd: 5_220,
    },
    { ...zero, category: 'agent_machine', usageQuantity: 600, credits: 4, costMicroUsd: 19_000 },
    { ...zero, category: 'agent_instance', usageQuantity: 3600, credits: 6, costMicroUsd: 22_000 },
    {
      ...zero,
      category: 'agent_storage',
      usageQuantity: 864_000,
      credits: 10,
      costMicroUsd: 76_667,
    },
    { ...zero, category: 'ci', usageQuantity: 120, credits: 1, costMicroUsd: 3_800 },
    { ...zero, category: 'search', usageQuantity: 3, credits: 3, costMicroUsd: 15_000 },
    { ...zero, category: 'indexing', usageQuantity: 1800, costMicroUsd: 57_000 },
  ],
  models: {
    planning_tokens: [
      model('claude-opus-5-5', 60, 26_100),
      model('claude-sonnet-5-5', 25, 10_875),
      model('claude-haiku-4-5', 5, 2_175),
    ],
    agent_tokens: [model('claude-opus-5-5', 12, 5_220)],
  },
  spend: {
    chargedCredits: 136,
    chargedCostMicroUsd: 180_837,
    costMicroUsdInclIndexing: 237_837,
    machineSeconds: 6120,
  },
  orgsWithSpend: null,
};

function renderSheet(belowOrg: 'workspace' | 'project' | null = null) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <CategoryModelSheet
        categories={RECORDED.categories}
        models={RECORDED.models}
        belowOrg={belowOrg}
      />
    </NextIntlClientProvider>,
  );
}

afterEach(() => cleanup());

describe('CategoryModelSheet', () => {
  it('expands each token category to its models, and the model rows sum to the category', () => {
    const { container } = renderSheet();
    expect(container.querySelectorAll('[data-model-of]')).toHaveLength(0);

    for (const category of ['planning_tokens', 'agent_tokens'] as const) {
      const row = container.querySelector(`tr[data-category="${category}"]`)!;
      fireEvent.click(within(row as HTMLElement).getByRole('button'));
      const modelRows = [...container.querySelectorAll(`[data-model-of="${category}"]`)];
      expect(modelRows).toHaveLength(RECORDED.models[category].length);

      const cat = RECORDED.categories.find((c) => c.category === category)!;
      const credits = modelRows.map((r) => Number(r.children[2]!.textContent!.replace(/,/g, '')));
      expect(credits.reduce((a, b) => a + b, 0)).toBe(cat.credits);
      expect(RECORDED.models[category].reduce((a, m) => a + m.costMicroUsd, 0)).toBe(
        cat.costMicroUsd,
      );
    }
    fireEvent.click(screen.getAllByRole('button', { expanded: true })[0]!);
    expect(container.querySelectorAll('[data-model-of="planning_tokens"]')).toHaveLength(0);
  });

  it('indexing reads "not charged" and stays out of the charged total', () => {
    const { container } = renderSheet();
    expect(
      within(container.querySelector('tr[data-category="indexing"]') as HTMLElement).getByText(
        'not charged',
      ),
    ).toBeTruthy();
    const charged = screen.getByText('Charged total').closest('tr')!;
    expect(charged.children[2]!.textContent).toBe('126');
  });

  it('below the org, instances, storage, search and production hosting say they are org-level — never a zero', () => {
    const { container } = renderSheet('project');
    const lines = [...container.querySelectorAll('[data-testid="org-level-line"]')];
    expect(lines.map((l) => l.closest('tr')!.getAttribute('data-category'))).toEqual([
      'agent_instance',
      'agent_storage',
      'search',
      'hosting_production',
    ]);
    for (const l of lines) expect(l.textContent).toBe('Org-level — not split by project');
    expect(
      renderSheet(null).container.querySelectorAll('[data-testid="org-level-line"]'),
    ).toHaveLength(0);
  });
});
