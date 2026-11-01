// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToHtml } from '../helpers/serverPageHarness';
import en from '@/messages/en.json';
import type {
  FleetKillDTO,
  FleetKillsDTO,
  FleetOrgPlanDTO,
  FleetOrgRowDTO,
  FleetRunningOrgsDTO,
  FleetVerdict,
} from '@/lib/dto/platformFleetMonitor';

// MONITORING · FLEET (MOTIR-7319 · design MOTIR-7314). The two server components
// rendered to HTML through Fizz over the REAL `en` catalogue, so every assertion
// is about the copy the design lists — one case per verdict chip and per section
// state the mock draws (frames 1, 3–8), plus the pager's URL grammar.

// `getTranslations` / `getFormatter` are next-intl's SERVER entry; under happy-dom
// next-intl resolves to its client build, so bind real ones over the catalogue.
vi.mock('next-intl/server', async () => {
  const { createTranslator, createFormatter } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
    getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
  };
});

const { FleetSection, duration, ago, hrefWith } =
  await import('@/app/(admin)/admin/monitoring/_components/FleetSection');
const { FleetVerdictChip, FLEET_VERDICT_CHIP } =
  await import('@/app/(admin)/admin/monitoring/_components/FleetVerdictChip');
type FleetRead<T> = import('@/app/(admin)/admin/monitoring/_components/FleetSection').FleetRead<T>;

const NOW = new Date('2026-10-02T12:00:00.000Z');
const minAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();
const fleet = en.platformAdmin.monitoring.fleet;

const capped = (
  planKey: string,
  planName: string,
  figures: [runs: number, perUser: number, perOrg: number, ci: number],
  ciBurstSource: 'plan' | 'override' | 'unreadable' = 'plan',
): FleetOrgPlanDTO => ({
  kind: 'capped',
  planKey,
  planName,
  agentRunsInParallel: figures[0],
  agentsPerUser: figures[1],
  agentsPerOrg: figures[2],
  ciBurstCap: ciBurstSource === 'unreadable' ? null : figures[3],
  ciBurstSource,
});
const MAX = capped('max', 'Max', [5, 10, 50, 25]);
const STANDARD = capped('standard', 'Standard', [1, 1, 5, 5]);
const PRO = capped('pro', 'Pro', [3, 5, 30, 10]);

function row(overrides: Partial<FleetOrgRowDTO> = {}): FleetOrgRowDTO {
  return {
    organizationId: 'org_acme',
    name: 'Acme Corp',
    isMeta: false,
    internalBilling: false,
    byWorkload: { ci_runner: 42, hosted_agent: 6, code_graph_index: 2, agent_instance: 3 },
    agentsLive: 3,
    plan: MAX,
    accruedMinutesInWindow: 386,
    confirmedCreditsThisMonth: 18_420,
    pendingCredits: 0,
    pendingSince: null,
    latestAccrualTickAt: minAgo(2),
    balanceCredits: null,
    verdicts: ['ok'],
    ...overrides,
  };
}

function orgs(
  rows: FleetOrgRowDTO[],
  extra: Partial<Extract<FleetRunningOrgsDTO, { meter: 'enabled' }>> = {},
): FleetRead<FleetRunningOrgsDTO> {
  return {
    status: 'ok',
    data: {
      meter: 'enabled',
      window: { windowMinutes: 10, periodMinutes: 5, judgedAt: NOW.toISOString() },
      rows,
      total: rows.length,
      mismatched: rows.filter((r) =>
        r.verdicts.some((v) => v !== 'ok' && v !== 'balance_unknown' && v !== 'not_charged'),
      ).length,
      ciRunners: rows.reduce((s, r) => s + r.byWorkload.ci_runner, 0),
      hostedAgents: rows.reduce((s, r) => s + r.byWorkload.hosted_agent, 0),
      agentInstances: rows.reduce((s, r) => s + r.byWorkload.agent_instance, 0),
      page: 1,
      pageSize: 25,
      pageCount: 1,
      ...extra,
    },
  };
}

