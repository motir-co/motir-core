// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import en from '@/messages/en.json';
import { ToastProvider } from '@/components/ui/Toast';
import type { PlatformAuditEntryDTO } from '@/lib/dto/platform';
import type { PlatformCreditLedgerPageDTO } from '@/lib/dto/platformCreditOps';

/**
 * The ops toolkit's rendered STATES (MOTIR-752, design `platform-admin`
 * AMENDMENT 2026-10-03 Panels 6–8): the audit table's rows, chain markers, open
 * detail and no-match state; the credits card's unreachable (8b), empty-ledger
 * (8d), read-only (8c) and keyset-paged states.
 */

const loadCreditLedgerPageAction = vi.fn();
vi.mock('@/app/(admin)/admin/tenants/[orgId]/creditActions', () => ({
  grantCreditsAction: vi.fn(),
  adjustCreditsAction: vi.fn(),
  setPlanAction: vi.fn(),
  loadCreditLedgerPageAction: (...a: unknown[]) => loadCreditLedgerPageAction(...a),
}));

const { AuditLogTable } = await import('@/app/(admin)/admin/audit-log/_components/AuditLogTable');
const { CreditsCard } =
  await import('@/app/(admin)/admin/tenants/[orgId]/_components/ops/CreditsCard');

function wrap(node: ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <ToastProvider>{node}</ToastProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => loadCreditLedgerPageAction.mockReset());
afterEach(() => cleanup());

function entry(seq: number, over: Partial<PlatformAuditEntryDTO> = {}): PlatformAuditEntryDTO {
  return {
    seq,
    id: `e${seq}`,
    createdAt: '2026-10-02T14:20:00.000Z',
    actor: { userId: 'u1', name: 'Yue', email: 'yue@moooon.net', role: 'superadmin' },
    action: 'org.credit_grant',
    isWrite: true,
    targetKind: 'organization',
    targetId: 'org_1',
    targetLabel: 'Acme Corp',
    organizationId: 'org_1',
    reason: 'Goodwill credit (ticket #4512)',
    metadata: { credits: 500, requestId: 'adm_1' },
    entryHash: '9f3c0000000000000000000000000000000000000000000000000000000a41e',
    prevHash: '1b2a00000000000000000000000000000000000000000000000000000000c0de',
    chainedToSeq: seq - 1,
    ...over,
  };
}

