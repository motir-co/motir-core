// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { FleetOrgRowDTO, FleetVerdict } from '@/lib/dto/platformFleetMonitor';
import type { FleetLastStopDTO } from '@/lib/dto/platformFleetStop';
import type { PlatformRole } from '@/generated/prisma/client';
import zhMessages from '@/messages/zh.json';

/**
 * The tenant page's FLEET card (MOTIR-7320 · design `tenant--stop-containers.mock.html`
 * S1, S2 a–d, S4 k). The control by ROLE and by what is running — and the
 * reason a disabled control gives, in words beside it.
 */

const previewStopAction = vi.hoisted(() => vi.fn());
const stopContainersAction = vi.hoisted(() => vi.fn());
vi.mock('@/app/(admin)/admin/tenants/[orgId]/actions', () => ({
  previewStopAction,
  stopContainersAction,
}));

// The chip is MOTIR-7319's async Server Component (its own suite covers its six
// faces, `tests/platform/fleetSection.test.tsx`); a client render cannot await
// it, so it is stood in for by its word, keyed by the verdict it was handed.
vi.mock('@/app/(admin)/admin/monitoring/_components/FleetVerdictChip', async () => {
  const en = (await import('@/messages/en.json')).default;
  const words = en.platformAdmin.monitoring.fleet.verdict as Record<string, string>;
  return {
    FleetVerdictChip: ({ verdict }: { verdict: string }) => (
      <span data-verdict={verdict}>{words[verdict]}</span>
    ),
  };
});

const { OrgFleetCard } =
  await import('@/app/(admin)/admin/tenants/[orgId]/_components/OrgFleetCard');

afterEach(() => cleanup());

function row(overrides: Partial<FleetOrgRowDTO> = {}): FleetOrgRowDTO {
  return {
    organizationId: 'org_1',
    name: 'Acme Corp',
    isMeta: false,
    internalBilling: false,
    byWorkload: { ci_runner: 3, hosted_agent: 1, agent_instance: 2, code_graph_index: 1 },
    agentsLive: 2,
    plan: {
      kind: 'capped',
      planKey: 'standard',
      planName: 'Standard',
      agentRunsInParallel: 1,
      agentsPerUser: 1,
      agentsPerOrg: 5,
      ciBurstCap: 5,
      ciBurstSource: 'plan',
    },
    accruedMinutesInWindow: 0,
    confirmedCreditsThisMonth: 1240,
    pendingCredits: 36,
    pendingSince: null,
    latestAccrualTickAt: null,
    balanceCredits: 900,
    verdicts: ['running_not_debited'],
    ...overrides,
  };
}

const WINDOW = { windowMinutes: 10, periodMinutes: 5, judgedAt: '2026-10-02T14:32:00.000Z' };

function renderCard(
  props: { role?: PlatformRole; row?: FleetOrgRowDTO; lastStop?: FleetLastStopDTO | null } = {},
  messages?: Record<string, unknown>,
) {
  render(
    <ToastProvider>
      <OrgFleetCard
        orgId="org_1"
        orgName="Acme Corp"
        role={props.role ?? 'superadmin'}
        row={props.row ?? row()}
        window={WINDOW}
        lastStop={props.lastStop ?? null}
      />
    </ToastProvider>,
    { now: new Date('2026-10-02T14:40:00.000Z'), ...(messages ? { messages } : {}) },
  );
}

const stopButton = () => screen.getByRole('button', { name: /Stop containers/i });

