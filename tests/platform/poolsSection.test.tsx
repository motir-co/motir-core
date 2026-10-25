// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToHtml } from '../helpers/serverPageHarness';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import type {
  PlatformPoolAccountDTO,
  PlatformPoolBlockDTO,
  PlatformPoolRequestDTO,
  PlatformPoolSpareDTO,
  PlatformPoolsDTO,
} from '@/lib/dto/platformFleetPools';
import type { FleetGrowthEventViewDTO } from '@/lib/dto/fleetPools';

// MONITORING · POOLS (MOTIR-9563 · design MOTIR-9561). The section rendered to
// HTML through Fizz over the REAL `en` catalogue, one case per state the mock
// draws: a Fly kind, a healthy AWS pool, an account past 70%, a quota AWS has not
// answered for, the Motir spare, the request and event lists, a block that
// failed, the whole read failing, and the pagers' URL grammar.

vi.mock('next-intl/server', async () => {
  const { createTranslator, createFormatter } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
    getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
  };
});

const { PoolsSection, poolRequestsParam, poolEventsParam } =
  await import('@/app/(admin)/admin/monitoring/_components/PoolsSection');
type PoolsRead = import('@/app/(admin)/admin/monitoring/_components/PoolsSection').PoolsRead;

const NOW = new Date('2026-10-25T12:00:00.000Z');
const minAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();
const dayAgo = (n: number) => minAgo(n * 24 * 60);
const p = en.platformAdmin.monitoring.pools;

function account(overrides: Partial<PlatformPoolAccountDTO> = {}): PlatformPoolAccountDTO {
  return {
    name: 'ci-iad-1',
    role: 'shared',
    state: 'active',
    grantedVcpu: 128,
    grantedReadAt: minAgo(120),
    usedVcpu: 40,
    percent: 31,
    toThreshold: 50,
    overThreshold: false,
    ...overrides,
  };
}

function spare(overrides: Partial<PlatformPoolSpareDTO> = {}): PlatformPoolSpareDTO {
  return {
    name: 'ci-iad-spare',
    state: 'active',
    grantedVcpu: 128,
    grantedReadAt: minAgo(60),
    ready: true,
    ...overrides,
  };
}

function request(overrides: Partial<PlatformPoolRequestDTO> = {}): PlatformPoolRequestDTO {
  return {
    account: 'ci-iad-1',
    desiredValue: 128,
    status: 'approved',
    grantedValue: 128,
    open: false,
    createdAt: dayAgo(10),
    lastReadAt: dayAgo(9),
    ...overrides,
  };
}

function event(overrides: Partial<FleetGrowthEventViewDTO> = {}): FleetGrowthEventViewDTO {
  return {
    createdAt: minAgo(30),
    triggeringAccount: 'ci-iad-1',
    vcpuInUse: 96,
    grantedQuota: 128,
    outcome: 'spare_promoted',
    spareAccount: 'ci-iad-spare',
    newAccount: 'ci-iad-spare-2',
    reason: null,
    ...overrides,
  };
}

function aws(
  overrides: Partial<Extract<PlatformPoolBlockDTO, { provider: 'aws' }>> = {},
): PlatformPoolBlockDTO {
  const accounts = overrides.accounts ?? [
    account(),
    account({ name: 'ci-iad-2', usedVcpu: 20, percent: 16, toThreshold: 70 }),
  ];
  return {
    fleetKind: 'ci_runner',
    provider: 'aws',
    pool: { grantedVcpu: 256, usedVcpu: 60, percent: 23, complete: true },
    accounts,
    spares: [spare()],
    requests: [request()],
    growthEvents: [event()],
    growthInFlight: false,
    ...overrides,
  };
}

function pools(blocks: PlatformPoolBlockDTO[]): PoolsRead {
  return { status: 'ok', data: { blocks } satisfies PlatformPoolsDTO };
}

const FLY_REST: PlatformPoolBlockDTO[] = [
  { fleetKind: 'hosted_agent', provider: 'fly' },
  { fleetKind: 'code_graph_index', provider: 'fly' },
  { fleetKind: 'agent_instance', provider: 'fly' },
];

async function render(read: PoolsRead, query: Record<string, string | undefined> = {}) {
  const tree = await PoolsSection({ read, query, now: NOW });
  document.body.innerHTML = await renderToHtml(tree);
  return document.body;
}

const block = (root: HTMLElement, kind: string) =>
  root.querySelector<HTMLElement>(`[data-testid="pool-${kind}"]`)!;
const rowOf = (root: HTMLElement, name: string) =>
  root.querySelector<HTMLElement>(`tr[data-account="${name}"]`)!;
