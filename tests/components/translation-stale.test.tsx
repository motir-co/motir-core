// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { ReaderTranslationDTO, TranslationOfferDTO } from '@/lib/dto/workItemTranslation';

// THE STALE STATE, rendered (Story MOTIR-7735 · MOTIR-8123; design MOTIR-8112
// panels 10–11, D5). The page re-reads its offer; a field whose revision moved
// is re-translated ONCE and quietly, the untouched fields never change, and the
// new translation is announced once, naming the field.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import {
  TRANSLATION_REFRESH_MS,
  TranslationProvider,
} from '@/app/(authed)/items/[key]/_components/translation/TranslationProvider';
import { TranslateControl } from '@/app/(authed)/items/[key]/_components/translation/TranslateControl';
import { FieldTranslationMark } from '@/app/(authed)/items/[key]/_components/translation/FieldTranslationMark';
import { TranslatableMarkdown } from '@/app/(authed)/items/[key]/_components/translation/TranslatableFields';

afterEach(cleanup);

const field = (revision: string, kept = false, needsTranslation = true) => ({
  needsTranslation,
  kept,
  sourceLanguage: needsTranslation ? ('zh' as const) : null,
  revision,
});
const offerOf = (fields: TranslationOfferDTO['fields']): ReaderTranslationDTO => ({
  canAddCredits: false,
  offer: { targetLanguage: 'en', anyNeedsTranslation: true, fields },
});

const V1 = offerOf({ title: field('t1'), description: field('d1') });
const V2 = offerOf({ title: field('t1'), description: field('d2') });

function Page({
  translation,
  description,
  liveRefresh,
}: {
  translation: ReaderTranslationDTO;
  description: string;
  liveRefresh?: boolean;
}) {
  return (
    <TranslationProvider itemId="item-1" translation={translation} liveRefresh={liveRefresh}>
      <TranslateControl />
      <section aria-label="Title">
        <FieldTranslationMark fieldRef="title" field="title" />
        <TranslatableMarkdown fieldRef="title" value="标题" workItemRefs={{}} />
      </section>
      <section aria-label="Description">
        <FieldTranslationMark fieldRef="description" field="description" />
        <TranslatableMarkdown fieldRef="description" value={description} workItemRefs={{}} />
      </section>
    </TranslationProvider>
  );
}

