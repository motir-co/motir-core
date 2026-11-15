// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderToHtml } from '../../helpers/serverPageHarness';
import { renderWithIntl as render } from '../../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type {
  ModelServingEntryDTO,
  PlatformModelServingViewDTO,
} from '@/lib/dto/platformModelServing';
import en from '@/messages/en.json';

// THE MODEL SERVING PAGE (MOTIR-11280; design MOTIR-11279, `platform-admin/
// design-notes.md` § Model serving, Panels 1–7). The server parts render to HTML
// over the real `en` catalogue; the Change dialog is driven in happy-dom with
// its action stubbed, one case per state the mock draws.

vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
    getLocale: async () => 'en',
  };
});
const setModelServingAction = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true, servedBy: 'qwen' })),
);
vi.mock('@/app/(admin)/admin/model-serving/actions', () => ({ setModelServingAction }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }), usePathname: () => '/' }));
const view = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/lib/platform/pageGate', () => ({
  requirePlatformStaffPage: vi.fn(async () => ({ userId: 'u1', email: 's@m', role: 'support' })),
}));
vi.mock('@/lib/services/platformModelServingService', () => ({
  platformModelServingService: { getView: vi.fn(async () => view.current) },
}));

const { ModelServingTable } =
  await import('@/app/(admin)/admin/model-serving/_components/ModelServingTable');
const { ModelServingChange } =
  await import('@/app/(admin)/admin/model-serving/_components/ModelServingChange');
const { ModelServingUnavailable } =
  await import('@/app/(admin)/admin/model-serving/_components/ModelServingUnavailable');
const { default: AdminModelServingPage } = await import('@/app/(admin)/admin/model-serving/page');

const ms = en.platformAdmin.modelServing;

afterEach(() => {
  cleanup();
  setModelServingAction.mockClear();
  refresh.mockClear();
});

function entry(over: Partial<ModelServingEntryDTO> = {}): ModelServingEntryDTO {
  return {
    model: 'glm-5.3',
    modelName: 'GLM-5.3',
    originProvider: 'z-ai',
    originName: 'Z.ai',
    charged: { input: 1.4, output: 4.4 },
    priceSource: {
      url: 'https://docs.z.ai/guides/overview/pricing',
      host: 'docs.z.ai',
      readDate: '2026-11-15',
    },
    selected: null,
    selectedBy: null,
    selectedAt: null,
    effective: 'z-ai',
    offerings: [
      {
        provider: 'z-ai',
        providerName: 'Z.ai',
        channelName: 'GLM',
        enabled: true,
        isOrigin: true,
        cost: { input: 1.4, output: 4.4 },
        costSource: { url: 'https://docs.z.ai', host: 'docs.z.ai', readDate: '2026-11-15' },
      },
      {
        provider: 'qwen',
        providerName: 'Alibaba Cloud',
        channelName: 'Qwen',
        enabled: true,
        isOrigin: false,
        cost: { input: 1.131, output: 3.957 },
        costSource: {
          url: 'https://www.alibabacloud.com/x',
          host: 'alibabacloud.com',
          readDate: '2026-11-12',
        },
      },
    ],
    ...over,
  };
}

const chosenQwen = (enabled: boolean) => {
  const e = entry({
    selected: 'qwen',
    selectedBy: 'yue@motir.co',
    selectedAt: '2026-11-14T09:00:00.000Z',
    effective: enabled ? 'qwen' : 'z-ai',
  });
  e.offerings[1] = { ...e.offerings[1]!, enabled };
  return e;
};

const text = (html: string) => {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
};

