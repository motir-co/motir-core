import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFormatter, createTranslator } from 'next-intl';
import { Window } from 'happy-dom';
import en from '@/messages/en.json';
import type { RawProviderReconciliation } from '@/lib/ai/motirAiClient';
import { PROVIDER_RECONCILIATION, USAGE, withIds } from '../fixtures/motirAiContract/platformReads';

/**
 * Story MOTIR-11350's motir-core INTEGRATION GATE (MOTIR-11388) — the provider-bill
 * reconciliation seam, assembled: motir-ai's RECORDED body for
 * `GET /v1/platform/usage/provider-reconciliation` → the platform read client →
 * `platformReadService.getEstateUsage`'s DTO → the server output of
 * `/admin/usage?period=YYYY-MM`. Real Postgres and the real platform-staff gate; the
 * session is the one thing mocked, and motir-ai is faked at `fetch` in this process
 * (the page and the service run in-process, so the stub is reachable).
 *
 * The unit suites stub the next layer down, so none of them can see a field the
 * client renames, the mapper drops or the page never reads. This file drives the
 * three together for every source, every status, a day past tolerance, findings
 * with and without a differing side, an unreconciled provider, an empty month, and
 * both failure modes; then it pins the read-only guarantee by recording every
 * outbound request. The access and audit boundary for the same read lives in
 * `consoleGate.test.ts`'s loops.
 */

let currentSession: { user: { id: string } } | null = null;
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));
vi.mock('next/navigation', async () => ({
  ...(await import('../helpers/serverPageHarness')).navigationHooks(),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as 'platformAdmin' }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));

const { db } = await import('@/lib/db');
const { platformReadService } = await import('@/lib/services/platformReadService');
const { default: UsagePage } = await import('@/app/(admin)/admin/usage/page');
const { createTestUser } = await import('../fixtures/userFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');
const { renderToHtml } = await import('../helpers/serverPageHarness');

const RECON_PATH = '/v1/platform/usage/provider-reconciliation';
const USAGE_PATH = '/v1/platform/usage';
/** The page's Failed usage section reads this on its own (MOTIR-11794). */
const FAILED_PATH = '/v1/admin/gateway-usage/failed-groups';
const copy = en.platformAdmin.usage;

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
}
let seen: Seen[] = [];
/** motir-ai unreachable: every request throws, as a refused connection does. */
let down = false;
/** Paths that answer a problem+json error instead of their recording. */
let failing = new Set<string>();
/** The reconciliation body motir-ai answers — the recording unless a case swaps it. */
let reconciliationBody: RawProviderReconciliation = PROVIDER_RECONCILIATION;

const ids = { org: 'org_seam', ws: 'ws_seam', project: 'project_seam' };

function fakeMotirAi(input: string | URL | Request, init?: RequestInit): Response {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  seen.push({ method, path: url.pathname, query: url.searchParams });
  if (down) throw new TypeError('fetch failed');
  if (failing.has(url.pathname)) {
    return new Response(
      JSON.stringify({
        type: 'about:blank',
        title: 'Service unavailable',
        status: 503,
        code: 'upstream_unavailable',
      }),
      { status: 503, headers: { 'content-type': 'application/problem+json' } },
    );
  }
  switch (url.pathname) {
    case USAGE_PATH:
      return Response.json(withIds(USAGE, ids));
    case RECON_PATH:
      return Response.json(reconciliationBody);
    case FAILED_PATH:
      return Response.json({ groups: [] });
    default:
      return new Response('{}', { status: 404 });
  }
}

let principal: { userId: string; email: string; role: 'support' };

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  const staff = await createTestUser({ email: 'ops+provider-bills@moooon.net' });
  await adminDb.user.update({ where: { id: staff.id }, data: { platformRole: 'support' } });
  principal = { userId: staff.id, email: staff.email, role: 'support' };
  currentSession = { user: { id: staff.id } };

  seen = [];
  down = false;
  failing = new Set();
  reconciliationBody = PROVIDER_RECONCILIATION;
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => fakeMotirAi(input, init)),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** `/admin/usage?period=…` as the framework renders it, parsed into a document. */
async function renderUsage(period: string): Promise<Document> {
  const tree = await UsagePage({ searchParams: Promise.resolve({ period }) });
  const html = await renderToHtml(tree);
  const window = new Window();
  window.document.body.innerHTML = html;
  return window.document as unknown as Document;
}

