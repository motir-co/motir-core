// @vitest-environment happy-dom
// MOTIR-5779 — the ROUTE SMOKE for the preview gate's pages: `preview-access` on
// app.motir.co and each preview-host page (Building, Starting, Failed, the
// unsupported variant, Closed, Not found) render through their real route
// modules, each asserting its landmark heading, so later cards' CI opens them.
// The decisions behind them are `previewGateService.test.ts` and
// `gateProxy.test.ts`; here the service is stubbed and only the pages run.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { GATE_COOKIE, mintAdmission, mintGatePass } from '@/lib/preview/gate';
import type { PreviewGateView } from '@/lib/services/previewGateService';

const HOST = 'pr-14--portal.preview.motir.site';
const KEY = 'test-gate-signing-key';

const { requestHeaders, requestCookies } = vi.hoisted(() => ({
  requestHeaders: new Map<string, string>(),
  requestCookies: new Map<string, string>(),
}));
const { view, admit } = vi.hoisted(() => ({ view: vi.fn(), admit: vi.fn() }));
const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
const { resolveRequirement } = vi.hoisted(() => ({ resolveRequirement: vi.fn() }));
const { redirect, notFound } = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => requestHeaders.get(name) ?? null }),
  cookies: async () => ({
    get: (name: string) =>
      requestCookies.has(name) ? { name, value: requestCookies.get(name)! } : undefined,
  }),
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
  notFound,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
  };
});
vi.mock('@/lib/services/previewGateService', () => ({ previewGateService: { view, admit } }));
vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('@/lib/auth/client', () => ({ signOut: vi.fn() }));
vi.mock('@/lib/services/twoFactorPolicyService', () => ({
  twoFactorPolicyService: { resolveRequirement },
}));

const BASE: PreviewGateView = {
  host: HOST,
  state: 'building',
  failureReason: null,
  pullRequestNumber: 14,
  repository: 'acme/portal',
  pullRequestUrl: 'https://github.com/acme/portal/pull/14',
  workItem: {
    identifier: 'ACME-212',
    title: 'Let customers export invoices as CSV',
    url: 'https://app.motir.co/items/ACME-212',
  },
  closedReason: null,
};

beforeAll(async () => {
  await import('@/app/(preview-host)/preview-gate/page');
  await import('@/app/(auth)/preview-access/page');
}, 180_000);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MOTIR_PREVIEW_DOMAIN', 'preview.motir.site');
  vi.stubEnv('MOTIR_HOSTING_GATE_SIGNING_KEY', KEY);
  vi.stubEnv('MOTIR_BASE_URL', 'https://app.motir.co');
  requestHeaders.clear();
  requestCookies.clear();
  requestHeaders.set('host', HOST);
  const { admission } = mintAdmission({ host: HOST, sub: 'u1' }, KEY);
  requestCookies.set(GATE_COOKIE, mintGatePass(admission, KEY));
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

async function renderGate(
  data: Partial<PreviewGateView> | null,
  search: Record<string, string> = {},
) {
  view.mockResolvedValue(data === null ? null : { ...BASE, ...data });
  const mod = await import('@/app/(preview-host)/preview-gate/page');
  const tree = (await mod.default({ searchParams: Promise.resolve(search) })) as ReactElement;
  return render(tree);
}

const heading = (name: string) => screen.getByRole('heading', { level: 1, name });

