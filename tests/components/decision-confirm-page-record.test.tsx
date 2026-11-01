// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import { parseDecisionRecord } from '@/lib/approvalGates/decisionRecord';
import type { ApprovalGateDTO, ConfirmedRecordDTO } from '@/lib/dto/approvalGate';

vi.mock('next/navigation', () => ({
  usePathname: () => '/items/ACME-42',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn() }));

const { DecisionConfirmGateFrame } = await import('@/components/approvals/DecisionConfirmGate');

// THE CONFIRM PORT'S PAGE RECORD (Story MOTIR-5761 · MOTIR-7444;
// `design/approvals/confirm-port--page-record.mock.html`, delta 4). Choose page is a
// publication through the REST door; the record then names the page and its version; the
// confirm list says the version freezes; the confirmed band reads the frozen STAMP.

const t = en.approvalGate.decisionConfirm;
const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));
const plain = (text: string) => ['<b>', '</b>'].reduce((out, tag) => out.split(tag).join(''), text);

const BODY = [
  '## Decision',
  'Exports move to managed object storage.',
  '## What changed',
  '**Change:** workflow',
  'The approved plan kept exports in Postgres.',
  '## Supersedes',
  'ACME-6',
  '## Resulting direction',
  'Every export is written to the bucket.',
].join('\n');

const PAGE: ConfirmedRecordDTO = {
  kind: 'page',
  pageId: 'page-7',
  versionId: 'version-3',
  versionNumber: 3,
  title: 'Exports direction',
};

function view() {
  const parse = parseDecisionRecord(BODY);
  if (!parse.ok) throw new Error(parse.defect.reason);
  const { ok: _ok, ...sections } = parse;
  return { ...sections, supersedesItems: [{ key: 'ACME-6', title: 'Postgres export table' }] };
}

const AWAITING: ApprovalGateDTO = {
  id: 'gate-d1',
  workItemId: 'wi-42',
  kind: 'decision_confirmation',
  subjectId: 'wi-42',
  state: 'awaiting',
  decidedById: null,
  decidedAt: null,
  noteMd: null,
  supersededCause: null,
  subjectVersion: 'a'.repeat(64),
  decidedByLabel: null,
  routedToId: 'user-1',
  decidedUnderAuthority: null,
  decisionSource: null,
  outcomeRef: null,
  confirmedRecord: null,
  refusalVerdict: null,
  offersRefusalVerdict: false,
  replanOwed: null,
  chosenOption: null,
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
};

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const PAGES = {
  items: [
    {
      id: 'page-7',
      title: 'Exports direction',
      updatedAt: '2026-09-20T10:00:00.000Z',
      updatedBy: { id: 'u', name: 'Mei' },
    },
  ],
};

function renderFrame(
  record: ConfirmedRecordDTO,
  over: Partial<React.ComponentProps<typeof DecisionConfirmGateFrame>> = {},
) {
  const onChosen = vi.fn();
  renderWithIntl(
    <DecisionConfirmGateFrame
      gate={AWAITING}
      view={view()}
      workItemRefs={{}}
      record={record}
      recordCount={0}
      presentRecordIds={[]}
      canDecide
      recordPicker={{ itemIdentifier: 'ACME-42', onChosen }}
      routedToLabel="Yue"
      identifier="ACME-42"
      onDecide={vi.fn(async () => null)}
      {...over}
    />,
  );
  return onChosen;
}

async function openPicker() {
  const trigger = await screen.findByRole('combobox', { name: t.record.link });
  fireEvent.click(trigger);
}

describe('Choose page (Panels 1a, 1b, 1d)', () => {
  it('lists the project pages and publishes the chosen one through the REST door', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith('/api/pages')
        ? json(PAGES)
        : json({ publication: { id: 'pub-1', replayed: false } }, 201),
    );
    const onChosen = renderFrame({ kind: 'none' });
    expect(screen.getByText(t.record.chooseHelper)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/pages?projectKey=ACME');
    await openPicker();
    fireEvent.click(await screen.findByRole('option', { name: 'Exports direction' }));
    await waitFor(() => expect(onChosen).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe('/api/work-items/ACME-42/decision-page');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ pageId: 'page-7' });
  });

  it('a project with no pages says so and offers New page', async () => {
    fetchMock.mockResolvedValue(json({ items: [] }));
    renderFrame({ kind: 'none' });
    await act(async () => {});
    await openPicker();
    expect(await screen.findByText(t.record.empty)).toBeTruthy();
    expect(screen.getByRole('link', { name: en.pages.index.newPage }).getAttribute('href')).toBe(
      '/pages',
    );
  });

  it('a refused publication is named in place (Panel 2c)', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith('/api/pages')
        ? json(PAGES)
        : json({ code: 'PAGE_IS_EMPTY', error: 'empty' }, 422),
    );
    const onChosen = renderFrame({ kind: 'none' });
    await openPicker();
    fireEvent.click(await screen.findByRole('option', { name: 'Exports direction' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      plain(fill(t.record.refusal.empty, { title: 'Exports direction' })),
    );
    expect(onChosen).not.toHaveBeenCalled();
  });
});

