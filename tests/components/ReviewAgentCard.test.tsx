// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import zh from '@/messages/zh.json';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { ReviewAgentCard } from '@/app/(authed)/settings/project/approvals/_components/ReviewAgentCard';
import { PrMergeModeCard } from '@/app/(authed)/settings/project/approvals/_components/PrMergeModeCard';
import { MergeModeAndReviewAgentCards } from '@/app/(authed)/settings/project/approvals/_components/MergeModeAndReviewAgentCards';
import type { PrMergeModeValue } from '@/lib/dto/projects';

// The REVIEW setting (MOTIR-6823, reworked by MOTIR-11946), built to
// `design/github/review-path--person-starts.mock.html` Panels 1, 1b, 1c (§ 33.1): a gate on
// approve-and-merge a person starts from the item, with no *Who reviews* choice and no
// AI-credits note, and the exclusion it forms with *Merge automatically* (`approval-gates.md`
// §12.2a). The room is manage-only, so there is no read-only case.

const ON_WHAT =
  'An item in In review waits for a passing review before anyone is asked to approve its merge.';
const OFF_WHAT =
  'An item can be approved for merge as soon as its checks pass. It can still be reviewed from the item; the verdict is recorded and holds nothing.';
const UNAVAILABLE_WHAT =
  'This project merges automatically, so no person approves a merge for a review to stand in front of. Choose Ask before merging to turn Review on.';
const OFF_NOTE =
  'Turning this off releases items waiting for a review: they go straight to approve-and-merge. A review already running still records its verdict.';
const BLOCKED = 'Turn Review off to merge automatically.';
const ASK = 'Ask before merging';
/** The words the retired source choice and billing note carried — none may render. */
const RETIRED = [/Who reviews/, /Your own agent/, /AI credits/, /Uses AI credits/];
const POSTING = 'Post agent reviews on pull requests';
const POSTING_ON =
  "Motir's GitHub app comments every verdict on the pull requests, and asks for changes on a send-back. It never approves.";
const POSTING_OFF = 'Verdicts stay in Motir. Nothing is posted on the pull requests.';
const SAVE_ERROR = "Couldn't save — try again.";

/** A fetch whose every call waits for the test to answer it, in any order. */
function deferredFetch() {
  const calls: Array<{ body: Record<string, unknown>; answer: (r: Response) => void }> = [];
  const spy = vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((answer) => {
        calls.push({ body: JSON.parse(String(init?.body)), answer });
      }),
  );
  vi.stubGlobal('fetch', spy);
  return { spy, calls };
}

/** The settings DTO the PATCH answers, with one field overridden. */
function settings(over: Record<string, unknown>) {
  return Response.json({
    acceptanceVideoEnabled: false,
    reviewAgentEnabled: true,
    designApprovalGate: true,
    reviewBotPostsEnabled: true,
    ...over,
  });
}
const AUTO = 'Merge automatically';

function renderCard(
  initialEnabled: boolean,
  prMergeMode: PrMergeModeValue = 'manual',
  extra: { initialBotPostsEnabled?: boolean } = {},
) {
  return renderWithIntl(
    <ToastProvider>
      <ReviewAgentCard
        projectKey="MOTIR"
        initialEnabled={initialEnabled}
        prMergeMode={prMergeMode}
        {...extra}
      />
    </ToastProvider>,
  );
}

function renderPair(mode: PrMergeModeValue, enabled: boolean, locale?: 'zh') {
  return renderWithIntl(
    <ToastProvider>
      <MergeModeAndReviewAgentCards
        projectKey="ACME"
        initialPrMergeMode={mode}
        initialReviewAgentEnabled={enabled}
      />
    </ToastProvider>,
    locale ? { locale, messages: zh } : undefined,
  );
}

const reviewSwitch = (name = 'Review') => screen.getByRole('switch', { name }) as HTMLButtonElement;
const option = (name: string) =>
  screen.getByRole('radio', { name: new RegExp(name) }) as HTMLButtonElement;
