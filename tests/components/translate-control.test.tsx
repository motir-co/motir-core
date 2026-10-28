// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { ReaderTranslationDTO, TranslationOfferDTO } from '@/lib/dto/workItemTranslation';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import { TranslationProvider } from '@/app/(authed)/items/[key]/_components/translation/TranslationProvider';
import { TranslateControl } from '@/app/(authed)/items/[key]/_components/translation/TranslateControl';
import { FieldTranslationMark } from '@/app/(authed)/items/[key]/_components/translation/FieldTranslationMark';
import {
  TranslatableMarkdown,
  TranslatableTitle,
} from '@/app/(authed)/items/[key]/_components/translation/TranslatableFields';

// THE TRANSLATE CONTROL AND THE FIELD MARKS (Story MOTIR-7735 · MOTIR-8122;
// design MOTIR-8112). The press, the busy state, the toggle, the per-field
// marks, failure and no credit — against a stubbed `fetch`, so the request the
// browser sends is asserted exactly.

afterEach(cleanup);

const OFFER: TranslationOfferDTO = {
  targetLanguage: 'en',
  anyNeedsTranslation: true,
  fields: {
    title: { needsTranslation: true, kept: false, sourceLanguage: 'zh', revision: 'r0' },
    description: { needsTranslation: true, kept: false, sourceLanguage: 'zh', revision: 'r0' },
    explanation: { needsTranslation: false, kept: false, sourceLanguage: 'en', revision: 'r0' },
  },
};

const REFS: WorkItemRefMap = {
  wi_9: {
    accessible: true,
    id: 'wi_9',
    identifier: 'MOTIR-9',
    title: 'The linked one',
    kind: 'task',
    archived: false,
    status: null,
    type: null,
    assignee: null,
  },
};

const DESC_ZH = '描述 [链接](https://example.com/a) 和 [MOTIR-9](motir:wi_9)\n\n```\ncode()\n```';
const DESC_EN =
  'Description [link](https://example.com/a) and [MOTIR-9](motir:wi_9)\n\n```\ncode()\n```';