const cells = (tr: HTMLElement) =>
  [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? '');

beforeAll(async () => {
  // Pay the module graph once, under the hook timeout.
  await render(pools([aws(), ...FLY_REST]));
}, 120_000);

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the Pools section', () => {
  it('renders one block per kind in the service order, each naming its provider in words', async () => {
    const root = await render(pools([aws(), ...FLY_REST]));
    expect(root.querySelector('h2')!.textContent).toBe(p.title);
    const blocks = [...root.querySelectorAll<HTMLElement>('[data-testid^="pool-"]')];
    expect(blocks.map((b) => b.getAttribute('data-testid'))).toEqual([
      'pool-ci_runner',
      'pool-hosted_agent',
      'pool-code_graph_index',
      'pool-agent_instance',
    ]);
    expect(blocks.map((b) => b.querySelector('h3')!.textContent)).toEqual([
      'Pool · CI runner',
      'Pool · Agent runner',
      'Pool · Indexer',
      'Pool · Agent hoster',
    ]);
    expect(block(root, 'ci_runner').textContent).toContain(p.provider.aws);
    expect(block(root, 'hosted_agent').textContent).toContain(p.provider.fly);
  });

  it('a Fly kind shows words only: no figure, no account, no spare, no list', async () => {
    const root = await render(pools([aws(), ...FLY_REST]));
    const fly = block(root, 'code_graph_index');
    expect(fly.getAttribute('data-state')).toBe('fly');
    expect(fly.textContent).toContain('Indexer runs on Fly');
    expect(fly.textContent).toContain(p.fly.body);
    for (const el of ['pool-total', 'account-rows', 'spare-line', 'quota-request-list']) {
      expect(fly.querySelector(`[data-element="${el}"]`)).toBeNull();
    }
    expect(fly.querySelector('[data-element="growth-event-list"]')).toBeNull();
    expect(fly.textContent).not.toMatch(/\d/);
  });

  it('a healthy AWS pool renders its total and each account row', async () => {
    const root = await render(pools([aws(), ...FLY_REST]));
    const total = block(root, 'ci_runner').querySelector('[data-element="pool-total"]')!;
    expect(total.getAttribute('data-complete')).toBe('true');
    expect(total.textContent).toContain('256 vCPU');
    expect(total.textContent).toContain('Capacity · granted quota of 2 shared accounts');
    expect(total.textContent).toContain('60 vCPU');
    expect(total.textContent).toContain('23%');
    expect(cells(rowOf(root, 'ci-iad-1'))).toEqual([
      'ci-iad-1',
      'Shared',
      'Active',
      '128 vCPUread 2 h ago',
      '40 vCPU',
      '31%',
      '50 vCPU to go',
    ]);
  });

  it('an account past 70% reads Over 70% in words, with the vCPU past it and a rail', async () => {
    const over = account({
      name: 'ci-iad-1',
      usedVcpu: 96,
      percent: 75,
      toThreshold: 0,
      overThreshold: true,
    });
    const atMark = account({
      name: 'ci-iad-2',
      grantedVcpu: 100,
      usedVcpu: 70,
      percent: 70,
      toThreshold: 0,
      overThreshold: true,
    });
    const root = await render(
      pools([aws({ accounts: [over, atMark], growthInFlight: true }), ...FLY_REST]),
    );
    const row = rowOf(root, 'ci-iad-1');
    expect(row.getAttribute('data-over')).toBe('true');
    expect(row.querySelector('td')!.getAttribute('data-rail')).toBe('warning');
    const mark = row.querySelector('[data-mark="over"]')!;
    // ⌈128 × 0.7⌉ = 90, so 96 is 6 past it.
    expect(mark.textContent).toBe('Over 70%6 vCPU past it');
    expect(mark.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(rowOf(root, 'ci-iad-2').querySelector('[data-mark="over"]')!.textContent).toContain(
      p.atThreshold,
    );
    const ci = block(root, 'ci_runner');
    expect(ci.textContent).toContain('2 accounts over 70%');
    expect(ci.textContent).toContain(p.growthInFlight);
  });

  it('a quota AWS has not answered for is the Not-read mark, and nothing derived from it is a number', async () => {
    const failed = account({
      name: 'ci-iad-2',
      grantedVcpu: null,
      grantedReadAt: dayAgo(3),
      usedVcpu: 12,
      percent: null,
      toThreshold: null,
    });
    const never = account({
      name: 'ci-iad-3',
      grantedVcpu: null,
      grantedReadAt: null,
      usedVcpu: 0,
      percent: null,
      toThreshold: null,
    });
    const root = await render(
      pools([
        aws({
          accounts: [account(), failed, never],
          pool: { grantedVcpu: 128, usedVcpu: 52, percent: null, complete: false },
        }),
        ...FLY_REST,
      ]),
    );
    for (const [name, readWords] of [
      ['ci-iad-2', 'last read 3 d ago'],
      ['ci-iad-3', p.neverRead],
    ] as const) {
      const row = rowOf(root, name);
      const mark = row.querySelector('[data-mark="not-read"]')!;
      expect(mark.querySelector('[aria-label]')!.getAttribute('aria-label')).toBe(p.notReadLabel);
      expect(mark.textContent).toBe(`${p.notRead}${readWords}`);
      const [, , , granted, , percent, toThreshold] = cells(row);
      expect(granted).not.toMatch(/\bvCPU\b/);
      expect(percent).toBe(p.notAvailable);
      expect(toThreshold).toBe(p.notAvailable);
      for (const text of [granted, percent, toThreshold]) expect(text).not.toContain('0');
    }
    // A partial sum is never the pool's capacity, and no percent is shown.
    const total = root.querySelector('[data-element="pool-total"]')!;
    expect(total.getAttribute('data-complete')).toBe('false');
    expect(total.textContent).not.toContain('128 vCPU');
    expect(total.textContent).toContain('2 accounts’ quota is not read, so the total is not known');
    const tiles = [...total.children].map((tile) => tile.firstElementChild!.textContent);
    // vCPU in use is measured, not read from AWS, so it stays a figure.
    expect(tiles).toEqual([p.notAvailable, '52 vCPU', p.notAvailable]);
  });

  it('a pool with no account yet shows words in every tile and no rows', async () => {
    const root = await render(
      pools([
        aws({
          accounts: [],
          spares: [],
          requests: [],
          growthEvents: [],
          pool: { grantedVcpu: 0, usedVcpu: 0, percent: null, complete: false },
        }),
        ...FLY_REST,
      ]),
    );
    const ci = block(root, 'ci_runner');
    const total = ci.querySelector('[data-element="pool-total"]')!;
    expect(total.getAttribute('data-state')).toBe('no-account');
    expect(total.textContent).toContain('fleet-admin add-shard');
    expect(total.textContent).not.toMatch(/\d/);
    expect(ci.querySelector('[data-element="account-rows"]')).toBeNull();
    expect(ci.textContent).toContain(p.spare.none);
    expect(ci.textContent).toContain(p.requests.empty);
    expect(ci.textContent).toContain(p.events.empty);
  });

  it('the spare line says ready or waiting, and why', async () => {
    const waiting = spare({ ready: false, grantedVcpu: 32 });
    const notRead = spare({ name: 'ci-iad-spare-2', ready: false, grantedVcpu: null });
    const root = await render(
      pools([
        aws({
          spares: [spare({ name: 'ci-iad-ready' }), waiting, notRead],
          requests: [
            request({
              account: 'ci-iad-spare',
              desiredValue: 128,
              status: 'case_opened',
              grantedValue: null,
              open: true,
              createdAt: minAgo(180),
            }),
          ],
        }),
        ...FLY_REST,
      ]),
    );
    const line = (name: string) => root.querySelector<HTMLElement>(`[data-spare="${name}"]`)!;
    expect(line('ci-iad-ready').textContent).toContain(p.spare.ready);
    expect(line('ci-iad-ready').textContent).toContain('128 vCPU granted · read 1 h ago');
    expect(line('ci-iad-ready').textContent).toContain(p.spare.readyBody);
    expect(line('ci-iad-spare').textContent).toContain(p.spare.waiting);
    expect(line('ci-iad-spare').textContent).toContain(
      'A raise to 128 vCPU was asked 3 h ago and is still open.',
    );
    expect(line('ci-iad-spare-2').textContent).toContain('Quota not read · last read 1 h ago');
    expect(line('ci-iad-spare-2').textContent).toContain(p.spare.notReadBody);
    expect(line('ci-iad-spare-2').textContent).not.toMatch(/\d+ vCPU/);
  });

  it('the request list keeps the service order and says what a denial left', async () => {
    const root = await render(
      pools([
        aws({
          requests: [
            request({
              status: 'pending',
              grantedValue: null,
              open: true,
              createdAt: minAgo(5),
              lastReadAt: null,
            }),
            request({
              account: 'ci-iad-2',
              status: 'denied',
              grantedValue: null,
              desiredValue: 256,
            }),
            request({ status: 'approved', createdAt: dayAgo(40) }),
          ],
        }),
        ...FLY_REST,
      ]),
    );
    const list = root.querySelector('[data-element="quota-request-list"]')!;
    expect(list.textContent).toContain('3 requests · 1 open');
    const rows = [...list.querySelectorAll<HTMLElement>('tbody tr')];
    expect(rows.map((r) => r.getAttribute('data-status'))).toEqual([
      'pending',
      'denied',
      'approved',
    ]);
    expect(cells(rows[0]!)).toEqual([
      'ci-iad-1',
      '128 vCPU',
      'Open · pending',
      'Not yet',
      '5 min ago',
      'not read yet',
    ]);
    expect(cells(rows[1]!).slice(2, 4)).toEqual(['Denied', 'Not grantedquota stays 128 vCPU']);
    expect(cells(rows[2]!)[4]).toBe('40 d ago');
    expect(list.querySelector('th[aria-sort="descending"]')!.textContent).toBe('Asked');
    for (const th of list.querySelectorAll('th')) expect(th.getAttribute('scope')).toBe('col');
  });

  it('the event list shows each outcome, and a refusal in AWS’s own words', async () => {
    const root = await render(
      pools([
        aws({
          growthEvents: [
            event({
              outcome: 'refused',
              spareAccount: null,
              newAccount: null,
              reason: 'The organization has reached its account limit.',
            }),
            event({ outcome: 'waiting_for_quota', newAccount: null }),
            event({ outcome: 'account_created', spareAccount: null, newAccount: 'ci-iad-4' }),
            event({ newAccount: null, triggeringAccount: null }),
          ],
        }),
        ...FLY_REST,
      ]),
    );
    const list = root.querySelector('[data-element="growth-event-list"]')!;
    const rows = [...list.querySelectorAll<HTMLElement>('tbody tr')];
    expect(rows.map((r) => r.getAttribute('data-outcome'))).toEqual([
      'refused',
      'waiting_for_quota',
      'account_created',
      'spare_promoted',
    ]);
    expect(rows[0]!.querySelector('td')!.getAttribute('data-rail')).toBe('danger');
    expect(rows[0]!.textContent).toContain(
      'AWS said: “The organization has reached its account limit.”',
    );
    expect(rows[0]!.textContent).toContain(p.events.refusedNote);
    expect(cells(rows[0]!)[2]).toBe('96 of 128 vCPU75% of its granted quota');
    expect(rows[1]!.textContent).toContain(p.events.waiting);
    expect(rows[2]!.textContent).toContain('ci-iad-4 added, with no spare to promote');
    expect(rows[3]!.textContent).toContain('ci-iad-spare joined the shared pool');
    expect(cells(rows[3]!)[1]).toBe(p.events.accountRemoved);
  });

  it('a kind whose read failed renders its own error; the other blocks render as usual', async () => {
    const root = await render(
      pools([aws(), { fleetKind: 'hosted_agent', provider: 'unavailable' }, ...FLY_REST.slice(1)]),
    );
    const failed = block(root, 'hosted_agent');
    expect(failed.getAttribute('data-state')).toBe('failed');
    expect(failed.querySelector('[role="alert"]')!.textContent).toContain(
      'Couldn’t read the Agent runner pool',
    );
    // No provider claimed and no figure.
    expect(failed.textContent).not.toContain(p.provider.aws);
    expect(failed.textContent).not.toContain(p.provider.fly);
    expect(failed.textContent).not.toMatch(/\d/);
    expect(block(root, 'ci_runner').getAttribute('data-state')).toBe('aws');
    expect(block(root, 'code_graph_index').getAttribute('data-state')).toBe('fly');
  });

  it('a whole read that failed renders one error for the section and no block', async () => {
    const root = await render({ status: 'failed' });
    expect(
      root.querySelector('[data-testid="pools-failed"] [role="alert"]')!.textContent,
    ).toContain(p.sectionError.title);
    expect(root.querySelectorAll('[data-testid^="pool-"]')).toHaveLength(0);
  });

  it('pages each list by its own per-kind param, keeping every other list’s place', async () => {
    const requests = Array.from({ length: 14 }, (_, i) =>
      request({ account: `ci-iad-${i + 1}`, createdAt: dayAgo(i + 1) }),
    );
    const growthEvents = Array.from({ length: 23 }, (_, i) =>
      event({ triggeringAccount: `ci-iad-${i + 1}`, createdAt: dayAgo(i + 1) }),
    );
    const query = { fleetPage: '2', [poolEventsParam('ci_runner')]: '2' };
    const root = await render(pools([aws({ requests, growthEvents }), ...FLY_REST]), query);

    const reqs = root.querySelector('[data-element="quota-request-list"]')!;
    expect(reqs.querySelectorAll('tbody tr')).toHaveLength(10);
    expect(reqs.textContent).toContain('Showing 1–10 of 14 · open first, then newest');
    expect(reqs.textContent).toContain('Page 1 of 2');
    const nextReq = reqs.querySelector<HTMLAnchorElement>('nav a')!;
    const reqParams = new URLSearchParams(nextReq.getAttribute('href')!.slice(1));
    expect(reqParams.get(poolRequestsParam('ci_runner'))).toBe('2');
    expect(reqParams.get(poolEventsParam('ci_runner'))).toBe('2');
    expect(reqParams.get('fleetPage')).toBe('2');
    expect(reqs.querySelector('nav')!.getAttribute('aria-label')).toBe(
      'CI runner quota raises pages',
    );

    const evs = root.querySelector('[data-element="growth-event-list"]')!;
    expect(evs.textContent).toContain('Showing 11–20 of 23 · newest first');
    expect(evs.textContent).toContain('Page 2 of 3');
    expect(evs.querySelector('tbody tr td:nth-child(2)')!.textContent).toBe('ci-iad-11');
  });

  it('a page past the end is the last page; junk is page 1', async () => {
    const requests = Array.from({ length: 14 }, (_, i) => request({ account: `ci-iad-${i + 1}` }));
    let root = await render(pools([aws({ requests }), ...FLY_REST]), {
      [poolRequestsParam('ci_runner')]: '9',
    });
    expect(root.textContent).toContain('Showing 11–14 of 14');
    root = await render(pools([aws({ requests }), ...FLY_REST]), {
      [poolRequestsParam('ci_runner')]: 'abc',
    });
    expect(root.textContent).toContain('Showing 1–10 of 14');
  });

  it('is read-only: no button, no form, and the only links are the pagers', async () => {
    const requests = Array.from({ length: 14 }, (_, i) => request({ account: `ci-iad-${i + 1}` }));
    const root = await render(pools([aws({ requests }), ...FLY_REST]));
    expect(root.querySelectorAll('button, form, input, select')).toHaveLength(0);
    for (const a of root.querySelectorAll('a')) expect(a.closest('nav')).not.toBeNull();
    expect(root.querySelector('code')!.textContent).toBe(
      'fleet-admin request-quota --account <name> --vcpu <n>',
    );
  });
});