function kill(overrides: Partial<FleetKillDTO> = {}): FleetKillDTO {
  return {
    id: 'k1',
    app: 'motir-fleet',
    machineId: '3d8e5f1c2a9b47',
    machineName: 'ci-runner-7f3a',
    reason: 'no_record',
    action: 'destroyed',
    workload: null,
    organizationId: null,
    organizationName: null,
    ageSeconds: 2 * 3600 + 14 * 60,
    decidedAt: minAgo(3),
    completedAt: minAgo(3),
    failureDetail: null,
    ...overrides,
  };
}

function kills(
  rows: FleetKillDTO[],
  extra: Partial<Extract<FleetKillsDTO, { meter: 'enabled' }>> = {},
): FleetRead<FleetKillsDTO> {
  return {
    status: 'ok',
    data: {
      meter: 'enabled',
      since: minAgo(24 * 60),
      rows,
      total: rows.length,
      failed: rows.filter((k) => k.completedAt === null && k.failureDetail !== null).length,
      page: 1,
      pageSize: 25,
      pageCount: 1,
      ...extra,
    },
  };
}

async function render(props: {
  orgs: FleetRead<FleetRunningOrgsDTO>;
  kills: FleetRead<FleetKillsDTO>;
  query?: Record<string, string | undefined>;
}): Promise<HTMLElement> {
  const html = await renderToHtml(
    <FleetSection orgs={props.orgs} kills={props.kills} query={props.query ?? {}} now={NOW} />,
  );
  document.body.innerHTML = html;
  return document.body;
}

const card = (root: HTMLElement, id: 'fleet-orgs' | 'fleet-kills') =>
  root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeAll(async () => {
  // Pay the module graph's first Fizz render in a hook, not under one test's timeout.
  await render({ orgs: orgs([row()]), kills: kills([kill()]) });
}, 120_000);

afterEach(() => {
  document.body.innerHTML = '';
});