function Harness({
  translation,
  fields,
}: {
  translation: ReaderTranslationDTO;
  fields?: readonly string[];
}) {
  return (
    <TranslationProvider itemId="item-1" translation={translation} fields={fields}>
      <h1>
        <TranslatableTitle title="标题" projectIdentifier="MOTIR" workItemRefs={{}} />
      </h1>
      <FieldTranslationMark fieldRef="title" field="title" />
      <TranslateControl />
      <section aria-label="Description">
        <FieldTranslationMark fieldRef="description" field="description" />
        <TranslatableMarkdown fieldRef="description" value={DESC_ZH} workItemRefs={REFS} />
      </section>
      <section aria-label="Explanation">
        <FieldTranslationMark fieldRef="explanation" field="explanation" />
        <TranslatableMarkdown fieldRef="explanation" value="Already English." workItemRefs={{}} />
      </section>
    </TranslationProvider>
  );
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function ok(fields: unknown[]) {
  return { ok: true, json: async () => ({ targetLanguage: 'en', fields }) } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const control = () => screen.getByRole('button', { name: /Translate|Retry|Show|Translating/ });
const live = (c: HTMLElement) => c.querySelector('[data-translation-live]')!;

describe('the press', () => {
  it('offers Translate into the reader’s language and posts ONCE, naming only the item', async () => {
    const d = deferred<Response>();
    fetchMock.mockReturnValue(d.promise);
    const { container } = render(<Harness translation={{ offer: OFFER, canAddCredits: false }} />);
    const button = screen.getByRole('button', { name: 'Translate' });
    expect(screen.getByText('into English')).toBeTruthy();

    button.focus();
    fireEvent.click(button);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/work-items/item-1/translate');
    expect(init).toEqual({ method: 'POST' });

    // Busy: the SAME element, aria-disabled + aria-busy (never `disabled`), focus kept.
    const busy = control();
    expect(busy).toBe(button);
    expect(busy.textContent).toContain('Translating…');
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.hasAttribute('disabled')).toBe(false);
    expect(document.activeElement).toBe(busy);
    // A second press while busy is ignored.
    fireEvent.click(busy);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Each differing field shows its loading mark; the original stays in place.
    expect(container.querySelectorAll('[data-translation-mark="loading"]')).toHaveLength(2);
    expect(screen.getByRole('heading').textContent).toBe('标题');
    expect(live(container).textContent).toBe('Translating into English…');

    await act(async () => {
      d.resolve(
        ok([
          { fieldRef: 'title', status: 'ready', text: 'Title' },
          { fieldRef: 'description', status: 'ready', text: DESC_EN },
        ]),
      );
    });

    expect(screen.getByRole('heading').textContent).toBe('Title');
    const desc = screen.getByRole('region', { name: 'Description' });
    expect(desc.textContent).toContain('Description');
    // Markdown structure survives the swap: the link, the code block, the chip.
    expect(within(desc).getByRole('link', { name: 'link' }).getAttribute('href')).toBe(
      'https://example.com/a',
    );
    expect(desc.querySelector('pre')?.textContent).toContain('code()');
    expect(desc.querySelector('.wi-chip .wi-key')?.textContent).toBe('MOTIR-9');
    // Marks: each translated field says so, with a text name for AT.
    const marks = container.querySelectorAll('[data-translation-mark="translated"]');
    expect(marks).toHaveLength(2);
    expect(marks[0]!.textContent).toBe('Title: Translated from Chinese');
    expect(marks[1]!.textContent).toBe('Description: Translated from Chinese');
    // The field already in the reader's language is never marked, never swapped.
    const expl = screen.getByRole('region', { name: 'Explanation' });
    expect(expl.querySelector('[data-translation-mark]')).toBeNull();
    expect(expl.textContent).toBe('Already English.');
    // Focus stays on the control; the live region announced the outcome once.
    expect(document.activeElement).toBe(button);
    expect(live(container).textContent).toBe('Translated into English.');
    expect(screen.getByText('Translated into English')).toBeTruthy();
  });

  it('Show original / Show translation toggles locally — fetch is called once in total', async () => {
    fetchMock.mockResolvedValue(ok([{ fieldRef: 'title', status: 'ready', text: 'Title' }]));
    const { container } = render(<Harness translation={{ offer: OFFER, canAddCredits: false }} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Translate' })));

    const toggle = screen.getByRole('button', { name: 'Show original' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);
    expect(screen.getByRole('heading').textContent).toBe('标题');
    expect(control().textContent).toContain('Show translation');
    expect(control().getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('[data-translation-mark]')).toBeNull();
    expect(live(container).textContent).toBe('Showing the original.');

    fireEvent.click(screen.getByRole('button', { name: 'Show translation' }));
    expect(screen.getByRole('heading').textContent).toBe('Title');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('failure', () => {
  it('a whole-item failure offers Retry in the same slot and says nothing was charged', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) } as Response);
    const { container } = render(<Harness translation={{ offer: OFFER, canAddCredits: false }} />);
    const button = screen.getByRole('button', { name: 'Translate' });
    await act(async () => fireEvent.click(button));

    expect(control()).toBe(button);
    expect(button.textContent).toContain('Retry');
    expect(container.querySelector('[data-translation-message="failed"]')?.textContent).toBe(
      'Couldn’t translate this work item. Nothing was charged.',
    );
    // …and the live region says it once.
    expect(live(container).textContent).toBe(
      'Couldn’t translate this work item. Nothing was charged.',
    );
    // The item failed, so the bar says so and the fields stay unmarked.
    expect(container.querySelector('[data-translation-mark]')).toBeNull();
    expect(screen.getByRole('heading').textContent).toBe('标题');

    fetchMock.mockResolvedValueOnce(ok([{ fieldRef: 'title', status: 'ready', text: 'Title' }]));
    await act(async () => fireEvent.click(button));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('heading').textContent).toBe('Title');
  });

  it('a field that failed or timed out beside a translated one gets its own Retry', async () => {
    fetchMock.mockResolvedValueOnce(
      ok([
        { fieldRef: 'title', status: 'ready', text: 'Title' },
        { fieldRef: 'description', status: 'timeout' },
      ]),
    );
    const { container } = render(<Harness translation={{ offer: OFFER, canAddCredits: false }} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Translate' })));

    const failed = container.querySelector('[data-translation-mark="failed"]')!;
    expect(failed.textContent).toContain('Description: Not translated. Nothing was charged.');
    expect(
      screen.getByText('Translated into English · 1 field couldn’t be translated'),
    ).toBeTruthy();
    expect(live(container).textContent).toBe('1 field couldn’t be translated.');

    fetchMock.mockResolvedValueOnce(
      ok([
        { fieldRef: 'title', status: 'ready', text: 'Title' },
        { fieldRef: 'description', status: 'ready', text: DESC_EN },
      ]),
    );
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Retry translating the description' })),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-translation-mark="failed"]')).toBeNull();
    expect(screen.getByRole('region', { name: 'Description' }).textContent).toContain(
      'Description',
    );
  });

  it('an unknown status from the server shows as failed, never as unmarked', async () => {
    fetchMock.mockResolvedValue(
      ok([
        { fieldRef: 'title', status: 'ready', text: 'Title' },
        { fieldRef: 'description', status: 'surprise' },
      ]),
    );
    const { container } = render(<Harness translation={{ offer: OFFER, canAddCredits: false }} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Translate' })));
    expect(container.querySelector('[data-translation-mark="failed"]')).not.toBeNull();
  });
});

describe('no credit', () => {
  const noCredit = () =>
    ok([
      { fieldRef: 'title', status: 'no_credit' },
      { fieldRef: 'description', status: 'no_credit' },
    ]);

  it('an owner or admin is linked to add credits; the button is removed, no Retry', async () => {
    fetchMock.mockResolvedValue(noCredit());
    const { container } = render(<Harness translation={{ offer: OFFER, canAddCredits: true }} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Translate' })));

    expect(screen.getByText(/Translation needs AI credits\. Nothing was charged\./)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Add credits' });
    expect(link.getAttribute('href')).toBe('/settings/organization/billing');
    expect(screen.queryByRole('button', { name: /Translate|Retry/ })).toBeNull();
    expect(container.querySelector('[data-translation-mark]')).toBeNull();
    // Focus left with the removed button and lands on the message.
    expect(document.activeElement).toBe(
      container.querySelector('[data-translation-message="no-credit"]'),
    );
    expect(live(container).textContent).toBe('Translation needs AI credits.');
  });

  it('a member is told who can add them, with no link', async () => {
    fetchMock.mockResolvedValue(noCredit());
    render(<Harness translation={{ offer: OFFER, canAddCredits: false }} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Translate' })));
    expect(screen.getByText(/An organization owner or admin can add them\./)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Add credits' })).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('what is offered', () => {
  it('nothing differing → no control, no disabled button', () => {
    const none: TranslationOfferDTO = {
      targetLanguage: 'en',
      anyNeedsTranslation: false,
      fields: {
        title: { needsTranslation: false, kept: false, sourceLanguage: 'en', revision: 'r0' },
      },
    };
    render(<Harness translation={{ offer: none, canAddCredits: false }} />);
    expect(screen.queryByRole('group', { name: 'Translation' })).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('no provider (the public page) → the bare renderers and no control', () => {
    render(
      <>
        <TranslateControl />
        <FieldTranslationMark fieldRef="title" field="title" />
        <TranslatableMarkdown fieldRef="description" value="Stored text" workItemRefs={{}} />
      </>,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Stored text')).toBeTruthy();
  });

  it('the quick view’s scope is the title and description only; its press still posts once', async () => {
    const wider: TranslationOfferDTO = {
      ...OFFER,
      fields: {
        ...OFFER.fields,
        explanation: { needsTranslation: true, kept: false, sourceLanguage: 'zh', revision: 'r0' },
      },
    };
    fetchMock.mockResolvedValue(
      ok([
        { fieldRef: 'title', status: 'ready', text: 'Title' },
        { fieldRef: 'description', status: 'ready', text: DESC_EN },
        { fieldRef: 'explanation', status: 'failed' },
      ]),
    );
    const { container } = render(
      <Harness
        translation={{ offer: wider, canAddCredits: false }}
        fields={['title', 'description']}
      />,
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Translate' })));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The explanation is outside the host's scope: never marked, never counted.
    expect(container.querySelector('[data-translation-mark="failed"]')).toBeNull();
    expect(screen.getByText('Translated into English')).toBeTruthy();
  });
});
