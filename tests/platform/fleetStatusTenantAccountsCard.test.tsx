// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToHtml } from '../helpers/serverPageHarness';
import en from '@/messages/en.json';
import type {
  TenantAccountDTO,
  TenantAccountsBlockDTO,
  TenantQuotaDTO,
} from '@/lib/dto/fleetStatusTenantAccounts';

// THE TENANT HOSTING ACCOUNTS CARD (MOTIR-12014; design MOTIR-12013 Panels 1–7).
// Rendered to HTML through Fizz over the REAL `en` catalogue: an account at
// target, one below target with no raise (flagged in its row AND its header),
// one whose raise is open, one not read, each not-ready state, the search box,
// the pager, a search that matches nothing, the empty block and the failed one.

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', async () => {
  const { createTranslator, createFormatter } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
    getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
  };
});

const { TenantAccountsCard, tenantPageHref } =
  await import('@/app/(admin)/admin/fleet-status/_components/TenantAccountsCard');
const { pageTenantAccounts, orderTenantAccounts } =
  await import('@/lib/services/fleetStatusTenantAccountsService');

const NOW = new Date('2026-11-22T14:00:00.000Z');
const hAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000).toISOString();
const t = en.platformAdmin.fleetStatus.tenants;
const mon = en.platformAdmin.monitoring.pools;

const text = (el: Element | null | undefined) =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

const fargate = (over: Partial<TenantQuotaDTO> = {}): TenantQuotaDTO =>
  ({
    name: 'fargate-on-demand-vcpu',
    serviceCode: 'fargate',
    quotaCode: 'L-3032A538',
    target: 64,
    status: 'ok',
    applied: 64,
    raise: null,
    belowTarget: false,
    ...over,
  }) as TenantQuotaDTO;
const lambda = (over: Partial<TenantQuotaDTO> = {}): TenantQuotaDTO =>
  ({
    name: 'lambda-concurrent-executions',
    serviceCode: 'lambda',
    quotaCode: 'L-B99A9384',
    target: 1000,
    status: 'ok',
    applied: 1000,
    raise: null,
    belowTarget: false,
    ...over,
  }) as TenantQuotaDTO;
const notRead = (q: TenantQuotaDTO, lastReadAt: string | null): TenantQuotaDTO => ({
  name: q.name,
  serviceCode: q.serviceCode,
  quotaCode: q.quotaCode,
  target: q.target,
  status: 'notRead',
  lastReadAt,
});

const account = (
  organizationName: string,
  over: Partial<TenantAccountDTO> = {},
): TenantAccountDTO => ({
  organizationName,
  accountName: `tenant-${organizationName.toLowerCase().replace(/\W/g, '')}`,
  awsAccountId: '482915370264',
  state: 'ready',
  refusedCount: 0,
  lastRefusedAt: null,
  quotas: [fargate(), lambda()],
  ...over,
});

const MOOOON = account('moooon', {
  accountName: 'tenant-cmqfb4d3h00002d0ictswxwi8',
  awsAccountId: '019602753597',
  quotas: [
    fargate({
      applied: 6,
      raise: { status: 'case_opened', desiredValue: 64, createdAt: hAgo(5) },
    }),
    lambda({ applied: 10, belowTarget: true }),
  ],
});
const INITECH = account('Initech', {
  awsAccountId: '160427395581',
  quotas: [notRead(fargate(), hAgo(3)), notRead(lambda(), null)],
});
const NORTHWIND = account('Northwind Data', {
  quotas: [
    fargate(),
    lambda({ applied: 10, raise: { status: 'pending', desiredValue: null, createdAt: null } }),
  ],
});
const ACME = account('Acme Robotics');
const GLOBEX = account('Globex Platform', { state: 'requested', awsAccountId: null, quotas: [] });
const FERNWOOD = account('Fernwood IO', { state: 'creating', quotas: [] });
const HALCYON = account('Halcyon Health', { state: 'bootstrapping', quotas: [] });
const UMBRELLA = account('Umbrella Labs', {
  state: 'refused',
  awsAccountId: null,
  refusedCount: 3,
  lastRefusedAt: hAgo(2),
  quotas: [],
});
const NEVER_REFUSED = account('Vandelay Imports', {
  state: 'refused',
  awsAccountId: null,
  refusedCount: 0,
  lastRefusedAt: null,
  quotas: [],
});