describe('the list (server)', () => {
  it('Panel 1: a default row under its maker at its maker price, with Change', async () => {
    const dom = text(
      await renderToHtml(await ModelServingTable({ entries: [entry()], canChange: true })),
    );
    const row = dom.querySelector('[data-testid="model-serving-row-glm-5.3"]')!;
    const cells = [...row.querySelectorAll('td')].map((td) => td.textContent);
    expect(cells[0]).toBe('GLM-5.3glm-5.3');
    expect(cells[1]).toBe('Z.ai');
    expect(cells[2]).toContain('$1.40 / $4.40 per MTok');
    expect(cells[2]).toContain(ms.plusMargin);
    expect(cells[2]).toContain('docs.z.ai');
    expect(cells[2]).toMatch(/Read Nov 15, 2026|Read 15 Nov 2026/);
    expect(cells[3]).toContain('Z.ai');
    expect(cells[3]).toContain(ms.default);
    expect(cells[3]).toContain('Channel GLM on');
    expect(cells[4]).toContain('$1.40 / $4.40 per MTok');
    expect(cells[4]).toContain(ms.diff.same);
    expect(row.querySelector('[data-testid="model-serving-change-glm-5.3"]')).not.toBeNull();
    expect(dom.textContent).toContain('1 model · read from');
    expect(dom.querySelector('[data-testid="model-serving-read-only"]')).toBeNull();
  });

  it('Panel 1: a chosen row names who chose it and costs Motir the seller price', async () => {
    const dom = text(
      await renderToHtml(await ModelServingTable({ entries: [chosenQwen(true)], canChange: true })),
    );
    const row = dom.querySelector('[data-testid="model-serving-row-glm-5.3"]')!;
    const cells = [...row.querySelectorAll('td')].map((td) => td.textContent);
    expect(cells[3]).toContain('Alibaba Cloud');
    expect(cells[3]).not.toContain(ms.default);
    expect(cells[3]).toMatch(/Chosen by yue@motir\.co · (Nov 14, 2026|14 Nov 2026)/);
    expect(cells[4]).toContain('$1.131 / $3.957 per MTok');
    expect(cells[4]).toContain('Input 19% · output 10% below the official price');
    expect(row.querySelector('[data-rail="warning"]')).toBeNull();
  });

  it('Panel 4: a chosen channel that is off falls back to the maker, on a warning rail', async () => {
    const dom = text(
      await renderToHtml(
        await ModelServingTable({ entries: [chosenQwen(false)], canChange: true }),
      ),
    );
    const row = dom.querySelector('[data-testid="model-serving-row-glm-5.3"]')!;
    expect(row.querySelector('td')!.getAttribute('data-rail')).toBe('warning');
    expect(row.textContent).toContain('Channel Qwen off');
    expect(dom.querySelector('[data-testid="model-serving-fallback-glm-5.3"]')!.textContent).toBe(
      'Falling back to Z.ai',
    );
    expect(row.textContent).toContain(
      'Alibaba Cloud’s channel is off, so Z.ai is serving it. The charged price does not change.',
    );
  });

  it('Panel 2: support staff read the list with no Action column', async () => {
    const dom = text(
      await renderToHtml(await ModelServingTable({ entries: [entry()], canChange: false })),
    );
    expect(dom.querySelector('[data-testid="model-serving-read-only"]')!.textContent).toBe(
      ms.readOnly,
    );
    expect(dom.textContent).not.toContain(ms.col.action);
    expect(dom.querySelector('[data-testid="model-serving-change-glm-5.3"]')).toBeNull();
  });

  it('Panel 6: no model with two sellers is the empty state, header kept', async () => {
    const dom = text(await renderToHtml(await ModelServingTable({ entries: [], canChange: true })));
    expect(dom.querySelector('[data-state="empty"]')).not.toBeNull();
    expect(dom.textContent).toContain(ms.card.title);
    expect(dom.textContent).toContain(ms.empty.title);
    expect(dom.querySelector('table')).toBeNull();
  });

  it('a row whose serving price is unknown shows a dash and no difference', async () => {
    const e = entry();
    e.offerings[0] = { ...e.offerings[0]!, cost: null, costSource: null };
    const dom = text(
      await renderToHtml(await ModelServingTable({ entries: [e], canChange: false })),
    );
    const cells = [...dom.querySelectorAll('[data-testid="model-serving-row-glm-5.3"] td')];
    expect(cells[4]!.textContent).toBe('—');
  });
});