describe('FleetVerdictChip — one chip per FleetVerdict, word + glyph', () => {
  const ROLE: Record<FleetVerdict, string> = {
    ok: 'bg-(--el-tint-mint)',
    running_not_debited: 'bg-(--el-tint-rose)',
    debited_nothing_running: 'bg-(--el-tint-rose)',
    exhausted_still_running: 'bg-(--el-tint-rose)',
    balance_unknown: 'bg-(--el-chip-bg)',
    not_charged: 'bg-(--el-chip-bg)',
  };

  it('the map is total over the closed union', () => {
    expect(Object.keys(FLEET_VERDICT_CHIP).sort()).toEqual(Object.keys(ROLE).sort());
  });

  it.each(Object.keys(ROLE) as FleetVerdict[])('%s', async (verdict) => {
    document.body.innerHTML = await renderToHtml(<FleetVerdictChip verdict={verdict} />);
    const chip = document.querySelector<HTMLElement>(`[data-verdict="${verdict}"]`);
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toBe(fleet.verdict[verdict]);
    expect(chip!.getAttribute('title')).toBe(fleet.verdictHint[verdict]);
    // A glyph beside the word — colour is never the only signal.
    expect(chip!.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(chip!.className).toContain(ROLE[verdict]);
  });
});

describe('organisations card', () => {
  it('populated: mismatched first with a danger rail, links to the tenant page, every cell the design draws', async () => {
    const root = await render({
      orgs: orgs(
        [
          row({
            organizationId: 'org_globex',
            name: 'Globex',
            byWorkload: { ci_runner: 3, hosted_agent: 0, code_graph_index: 0, agent_instance: 2 },
            accruedMinutesInWindow: 0,
            latestAccrualTickAt: minAgo(22),
            confirmedCreditsThisMonth: 4_018,
            balanceCredits: -12,
            verdicts: ['running_not_debited', 'exhausted_still_running'],
          }),
          row({
            organizationId: 'org_initech',
            name: 'Initech',
            accruedMinutesInWindow: 0,
            latestAccrualTickAt: minAgo(31),
            confirmedCreditsThisMonth: 1_240,
            pendingCredits: 85,
            pendingSince: minAgo(34),
            verdicts: ['running_not_debited'],
          }),
          row(),
          row({
            organizationId: 'org_moooon',
            name: 'moooon B.V.',
            isMeta: true,
            plan: { kind: 'exempt', ciBurstOverride: null },
            verdicts: ['not_charged'],
          }),
          row({ organizationId: 'org_nw', name: 'Northwind', verdicts: ['balance_unknown'] }),
        ],
        {
          total: 41,
          pageCount: 2,
          mismatched: 3,
          ciRunners: 1_284,
          hostedAgents: 96,
          agentInstances: 37,
        },
      ),
      kills: kills([kill()]),
    });
    const c = card(root, 'fleet-orgs')!;
    expect(c.getAttribute('data-state')).toBe('populated');
    expect(c.textContent).toContain(fleet.orgs.title);
    expect(c.textContent).toContain('3 mismatched');
    expect(c.textContent).toContain('41 orgs running');
    expect(c.textContent).toContain('1,284');
    expect(c.textContent).toContain('96');
    expect(c.textContent).toContain(fleet.orgs.group.plan);
    expect(c.textContent).toContain(fleet.orgs.group.uncapped);
    expect(c.textContent).toContain('CI minutes · last 10 min');

    const rows = [...c.querySelectorAll('tbody tr')] as HTMLElement[];
    expect(rows.map((r) => r.getAttribute('data-org'))).toEqual([
      'org_globex',
      'org_initech',
      'org_acme',
      'org_moooon',
      'org_nw',
    ]);
    // The rail on mismatched rows only; never on the neutral verdicts.
    expect(rows.map((r) => r.querySelector('td')!.getAttribute('data-rail'))).toEqual([
      'danger',
      'danger',
      null,
      null,
      null,
    ]);
    // The door: the org name links to the tenant page.
    expect(rows[0]!.querySelector('a')!.getAttribute('href')).toBe('/admin/tenants/org_globex');
    // Two reasons, two chips, in the service's order.
    expect(
      [...rows[0]!.querySelectorAll('[data-verdict]')].map((n) => n.getAttribute('data-verdict')),
    ).toEqual(['running_not_debited', 'exhausted_still_running']);

    expect(rows[0]!.textContent).toContain('none');
    expect(rows[0]!.textContent).toContain('last tick 22 min ago');
    expect(rows[0]!.textContent).toContain('balance -12');
    expect(rows[1]!.textContent).toContain('+85 pending · 34 min');
    expect(rows[1]!.textContent).toContain('1,240');
    expect(rows[2]!.textContent).toContain('Max · 10 per person');
    expect(rows[2]!.textContent).toContain('42 of 25');
    expect(rows[2]!.textContent).toContain('386 min');
    expect(rows[3]!.textContent).toContain('meta org · isMeta');
    expect(rows[3]!.textContent).toContain('not charged');
    expect(rows[3]!.textContent).not.toContain('18,420');
    expect(rows[4]!.textContent).toContain('balance unreadable');

    expect(c.textContent).toContain('Showing 1–25 of 41');
    const next = c.querySelector('nav a');
    expect(next!.getAttribute('href')).toBe('?fleetPage=2');
  });

  it('each workload reads against its own plan figure, and nothing names a pool (MOTIR-9377)', async () => {
    const root = await render({
      orgs: orgs([
        row({
          organizationId: 'org_std',
          name: 'Halcyon',
          plan: STANDARD,
          byWorkload: { ci_runner: 4, hosted_agent: 1, code_graph_index: 2, agent_instance: 0 },
          agentsLive: 0,
        }),
        row({
          organizationId: 'org_pro',
          name: 'Initech',
          plan: PRO,
          // 4 running, 7 live: the agent-instance cell reads the LIVE count (MOTIR-9954).
          byWorkload: { ci_runner: 2, hosted_agent: 2, code_graph_index: 0, agent_instance: 4 },
          agentsLive: 7,
        }),
      ]),
      kills: kills([]),
    });
    const c = card(root, 'fleet-orgs')!;
    expect(c.textContent).not.toContain('500');
    expect(c.textContent).not.toMatch(/pool/i);
    const [std, pro] = [...c.querySelectorAll('tbody tr')] as HTMLElement[];
    const cells = (r: HTMLElement) => [...r.querySelectorAll('td')].map((td) => td.textContent);
    // Organisation · Plan · CI · hosted · agent instances · index · …
    expect(cells(std!).slice(1, 6)).toEqual([
      'Standard · 1 per person',
      '4 of 5',
      '1 of 1',
      '0 of 5',
      '2',
    ]);
    expect(cells(pro!).slice(1, 6)).toEqual([
      'Pro · 5 per person',
      '2 of 10',
      '2 of 3',
      '7 of 30',
      '0',
    ]);
    // At the figure the bar is full and takes the warning fill; under it, the accent.
    const hostedBar = std!.querySelectorAll('td')[3]!.querySelector('[data-at-figure]');
    expect(hostedBar!.className).toContain('bg-(--el-warning)');
    expect(std!.querySelectorAll('td')[2]!.querySelector('[data-at-figure]')).toBeNull();
    // The index cell is a bare count, always.
    expect(std!.querySelectorAll('td')[5]!.querySelector('[aria-hidden]')).toBeNull();
  });

  it('an exempt org reads No plan limit, an unknown plan names its key, and an override is marked', async () => {
    const root = await render({
      orgs: orgs([
        row({ organizationId: 'org_meta', plan: { kind: 'exempt', ciBurstOverride: null } }),
        row({
          organizationId: 'org_legacy',
          plan: { kind: 'plan_unknown', planKey: 'legacy_tier' },
        }),
        row({ organizationId: 'org_unread', plan: { kind: 'plan_unknown', planKey: null } }),
        row({ organizationId: 'org_over', plan: capped('max', 'Max', [5, 10, 50, 7], 'override') }),
      ]),
      kills: kills([]),
    });
    const [meta, legacy, unread, over] = [
      ...card(root, 'fleet-orgs')!.querySelectorAll('tbody tr'),
    ] as HTMLElement[];
    const cells = (r: HTMLElement) => [...r.querySelectorAll('td')].map((td) => td.textContent);

    expect(cells(meta!).slice(1, 6)).toEqual([fleet.orgs.plan.exempt, '42', '6', '3', '2']);
    expect(meta!.textContent).not.toContain(' of ');
    for (const td of [...meta!.querySelectorAll('td')].slice(2, 6)) {
      expect(td.querySelector('[aria-hidden]')).toBeNull();
    }

    expect(cells(legacy!)[1]).toBe(`Plan unknown · legacy_tier${fleet.orgs.plan.unknownNote}`);
    expect(cells(legacy!).slice(2, 6)).toEqual(['42', '6', '3', '2']);
    expect(cells(unread!)[1]).toBe(`Plan unknown${fleet.orgs.plan.unknownNote}`);

    expect(cells(over!)[2]).toBe(`42 of 7${fleet.orgs.override}`);
    expect(cells(over!)[3]).toBe('6 of 5');
  });

  it('nothing running: a healthy empty in words, no table, and the kills card still renders', async () => {
    const root = await render({ orgs: orgs([]), kills: kills([kill()]) });
    const c = card(root, 'fleet-orgs')!;
    expect(c.getAttribute('data-state')).toBe('empty');
    expect(c.textContent).toContain(fleet.orgs.noMismatch);
    expect(c.textContent).toContain(fleet.orgs.empty.title);
    expect(c.querySelector('table')).toBeNull();
    expect(card(root, 'fleet-kills')!.getAttribute('data-state')).toBe('populated');
  });

  it('read failed: the card says nothing loaded and renders no figure; kills unaffected', async () => {
    const root = await render({ orgs: { status: 'failed' }, kills: kills([kill()]) });
    const c = card(root, 'fleet-orgs')!;
    expect(c.getAttribute('data-state')).toBe('failed');
    expect(c.querySelector('[role="alert"]')!.textContent).toContain(fleet.orgs.error.title);
    expect(c.textContent).toContain(fleet.orgs.error.body);
    expect(c.querySelector('table')).toBeNull();
    expect(c.textContent).not.toMatch(/\d+ mismatched|orgs running/);
    expect(card(root, 'fleet-kills')!.getAttribute('data-state')).toBe('populated');
  });
});

describe('fleet disabled on this deployment', () => {
  it('ONE card replaces both: no table, no kills list, no figure', async () => {
    const root = await render({
      orgs: { status: 'ok', data: { meter: 'disabled' } },
      kills: { status: 'ok', data: { meter: 'disabled' } },
    });
    const c = root.querySelector('[data-testid="fleet-disabled"]')!;
    expect(c.textContent).toContain(fleet.disabled.title);
    expect(c.textContent).toContain(fleet.disabled.pill);
    expect(c.textContent).toContain(fleet.disabled.empty.title);
    expect(card(root, 'fleet-orgs')).toBeNull();
    expect(card(root, 'fleet-kills')).toBeNull();
    expect(root.querySelector('table')).toBeNull();
  });
});

describe('reconciler kills card', () => {
  it('populated: app, machine, age, reason in words, action, org link', async () => {
    const root = await render({
      orgs: orgs([row()]),
      kills: kills(
        [
          kill(),
          kill({
            id: 'k2',
            app: 'motir-agents-acme',
            machineId: '91a07c44e2d118',
            machineName: 'agent-inst-2',
            reason: 'org_stopped',
            action: 'stopped',
            organizationId: 'org_acme',
            organizationName: 'Acme Corp',
            ageSeconds: 6 * 86400 + 3 * 3600,
            decidedAt: minAgo(19),
          }),
        ],
        { total: 63, pageCount: 3 },
      ),
      query: { reason: 'no_credit', page: '2', fleetPage: '2' },
    });
    const c = card(root, 'fleet-kills')!;
    expect(c.textContent).toContain('63 in 24 h');
    expect(c.textContent).not.toContain('failed');
    const rows = [...c.querySelectorAll('tbody tr')] as HTMLElement[];
    expect(rows[0]!.textContent).toContain('3 min ago');
    expect(rows[0]!.textContent).toContain('motir-fleet');
    expect(rows[0]!.textContent).toContain('3d8e5f1c2a9b47');
    expect(rows[0]!.textContent).toContain('ci-runner-7f3a');
    expect(rows[0]!.textContent).toContain('2 h 14 min');
    expect(rows[0]!.textContent).toContain('No record');
    expect(rows[0]!.textContent).toContain('no live charged record named this machine');
    expect(rows[0]!.textContent).toContain('Destroyed');
    expect(rows[0]!.textContent).toContain('No organisation on record');
    expect(rows[1]!.textContent).toContain('Org stopped');
    expect(rows[1]!.textContent).toContain('Stopped');
    expect(rows[1]!.textContent).toContain('6 d 3 h');
    expect(rows[1]!.querySelector('a')!.getAttribute('href')).toBe('/admin/tenants/org_acme');
    // Paging the kills keeps every other list's place.
    expect(c.querySelector('nav a')!.getAttribute('href')).toBe(
      '?reason=no_credit&page=2&fleetPage=2&killsPage=2',
    );
  });

  it('none in the window: a healthy empty in words', async () => {
    const root = await render({ orgs: orgs([row()]), kills: kills([]) });
    const c = card(root, 'fleet-kills')!;
    expect(c.getAttribute('data-state')).toBe('empty');
    expect(c.textContent).toContain(fleet.kills.none);
    expect(c.textContent).toContain(fleet.kills.empty.title);
    expect(c.querySelector('table')).toBeNull();
  });

  it('a failed destroy: danger pill, the rail, the failure verbatim, and a head count', async () => {
    const root = await render({
      orgs: orgs([row()]),
      kills: kills([
        kill({
          id: 'kf',
          completedAt: null,
          failureDetail:
            'fly: 503 Service Unavailable on DELETE /v1/apps/motir-fleet/machines/e44c',
        }),
        kill({ id: 'ks', action: 'stopped', completedAt: null, failureDetail: 'fly: 409' }),
        kill(),
      ]),
    });
    const c = card(root, 'fleet-kills')!;
    expect(c.textContent).toContain('2 failed');
    const rows = [...c.querySelectorAll('tbody tr')] as HTMLElement[];
    expect(rows[0]!.getAttribute('data-failed')).toBe('true');
    expect(rows[0]!.querySelector('td')!.getAttribute('data-rail')).toBe('danger');
    expect(rows[0]!.textContent).toContain('Destroy failed');
    expect(rows[0]!.textContent).toContain(
      'Not completed — fly: 503 Service Unavailable on DELETE /v1/apps/motir-fleet/machines/e44c',
    );
    expect(rows[1]!.textContent).toContain('Stop failed');
    expect(rows[2]!.getAttribute('data-failed')).toBeNull();
    expect(rows[2]!.querySelector('td')!.getAttribute('data-rail')).toBeNull();
  });

  it('read failed: the kills card alone shows its error; the organisations render', async () => {
    const root = await render({ orgs: orgs([row()]), kills: { status: 'failed' } });
    const c = card(root, 'fleet-kills')!;
    expect(c.getAttribute('data-state')).toBe('failed');
    expect(c.textContent).toContain(fleet.kills.error.title);
    expect(c.querySelector('table')).toBeNull();
    expect(card(root, 'fleet-orgs')!.getAttribute('data-state')).toBe('populated');
  });

  it('both reads failed: each card shows its own error', async () => {
    const root = await render({ orgs: { status: 'failed' }, kills: { status: 'failed' } });
    expect(card(root, 'fleet-orgs')!.getAttribute('data-state')).toBe('failed');
    expect(card(root, 'fleet-kills')!.getAttribute('data-state')).toBe('failed');
  });
});

describe('the formatting helpers', () => {
  it('durations and relative ages in the design grain', async () => {
    const { createTranslator } = await import('next-intl');
    const t = createTranslator({
      locale: 'en',
      messages: en,
      namespace: 'platformAdmin.monitoring.fleet',
    } as never) as never;
    expect(duration(t, 42)).toBe('42 s');
    expect(duration(t, 48 * 60)).toBe('48 min');
    expect(duration(t, 2 * 3600)).toBe('2 h');
    expect(duration(t, 2 * 3600 + 14 * 60)).toBe('2 h 14 min');
    expect(duration(t, 6 * 86400)).toBe('6 d');
    expect(duration(t, 6 * 86400 + 3 * 3600)).toBe('6 d 3 h');
    expect(ago(t, 30)).toBe('30 s ago');
    expect(ago(t, 3 * 60)).toBe('3 min ago');
    expect(ago(t, 2 * 3600 + 59 * 60)).toBe('2 h ago');
    expect(ago(t, 3 * 86400)).toBe('3 d ago');
  });

  it('hrefWith drops empty params and page 1', () => {
    expect(hrefWith({ fleetPage: '3', q: '' }, 'fleetPage', 1)).toBe('?');
    expect(hrefWith({ q: 'acme' }, 'killsPage', 2)).toBe('?q=acme&killsPage=2');
  });
});