function ok(fields: unknown[]) {
  return { ok: true, json: async () => ({ targetLanguage: 'en', fields }) } as Response;
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const region = (name: string) => screen.getByRole('region', { name });
const live = (c: HTMLElement) => c.querySelector('[data-translation-live]')!.textContent;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  refresh.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

/** Mount on V1 and press Translate; both fields come back translated. */
async function translatedPage(liveRefresh?: boolean) {
  fetchMock.mockResolvedValueOnce(
    ok([
      { fieldRef: 'title', status: 'ready', text: 'Title' },
      { fieldRef: 'description', status: 'ready', text: 'Old description' },
    ]),
  );
  const view = render(<Page translation={V1} description="旧描述" liveRefresh={liveRefresh} />);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Translate' })));
  expect(region('Title').textContent).toContain('Title');
  return view;
}

describe('an edit reaches the open translated view (case a)', () => {
  it('re-translates only the edited field, once, and announces it when it lands', async () => {
    const { container, rerender } = await translatedPage();
    const d = deferred<Response>();
    fetchMock.mockReturnValueOnce(d.promise);
    const titleBefore = region('Title').innerHTML;

    rerender(<Page translation={V2} description="新描述" />);

    // At once: the old translation is gone, the NEW original shows, marked edited.
    const desc = region('Description');
    expect(desc.textContent).toContain('新描述');
    expect(desc.textContent).not.toContain('Old description');
    expect(desc.querySelector('[data-translation-mark="edited"]')?.textContent).toBe(
      'Description: Edited · translating…',
    );
    // The untouched field: same markup, no pending mark. The bar is not busy.
    expect(region('Title').innerHTML).toBe(titleBefore);
    expect(
      container.querySelector('[data-translation-bar]')?.getAttribute('data-translation-bar'),
    ).toBe('translated');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]).toEqual([
      '/api/work-items/item-1/translate',
      { method: 'POST' },
    ]);
    // Nothing is announced when the edit arrives (D5).
    expect(live(container)).toBe('Translated into English.');

    // The same offer again, and a second refresh: no second request.
    rerender(<Page translation={{ ...V2 }} description="新描述" />);
    rerender(<Page translation={V2} description="新描述" />);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      d.resolve(
        ok([
          { fieldRef: 'title', status: 'ready', text: 'Title' },
          { fieldRef: 'description', status: 'ready', text: 'New description' },
        ]),
      );
    });
    expect(region('Description').textContent).toContain('New description');
    expect(
      region('Description').querySelector('[data-translation-mark="translated"]'),
    ).not.toBeNull();
    expect(region('Title').innerHTML).toBe(titleBefore);
    expect(live(container)).toBe('Description was edited and translated again.');
  });

  it('an answer that arrives after a SECOND edit is discarded for the older text', async () => {
    const { rerender } = await translatedPage();
    const first = deferred<Response>();
    const second = deferred<Response>();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    rerender(<Page translation={V2} description="新描述" />);
    const V3 = offerOf({ title: field('t1'), description: field('d3') });
    rerender(<Page translation={V3} description="第三版" />);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      first.resolve(ok([{ fieldRef: 'description', status: 'ready', text: 'Second version' }]));
    });
    // The answer for d2 does not land on d3's text.
    expect(region('Description').textContent).toContain('第三版');
    expect(region('Description').textContent).not.toContain('Second version');

    await act(async () => {
      second.resolve(ok([{ fieldRef: 'description', status: 'ready', text: 'Third version' }]));
    });
    expect(region('Description').textContent).toContain('Third version');
  });

  it('a failed re-translation shows failed with Retry, never the old translation', async () => {
    const { rerender } = await translatedPage();
    fetchMock.mockResolvedValueOnce(ok([{ fieldRef: 'description', status: 'failed' }]));
    await act(async () => rerender(<Page translation={V2} description="新描述" />));
    const desc = region('Description');
    expect(desc.querySelector('[data-translation-mark="failed"]')).not.toBeNull();
    expect(desc.textContent).toContain('新描述');
    expect(desc.textContent).not.toContain('Old description');
    expect(screen.getByRole('button', { name: 'Retry translating the description' })).toBeTruthy();
  });

  it('in the ORIGINAL view an edit marks nothing and requests nothing', async () => {
    const { container, rerender } = await translatedPage();
    fireEvent.click(screen.getByRole('button', { name: 'Show original' }));
    rerender(<Page translation={V2} description="新描述" />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-translation-mark]')).toBeNull();
  });

  it('a field that becomes the reader’s language is unmarked', async () => {
    const { rerender } = await translatedPage();
    rerender(
      <Page
        translation={offerOf({ title: field('t1'), description: field('d2', false, false) })}
        description="Now English"
      />,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(region('Description').querySelector('[data-translation-mark]')).toBeNull();
    expect(region('Description').textContent).toBe('Now English');
  });
});

describe('a later reader (case b)', () => {
  it('starts on the original and Translate; the press is one request', async () => {
    // The offer as recomputed after the edit: the title's kept copy still
    // matches, the description's does not.
    const after = offerOf({ title: field('t1', true), description: field('d2', false) });
    fetchMock.mockResolvedValueOnce(
      ok([
        { fieldRef: 'title', status: 'ready', text: 'Title' },
        { fieldRef: 'description', status: 'ready', text: 'New description' },
      ]),
    );
    render(<Page translation={after} description="新描述" />);
    expect(region('Description').textContent).toContain('新描述');
    expect(region('Title').textContent).toContain('标题');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Translate' })));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(region('Description').textContent).toContain('New description');
  });
});

describe('how the page sees an edit (liveRefresh)', () => {
  it('re-reads the page when the tab is shown again and once a minute, only while translated', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      render(<Page translation={V1} description="旧描述" liveRefresh />);
      // Not pressed yet: nothing is refreshed.
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
        vi.advanceTimersByTime(TRANSLATION_REFRESH_MS);
      });
      expect(refresh).not.toHaveBeenCalled();
      cleanup();

      await translatedPage(true);
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(refresh).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(TRANSLATION_REFRESH_MS);
      });
      expect(refresh).toHaveBeenCalledTimes(2);

      fireEvent.click(screen.getByRole('button', { name: 'Show original' }));
      act(() => {
        vi.advanceTimersByTime(TRANSLATION_REFRESH_MS);
      });
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