describe('the page', () => {
  it('draws the header and the list for a loaded view', async () => {
    view.current = {
      state: 'ok',
      canChange: false,
      entries: [entry()],
    } satisfies PlatformModelServingViewDTO;
    const html = await renderToHtml(await AdminModelServingPage());
    expect(html).toContain(ms.breadcrumb);
    expect(html).toContain(ms.lineCharge.replace(/’/g, '&#x27;').slice(0, 20));
    expect(html).toContain('model-serving-row-glm-5.3');
  });

  it('Panel 7: an unreadable gateway is the error card, no rows', async () => {
    view.current = { state: 'unavailable' } satisfies PlatformModelServingViewDTO;
    const html = await renderToHtml(await AdminModelServingPage());
    expect(html).toContain('model-serving-unavailable');
    expect(html).not.toContain('model-serving-row');
  });
});

describe('Panel 7 Retry', () => {
  it('refreshes the route', () => {
    render(<ModelServingUnavailable />);
    expect(screen.getByText(ms.error.unreachable.title)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: ms.error.retry }));
    expect(refresh).toHaveBeenCalled();
  });
});

describe('the Change dialog', () => {
  function open(e: ModelServingEntryDTO) {
    render(
      <ToastProvider>
        <ModelServingChange entry={e} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change which provider serves GLM-5.3' }));
    return screen.getByRole('alertdialog');
  }

  it('Panel 3: one option per seller, the maker first, the current one picked', () => {
    const dialog = open(entry());
    expect(within(dialog).getByText('Choose who serves GLM-5.3')).toBeTruthy();
    const zai = within(dialog).getByTestId('model-serving-option-z-ai');
    expect(zai.textContent).toContain(ms.dialog.original);
    expect(zai.textContent).toContain(ms.dialog.current);
    expect(zai.textContent).toContain('Costs Motir $1.40 / $4.40 per MTok');
    expect(zai.textContent).toContain('Price from docs.z.ai, read');
    expect((within(zai).getByRole('radio') as HTMLInputElement).checked).toBe(true);
    const qwen = within(dialog).getByTestId('model-serving-option-qwen');
    expect(qwen.textContent).toContain('Input 19% · output 10% below the official price');
    expect(dialog.textContent).toContain('People keep paying $1.40 / $4.40 per MTok.');
    expect(within(dialog).queryByTestId('model-serving-use-default')).toBeNull();
  });

  it('Saved: picks Alibaba, saves it, closes and toasts', async () => {
    const dialog = open(entry());
    fireEvent.click(
      within(within(dialog).getByTestId('model-serving-option-qwen')).getByRole('radio'),
    );
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: ms.dialog.save }));
    });
    expect(setModelServingAction).toHaveBeenCalledWith('glm-5.3', 'qwen');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await screen.findByText('Alibaba Cloud now serves GLM-5.3')).toBeTruthy();
  });

  it('saving the default untouched sends a clear, not a choice', async () => {
    const dialog = open(entry());
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: ms.dialog.save }));
    });
    expect(setModelServingAction).toHaveBeenCalledWith('glm-5.3', null);
  });

  it('Panel 4: a channel that is off warns, and Save reads Save anyway', () => {
    const e = entry();
    e.offerings[1] = { ...e.offerings[1]!, enabled: false };
    const dialog = open(e);
    fireEvent.click(
      within(within(dialog).getByTestId('model-serving-option-qwen')).getByRole('radio'),
    );
    const warning = within(dialog).getByTestId('model-serving-disabled-warning');
    expect(warning.textContent).toContain('Alibaba Cloud’s channel is off');
    expect(warning.textContent).toContain(
      'While channel Qwen is off, requests for GLM-5.3 fall back to Z.ai.',
    );
    expect(within(dialog).getByRole('button', { name: ms.dialog.saveAnyway })).toBeTruthy();
    expect(within(dialog).getByTestId('model-serving-option-qwen').textContent).toContain(
      ms.dialog.disabled,
    );
  });

  it('Use the default clears an admin choice', async () => {
    const dialog = open(chosenQwen(true));
    expect(
      (
        within(within(dialog).getByTestId('model-serving-option-qwen')).getByRole(
          'radio',
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId('model-serving-use-default'));
    });
    expect(setModelServingAction).toHaveBeenCalledWith('glm-5.3', null);
    expect(await screen.findByText('Z.ai now serves GLM-5.3')).toBeTruthy();
  });

  it('Panel 5: a failed save keeps the dialog open with the pick and an inline error', async () => {
    setModelServingAction.mockResolvedValueOnce({ ok: false, code: 'UNAVAILABLE' });
    const dialog = open(entry());
    fireEvent.click(
      within(within(dialog).getByTestId('model-serving-option-qwen')).getByRole('radio'),
    );
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: ms.dialog.save }));
    });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(within(dialog).getByTestId('model-serving-save-error').textContent).toBe(
      'The gateway did not accept the change, so GLM-5.3 is still served by Z.ai. Try again.',
    );
    expect(
      (
        within(within(dialog).getByTestId('model-serving-option-qwen')).getByRole(
          'radio',
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
    // Picking again clears the error.
    fireEvent.click(
      within(within(dialog).getByTestId('model-serving-option-z-ai')).getByRole('radio'),
    );
    expect(within(dialog).queryByTestId('model-serving-save-error')).toBeNull();
  });

  it('Escape closes the dialog', () => {
    const dialog = open(entry());
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('with every other channel off, the warning falls back to the maker by name', () => {
    const e = entry({ effective: null });
    e.offerings = e.offerings.map((o) => ({ ...o, enabled: false }));
    const dialog = open(e);
    fireEvent.click(
      within(within(dialog).getByTestId('model-serving-option-qwen')).getByRole('radio'),
    );
    expect(within(dialog).getByTestId('model-serving-disabled-warning').textContent).toContain(
      'fall back to Z.ai',
    );
    expect(within(dialog).queryByText(ms.dialog.current)).toBeNull();
  });

  it('a non-origin enabled seller is the fallback when the maker is the one off', () => {
    const e = entry();
    e.offerings[0] = { ...e.offerings[0]!, enabled: false };
    e.offerings.push({ ...e.offerings[1]!, provider: 'deepseek', providerName: 'DeepSeek' });
    const dialog = open(e);
    expect(within(dialog).getByTestId('model-serving-disabled-warning').textContent).toContain(
      'fall back to Alibaba Cloud',
    );
  });

  it('Cancel closes without saving', () => {
    const dialog = open(entry());
    fireEvent.click(within(dialog).getByRole('button', { name: ms.dialog.cancel }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(setModelServingAction).not.toHaveBeenCalled();
  });

  it('lists one option per provider, taking its enabled channel, and shows no cost when unknown', () => {
    const e = entry();
    e.offerings.push({
      ...e.offerings[1]!,
      channelName: 'Qwen backup',
      enabled: true,
    });
    e.offerings[1] = { ...e.offerings[1]!, enabled: false };
    e.offerings[0] = { ...e.offerings[0]!, cost: null, costSource: null };
    const dialog = open(e);
    expect(within(dialog).getAllByRole('radio')).toHaveLength(2);
    const qwen = within(dialog).getByTestId('model-serving-option-qwen');
    expect(qwen.textContent).toContain('Gateway channel Qwen backup');
    expect(within(dialog).getByTestId('model-serving-option-z-ai').textContent).not.toContain(
      'Costs Motir',
    );
  });
});