const one = (root: ParentNode, selector: string): Element => {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`no element matches ${selector}`);
  return el;
};
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ');
const section = (doc: Document) => one(doc, '[data-testid="usage-provider-bills"]');
const dayRow = (doc: Document, provider: string, day: string) =>
  one(doc, `[data-testid="provider-days-${provider}"] tr[data-day="${day}"]`);

describe('1 · the recorded body reaches the page field for field', () => {
  it('client → DTO: the service hands the page the recording unchanged, read for the chosen month', async () => {
    const { reconciliation } = await platformReadService.getEstateUsage(principal, '2026-09');
    expect(reconciliation).toStrictEqual(PROVIDER_RECONCILIATION);
    const call = seen.find((s) => s.path === RECON_PATH)!;
    expect(call.query.get('period')).toBe('2026-09');
  });

  it('every source value is tagged on its own day, beside the recorded and billed cost and the gap', async () => {
    const doc = await renderUsage('2026-09');
    const cases = [
      ['anthropic', '2026-09-01', 'api', '$2.00', '$3.00', '$1.00'],
      ['deepseek', '2026-09-01', 'balance_snapshot', '$0.90', '$0.91', '$0.01'],
      ['igate-export', '2026-09-01', 'export', '$0.10', '$0.10', '$0.00'],
      ['moonshotai', '2026-09-01', 'none', '$0.30', null, null],
    ] as const;
    for (const [provider, day, source, recorded, billed, gap] of cases) {
      const row = dayRow(doc, provider, day);
      const tag = one(row, '[data-testid="source-tag"]');
      expect(tag.getAttribute('data-source'), provider).toBe(source);
      expect(text(tag), provider).toContain(copy.reconciliation.source[source]);
      expect(text(row), provider).toContain(recorded);
      if (billed) expect(text(row), provider).toContain(billed);
      if (gap) expect(text(one(row, '[data-testid="gap"]')), provider).toContain(gap);
      else expect(row.querySelector('[data-testid="gap"]'), provider).toBeNull();
    }
    // Every provider the body lists has its own day grid, and every day it reads.
    for (const p of PROVIDER_RECONCILIATION.providers) {
      const grid = one(doc, `[data-testid="provider-days-${p.provider}"]`);
      expect(grid.querySelectorAll('tr[data-day]'), p.provider).toHaveLength(p.days.length);
    }
  });

  it('reconciled, failed and unreconciled each render their own mark; the unreconciled provider is listed', async () => {
    const doc = await renderUsage('2026-09');
    const mark = (provider: string, day: string) =>
      one(dayRow(doc, provider, day), '[data-testid="status-mark"]');

    expect(mark('anthropic', '2026-09-01').getAttribute('data-status')).toBe('reconciled');
    expect(text(mark('anthropic', '2026-09-01'))).toContain(copy.reconciliation.status.reconciled);

    const failed = mark('deepseek', '2026-09-02');
    expect(failed.getAttribute('data-status')).toBe('failed');
    expect(text(failed)).toContain(copy.reconciliation.status.failed);
    expect(text(failed)).toContain('UTC');

    const unrecorded = mark('anthropic', '2026-09-02');
    expect(unrecorded.getAttribute('data-status')).toBe('failed');
    expect(text(unrecorded)).toContain(copy.reconciliation.status.notRecorded);

    const unreconciled = mark('moonshotai', '2026-09-01');
    expect(unreconciled.getAttribute('data-status')).toBe('unreconciled');
    expect(text(unreconciled)).toContain(copy.reconciliation.status.unreconciled);

    const list = one(section(doc), '[data-testid="usage-unreconciled-providers"]');
    expect(
      [...list.querySelectorAll('li[data-provider]')].map((li) => li.getAttribute('data-provider')),
    ).toEqual(PROVIDER_RECONCILIATION.unreconciledProviders);
  });

  it('a day past tolerance is marked, carries its estimated-row count beside the gap, and opens its per-model breakdown', async () => {
    const doc = await renderUsage('2026-09');
    const row = dayRow(doc, 'anthropic', '2026-09-01');
    expect(row.getAttribute('data-past-tolerance')).toBe('true');
    expect(text(one(row, '[data-testid="past-tolerance"]'))).toContain(
      copy.reconciliation.pastTolerance,
    );
    expect(text(one(row, '[data-testid="estimated-rows"]'))).toContain('3 rows estimated');
    // The breakdown is one disclosure; the day without per-model rows draws none.
    expect(one(row, 'button[aria-expanded="false"]')).toBeTruthy();
    expect(dayRow(doc, 'deepseek', '2026-09-01').querySelector('button[aria-expanded]')).toBeNull();
    // A day within tolerance is not marked.
    expect(
      dayRow(doc, 'deepseek', '2026-09-01').querySelector('[data-testid="past-tolerance"]'),
    ).toBeNull();
  });

  it('a finding names its provider, day, both figures, gap, models and side; one with no side names none', async () => {
    const doc = await renderUsage('2026-09');
    const rows = [...one(doc, '[data-testid="usage-reconciliation-findings"] tbody').children];
    expect(rows).toHaveLength(PROVIDER_RECONCILIATION.findings.length);

    const [withSide, noSide] = rows as [Element, Element];
    for (const expected of ['Anthropic', 'Sep', '$2.00', '$3.00', '$1.00', 'claude-a']) {
      expect(text(withSide)).toContain(expected);
    }
    const side = one(withSide, '[data-testid="differing-side"] [data-side]');
    expect(side.getAttribute('data-side')).toBe('motir-ai');
    expect(text(side)).toContain(copy.reconciliation.side['motir-ai']);

    const noSideCell = one(noSide, '[data-testid="differing-side"]');
    expect(noSideCell.querySelector('[data-side]')).toBeNull();
    for (const label of Object.values(copy.reconciliation.side).filter(
      (l) => l !== copy.reconciliation.side.unnamed,
    )) {
      expect(text(noSideCell)).not.toContain(label);
    }
    expect(text(noSideCell)).not.toMatch(/undefined|null|^\s*$/);
  });

  it('a month with no reconciliation days renders the empty state, not the error state', async () => {
    reconciliationBody = {
      period: '2026-09',
      providers: [],
      findings: [],
      unreconciledProviders: [],
    };
    const doc = await renderUsage('2026-09');
    expect(section(doc).querySelector('[data-testid="usage-reconciliation-empty"]')).toBeTruthy();
    expect(text(section(doc))).not.toContain(copy.reconciliation.error.title);
  });
});

