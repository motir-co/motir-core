// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import en from '@/messages/en.json';
import { ToastProvider } from '@/components/ui/Toast';

/**
 * The ops toolkit's dialogs (MOTIR-752, design `platform-admin` AMENDMENT
 * 2026-10-03 Panels 2–3): the primary is DISABLED until a reason is typed, the
 * heavy writes add the typed slug, and the large grant asks for the slug only at
 * or above the threshold. The Server Actions are faked at their module — what is
 * asserted is the gate and what the dialog sends, not the write.
 */

const grantCreditsAction = vi.fn();
const suspendOrganizationAction = vi.fn();
vi.mock('@/app/(admin)/admin/tenants/[orgId]/creditActions', () => ({
  grantCreditsAction: (...a: unknown[]) => grantCreditsAction(...a),
  adjustCreditsAction: vi.fn(),
  setPlanAction: vi.fn(),
  loadCreditLedgerPageAction: vi.fn(),
}));
vi.mock('@/app/(admin)/admin/tenants/[orgId]/lifecycleActions', () => ({
  suspendOrganizationAction: (...a: unknown[]) => suspendOrganizationAction(...a),
  reactivateOrganizationAction: vi.fn(),
}));

const { ReasonConfirmDialog } =
  await import('@/app/(admin)/admin/tenants/[orgId]/_components/ops/ReasonConfirmDialog');
const { GrantCreditsDialog, ChangePlanDialog } =
  await import('@/app/(admin)/admin/tenants/[orgId]/_components/ops/CreditDialogs');
const { OrgLifecycleControl } =
  await import('@/app/(admin)/admin/tenants/[orgId]/_components/ops/OrgLifecycleControl');

function wrap(node: ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <ToastProvider>{node}</ToastProvider>
    </NextIntlClientProvider>,
  );
}

const confirmButton = () => screen.getByTestId('ops-confirm') as HTMLButtonElement;
const reasonField = () => screen.getByTestId('ops-reason') as HTMLTextAreaElement;

beforeEach(() => {
  grantCreditsAction.mockReset();
  suspendOrganizationAction.mockReset();
});
afterEach(() => cleanup());