// ── The catalogue ──────────────────────────────────────────────────────────────

type Tree = Record<string, unknown>;

function flatten(obj: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [kk, vv] of flatten(v as Tree, path)) out.set(kk, vv);
    } else if (typeof v === 'string') out.set(path, v);
  }
  return out;
}

/** Design copy the page has no surface for. `loading` is the Block skeleton's
 *  sentence: the page renders once every read has settled and never streams, so
 *  there is no loading state to draw — as for the Fleet section above it. */
const NOT_RENDERED = new Set(['loading']);

describe('the Pools catalogue', () => {
  const enPools = flatten(en.platformAdmin.monitoring.pools as Tree);
  const zhPools = flatten((zh as Tree & typeof en).platformAdmin.monitoring.pools as Tree);

  it('carries every string the design fixes, verbatim in en', () => {
    const notes = readFileSync('design/platform-admin/design-notes.md', 'utf8');
    const start = notes.indexOf('# AMENDMENT 2026-10-25 — Monitoring · Pools');
    expect(start, 'the pools amendment is in the design notes').toBeGreaterThan(-1);
    const end = notes.indexOf('\n# ', start + 1);
    const section = notes.slice(start, end === -1 ? undefined : end);
    const wrong: string[] = [];
    let rows = 0;
    for (const line of section.split('\n')) {
      // `| \`key\` | en |` rows; a `*` row summarises a group and is not a string.
      const m = /^\|\s*`([A-Za-z0-9_.]+)`\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
      if (!m || NOT_RENDERED.has(m[1]!)) continue;
      rows += 1;
      // The catalogue carries markup the table does not: strip its tags.
      const ours = enPools.get(m[1]!)?.replace(/<\/?[a-z]+>/g, '');
      if (ours !== m[2]!.replace(/`/g, '')) wrong.push(`${m[1]}: ${ours} ≠ ${m[2]}`);
    }
    expect(rows, 'the design Copy table parsed').toBeGreaterThan(60);
    expect(wrong).toEqual([]);
  });

  it('has a zh twin for every key, and no zh key without one', () => {
    expect([...zhPools.keys()].sort()).toEqual([...enPools.keys()].sort());
  });
});
