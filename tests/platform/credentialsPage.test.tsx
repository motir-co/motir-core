import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFormatter, createTranslator } from 'next-intl';
import { db } from '@/lib/db';
import en from '@/messages/en.json';
import type { PlatformCredentialsDTO } from '@/lib/dto/platformCredentials';
import { probeCredentialExpiry } from '@/lib/health/credentialExpiryProbe';
import { CREDENTIAL_INVENTORY_HREF } from '@/lib/health/credentialInventory';
import type { DeclaredCredential } from '@/lib/health/credentialRegistry';
import {
  judgeCredentials,
  platformCredentialsService,
} from '@/lib/services/platformCredentialsService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { renderToHtml } from '../helpers/serverPageHarness';

// THE CONSOLE'S CREDENTIALS PAGE (MOTIR-9408, design MOTIR-11084). The page gate
// runs for real over a real session and the real `platformRole` column; the
// read is stubbed at the service object with DTOs the service's own judge
// builds from the SHIPPED probe at the design's fixed clock, so every state the
// design draws is reached with the day counts the build computes.

class NotFoundSentinel extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));
vi.mock('next/navigation', async () => ({
  ...(await import('../helpers/serverPageHarness')).navigationHooks(),
  notFound: () => {
    throw new NotFoundSentinel();
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as 'platformAdmin' }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));

const { default: Page } = await import('@/app/(admin)/admin/credentials/page');

const NOW = new Date('2026-11-12T09:14:00.000Z');

function cred(envVar: string, expiresAt: string, over: Partial<DeclaredCredential> = {}) {
  return {
    envVar,
    name: `${envVar} token`,
    expiresAt,
    renewal: `mint it the way MOTIR-1908 did, then set \`${envVar}\` and move this entry's expiresAt`,
    source: 'MOTIR-1933, the card that recorded it',
    ...over,
  } satisfies DeclaredCredential;
}

/** The design's mixed board: 1 expired, 1 expiring, 1 not set, 3 healthy. */
const MIXED = [
  cred('GITHUB_BILLING_TOKEN', '2027-07-31'),
  cred('STATUS_PAGE_READ_TOKEN', '2046-09-27'),
  cred('EXPIRED_TOKEN', '2026-11-09'),
  cred('EXPIRING_TOKEN', '2026-11-24'),
  cred('UNSET_TOKEN', '2027-03-01'),
  cred('LATER_TOKEN', '2028-02-29'),
];
const SET = {
  GITHUB_BILLING_TOKEN: 'ghp_SECRET_must_not_render',
  STATUS_PAGE_READ_TOKEN: 'sp_SECRET_must_not_render',
  EXPIRED_TOKEN: 'x',
  EXPIRING_TOKEN: 'x',
  LATER_TOKEN: 'x',
};

function view(registry: DeclaredCredential[], env: Record<string, string>): PlatformCredentialsDTO {
  return judgeCredentials(registry, probeCredentialExpiry(registry, env, NOW));
}

let seq = 0;
async function signInAs(role: 'support' | 'operator' | 'superadmin' | null): Promise<void> {
  const user = await createTestUser({ email: `ops+credentials-page-${++seq}@example.test` });
  if (role) await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  currentSession = { user: { id: user.id } };
}

async function render(dto: PlatformCredentialsDTO): Promise<string> {
  await signInAs('support');
  vi.spyOn(platformCredentialsService, 'read').mockReturnValue(dto);
  return text(await renderToHtml(await Page()));
}

/** HTML text with React's comment markers dropped, so copy can be matched whole. */
function text(html: string): string {
  return html
    .replace(/<!-- -->/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

beforeEach(async () => {
  currentSession = null;
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the credentials page gate', () => {
  it('refuses a signed-in user who is not staff with the 404, and checks nothing', async () => {
    await signInAs(null);
    const read = vi.spyOn(platformCredentialsService, 'read');
    await expect(Page()).rejects.toBeInstanceOf(NotFoundSentinel);
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['support', 'operator', 'superadmin'] as const)('opens for %s', async (role) => {
    await signInAs(role);
    vi.spyOn(platformCredentialsService, 'read').mockReturnValue(view(MIXED, SET));
    const html = text(await renderToHtml(await Page()));
    expect(html).toContain('Platform · Credentials');
    expect(html).toContain('data-testid="credentials-card"');
  });
});

describe('the credentials card', () => {
  it('draws the mixed board: counts, rows in order, verdicts and the overall pill', async () => {
    const html = await render(view(MIXED, SET));

    expect(html).toContain('Declared credential expiries');
    expect(html).toContain('Checked at 09:14 UTC · Nov 12, 2026');
    expect(html).toContain('data-overall="expired"');
    expect(html).toContain('Expired · the daily check fails');
    expect(html).toContain('data-testid="credentials-counts"');
    expect(html).toContain('Each date is declared by whoever minted the token');

    // Rows in the table, in the design's order.
    const order = [...html.matchAll(/<tr data-credential="([A-Z_]+)"/g)].map((m) => m[1]);
    expect(order).toEqual([
      'EXPIRED_TOKEN',
      'EXPIRING_TOKEN',
      'UNSET_TOKEN',
      'GITHUB_BILLING_TOKEN',
      'LATER_TOKEN',
      'STATUS_PAGE_READ_TOKEN',
    ]);

    // Each state's day words.
    expect(html).toContain('Expired 3 days ago');
    expect(html).toContain('still set, so still in use');
    expect(html).toContain('11 days left');
    expect(html).toContain('inside the 30-day lead time');
    expect(html).toContain('variable not set here');
    expect(html).toContain('260 days');
    expect(html).toContain('warns from Jul 1, 2027');
    expect(html).toContain('7,258 days');
    expect(html).toContain('Jul 31, 2027');
    expect(html).toContain('2027-07-31');

    // Verdict pills and the rails.
    expect(html).toContain('data-verdict="expired"');
    expect(html).toContain('data-verdict="expiring"');
    expect(html).toContain('data-verdict="notSet"');
    expect(html).toContain('data-verdict="healthy"');
    expect(html).toContain('data-rail="danger"');
    expect(html).toContain('data-rail="warning"');
  });

  it('renders the renewal and source as text, card keys as links and backticks as code', async () => {
    const html = await render(view(MIXED, SET));
    expect(html).toContain('href="/items/MOTIR-1908"');
    expect(html).toContain('href="/items/MOTIR-1933"');
    expect(html).toMatch(/<code[^>]*>GITHUB_BILLING_TOKEN<\/code>/);
    expect(html).not.toContain('`');
  });

  it('never renders a value', async () => {
    const html = await render(view(MIXED, SET));
    expect(html).not.toContain('SECRET_must_not_render');
  });

  it('never renders registry text as HTML', async () => {
    const html = await render(
      view([cred('X_TOKEN', '2030-01-01', { renewal: '<b>bold</b>' })], { X_TOKEN: 'x' }),
    );
    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('reads Less than a day left and Expired today at the edges', async () => {
    const registry = [cred('TODAY', '2026-11-12'), cred('TOMORROW', '2026-11-13')];
    const html = await render(view(registry, { TODAY: 'x', TOMORROW: 'x' }));
    expect(html).toContain('Expired today');
    expect(html).toContain('Less than a day left');
  });

  it('reads expiring only, and none inside its lead time when all is healthy', async () => {
    const expiring = await render(
      view([cred('A', '2026-11-24'), cred('B', '2030-01-01')], { A: 'x', B: 'x' }),
    );
    expect(expiring).toContain('data-overall="expiring"');
    expect(expiring).toContain('Expiring · the daily check fails');

    vi.restoreAllMocks();
    const healthy = await render(view([cred('B', '2030-01-01')], { B: 'x' }));
    expect(healthy).toContain('data-overall="ok"');
    expect(healthy).toContain('None inside its lead time');
  });

  it('says Nothing checked when every variable is unset, with the rows still listed', async () => {
    const html = await render(view([cred('A', '2030-01-01'), cred('B', '2031-01-01')], {}));
    expect(html).toContain('data-overall="noneSet"');
    expect(html).toContain('Nothing checked');
    expect(html).not.toContain('data-overall="ok"');
    expect(html).toContain('data-testid="credentials-counts"');
  });

  it('draws the empty registry as a neutral inset, with no counts and no table', async () => {
    const html = await render(view([], {}));
    expect(html).toContain('data-overall="empty"');
    expect(html).toContain('No credential is registered');
    expect(html).toContain('lib/health/credentialRegistry.ts');
    expect(html).not.toContain('data-testid="credentials-counts"');
    expect(html).not.toContain('<table');
  });

  it('draws a read error with the message, Not checked, and no row', async () => {
    const html = await render({
      status: 'failed',
      checkedAt: NOW.toISOString(),
      message: 'credential registry: expiresAt "25-11-2026" is not an ISO date',
    });
    expect(html).toContain('Check failed at 09:14 UTC · Nov 12, 2026');
    expect(html).toContain('role="alert"');
    expect(html).toContain('The registry could not be checked');
    expect(html).toContain('credential registry: expiresAt "25-11-2026" is not an ISO date');
    expect(html).toContain('data-overall="notChecked"');
    expect(html).toContain('aria-label="Credentials not checked: the registry could not be read"');
    expect(html).not.toContain('data-testid="credentials-counts"');
    expect(html).not.toContain('data-credential=');
  });

  it('links the footer to the credential inventory', async () => {
    const html = await render(view(MIXED, SET));
    expect(CREDENTIAL_INVENTORY_HREF).toMatch(/^\/pages\/[a-z0-9]+$/);
    expect(html).toContain(`href="${CREDENTIAL_INVENTORY_HREF}"`);
    expect(html).toContain('credential inventory');
  });

  it('lists every row a second time as the phone list', async () => {
    const html = await render(view(MIXED, SET));
    expect(html).toContain('aria-label="Registered credentials"');
    expect([...html.matchAll(/<li[^>]*data-credential=/g)]).toHaveLength(MIXED.length);
  });
});