const botSwitch = (name = POSTING) => screen.getByRole('switch', { name }) as HTMLButtonElement;
/** Run an element's React click handler, even while the element is disabled. */
function press(el: HTMLElement) {
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps'))!;
  (el as unknown as Record<string, { onClick: () => void }>)[key]!.onClick();
}
const textOf = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim();

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReviewAgentCard — the three states', () => {
  it('OFF (the default): named Off, the gloss says what happens instead, no footer note (S2)', () => {
    const { container } = renderCard(false);
    expect(container.querySelector('#review-agent')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Review' })).toBeTruthy();
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.getByText(OFF_WHAT)).toBeTruthy();
    expect(reviewSwitch().getAttribute('aria-checked')).toBe('false');
    expect(reviewSwitch().disabled).toBe(false);
    expect(screen.queryByText(OFF_NOTE)).toBeNull();
  });

  it('ON: named On, with the switch-off note and no AI-credits note', () => {
    renderCard(true);
    expect(screen.getByText('On')).toBeTruthy();
    expect(screen.getByText(ON_WHAT)).toBeTruthy();
    expect(reviewSwitch().getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(OFF_NOTE)).toBeTruthy();
    expect(screen.queryByText(/AI credits/)).toBeNull();
  });

  it('the description names the gate it is and who starts a review', () => {
    const { container } = renderCard(false);
    const strongs = [...container.querySelectorAll('strong')].map((s) => s.textContent);
    expect(strongs).toEqual(['approve-and-merge']);
    expect(textOf(container.querySelector('h2 + p'))).toBe(
      'A gate on approve-and-merge. With it on, a work item can’t be approved for merge until an agent review of its current pull requests passes. Nothing starts a review by itself: a person starts it from the item.',
    );
  });

  it.each([
    ['the stored flag OFF', false],
    ['the stored flag ON (a stale pair)', true],
  ])(
    'in an AUTO project, %s: Unavailable, switch off and disabled, no switch-off note',
    (_label, enabled) => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const { container } = renderCard(enabled, 'auto');
      expect(screen.getByText('Unavailable')).toBeTruthy();
      expect(textOf(screen.getByText(/This project merges automatically/))).toBe(UNAVAILABLE_WHAT);
      expect([...container.querySelectorAll('strong')].map((s) => s.textContent)).toContain(ASK);
      expect(screen.queryByText('On')).toBeNull();
      expect(screen.queryByText('Off')).toBeNull();
      expect(reviewSwitch().getAttribute('aria-checked')).toBe('false');
      expect(reviewSwitch().disabled).toBe(true);
      expect(screen.queryByText(/AI credits/)).toBeNull();
      expect(screen.queryByText(OFF_NOTE)).toBeNull();

      fireEvent.click(reviewSwitch());
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('no string uses --el-text-muted', () => {
    const { container } = renderCard(true);
    expect(container.innerHTML).not.toContain('--el-text-muted');
  });
});

describe('ReviewAgentCard — saving, saved, refused', () => {
  it('a flip is optimistic, sends the PATCH, and says Saved', async () => {
    let resolve!: (r: Response) => void;
    const fetchSpy = vi.fn(
      (_url: string, _init?: RequestInit) => new Promise<Response>((r) => (resolve = r)),
    );
    vi.stubGlobal('fetch', fetchSpy);
    renderCard(false);

    fireEvent.click(reviewSwitch());

    // Saving: flipped at once, the switch disabled while the write is in flight.
    expect(reviewSwitch().getAttribute('aria-checked')).toBe('true');
    expect(reviewSwitch().disabled).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/projects/MOTIR/approval-gates');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({ reviewAgentEnabled: true });

    resolve(Response.json({ acceptanceVideoEnabled: true, reviewAgentEnabled: true }));
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(reviewSwitch().getAttribute('aria-checked')).toBe('true');
    // The toast is raised INSIDE the async transition, so it can commit before
    // `isPending` turns false on a later commit (MOTIR-7009). Wait for the
    // re-enable itself rather than reading it synchronously after the toast.
    await waitFor(() => expect(reviewSwitch().disabled).toBe(false));
    expect(screen.getByText(OFF_NOTE)).toBeTruthy();
  });

  it.each([
    ['a 409 REVIEW_AGENT_NEEDS_MANUAL_MERGE', 409, 'REVIEW_AGENT_NEEDS_MANUAL_MERGE'],
    ['a 500', 500, 'INTERNAL'],
  ])('%s puts the switch BACK and says it could not save', async (_label, status, code) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ code }, { status })),
    );
    renderCard(false);

    fireEvent.click(reviewSwitch());

    expect(await screen.findByText("Couldn't save — try again.")).toBeTruthy();
    expect(reviewSwitch().getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Off')).toBeTruthy();
  });
});

