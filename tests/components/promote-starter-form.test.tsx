// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { PromoteForm } from '@/app/(admin)/admin/starters/promote/_components/PromoteForm';
import { ToastProvider } from '@/components/ui/Toast';
import type { SeedPromotionSourceDto } from '@/lib/dto/seedRegistry';
import { seedEntry } from '../fixtures/seedRegistryFixtures';
import { renderWithIntl } from '../helpers/renderWithIntl';

// THE PROMOTE FORM (Story MOTIR-704 · MOTIR-712; design MOTIR-705 §3.1–3.3,
// §3.5). Only `fetch` and `useRouter` are faked. What is proved: the picker lists
// what it is given with the held repositories disabled and saying why; NOTHING is
// pre-ticked; Review stays disabled until every required field is filled; the
// confirm restates the promotion and nothing is posted before **Promote**; each
// typed refusal lands where the design puts it with the form still filled; and a
// promotion toasts and opens the library on the new row.

const { push, listPromotionSources } = vi.hoisted(() => ({
  push: vi.fn(),
  listPromotionSources: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/lib/platform/pageGate', () => ({
  requirePlatformStaffPage: vi.fn(async () => ({ userId: 'u-op', role: 'operator' })),
}));
vi.mock('@/lib/services/seedRegistryConsoleService', () => ({
  seedRegistryConsoleService: { listPromotionSources },
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
  };
});

const SOURCES: SeedPromotionSourceDto[] = [
  {
    id: 'row-ready',
    name: 'acme-booking-web',
    repoRef: 'motir-projects/acme-booking-web',
    role: 'web',
    state: 'created',
    projectName: 'Acme booking',
    unavailable: null,
  },
  {
    id: 'row-proposed',
    name: 'acme-api',
    repoRef: null,
    role: 'api',
    state: 'proposed',
    projectName: 'Acme booking',
    unavailable: 'not_created',
  },
  {
    id: 'row-leaving',
    name: 'leaving-web',
    repoRef: 'motir-projects/leaving-web',
    role: 'web',
    state: 'created',
    projectName: 'Leaving Co',
    unavailable: 'leaving',
  },
];

let fetchMock: ReturnType<typeof vi.fn>;
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  push.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderForm() {
  return renderWithIntl(
    <ToastProvider>
      <PromoteForm sources={SOURCES} />
    </ToastProvider>,
  );
}

const review = () => screen.getByTestId('promote-review') as HTMLButtonElement;
const textbox = (name: string) => screen.getByRole('textbox', { name });
const tick = (name: string) =>
  fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(`^${name},`) }));

function pick(combobox: string, option: RegExp) {
  fireEvent.click(screen.getByRole('combobox', { name: combobox }));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

/** Fill every required field, ticking Fly as the hosting target. */
function fill() {
  pick('Repository Motir created', /acme-booking-web/);
  fireEvent.change(textbox('Ref'), { target: { value: 'main' } });
  pick('Role', /^web$/);
  fireEvent.change(textbox('Stack'), { target: { value: 'nextjs' } });
  fireEvent.change(textbox('Label'), { target: { value: 'Next.js · booking' } });
  fireEvent.change(textbox('Key'), { target: { value: 'nextjs-booking-starter' } });
  tick('MVP');
  tick('Small');
  tick('Fly');
  fireEvent.change(screen.getByRole('textbox', { name: /Reason/ }), {
    target: { value: 'Booking flow is reusable' },
  });
}

describe('the form (§3.1)', () => {
  it('lists only what it is given, the held repositories disabled with why', () => {
    renderForm();
    fireEvent.click(screen.getByRole('combobox', { name: 'Repository Motir created' }));
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    const proposed = screen.getByRole('option', { name: /acme-api/ });
    expect(proposed.getAttribute('aria-disabled')).toBe('true');
    expect(proposed.textContent).toContain('Acme booking · api · not created yet');
    expect(screen.getByRole('option', { name: /leaving-web/ }).textContent).toContain(
      'being handed over to its owner',
    );
    expect(screen.getByText('Only repositories Motir created.')).toBeTruthy();
  });

  it('ticks nothing, and keeps Review disabled until every required field is filled', () => {
    renderForm();
    for (const box of screen.getAllByRole('checkbox')) {
      expect(box.getAttribute('aria-checked')).toBe('false');
    }
    expect(review().disabled).toBe(true);
    fill();
    expect(review().disabled).toBe(false);
    // A use and a size are required; a hosting target is not.
    tick('MVP');
    expect(review().disabled).toBe(true);
  });

  it('shows the picked repository’s project, role and state', () => {
    renderForm();
    pick('Repository Motir created', /acme-booking-web/);
    expect(screen.getByTestId('promote-source-sub').textContent).toBe(
      'Acme booking · web · created',
    );
  });
});

describe('the confirm and the promotion (§3.2, §3.5)', () => {
  it('restates the promotion, posts only on Promote, then toasts and opens the library', async () => {
    fetchMock.mockResolvedValue(
      json(
        200,
        seedEntry('nextjs-booking-starter', {
          label: 'Next.js · booking',
          hostingTargets: ['fly'],
        }),
      ),
    );
    renderForm();
    fill();
    fireEvent.click(review());

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Promote acme-booking-web to a starter?')).toBeTruthy();
    expect(dialog.textContent).toContain(
      'Motir copies motir-projects/acme-booking-web at main into motir-co/nextjs-booking-starter and adds Next.js · booking to the library.',
    );
    const facts = within(dialog).getByTestId('promote-confirm-facts');
    expect(facts.textContent).toContain('web · nextjs');
    expect(facts.textContent).toContain('Fly');
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByTestId('promote-confirm'));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith('/admin/starters?promoted=nextjs-booking-starter'),
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/platform/seed-registry/promote');
    expect(JSON.parse(String(init.body))).toEqual({
      sourceRowId: 'row-ready',
      ref: 'main',
      key: 'nextjs-booking-starter',
      role: 'web',
      stack: 'nextjs',
      label: 'Next.js · booking',
      useCases: ['mvp'],
      sizes: ['small'],
      hostingTargets: ['fly'],
      reason: 'Booking flow is reusable',
    });
    expect(
      await screen.findByText(
        'Promoted. New web repositories on Fly can now start from Next.js · booking.',
      ),
    ).toBeTruthy();
  });
});