describe('AuditLogTable', () => {
  it('renders the columns, marks Hash mismatch / Unverified, and opens one entry', () => {
    wrap(
      <AuditLogTable
        rows={[
          { entry: entry(12), chain: 'unverified' },
          { entry: entry(11), chain: 'mismatch' },
          { entry: entry(10, { reason: null, metadata: null }), chain: 'verified' },
        ]}
        initialOpenSeq={null}
        clearHref={null}
      />,
    );
    const table = screen.getByTestId('audit-table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((c) => c.textContent),
    ).toEqual(['When (UTC)', 'Operator', 'Action', 'Target', 'Reason']);
    expect(within(screen.getByTestId('audit-row-12')).getByText('Unverified')).toBeTruthy();
    expect(within(screen.getByTestId('audit-row-11')).getByText('Hash mismatch')).toBeTruthy();
    const verified = screen.getByTestId('audit-row-10');
    expect(within(verified).queryByText('Unverified')).toBeNull();
    expect(within(verified).getByText('—')).toBeTruthy();

    expect(screen.queryByTestId('audit-detail')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show entry #11' }));
    const detail = screen.getByTestId('audit-detail');
    expect(detail.textContent).toContain('#11 · 2026-10-02T14:20:00.000Z');
    expect(detail.textContent).toContain('Yue <yue@moooon.net> · superadmin');
    expect(detail.textContent).toContain('"credits": 500');
    expect(detail.textContent).toContain('9f3c…a41e');
    expect(detail.textContent).toContain('chained to #10 (1b2a…c0de)');
  });

  it('opens the entry named by ?entry= (the "Show #n" door), and #1 reads as the first entry', () => {
    wrap(
      <AuditLogTable
        rows={[{ entry: entry(1, { prevHash: null, chainedToSeq: null }), chain: 'verified' }]}
        initialOpenSeq={1}
        clearHref={null}
      />,
    );
    expect(screen.getByTestId('audit-detail').textContent).toContain(
      'the first entry — chained to nothing',
    );
  });

  it('renders an action key that has left the vocabulary raw, and opens its entry (MOTIR-9386)', () => {
    wrap(
      <AuditLogTable
        rows={[
          {
            entry: entry(7, { action: 'enterprise_request.transition', metadata: null }),
            chain: 'verified',
          },
        ]}
        initialOpenSeq={null}
        clearHref={null}
      />,
    );
    const row = screen.getByTestId('audit-row-7');
    expect(within(row).getByText('enterprise_request.transition')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show entry #7' }));
    expect(screen.getByTestId('audit-detail').textContent).toContain('#7');
  });

  it('no match: the empty state with Clear filters', () => {
    wrap(<AuditLogTable rows={[]} initialOpenSeq={null} clearHref="/admin/audit-log" />);
    expect(screen.getByText('No entries match these filters')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Clear filters' }).getAttribute('href')).toBe(
      '/admin/audit-log',
    );
  });
});

function ledger(over: Partial<PlatformCreditLedgerPageDTO> = {}): PlatformCreditLedgerPageDTO {
  return {
    organizationId: 'org_1',
    known: true,
    balanceCredits: 12_400,
    tier: { key: 'pro', name: 'Pro', cadence: 'monthly', allotmentCredits: 8000 },
    lastTierAssignment: null,
    explainsCurrentTier: false,
    entries: [
      {
        id: 'l2',
        at: '2026-10-02T14:20:00.000Z',
        kind: 'grant',
        credits: 500,
        balanceAfter: 12_400,
        reason: 'Goodwill',
        actor: { userId: 'u1', label: 'Yue <yue@moooon.net>' },
      },
      {
        id: 'l1',
        at: '2026-10-01T09:02:00.000Z',
        kind: 'debit',
        credits: -42,
        balanceAfter: 11_900,
        reason: null,
        actor: null,
      },
    ],
    nextCursor: 'cur_2',
    largeGrantThresholdCredits: 10_000,
    ...over,
  };
}

const cardProps = {
  orgId: 'org_1',
  orgName: 'Acme Corp',
  slug: 'acme-corp',
  paysThroughStripe: false,
  countsAsPaid: true,
};

describe('CreditsCard', () => {
  it('superadmin: balance, plan, the three actions and the signed ledger', () => {
    wrap(<CreditsCard {...cardProps} canWrite initial={ledger()} />);
    expect(screen.getByTestId('ops-balance').textContent).toBe('12,400 credits');
    expect(screen.getByText('Pro')).toBeTruthy();
    for (const name of ['Grant credits', 'Adjust balance', 'Change plan']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    const rows = within(screen.getByTestId('ops-ledger')).getAllByRole('row').slice(1);
    expect(
      rows.map((r) => [...r.querySelectorAll('td')].slice(1, 4).map((c) => c.textContent)),
    ).toEqual([
      ['Grant', '+500', '12,400'],
      ['Debit', '−42', '11,900'],
    ]);
  });

  it('operator / support: the same card with no action rendered (Panel 8c)', () => {
    wrap(<CreditsCard {...cardProps} canWrite={false} initial={ledger()} />);
    expect(screen.queryByRole('button', { name: 'Grant credits' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change plan' })).toBeNull();
  });

  it('unreachable credit service: no balance, an explanation and Retry (Panel 8b)', async () => {
    loadCreditLedgerPageAction.mockResolvedValue({ ok: true, result: ledger() });
    wrap(<CreditsCard {...cardProps} canWrite initial={null} />);
    expect(screen.getByText('Couldn’t load credits')).toBeTruthy();
    expect(screen.queryByTestId('ops-balance')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(loadCreditLedgerPageAction).toHaveBeenCalledWith('org_1', null);
    expect(screen.getByTestId('ops-balance').textContent).toBe('12,400 credits');
  });

  it('an empty ledger is a state, not an error (Panel 8d)', () => {
    wrap(
      <CreditsCard
        {...cardProps}
        canWrite
        initial={ledger({
          known: false,
          balanceCredits: 0,
          tier: null,
          entries: [],
          nextCursor: null,
        })}
      />,
    );
    expect(screen.getByText('No credit transactions yet')).toBeTruthy();
    expect(screen.getByText(/Acme Corp has not been charged/)).toBeTruthy();
    expect(screen.getByText('No plan')).toBeTruthy();
  });

  it('Older loads the next keyset page and Newer returns to the first', async () => {
    const older = ledger({
      entries: [{ ...ledger().entries[1]!, id: 'l0', kind: 'top_up', credits: 10_000 }],
      nextCursor: null,
    });
    loadCreditLedgerPageAction.mockResolvedValueOnce({ ok: true, result: older });
    wrap(<CreditsCard {...cardProps} canWrite initial={ledger()} />);
    const newer = screen.getByRole('button', { name: 'Newer' }) as HTMLButtonElement;
    expect(newer.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Older' }));
    });
    expect(loadCreditLedgerPageAction).toHaveBeenLastCalledWith('org_1', 'cur_2');
    expect(screen.getByText('Top-up')).toBeTruthy();

    loadCreditLedgerPageAction.mockResolvedValueOnce({ ok: true, result: ledger() });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Newer' }));
    });
    expect(loadCreditLedgerPageAction).toHaveBeenLastCalledWith('org_1', null);
    expect(screen.getByText('Grant')).toBeTruthy();
  });
});