describe('PrMergeModeCard — Merge automatically while the review agent is on', () => {
  it('is disabled, dimmed and carries the line; Ask before merging stays live', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    renderWithIntl(
      <ToastProvider>
        <PrMergeModeCard projectKey="MOTIR" initialMode="manual" reviewAgentEnabled />
      </ToastProvider>,
    );
    const auto = option(AUTO);
    expect(auto.disabled).toBe(true);
    expect(auto.getAttribute('aria-disabled')).toBe('true');
    expect(auto.className).toContain('opacity-60');
    expect(auto.textContent).toContain(BLOCKED);
    expect(auto.textContent).toContain('When its checks pass, Motir merges the pull request');
    expect(option(ASK).disabled).toBe(false);
    expect(option(ASK).textContent).not.toContain(BLOCKED);

    fireEvent.click(auto);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('without the review agent, Merge automatically is live and has no extra line', () => {
    renderWithIntl(
      <ToastProvider>
        <PrMergeModeCard projectKey="MOTIR" initialMode="manual" />
      </ToastProvider>,
    );
    expect(option(AUTO).disabled).toBe(false);
    expect(option(AUTO).getAttribute('aria-disabled')).toBeNull();
    expect(screen.queryByText(BLOCKED)).toBeNull();
  });

  it('a 409 MERGE_MODE_REVIEW_AGENT_ON from a stale page puts the mode BACK', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ code: 'MERGE_MODE_REVIEW_AGENT_ON' }, { status: 409 })),
    );
    // Stale: this page believes the review agent is off.
    renderWithIntl(
      <ToastProvider>
        <PrMergeModeCard projectKey="MOTIR" initialMode="manual" reviewAgentEnabled={false} />
      </ToastProvider>,
    );
    fireEvent.click(option(AUTO));
    expect(await screen.findByText("Couldn't save — try again.")).toBeTruthy();
    expect(option(ASK).getAttribute('aria-checked')).toBe('true');
    expect(option(AUTO).getAttribute('aria-checked')).toBe('false');
  });
});

