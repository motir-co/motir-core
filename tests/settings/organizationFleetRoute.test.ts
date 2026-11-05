import { isValidElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Settings › Organization › Fleet — the ROUTE and its Server Actions
 * (MOTIR-10369). Transport only, asserted with the services mocked: the page
 * decides existence before anything renders, and each action calls exactly ONE
 * stop-service method and turns its typed refusal into a code the island says
 * in words. Who may stop is the SERVICE's decision — the story's integration test
 * (MOTIR-10371) asserts that against real Postgres.
 */

class NotFoundSentinel extends Error {}
class RedirectSentinel extends Error {
  constructor(readonly to: string) {
    super(to);
  }
}

const getSession = vi.hoisted(() => vi.fn());
const isCloudBilling = vi.hoisted(() => vi.fn(() => true));
const resolveActiveOrganizationForPane = vi.hoisted(() => vi.fn());
const read = vi.hoisted(() => vi.fn());
const stop = vi.hoisted(() => ({
  cancelHostedRun: vi.fn(),
  hibernateAgent: vi.fn(),
  previewStopEverything: vi.fn(),
  stopEverything: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/billing/availability', () => ({ isCloudBilling }));
vi.mock('@/lib/workspaces/tierDisclosure.server', () => ({ resolveActiveOrganizationForPane }));
vi.mock('@/lib/services/orgFleetService', () => ({ orgFleetService: { read } }));
vi.mock('@/lib/services/orgFleetStopService', () => ({ orgFleetStopService: stop }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new NotFoundSentinel();
  }),
  redirect: vi.fn((to: string) => {
    throw new RedirectSentinel(to);
  }),
}));

const { BillingForbiddenError, BillingNotAvailableError } = await import('@/lib/billing/errors');
const { OrganizationNotFoundError } = await import('@/lib/organizations/errors');
const { OrgFleetInstanceNotFoundError, OrgFleetRunNotFoundError } =
  await import('@/lib/orgFleet/errors');
const { default: OrganizationFleetPage } =
  await import('@/app/(authed)/settings/organization/fleet/page');
const { FleetClient } =
  await import('@/app/(authed)/settings/organization/fleet/_components/FleetClient');
const actions = await import('@/app/(authed)/settings/organization/fleet/actions');

const SESSION = { user: { id: 'user_1' } };
const ORG = { organization: { id: 'org_1', name: 'Acme' } };
const FLEET = { tiles: { kind: 'not_read' } };

afterEach(() => {
  vi.clearAllMocks();
  isCloudBilling.mockReturnValue(true);
});

/** The page's content element, under its one wrapper when it has one. */
function content(node: unknown): ReactElement<Record<string, unknown>> {
  if (!isValidElement(node)) throw new Error('not an element');
  const el = node as ReactElement<{ children?: unknown }>;
  if (typeof el.type === 'string' && isValidElement(el.props.children)) {
    return el.props.children as ReactElement<Record<string, unknown>>;
  }
  return el as ReactElement<Record<string, unknown>>;
}

describe('the page decides existence before it renders', () => {
  it('404s off-cloud without reading the session', async () => {
    isCloudBilling.mockReturnValue(false);
    await expect(OrganizationFleetPage()).rejects.toBeInstanceOf(NotFoundSentinel);
    expect(getSession).not.toHaveBeenCalled();
  });

  it('sends a signed-out visitor to sign in', async () => {
    getSession.mockResolvedValue(null);
    await expect(OrganizationFleetPage()).rejects.toMatchObject({ to: '/sign-in' });
  });

  it('says there is no active organisation, reading nothing', async () => {
    getSession.mockResolvedValue(SESSION);
    resolveActiveOrganizationForPane.mockResolvedValue(null);
    const el = content(await OrganizationFleetPage());
    expect(el.props.title).toBe('states.noActiveOrgTitle');
    expect(read).not.toHaveBeenCalled();
  });

  it.each([new OrganizationNotFoundError('org_1'), new BillingNotAvailableError()])(
    '404s on %s',
    async (err) => {
      getSession.mockResolvedValue(SESSION);
      resolveActiveOrganizationForPane.mockResolvedValue(ORG);
      read.mockRejectedValue(err);
      await expect(OrganizationFleetPage()).rejects.toBeInstanceOf(NotFoundSentinel);
    },
  );

  it('gives a plain member the area’s forbidden panel', async () => {
    getSession.mockResolvedValue(SESSION);
    resolveActiveOrganizationForPane.mockResolvedValue(ORG);
    read.mockRejectedValue(new BillingForbiddenError('member'));
    const el = content(await OrganizationFleetPage());
    expect(el.props.title).toBe('states.forbiddenTitle');
  });

  it('rethrows a fault it cannot name', async () => {
    getSession.mockResolvedValue(SESSION);
    resolveActiveOrganizationForPane.mockResolvedValue(ORG);
    read.mockRejectedValue(new Error('db down'));
    await expect(OrganizationFleetPage()).rejects.toThrow('db down');
  });

  it('hands an owner or admin the island with ONE read', async () => {
    getSession.mockResolvedValue(SESSION);
    resolveActiveOrganizationForPane.mockResolvedValue(ORG);
    read.mockResolvedValue(FLEET);
    const el = content(await OrganizationFleetPage());
    expect(el.type).toBe(FleetClient);
    expect(el.props).toMatchObject({ orgId: 'org_1', orgName: 'Acme', initialFleet: FLEET });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({ organizationId: 'org_1', actorUserId: 'user_1' });
  });
});

describe('the actions', () => {
  const INPUT = { organizationId: 'org_1', actorUserId: 'user_1' };

  it('refuse a signed-out caller before any service call', async () => {
    getSession.mockResolvedValue(null);
    expect(await actions.cancelHostedRunAction('org_1', 'run_1')).toEqual({
      ok: false,
      code: 'forbidden',
    });
    expect(await actions.hibernateAgentAction('org_1', 'inst_1')).toEqual({
      ok: false,
      code: 'forbidden',
    });
    expect(await actions.previewStopEverythingAction('org_1')).toEqual({
      ok: false,
      code: 'forbidden',
    });
    expect(await actions.stopEverythingAction('org_1')).toEqual({ ok: false, code: 'forbidden' });
    for (const fn of Object.values(stop)) expect(fn).not.toHaveBeenCalled();
  });

  it('pass the session’s user and the page’s org to exactly one method', async () => {
    getSession.mockResolvedValue(SESSION);
    const outcome = { dispatchRunId: 'run_1', closed: true, at: '2026-11-05T10:00:00.000Z' };
    stop.cancelHostedRun.mockResolvedValue(outcome);
    expect(await actions.cancelHostedRunAction('org_1', 'run_1')).toEqual({ ok: true, outcome });
    expect(stop.cancelHostedRun).toHaveBeenCalledWith(INPUT, 'run_1');

    const preview = {
      ciRuns: 1,
      ciContainers: 1,
      hostedRuns: 0,
      runningAgents: 0,
      indexContainers: 0,
    };
    stop.previewStopEverything.mockResolvedValue(preview);
    const previewed = await actions.previewStopEverythingAction('org_1');
    expect(previewed).toMatchObject({ ok: true, preview });
    expect(stop.previewStopEverything).toHaveBeenCalledWith(INPUT, expect.any(Date));

    const result = { runsCancelled: 1 };
    stop.stopEverything.mockResolvedValue(result);
    expect(await actions.stopEverythingAction('org_1')).toEqual({ ok: true, result });
    expect(stop.stopEverything).toHaveBeenCalledWith(INPUT);
  });

  it.each([
    [
      { kind: 'hibernated', at: '2026-11-05T10:00:00.000Z' },
      { ok: true, code: 'hibernated', at: '2026-11-05T10:00:00.000Z' },
    ],
    [
      { kind: 'already_resting', instanceId: 'inst_1' },
      { ok: true, code: 'alreadyResting' },
    ],
    [
      { kind: 'in_motion', instanceId: 'inst_1' },
      { ok: true, code: 'inMotion' },
    ],
  ])('say what Hibernate did (%o)', async (outcome, expected) => {
    getSession.mockResolvedValue(SESSION);
    stop.hibernateAgent.mockResolvedValue(outcome);
    expect(await actions.hibernateAgentAction('org_1', 'inst_1')).toEqual(expected);
    expect(stop.hibernateAgent).toHaveBeenCalledWith(INPUT, 'inst_1');
  });

  it.each([
    [new BillingForbiddenError('member'), 'forbidden'],
    [new OrganizationNotFoundError('org_1'), 'notFound'],
    [new BillingNotAvailableError(), 'notFound'],
    [new OrgFleetRunNotFoundError('run_1'), 'notFound'],
    [new OrgFleetInstanceNotFoundError('inst_1'), 'notFound'],
    [new Error('boom'), 'failed'],
    ['a string', 'failed'],
  ])('turn %s into %s', async (err, code) => {
    getSession.mockResolvedValue(SESSION);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const fn of Object.values(stop)) fn.mockRejectedValue(err);
    expect(await actions.cancelHostedRunAction('org_1', 'run_1')).toEqual({ ok: false, code });
    expect(await actions.hibernateAgentAction('org_1', 'inst_1')).toEqual({ ok: false, code });
    expect(await actions.previewStopEverythingAction('org_1')).toEqual({ ok: false, code });
    expect(await actions.stopEverythingAction('org_1')).toEqual({ ok: false, code });
    if (code === 'failed') {
      // The fault's NAME only — never its message, which may carry provider text.
      expect(logged).toHaveBeenCalledWith('[settings/organization/fleet] stop everything failed', {
        error: err instanceof Error ? err.name : 'UnknownError',
      });
    } else {
      expect(logged).not.toHaveBeenCalled();
    }
    logged.mockRestore();
  });
});