describe('ReasonConfirmDialog', () => {
  it('keeps the primary disabled until a non-blank reason is typed, then sends it trimmed', () => {
    const onConfirm = vi.fn();
    wrap(
      <ReasonConfirmDialog
        title="Turn off AI planning for Acme?"
        confirmLabel="Turn off"
        pending={false}
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText('Reason — required, written to the audit log')).toBeTruthy();
    expect(confirmButton().disabled).toBe(true);

    fireEvent.change(reasonField(), { target: { value: '   ' } });
    expect(confirmButton().disabled).toBe(true);

    fireEvent.change(reasonField(), { target: { value: '  abuse report #77  ' } });
    expect(confirmButton().disabled).toBe(false);
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith('abuse report #77');
  });

  it('with a typed slug, needs BOTH the exact slug and a reason', () => {
    wrap(
      <ReasonConfirmDialog
        title="Suspend Acme Corp?"
        confirmLabel="Suspend Acme Corp"
        confirmVariant="danger"
        typedSlug="acme-corp"
        pending={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByText('Type acme-corp to confirm')).toBeTruthy();
    fireEvent.change(reasonField(), { target: { value: 'non-payment' } });
    expect(confirmButton().disabled).toBe(true);
    fireEvent.change(screen.getByTestId('ops-typed-slug'), { target: { value: 'acme' } });
    expect(confirmButton().disabled).toBe(true);
    fireEvent.change(screen.getByTestId('ops-typed-slug'), { target: { value: 'acme-corp' } });
    expect(confirmButton().disabled).toBe(false);
  });

  it("honours the caller's own gate (an amount, a plan)", () => {
    wrap(
      <ReasonConfirmDialog
        title="t"
        confirmLabel="Go"
        extraReady={false}
        pending={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    fireEvent.change(reasonField(), { target: { value: 'a reason' } });
    expect(confirmButton().disabled).toBe(true);
  });
});

describe('GrantCreditsDialog', () => {
  it('previews the balance after, asks for the slug only at the threshold, and sends one requestId', async () => {
    grantCreditsAction.mockResolvedValue({
      ok: true,
      result: { idempotent: false, balanceCredits: 22_000 },
    });
    const onDone = vi.fn();
    const onClose = vi.fn();
    wrap(
      <GrantCreditsDialog
        orgId="org_1"
        orgName="Acme Corp"
        slug="acme-corp"
        balance={12_000}
        threshold={10_000}
        onClose={onClose}
        onDone={onDone}
      />,
    );
    fireEvent.change(screen.getByTestId('ops-amount'), { target: { value: '500' } });
    expect(screen.getByTestId('ops-balance-after').textContent).toBe(
      'Balance after: 12,500 credits (now 12,000)',
    );
    expect(screen.queryByTestId('ops-typed-slug')).toBeNull();

    fireEvent.change(screen.getByTestId('ops-amount'), { target: { value: '10,000' } });
    expect(screen.getByTestId('ops-typed-slug')).toBeTruthy();
    fireEvent.change(reasonField(), { target: { value: 'contract credit, ticket #4590' } });
    expect(confirmButton().disabled).toBe(true);
    fireEvent.change(screen.getByTestId('ops-typed-slug'), { target: { value: 'acme-corp' } });
    expect(confirmButton().textContent).toContain('Grant 10,000 credits');

    await act(async () => {
      fireEvent.click(confirmButton());
    });
    expect(grantCreditsAction).toHaveBeenCalledTimes(1);
    const [orgId, input] = grantCreditsAction.mock.calls[0] as [string, Record<string, unknown>];
    expect(orgId).toBe('org_1');
    expect(input).toMatchObject({
      credits: 10_000,
      reason: 'contract credit, ticket #4590',
      confirmSlug: 'acme-corp',
    });
    expect(String(input['requestId'])).toMatch(/^adm_/);
    expect(onClose).toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
    expect(await screen.findByText(/Granted 10,000 credits to Acme Corp/)).toBeTruthy();
  });

  it('an unreachable credit service keeps the dialog open and says nothing was recorded', async () => {
    grantCreditsAction.mockResolvedValue({ ok: false, code: 'CREDIT_SERVICE_UNREACHABLE' });
    const onClose = vi.fn();
    wrap(
      <GrantCreditsDialog
        orgId="org_1"
        orgName="Acme Corp"
        slug="acme-corp"
        balance={0}
        threshold={10_000}
        onClose={onClose}
        onDone={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId('ops-amount'), { target: { value: '50' } });
    fireEvent.change(reasonField(), { target: { value: 'goodwill' } });
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByText(/Couldn’t reach the credit service/)).toBeTruthy();
  });
});

describe('ChangePlanDialog — a tier is not a paid plan (MOTIR-8985)', () => {
  const NOT_PAID =
    'Changing the tier does not give Acme a paid AI plan. Motir-hosted repositories, Motir’s CI runners and agents stay refused until Acme pays for a plan through Stripe. For a comped or test organization, use Classify as internal billing instead.';

  function renderPlan(over: { countsAsPaid: boolean; paysThroughStripe?: boolean }) {
    return wrap(
      <ChangePlanDialog
        orgId="org-1"
        orgName="Acme"
        currentTier={null}
        paysThroughStripe={over.paysThroughStripe ?? false}
        countsAsPaid={over.countsAsPaid}
        onClose={() => {}}
        onDone={() => {}}
      />,
    );
  }

  it('says the org will still not count as paid, before anything is confirmed', () => {
    renderPlan({ countsAsPaid: false });

    expect(screen.getByTestId('ops-plan-not-paid').textContent).toBe(NOT_PAID);
    // It is said BEFORE the admin confirms: the dialog is still waiting on a
    // tier and a reason, and nothing has been sent.
    expect(confirmButton().disabled).toBe(true);
  });

  it('says nothing of the kind for an org the gate already counts as paid', () => {
    renderPlan({ countsAsPaid: true });

    expect(screen.queryByTestId('ops-plan-not-paid')).toBeNull();
  });

  it('keeps the Stripe caution beside it — the two say different things', () => {
    renderPlan({ countsAsPaid: false, paysThroughStripe: true });

    expect(screen.getByText(/pays for its plan through Stripe/)).toBeTruthy();
    expect(screen.getByTestId('ops-plan-not-paid')).toBeTruthy();
  });
});

describe('OrgLifecycleControl', () => {
  it('Suspend opens the consequence list, needs slug + reason, and calls the action once', async () => {
    suspendOrganizationAction.mockResolvedValue({ ok: true, result: {} });
    wrap(
      <OrgLifecycleControl
        orgId="org_1"
        name="Acme Corp"
        slug="acme-corp"
        suspended={false}
        memberCount={14}
        workspaceCount={3}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Suspend organization' }));
    expect(screen.getByText(/All 14 members of all 3 workspaces are refused/)).toBeTruthy();
    expect(confirmButton().disabled).toBe(true);
    fireEvent.change(screen.getByTestId('ops-typed-slug'), { target: { value: 'acme-corp' } });
    fireEvent.change(reasonField(), { target: { value: 'non-payment since July' } });
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    expect(suspendOrganizationAction).toHaveBeenCalledWith('org_1', {
      reason: 'non-payment since July',
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('a refusal is named in a toast and the dialog stays open', async () => {
    suspendOrganizationAction.mockResolvedValue({ ok: false, code: 'ALREADY_IN_STATE' });
    wrap(
      <OrgLifecycleControl
        orgId="org_1"
        name="Acme Corp"
        slug="acme-corp"
        suspended={false}
        memberCount={1}
        workspaceCount={1}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Suspend organization' }));
    fireEvent.change(screen.getByTestId('ops-typed-slug'), { target: { value: 'acme-corp' } });
    fireEvent.change(reasonField(), { target: { value: 'abuse' } });
    await act(async () => {
      fireEvent.click(confirmButton());
    });
    expect(await screen.findByText(/Someone else changed this first/)).toBeTruthy();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });
});