describe('OrgFleetCard', () => {
  it('shows the counts by workload, the facts and the verdict chip', () => {
    renderCard();
    expect(screen.getByRole('heading', { name: 'Fleet · running now' })).toBeTruthy();
    expect(screen.getByText(/What Acme Corp is running on Motir’s fleet/)).toBeTruthy();
    expect(within(screen.getByTestId('org-fleet-tile-ciRunner')).getByText('3')).toBeTruthy();
    expect(within(screen.getByTestId('org-fleet-tile-hostedAgent')).getByText('1')).toBeTruthy();
    expect(within(screen.getByTestId('org-fleet-tile-agentInstance')).getByText('2')).toBeTruthy();
    expect(within(screen.getByTestId('org-fleet-tile-index')).getByText('1')).toBeTruthy();
    // MOTIR-9377: the plan and its four figures, each tile against its own.
    expect(screen.getByTestId('org-fleet-plan').textContent).toBe(
      'Plan Standard · hosted runs at once: 1 · agents per person: 1 · agents: 5 · CI jobs at once: 5',
    );
    expect(screen.getByTestId('org-fleet-tile-ciRunner').textContent).toContain('3 of 5');
    expect(screen.getByTestId('org-fleet-tile-hostedAgent').textContent).toContain('1 of 1');
    // Running machines, against no figure: the org figure counts live agents (MOTIR-9954).
    expect(screen.getByTestId('org-fleet-tile-agentInstance').textContent).not.toContain(' of ');
    expect(screen.getByTestId('org-fleet-tile-index').textContent).not.toContain(' of ');
    expect(screen.getByTestId('org-fleet-card').textContent).not.toMatch(/pool|500/i);
    expect(screen.getByText('1,240 credits')).toBeTruthy();
    expect(
      within(screen.getByTestId('org-fleet-verdicts')).getByText('Running, not debited'),
    ).toBeTruthy();
  });

  it('hands every verdict the org holds to the shared chip, in order', () => {
    const all: FleetVerdict[] = [
      'running_not_debited',
      'debited_nothing_running',
      'exhausted_still_running',
      'balance_unknown',
      'not_charged',
      'ok',
    ];
    renderCard({ row: row({ verdicts: all }) });
    const chips = within(screen.getByTestId('org-fleet-verdicts'));
    for (const verdict of all) {
      expect(chips.getByText((_, el) => el?.getAttribute('data-verdict') === verdict)).toBeTruthy();
    }
  });

  it('a superadmin with something running gets the live control and the explainer (S2 a)', () => {
    renderCard();
    expect(stopButton().hasAttribute('disabled')).toBe(false);
    expect(screen.getByText(/It does not suspend the organization/)).toBeTruthy();
  });

  it.each(['operator', 'support'] as const)(
    '%s sees the control DISABLED, described by its reason (S2 b/c)',
    (role) => {
      renderCard({ role });
      const button = stopButton();
      expect(button.hasAttribute('disabled')).toBe(true);
      const reason = document.getElementById(button.getAttribute('aria-describedby') ?? '');
      expect(reason?.textContent).toBe(
        `Only a superadmin can stop an organization’s containers. You are signed in as ${role}.`,
      );
    },
  );

  it('nothing running disables it with “Nothing to stop.” — an index container alone counts as nothing (S2 d)', () => {
    renderCard({
      row: row({
        byWorkload: { ci_runner: 0, hosted_agent: 0, agent_instance: 0, code_graph_index: 1 },
        verdicts: ['ok'],
      }),
    });
    const button = stopButton();
    expect(button.hasAttribute('disabled')).toBe(true);
    const reason = document.getElementById(button.getAttribute('aria-describedby') ?? '');
    expect(reason?.textContent).toBe('Nothing to stop.');
  });

  it('the role reason wins over “Nothing to stop.”', () => {
    renderCard({
      role: 'operator',
      row: row({
        byWorkload: { ci_runner: 0, hosted_agent: 0, agent_instance: 0, code_graph_index: 0 },
      }),
    });
    expect(screen.queryByText('Nothing to stop.')).toBeNull();
    expect(screen.getByText(/Only a/)).toBeTruthy();
    expect(screen.getByText('Nothing is running on the fleet for this organization.')).toBeTruthy();
  });

  it('after a stop the foot shows the fleet.stop row — actor, time, reason, counts (S4 k)', () => {
    renderCard({
      row: row({
        byWorkload: { ci_runner: 0, hosted_agent: 0, agent_instance: 0, code_graph_index: 1 },
        verdicts: ['ok'],
      }),
      lastStop: {
        at: '2026-10-02T14:38:00.000Z',
        actorEmail: 'ops@moooon.net',
        reason: 'Monitor: running, not debited for 25 min',
        runsCancelled: 2,
        ciContainersStopped: 3,
        hostedRunsEnded: 1,
        agentInstancesHibernated: 2,
      },
    });
    const last = screen.getByTestId('org-fleet-last-stop');
    expect(last.textContent).toContain('Last stop');
    expect(last.textContent).toContain('2 minutes ago · ops@moooon.net');
    expect(last.textContent).toContain('Monitor: running, not debited for 25 min');
    expect(last.textContent).toContain(
      '2 CI runs · 3 CI containers · 1 hosted runs · 2 agent instances',
    );
    expect(stopButton().hasAttribute('disabled')).toBe(true);
  });

  it('renders in zh from the zh catalog', () => {
    renderCard({ role: 'operator' }, zhMessages as unknown as Record<string, unknown>);
    expect(screen.getByRole('heading', { name: '集群 · 正在运行' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /停止容器/ }).hasAttribute('disabled')).toBe(true);
  });

  // ── MOTIR-7321's coverage top-up ───────────────────────────────────────────

  it.each([
    [{ kind: 'exempt', ciBurstOverride: null }, 'Plan No plan limit'],
    [{ kind: 'exempt', ciBurstOverride: 9 }, 'Plan No plan limit · CI jobs at once: 9 (override)'],
    [
      { kind: 'plan_unknown', planKey: 'legacy_tier' },
      'Plan unknown · legacy_tier · new containers refused',
    ],
    [{ kind: 'plan_unknown', planKey: null }, 'Plan unknown · new containers refused'],
  ] as const)('a plan with no figures is said in words, never a figure (%j)', (plan, words) => {
    renderCard({ row: row({ plan }) });
    expect(screen.getByTestId('org-fleet-plan').textContent).toBe(words);
    const tiles = ['hostedAgent', 'agentInstance', 'index'];
    for (const key of tiles) {
      expect(screen.getByTestId(`org-fleet-tile-${key}`).textContent).not.toContain(' of ');
    }
    const ci = screen.getByTestId('org-fleet-tile-ciRunner').textContent;
    if (plan.kind === 'exempt' && plan.ciBurstOverride !== null) {
      expect(ci).toContain('3 of 9');
      expect(ci).toContain('override');
    } else {
      expect(ci).not.toContain(' of ');
    }
  });

  it('a CI override is marked on its tile; an unreadable one names no CI figure', () => {
    const base = row().plan as Extract<FleetOrgRowDTO['plan'], { kind: 'capped' }>;
    renderCard({ row: row({ plan: { ...base, ciBurstCap: 2, ciBurstSource: 'override' } }) });
    expect(screen.getByTestId('org-fleet-tile-ciRunner').textContent).toContain('3 of 2');
    expect(screen.getByTestId('org-fleet-tile-ciRunner').textContent).toContain('override');
    cleanup();
    renderCard({ row: row({ plan: { ...base, ciBurstCap: null, ciBurstSource: 'unreadable' } }) });
    expect(screen.getByTestId('org-fleet-plan').textContent).toContain('CI limit unreadable');
    expect(screen.getByTestId('org-fleet-tile-ciRunner').textContent).not.toContain(' of ');
  });

  it('a last stop with no actor and no reason is said in words', () => {
    renderCard({
      lastStop: {
        at: '2026-10-02T14:38:00.000Z',
        actorEmail: null,
        reason: null,
        runsCancelled: 0,
        ciContainersStopped: 1,
        hostedRunsEnded: 0,
        agentInstancesHibernated: 0,
      },
    });
    const last = screen.getByTestId('org-fleet-last-stop');
    expect(last.textContent).toContain('a former operator');
    expect(last.textContent).toContain('No reason recorded');
  });
});