describe('the pair on the page — each card reads the other’s CURRENT value', () => {
  it('switching the review agent ON disables Merge automatically; OFF enables it again', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        Response.json({
          acceptanceVideoEnabled: false,
          reviewAgentEnabled: JSON.parse(String(init?.body)).reviewAgentEnabled,
        }),
      ),
    );
    renderPair('manual', false);
    expect(option(AUTO).disabled).toBe(false);

    fireEvent.click(reviewSwitch());
    // Optimistic: the other card follows at once.
    expect(option(AUTO).disabled).toBe(true);
    expect(screen.getByText(BLOCKED)).toBeTruthy();
    await waitFor(() => expect(reviewSwitch().disabled).toBe(false));

    fireEvent.click(reviewSwitch());
    await waitFor(() => expect(reviewSwitch().getAttribute('aria-checked')).toBe('false'));
    await waitFor(() => expect(option(AUTO).disabled).toBe(false));
    expect(screen.queryByText(BLOCKED)).toBeNull();
  });

  it('a REFUSED review-agent write leaves Merge automatically enabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ code: 'REVIEW_AGENT_NEEDS_MANUAL_MERGE' }, { status: 409 }),
      ),
    );
    renderPair('manual', false);
    fireEvent.click(reviewSwitch());
    expect(await screen.findByText("Couldn't save — try again.")).toBeTruthy();
    expect(reviewSwitch().getAttribute('aria-checked')).toBe('false');
    expect(option(AUTO).disabled).toBe(false);
  });

  it('choosing Merge automatically makes the review agent Unavailable; Ask before merging brings it back', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        Response.json({ prMergeMode: JSON.parse(String(init?.body)).prMergeMode }),
      ),
    );
    renderPair('manual', false);
    expect(screen.getByText('Off')).toBeTruthy();

    fireEvent.click(option(AUTO));
    expect(screen.getByText('Unavailable')).toBeTruthy();
    expect(reviewSwitch().disabled).toBe(true);
    await waitFor(() => expect(option(AUTO).getAttribute('aria-checked')).toBe('true'));

    await waitFor(() => expect(option(ASK).disabled).toBe(false));
    fireEvent.click(option(ASK));
    await waitFor(() => expect(screen.getByText('Off')).toBeTruthy());
    expect(reviewSwitch().disabled).toBe(false);
  });

  it('renders in zh with every string from the catalog', () => {
    renderPair('manual', true, 'zh');
    expect(screen.getByRole('heading', { name: '审查' })).toBeTruthy();
    expect(screen.getByText('已开启')).toBeTruthy();
    expect(
      screen.getByText('处于评审中的工作项会等待审查通过，然后才会请人批准合并。'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        '关闭后，等待审查的工作项会被放行，直接进入批准并合并。已在运行的审查仍会记录其结论。',
      ),
    ).toBeTruthy();
    expect(screen.getByText('关闭审查后才能自动合并。')).toBeTruthy();
    expect(reviewSwitch('审查').getAttribute('aria-checked')).toBe('true');
    // The merge-mode card above keeps its own radiogroup; the Review card has none.
    expect(document.querySelector('#review-agent [role="radiogroup"]')).toBeNull();
    expect(screen.queryByText(/AI 额度/)).toBeNull();
    expect(botSwitch('在拉取请求上发布智能体审查').getAttribute('aria-checked')).toBe('true');
  });

  it('renders the Unavailable state in zh', () => {
    renderPair('auto', false, 'zh');
    expect(screen.getByText('不可用')).toBeTruthy();
    expect(textOf(screen.getByText(/该项目会自动合并/))).toBe(
      '该项目会自动合并，没有人批准合并，审查也就无处把关。请选择合并前询问以开启审查。',
    );
  });
});

describe('ReviewAgentCard — no review source (MOTIR-11946 · Panels 1, 1b, 1c)', () => {
  it.each([
    [false, 'manual'],
    [true, 'manual'],
    [false, 'auto'],
    [true, 'auto'],
  ] as const)('enabled %s, %s: no Who reviews choice and no AI-credits note', (enabled, mode) => {
    const { container } = renderCard(enabled, mode);
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryAllByRole('radio')).toEqual([]);
    for (const words of RETIRED) expect(container.textContent).not.toMatch(words);
  });

  it('no PATCH the card sends carries a review source', async () => {
    const { calls } = deferredFetch();
    renderCard(false);
    fireEvent.click(reviewSwitch());
    await act(async () => calls[0]!.answer(settings({ reviewAgentEnabled: true })));
    await waitFor(() => expect(botSwitch().disabled).toBe(false));
    fireEvent.click(botSwitch());
    await act(async () => calls[1]!.answer(settings({ reviewBotPostsEnabled: false })));
    await waitFor(() => expect(reviewSwitch().disabled).toBe(false));
    fireEvent.click(reviewSwitch());
    await act(async () => calls[2]!.answer(settings({ reviewAgentEnabled: false })));
    expect(calls.map((c) => c.body)).toEqual([
      { reviewAgentEnabled: true },
      { reviewBotPostsEnabled: false },
      { reviewAgentEnabled: false },
    ]);
    for (const c of calls) expect(c.body).not.toHaveProperty('reviewAgentSource');
  });
});