describe('refusals (§3.3)', () => {
  async function submitAndRefuse(status: number, body: unknown) {
    fetchMock.mockResolvedValue(json(status, body));
    renderForm();
    fill();
    fireEvent.click(review());
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByTestId('promote-confirm'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  }

  it('puts a source refusal at the top, the form still filled', async () => {
    await submitAndRefuse(422, {
      code: 'SEED_PROMOTION_SOURCE_REFUSED',
      refusal: 'taken_over',
      error: 'x',
    });
    const alert = screen.getByTestId('promote-refusal');
    expect(alert.textContent).toContain("This repository can't be promoted.");
    expect(alert.textContent).toContain('It is being handed over to its owner');
    expect((textbox('Key') as HTMLInputElement).value).toBe('nextjs-booking-starter');
  });

  it('puts an undeclared target in the alert AND under Hosting targets', async () => {
    await submitAndRefuse(422, {
      code: 'SEED_PROMOTION_MANIFEST_REFUSED',
      refusal: 'target_not_declared',
      file: 'motir.hosting.json',
      field: 'targets',
      target: 'fly',
      reason: null,
      declared: ['serverless'],
      error: 'x',
    });
    expect(screen.getByTestId('promote-refusal').textContent).toContain(
      'It does not list Fly in targets (it lists Serverless).',
    );
    expect(screen.getByText('Fly is not in motir.hosting.json at main.')).toBeTruthy();
  });

  it('names an invalid manifest field and what is wrong with it', async () => {
    await submitAndRefuse(422, {
      code: 'SEED_PROMOTION_MANIFEST_REFUSED',
      refusal: 'invalid',
      field: 'port',
      target: null,
      reason: 'must be a positive integer',
      declared: [],
      error: 'x',
    });
    const alert = screen.getByTestId('promote-refusal');
    expect(alert.textContent).toContain(
      'The file at main is invalid: port must be a positive integer',
    );
    expect(alert.textContent).toContain('motir.hosting.json · port');
  });

  it.each([
    [
      { code: 'SEED_PROMOTION_REF_NOT_FOUND', error: 'x' },
      'Ref',
      '“main” is not a branch, tag or commit of motir-projects/acme-booking-web.',
    ],
    [
      { code: 'SEED_REGISTRY_KEY_TAKEN', error: 'x' },
      'Key',
      'The key nextjs-booking-starter is already taken.',
    ],
    [
      { code: 'SEED_PROMOTION_TEMPLATE_NAME_TAKEN', error: 'x' },
      'Key',
      'motir-co/nextjs-booking-starter already exists and is not this starter',
    ],
  ])('puts %o under its field', async (body, _field, copy) => {
    await submitAndRefuse(body.code === 'SEED_PROMOTION_REF_NOT_FOUND' ? 422 : 409, body);
    expect(screen.queryByTestId('promote-refusal')).toBeNull();
    expect(screen.getByText(new RegExp(copy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeTruthy();
  });

  it('says a value outside its list is not one, and lists the choices', async () => {
    await submitAndRefuse(422, {
      code: 'SEED_REGISTRY_INVALID_FIELD',
      field: 'sizes',
      value: 'huge',
      error: 'x',
    });
    expect(
      screen.getByText('“huge” is not a size. Choose from Small, Medium, or Large.'),
    ).toBeTruthy();
  });

  it('falls back to the server’s sentence for anything else', async () => {
    await submitAndRefuse(502, { code: 'REPO_PROVISIONING_API_ERROR', error: 'GitHub said no.' });
    const alert = screen.getByTestId('promote-refusal');
    expect(alert.textContent).toContain("Motir couldn't promote this repository.");
    expect(alert.textContent).toContain('GitHub said no.');
  });
});

describe('the promote page', () => {
  it('reads the picker’s sources behind the operator gate', async () => {
    listPromotionSources.mockResolvedValue(SOURCES);
    const mod = await import('@/app/(admin)/admin/starters/promote/page');
    const tree = (await mod.default()) as ReactElement;
    renderWithIntl(<ToastProvider>{tree}</ToastProvider>);
    expect(screen.getByRole('heading', { name: 'Promote a repository' })).toBeTruthy();
    expect(listPromotionSources).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-op' }));
  });
});
