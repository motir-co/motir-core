// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToHtml } from '../../helpers/serverPageHarness';
import type { FailedUsageGroupDTO } from '@/lib/dto/failedUsage';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import en from '@/messages/en.json';

// USAGE & COST · FAILED USAGE (MOTIR-11794; design MOTIR-11793, `platform-admin/
// design-notes.md` § AMENDMENT 2026-11-19 — Usage & cost · Failed usage). The
// section renders to HTML over the real `en` catalogue, one case per state the
// delta mock draws: groups for an operator, read-only for support, nothing
// failed, the read failed, and loading. The service is stubbed; its audit and
// gate have their own real-Postgres suite.

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
vi.mock('@/app/(admin)/admin/usage/actions', () => ({ replayFailedUsageAction: vi.fn() }));
const listGroups = vi.hoisted(() => vi.fn<(p: unknown) => Promise<FailedUsageGroupDTO[] | null>>());
vi.mock('@/lib/services/platformFailedUsageService', () => ({
  platformFailedUsageService: { listGroups },
}));

const { FailedUsageSection, FailedUsageLoading } =
  await import('@/app/(admin)/admin/usage/_components/FailedUsageSection');

const f = en.platformAdmin.usage.failed;
const operator: PlatformPrincipal = { userId: 'u_op', email: 'op@motir.test', role: 'operator' };
const support: PlatformPrincipal = { userId: 'u_sup', email: 'sup@motir.test', role: 'support' };

const GROUPS: FailedUsageGroupDTO[] = [
  {
    error: 'Value out of range for the type integer.',
    rows: 7352,
    organizations: 41,
    oldestReceivedAt: '2026-11-12T03:18:00.000Z',
    newestReceivedAt: '2026-11-14T22:51:00.000Z',
  },
  {
    error: 'No rate for model kimi-k2.5.',
    rows: 21,
    organizations: 2,
    oldestReceivedAt: '2026-11-17T09:02:00.000Z',
    newestReceivedAt: '2026-11-18T16:40:00.000Z',
  },
];

afterEach(() => listGroups.mockReset());

async function dom(node: Promise<React.ReactNode> | React.ReactNode) {
  const div = document.createElement('div');
  div.innerHTML = await renderToHtml(await node);
  return div;
}

const q = (root: Element, sel: string) => root.querySelector(sel);

describe('FailedUsageSection', () => {
  it('lists the groups with the count line, and Replay for an operator', async () => {
    listGroups.mockResolvedValue(GROUPS);
    const root = await dom(FailedUsageSection({ principal: operator }));
    expect(listGroups).toHaveBeenCalledWith(operator);
    expect(q(root, 'h2#usage-failed')!.textContent).toBe(f.title);
    expect(q(root, '[data-testid="usage-failed-count"]')!.textContent).toBe(
      '7,373 rows in 2 groups',
    );
    expect(root.textContent).toContain(f.intro);
    expect(q(root, '[data-testid="usage-failed-groups"]')).not.toBeNull();
    expect(q(root, '[data-testid="usage-failed-read-only"]')).toBeNull();
    expect(root.querySelectorAll('[data-testid="failed-group-replay"]').length).toBeGreaterThan(0);
  });

  it('support reads without Replay, under the read-only note', async () => {
    listGroups.mockResolvedValue(GROUPS);
    const root = await dom(FailedUsageSection({ principal: support }));
    const note = q(root, '[data-testid="usage-failed-read-only"]')!;
    expect(note.getAttribute('role')).toBe('note');
    expect(note.textContent).toBe(f.readOnly);
    expect(root.querySelectorAll('[data-testid="failed-group-replay"]')).toHaveLength(0);
  });

  it('nothing failed: the empty line, no count, no table', async () => {
    listGroups.mockResolvedValue([]);
    const root = await dom(FailedUsageSection({ principal: operator }));
    expect(q(root, '[data-testid="usage-failed-empty"]')!.textContent).toBe(f.empty);
    expect(q(root, '[data-testid="usage-failed-count"]')).toBeNull();
    expect(q(root, '[data-testid="usage-failed-groups"]')).toBeNull();
  });

  it('the read failed: the section’s own error state with Try again', async () => {
    listGroups.mockResolvedValue(null);
    const root = await dom(FailedUsageSection({ principal: operator }));
    expect(root.textContent).toContain(f.error.title);
    expect(root.textContent).toContain(f.error.description);
    expect(q(root, '[data-testid="usage-failed-count"]')).toBeNull();
    expect(q(root, 'h2#usage-failed')).not.toBeNull();
  });
});

describe('FailedUsageLoading', () => {
  it('is the busy section with three bars and a status line', async () => {
    const root = await dom(FailedUsageLoading());
    const section = q(root, '[data-testid="usage-failed"]')!;
    expect(section.getAttribute('aria-busy')).toBe('true');
    expect(q(root, '[role="status"]')!.textContent).toBe(f.loading);
    const bars = q(root, '[data-testid="usage-failed-loading"]')!;
    expect(bars.getAttribute('aria-hidden')).toBe('true');
    expect(bars.querySelectorAll('.bg-\\(--el-muted\\)')).toHaveLength(3);
  });
});