describe('ReviewAgentCard — bot posting (MOTIR-10337 · S2, S5)', () => {
  it('is shown on by default in every state, with the on line', () => {
    for (const [enabled, mode] of [
      [false, 'manual'],
      [true, 'manual'],
      [false, 'auto'],
    ] as const) {
      renderCard(enabled, mode);
      expect(botSwitch().getAttribute('aria-checked')).toBe('true');
      expect(screen.getByText(POSTING_ON)).toBeTruthy();
      cleanup();
    }
  });

  it('an off project reads the off line', () => {
    renderCard(true, 'manual', { initialBotPostsEnabled: false });
    expect(botSwitch().getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(POSTING_OFF)).toBeTruthy();
  });

  it('a flip PATCHes reviewBotPostsEnabled ALONE and leaves the Review switch', async () => {
    const { calls } = deferredFetch();
    renderCard(true, 'manual');

    fireEvent.click(botSwitch());
    expect(botSwitch().getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(POSTING_OFF)).toBeTruthy();
    expect(calls[0]!.body).toEqual({ reviewBotPostsEnabled: false });
    await act(async () => calls[0]!.answer(settings({ reviewBotPostsEnabled: false })));
    expect(await screen.findByText('Saved')).toBeTruthy();
    await waitFor(() => expect(botSwitch().disabled).toBe(false));
    expect(botSwitch().getAttribute('aria-checked')).toBe('false');
    expect(reviewSwitch().getAttribute('aria-checked')).toBe('true');

    fireEvent.click(botSwitch());
    expect(calls[1]!.body).toEqual({ reviewBotPostsEnabled: true });
    await act(async () => calls[1]!.answer(settings({ reviewBotPostsEnabled: true })));
    await waitFor(() => expect(botSwitch().getAttribute('aria-checked')).toBe('true'));
  });

  it('a failed bot write puts it BACK with the error toast', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ code: 'INTERNAL' }, { status: 500 })),
    );
    renderCard(false);
    fireEvent.click(botSwitch());
    expect(await screen.findByText(SAVE_ERROR)).toBeTruthy();
    expect(botSwitch().getAttribute('aria-checked')).toBe('true');
    expect(reviewSwitch().getAttribute('aria-checked')).toBe('false');
  });
});

describe('ReviewAgentCard — the per-control sequence guard', () => {
  // Every control is disabled once a write is in flight (S7), so two overlapping
  // writes can only come from handlers that run before React commits the disabled
  // state (a double activation inside one task). A click on a disabled <button>
  // never reaches React, so these cases call the element's React handler directly
  // — the same function that race would run.
  it('an OLDER failure never puts a value back over a newer write', async () => {
    const { calls } = deferredFetch();
    renderCard(true);

    act(() => press(botSwitch()));
    act(() => press(botSwitch()));
    expect(calls.map((c) => c.body)).toEqual([
      { reviewBotPostsEnabled: false },
      { reviewBotPostsEnabled: true },
    ]);
    await act(async () => calls[1]!.answer(settings({ reviewBotPostsEnabled: true })));
    await act(async () => calls[0]!.answer(Response.json({ code: 'INTERNAL' }, { status: 500 })));
    await waitFor(() => expect(botSwitch().disabled).toBe(false));
    expect(botSwitch().getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText(SAVE_ERROR)).toBeNull();
  });

  it('writes of DIFFERENT controls reconcile only their own value', async () => {
    const { calls } = deferredFetch();
    renderCard(false);

    act(() => {
      press(reviewSwitch());
      press(botSwitch());
    });
    expect(calls.map((c) => c.body)).toEqual([
      { reviewAgentEnabled: true },
      { reviewBotPostsEnabled: false },
    ]);
    // The bot write fails first; the Review write then succeeds with a DTO whose bot
    // value is stale — the Review control must not apply it.
    await act(async () => calls[1]!.answer(Response.json({ code: 'INTERNAL' }, { status: 500 })));
    await act(async () =>
      calls[0]!.answer(settings({ reviewAgentEnabled: true, reviewBotPostsEnabled: false })),
    );
    await waitFor(() => expect(reviewSwitch().disabled).toBe(false));
    expect(reviewSwitch().getAttribute('aria-checked')).toBe('true');
    expect(botSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('the enabled switch carries its own guard too', async () => {
    const { calls } = deferredFetch();
    renderCard(false);
    act(() => press(reviewSwitch()));
    act(() => press(reviewSwitch()));
    expect(calls.map((c) => c.body)).toEqual([
      { reviewAgentEnabled: true },
      { reviewAgentEnabled: false },
    ]);
    await act(async () => calls[1]!.answer(settings({ reviewAgentEnabled: false })));
    await act(async () => calls[0]!.answer(settings({ reviewAgentEnabled: true })));
    await waitFor(() => expect(reviewSwitch().disabled).toBe(false));
    expect(reviewSwitch().getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Off')).toBeTruthy();
  });
});