function block(accounts: TenantAccountDTO[]): Extract<TenantAccountsBlockDTO, { status: 'ok' }> {
  const ordered = orderTenantAccounts(accounts);
  return {
    status: 'ok',
    accounts: ordered,
    belowTargetCount: ordered
      .flatMap((a) => a.quotas)
      .filter((q) => q.status === 'ok' && q.belowTarget).length,
    notReadCount: ordered.filter((a) => a.quotas.some((q) => q.status === 'notRead')).length,
  };
}

async function card(
  b: TenantAccountsBlockDTO,
  input: { query?: string; page?: string } = {},
): Promise<HTMLElement> {
  const page = b.status === 'ok' ? pageTenantAccounts(b.accounts, input) : null;
  document.body.innerHTML = await renderToHtml(
    await TenantAccountsCard({ block: b, page, now: NOW }),
  );
  return document.body;
}
const item = (root: HTMLElement, organizationName: string) =>
  [...root.querySelectorAll<HTMLElement>('li[data-tenant-account]')].find(
    (li) => text(li.querySelector('h5')) === organizationName,
  )!;
const row = (li: HTMLElement, code: string) =>
  li.querySelector<HTMLElement>(`tr[data-quota="${code}"]`)!;

beforeAll(async () => {
  await card(block([ACME]));
}, 120_000);

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the tenant hosting accounts card', () => {
  it('lists each account with its organisation, AWS account id, account name and state (Panel 1)', async () => {
    const root = await card(block([ACME, MOOOON, INITECH, NORTHWIND, GLOBEX]));
    const section = root.querySelector('[data-pool="tenant-accounts"]')!;
    expect(section.getAttribute('data-state')).toBe('ok');
    expect(section.id).toBe('tenant-accounts');
    expect(text(section)).toContain(t.title);
    // What needs acting on first: below target, then not read, then the rest by name.
    expect([...root.querySelectorAll('li[data-tenant-account] h5')].map((h) => text(h))).toEqual([
      'moooon',
      'Initech',
      'Acme Robotics',
      'Globex Platform',
      'Northwind Data',
    ]);
    const m = item(root, 'moooon');
    expect(m.getAttribute('data-tenant-account')).toBe('tenant-cmqfb4d3h00002d0ictswxwi8');
    expect(m.querySelector('[aria-label="AWS account 019602753597"]')).not.toBeNull();
    expect(text(m.querySelector('[data-account-state]'))).toBe(t.state.ready);
    expect(text(item(root, 'Globex Platform'))).toContain(t.account.noAwsAccount);
  });

  it('shows applied, target and open raise, and flags below target with no raise in the row and the header', async () => {
    const root = await card(block([ACME, MOOOON, NORTHWIND]));
    const acme = item(root, 'Acme Robotics');
    expect(row(acme, 'L-3032A538').getAttribute('data-state')).toBe('at-target');
    expect(text(row(acme, 'L-3032A538'))).toContain('64 vCPU');
    expect(text(row(acme, 'L-3032A538'))).toContain(t.atTarget);
    expect(text(row(acme, 'L-B99A9384'))).toContain('1,000');
    expect(text(row(acme, 'L-B99A9384'))).toContain(t.raise.none);
    expect(acme.querySelector('[data-flag]')).toBeNull();

    const m = item(root, 'moooon');
    const flagged = row(m, 'L-B99A9384');
    expect(flagged.getAttribute('data-state')).toBe('below-target');
    expect(text(flagged)).toContain('990 short of target');
    expect(flagged.querySelector('[data-flag="below-target"]')).not.toBeNull();
    expect(flagged.querySelector('td')!.className).toContain('--el-warning');
    expect(m.querySelector('[data-flag="account-below-target"]')).not.toBeNull();
    // Below target with its raise open: not flagged, the raise says what happens.
    const raising = row(m, 'L-3032A538');
    expect(raising.getAttribute('data-state')).toBe('raising');
    expect(raising.querySelector('[data-flag]')).toBeNull();
    expect(text(raising.querySelector('[data-raise="case_opened"]'))).toContain(
      mon.requests.status.case_opened,
    );
    expect(text(raising)).toContain('to 64 vCPU');
    expect(text(raising)).toContain('filed 5 h ago');

    // A pending raise AWS gave no value or time for shows only its status.
    const pending = row(item(root, 'Northwind Data'), 'L-B99A9384');
    expect(text(pending)).toContain(mon.requests.status.pending);
    expect(text(pending)).not.toContain('to ');
    expect(text(pending)).not.toContain('filed');

    const header = root.querySelector('[data-pool="tenant-accounts"]')!;
    expect(text(header.querySelector('[data-flag="below-target"]'))).toContain(
      '1 quota below target, no raise',
    );
    expect(header.querySelector('[data-flag="accounts-not-read"]')).toBeNull();
    // Each quota also stacks below sm, with the same state.
    expect(m.querySelectorAll('ul li[data-quota]')).toHaveLength(2);
    expect(m.querySelector('ul li[data-state="below-target"]')!.className).toContain(
      'border-l-(--el-warning)',
    );
  });

  it('shows a quota not read as the Not read mark, never a number (Panel 5)', async () => {
    const root = await card(block([INITECH, ACME]));
    const i = item(root, 'Initech');
    expect(i.querySelector('[data-flag="not-read"]')).not.toBeNull();
    expect(text(i.querySelector('[role="alert"]'))).toBe(t.notRead.body);
    const fg = row(i, 'L-3032A538');
    expect(fg.getAttribute('data-state')).toBe('not-read');
    expect(fg.querySelector(`[aria-label="${mon.notReadLabel}"]`)).not.toBeNull();
    expect(text(fg)).toContain('last read 3 h ago');
    expect(text(fg)).toContain(mon.notAvailable);
    expect(text(fg)).not.toMatch(/\bvCPU\b.*\bvCPU\b/);
    expect(text(row(i, 'L-B99A9384'))).toContain(mon.neverRead);
    expect(
      text(root.querySelector('[data-pool="tenant-accounts"] [data-flag="accounts-not-read"]')),
    ).toContain('1 account not read');
    // Acme, read, still renders whole.
    expect(text(row(item(root, 'Acme Robotics'), 'L-3032A538'))).toContain('64 vCPU');
  });

  it('says why nothing is read for each account that is not ready (Panel 4)', async () => {
    const root = await card(block([GLOBEX, FERNWOOD, HALCYON, UMBRELLA, NEVER_REFUSED]));
    expect(text(item(root, 'Globex Platform').querySelector('p'))).toBe(t.notReady.requested);
    expect(text(item(root, 'Fernwood IO').querySelector('p'))).toBe(t.notReady.creating);
    expect(text(item(root, 'Halcyon Health').querySelector('p'))).toBe(t.notReady.bootstrapping);
    const umbrella = item(root, 'Umbrella Labs');
    expect(text(umbrella.querySelector('p'))).toContain(
      'AWS refused to create the account 3 times, last 2 h ago.',
    );
    expect(umbrella.querySelector('[data-account-state="refused"]')).not.toBeNull();
    expect(text(item(root, 'Vandelay Imports').querySelector('p'))).toBe(t.notReady.refusedNever);
    expect(root.querySelector('tr[data-quota]')).toBeNull();
    expect(text(item(root, 'Fernwood IO').querySelector('[data-account-state]'))).toBe(
      t.state.creating,
    );
  });

  it('pages ten accounts at a time, keeping the search in the links', async () => {
    const many = Array.from({ length: 23 }, (_, i) =>
      account(`Org ${String(i).padStart(2, '0')}`, {
        awsAccountId: `3100000000${String(i).padStart(2, '0')}`,
      }),
    );
    const b = block([...many, MOOOON]);
    const first = await card(b);
    expect(item(first, 'moooon')).toBe(first.querySelector('li[data-tenant-account]'));
    const pager = first.querySelector('[data-element="tenant-pager"]')!;
    expect(text(pager)).toContain('1–10 of 24 accounts');
    expect(text(pager)).toContain('Page 1 of 3');
    expect(pager.querySelector('nav')!.getAttribute('aria-label')).toBe(t.pagerLabel);
    expect(pager.querySelector('a')!.getAttribute('href')).toBe(
      '/admin/fleet-status?tenantPage=2#tenant-accounts',
    );

    const last = await card(b, { page: '3' });
    expect(last.querySelectorAll('li[data-tenant-account]')).toHaveLength(4);
    expect(text(last.querySelector('[data-element="tenant-pager"]'))).toContain(
      '21–24 of 24 accounts',
    );

    const searched = await card(b, { query: 'org 1' });
    expect(text(searched.querySelector('[data-element="tenant-pager"]'))).toContain(
      '1–10 of 10 accounts matching “org 1”',
    );
    const input = searched.querySelector<HTMLInputElement>('input[name="tenantQ"]')!;
    expect(input.getAttribute('value')).toBe('org 1');
    expect(searched.querySelector('form[role="search"]')!.getAttribute('action')).toBe(
      '/admin/fleet-status#tenant-accounts',
    );
    // The header counts every account, not the matches.
    expect(
      text(searched.querySelector('[data-pool="tenant-accounts"] [data-flag="below-target"]')),
    ).toContain('1 quota below target');

    expect(tenantPageHref('north', 2)).toBe(
      '/admin/fleet-status?tenantQ=north&tenantPage=2#tenant-accounts',
    );
    expect(tenantPageHref('', 1)).toBe('/admin/fleet-status#tenant-accounts');
  });

  it('says so when a search matches nothing, with the way back (Panel 3)', async () => {
    const root = await card(block([ACME, MOOOON]), { query: 'wayne' });
    const none = root.querySelector('[data-element="no-match"]')!;
    expect(text(none)).toContain('No account matches “wayne”');
    expect(none.querySelector('a')!.getAttribute('href')).toBe(
      '/admin/fleet-status#tenant-accounts',
    );
    expect(text(none.querySelector('a'))).toBe(t.noMatch.clear);
    expect(root.querySelector('li[data-tenant-account]')).toBeNull();
    expect(root.querySelector('[data-element="tenant-pager"]')).toBeNull();
  });

  it('renders the empty block with no search box, and the failed block (Panels 6–7)', async () => {
    const empty = await card(block([]));
    expect(empty.querySelector('[data-pool="tenant-accounts"]')!.getAttribute('data-state')).toBe(
      'empty',
    );
    expect(text(empty)).toContain(t.empty.title);
    expect(text(empty)).toContain(t.readOnly);
    expect(empty.querySelector('form[role="search"]')).toBeNull();

    const failed = await card({ status: 'unavailable' });
    expect(failed.querySelector('[data-pool="tenant-accounts"]')!.getAttribute('data-state')).toBe(
      'failed',
    );
    expect(text(failed.querySelector('[role="alert"]'))).toContain(t.error.title);
    expect(failed.querySelector('[data-flag]')).toBeNull();
  });

  it('names a quota target with no copy of its own by its name', async () => {
    const odd = account('Odd', {
      quotas: [{ ...lambda(), name: 'some-new-quota', quotaCode: 'L-NEW' } as TenantQuotaDTO],
    });
    const root = await card(block([odd]));
    expect(text(row(item(root, 'Odd'), 'L-NEW'))).toContain('some-new-quota');
  });
});