describe('the preview-host pages', () => {
  it('Building: its heading, the first step current, the work item as the action', async () => {
    const { container } = await renderGate({ state: 'building' });
    expect(heading('This preview is being built')).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByText('Building the image').closest('li')?.getAttribute('aria-current')).toBe(
      'step',
    );
    expect(screen.getByRole('link', { name: /Open ACME-212 in Motir/ }).getAttribute('href')).toBe(
      'https://app.motir.co/items/ACME-212',
    );
    // React hoists the refresh `<meta>` into the document head.
    expect(document.querySelector('meta[http-equiv="refresh"]')?.getAttribute('content')).toBe(
      '10',
    );
    // The footer names the address and never asks for a password here.
    expect(screen.getByText(HOST)).toBeTruthy();
    expect(container.querySelector('input')).toBeNull();
  });

  it('Starting: the second step is current', async () => {
    await renderGate({ state: 'starting' });
    expect(heading('This preview is starting')).toBeTruthy();
    expect(
      screen.getByText('Starting the preview').closest('li')?.getAttribute('aria-current'),
    ).toBe('step');
  });

  it('Failed: the stored reason, and the pull request when no work item is linked', async () => {
    await renderGate({
      state: 'failed',
      workItem: null,
      failureReason: 'Motir could not start the preview: the machine refused',
    });
    expect(heading("This preview didn't start")).toBeTruthy();
    expect(screen.getByRole('note').textContent).toContain(
      'Motir could not start the preview: the machine refused',
    );
    expect(screen.getByRole('link', { name: /Open pull request #14 on GitHub/ })).toBeTruthy();
  });

  it('the unsupported variant names what the gate cannot carry', async () => {
    await renderGate({ state: 'ready' }, { unsupported: 'websocket' });
    expect(heading("Previews can't do this")).toBeTruthy();
    expect(screen.getByRole('note').textContent).toContain('Live connections (websockets)');
  });

  it('Closed: why it closed', async () => {
    await renderGate({ state: 'closed', closedReason: 'merged' });
    expect(heading('This preview has been shut down')).toBeTruthy();
    expect(
      screen.getByText(
        'Pull request #14 was merged, so Motir shut its preview down and deleted its database.',
      ),
    ).toBeTruthy();
  });

  it('Not found: no row — and nothing about the pull request or the work item', async () => {
    await renderGate(null);
    expect(heading('There is no preview here')).toBeTruthy();
    expect(screen.queryByText(/ACME-212|#14/)).toBeNull();
  });

  it('a viewer without a valid pass sees Not found, and the service is never asked', async () => {
    requestCookies.clear();
    await renderGate({ state: 'building' });
    expect(heading('There is no preview here')).toBeTruthy();
    expect(view).not.toHaveBeenCalled();
  });

  it('is a 404 on any host that is not a preview host', async () => {
    requestHeaders.set('host', 'app.motir.co');
    await expect(renderGate({ state: 'building' })).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

describe('/preview-access', () => {
  async function renderAccess(search: Record<string, string>) {
    const mod = await import('@/app/(auth)/preview-access/page');
    const tree = (await mod.default({ searchParams: Promise.resolve(search) })) as ReactElement;
    return render(tree);
  }

  beforeEach(() => {
    requestHeaders.set('host', 'app.motir.co');
    getSession.mockResolvedValue({ user: { id: 'u1', email: 'sam@example.com' } });
    resolveRequirement.mockResolvedValue({ required: false, compliant: true });
  });

  it('sends a signed-out viewer through sign-in and back here', async () => {
    getSession.mockResolvedValue(null);
    await expect(renderAccess({ host: HOST, return: '/x' })).rejects.toThrow(
      `NEXT_REDIRECT:/sign-in?next=${encodeURIComponent(`/preview-access?host=${HOST}&return=%2Fx`)}`,
    );
  });

  it('sends a member straight to the preview host with the admission', async () => {
    admit.mockResolvedValue({
      admitted: true,
      url: `https://${HOST}/__motir/preview-auth?token=t`,
    });
    await expect(renderAccess({ host: HOST, return: '/' })).rejects.toThrow(
      `NEXT_REDIRECT:https://${HOST}/__motir/preview-auth?token=t`,
    );
    expect(admit).toHaveBeenCalledWith({ userId: 'u1', host: HOST, returnPath: '/' });
  });

  it('holds a person under a 2FA mandate on the enrolment screen, returning here', async () => {
    resolveRequirement.mockResolvedValue({ required: true, compliant: false });
    await expect(renderAccess({ host: HOST, return: '/' })).rejects.toThrow(
      /NEXT_REDIRECT:\/two-factor-required\?next=%2Fpreview-access/,
    );
    expect(admit).not.toHaveBeenCalled();
  });

  it('Refused: its landmark, the account, and the two ways out — naming no project', async () => {
    admit.mockResolvedValue({ admitted: false });
    await renderAccess({ host: HOST, return: '/' });
    expect(heading("You don't have access to this preview")).toBeTruthy();
    expect(screen.getByText('sam@example.com')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to Motir' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in with a different account' })).toBeTruthy();
  });
});