describe('2 · a failed read takes down the section, never the page', () => {
  it('motir-ai unreachable: no throw, the section shows its error state and the sheets their own', async () => {
    down = true;
    const doc = await renderUsage('2026-09');
    expect(text(section(doc))).toContain(copy.reconciliation.error.title);
    expect(text(doc.body)).toContain(copy.unavailable.title);
  });

  it('a problem+json error on the reconciliation route alone: the section errors, the sheets render', async () => {
    failing = new Set([RECON_PATH]);
    const doc = await renderUsage('2026-09');
    expect(text(section(doc))).toContain(copy.reconciliation.error.title);
    expect(section(doc).querySelector('[data-testid^="provider-days-"]')).toBeNull();
    expect(doc.querySelector('[data-testid="usage-categories"]')).toBeTruthy();
    expect(doc.querySelector('[data-testid="usage-figure-charged"]')).toBeTruthy();
    expect(text(doc.body)).not.toContain(copy.unavailable.title);
  });
});

describe('3 · read-only: the page and the read only ever GET', () => {
  // Since MOTIR-11794 the page also renders the Failed usage section, whose own
  // read is the one GET outside /v1/platform/usage; its Replay is a POST that
  // only an operator's press sends, never a render.
  it('every request recorded while staff render the page and call the read', async () => {
    await renderUsage('2026-09');
    await platformReadService.getEstateUsage(principal, '2026-09');
    expect(seen.length).toBeGreaterThanOrEqual(5);
    expect(new Set(seen.map((s) => s.path))).toEqual(
      new Set([USAGE_PATH, RECON_PATH, FAILED_PATH]),
    );
    for (const s of seen) {
      expect(s.method, s.path).toBe('GET');
      expect(s.path.startsWith(USAGE_PATH) || s.path === FAILED_PATH, s.path).toBe(true);
    }
  });
});