describe('the picker when something goes wrong', () => {
  it('a list that fails to load says so in the open menu', async () => {
    fetchMock.mockResolvedValue(json({ code: 'BOOM' }, 500));
    renderFrame({ kind: 'none' });
    await act(async () => {});
    await openPicker();
    expect(await screen.findByText(t.record.loadFailed)).toBeTruthy();
  });

  it('a list answer without items is a failed load, not a crash', async () => {
    fetchMock.mockResolvedValue(json({}));
    renderFrame({ kind: 'none' });
    await act(async () => {});
    await openPicker();
    expect(await screen.findByText(t.record.loadFailed)).toBeTruthy();
  });

  it('an untitled page is offered by the untitled name', async () => {
    fetchMock.mockResolvedValue(json({ items: [{ ...PAGES.items[0], title: '' }] }));
    renderFrame({ kind: 'none' });
    await openPicker();
    expect(await screen.findByRole('option', { name: en.pages.untitled })).toBeTruthy();
  });

  it('a publish that never answers, or answers with an unknown code, reads as no access', async () => {
    let publishAnswer: () => Promise<Response> = async () => {
      throw new TypeError('network down');
    };
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith('/api/pages') ? json(PAGES) : publishAnswer(),
    );
    renderFrame({ kind: 'none' });
    await openPicker();
    fireEvent.click(await screen.findByRole('option', { name: 'Exports direction' }));
    expect((await screen.findByRole('alert')).textContent).toBe(plain(t.record.refusal.noAccess));

    publishAnswer = async () => new Response('not json', { status: 500 });
    await openPicker();
    fireEvent.click(await screen.findByRole('option', { name: 'Exports direction' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(plain(t.record.refusal.noAccess)),
    );
  });

  it('a list answering after the picker closed is dropped', async () => {
    let resolveList: (r: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (resolveList = resolve)));
    renderFrame({ kind: 'none' });
    cleanup();
    await act(async () => resolveList(json(PAGES)));
    expect(screen.queryByTestId('decision-record-picker')).toBeNull();
  });
});

describe('chosen (Panel 2a) and the confirm step (Panel 3)', () => {
  it('names the page and its version, links to that version, and offers Change', async () => {
    fetchMock.mockResolvedValue(json(PAGES));
    renderFrame(PAGE);
    const row = screen.getByTestId('decision-record-page');
    expect(row.textContent).toContain(
      plain(fill(t.record.page, { title: 'Exports direction', number: 3 })),
    );
    expect(
      within(row)
        .getByRole('link', { name: /Open page/ })
        .getAttribute('href'),
    ).toBe('/pages/page-7?version=3');
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole('button', { name: t.record.change }));
    expect(await screen.findByRole('combobox', { name: t.record.link })).toBeTruthy();
  });

  it('a reader who cannot edit sees the record without Change', () => {
    renderFrame(PAGE, { recordPicker: undefined });
    const row = screen.getByTestId('decision-record-page');
    expect(within(row).queryByRole('button', { name: t.record.change })).toBeNull();
  });

  it('Confirm names the page record and the freeze', () => {
    fetchMock.mockResolvedValue(json(PAGES));
    renderFrame(PAGE);
    fireEvent.click(screen.getByRole('button', { name: t.verb.confirm }));
    expect(document.body.textContent).toContain(
      plain(fill(t.confirmStep.recordWithPage, { title: 'Exports direction', number: 3 })),
    );
    expect(document.body.textContent).toContain(
      plain(fill(t.confirmStep.freeze, { title: 'Exports direction', number: 3 })),
    );
  });
});

describe('confirmed (Panel 4)', () => {
  it('reads the frozen version from the stamp, with the Frozen chip', () => {
    renderFrame(PAGE, {
      gate: {
        ...AWAITING,
        state: 'approved',
        decidedById: 'user-1',
        decidedAt: '2026-09-21T14:02:00.000Z',
        decidedByLabel: 'Yue',
        outcomeRef: 'done',
        confirmedRecord: PAGE,
      },
      canDecide: false,
    });
    const link = screen.getByRole('link', {
      name: fill(t.band.pageRecord, { title: 'Exports direction', number: 3 }),
    });
    expect(link.getAttribute('href')).toBe('/pages/page-7?version=3');
    expect(screen.getByText(t.band.frozen)).toBeTruthy();
    expect(screen.queryByTestId('decision-record-picker')).toBeNull();
  });
});
