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
import type { ReviewAgentSourceValue } from '@/lib/dto/approvalGateSettings';

// The REVIEW-AGENT switch (MOTIR-6823), built to
// `design/projects/approvals--review-agent.mock.html` (MOTIR-6816), and the
// exclusion it forms with *Merge automatically* (`approval-gates.md` §12.2a).
// The room is manage-only, so there is no read-only case.

const ON_WHAT = 'Every work item is reviewed before you are asked to approve it.';
const OFF_WHAT = 'A work item is offered for approval as soon as its checks pass.';
const UNAVAILABLE_WHAT =
  'This project merges automatically, so nothing waits for a review. Choose Ask before merging to turn the review agent on.';
const BILLING = "Each review is a Motir agent run, paid from your organisation's AI credits.";
const OFF_NOTE =
  'Turning this off cancels reviews in progress — those work items go straight to the ordinary flow.';
const BLOCKED = 'Turn the review agent off to merge automatically.';
const ASK = 'Ask before merging';
const HOSTED = 'Motir agent';
const OWN = 'Your own agent';
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
    reviewAgentSource: 'hosted',
    reviewBotPostsEnabled: true,
    ...over,
  });
}
const AUTO = 'Merge automatically';

function renderCard(
  initialEnabled: boolean,
  prMergeMode: PrMergeModeValue = 'manual',
  extra: { initialSource?: ReviewAgentSourceValue; initialBotPostsEnabled?: boolean } = {},
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

function renderPair(
  mode: PrMergeModeValue,
  enabled: boolean,
  locale?: 'zh',
  source?: ReviewAgentSourceValue,
) {
  return renderWithIntl(
    <ToastProvider>
      <MergeModeAndReviewAgentCards
        projectKey="ACME"
        initialPrMergeMode={mode}
        initialReviewAgentEnabled={enabled}
        initialReviewAgentSource={source}
      />
    </ToastProvider>,
    locale ? { locale, messages: zh } : undefined,
  );
}

const reviewSwitch = (name = 'Review agent') =>
  screen.getByRole('switch', { name }) as HTMLButtonElement;
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
    expect(screen.getByRole('heading', { name: 'Review agent' })).toBeTruthy();
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.getByText(OFF_WHAT)).toBeTruthy();
    expect(reviewSwitch().getAttribute('aria-checked')).toBe('false');
    expect(reviewSwitch().disabled).toBe(false);
    expect(screen.queryByText(BILLING)).toBeNull();
    expect(screen.queryByText(OFF_NOTE)).toBeNull();
  });

  it('ON: named On, with the billing line AND the switch-off note', () => {
    renderCard(true);
    expect(screen.getByText('On')).toBeTruthy();
    expect(screen.getByText(ON_WHAT)).toBeTruthy();
    expect(reviewSwitch().getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(BILLING)).toBeTruthy();
    expect(screen.getByText(OFF_NOTE)).toBeTruthy();
  });

  it('the description emphasises the moment it stands in front of', () => {
    const { container } = renderCard(false);
    const strongs = [...container.querySelectorAll('strong')].map((s) => s.textContent);
    expect(strongs).toContain('before you are asked to approve it');
    expect(strongs).toContain('To fix');
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
      expect(screen.getByText(BILLING)).toBeTruthy();
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
    expect(screen.getByRole('heading', { name: '审查智能体' })).toBeTruthy();
    expect(screen.getByText('已开启')).toBeTruthy();
    expect(screen.getByText('每个工作项都会先经过审查，然后才会请你批准。')).toBeTruthy();
    expect(
      screen.getByText('每次审查都是一次 Motir 智能体运行，费用从你组织的 AI 额度中扣除。'),
    ).toBeTruthy();
    expect(
      screen.getByText('关闭后，进行中的审查会被取消——这些工作项将直接进入常规流程。'),
    ).toBeTruthy();
    expect(screen.getByText('关闭审查智能体后才能自动合并。')).toBeTruthy();
    expect(reviewSwitch('审查智能体').getAttribute('aria-checked')).toBe('true');
  });

  it('renders the Unavailable state in zh', () => {
    renderPair('auto', false, 'zh');
    expect(screen.getByText('不可用')).toBeTruthy();
    expect(textOf(screen.getByText(/该项目会自动合并/))).toBe(
      '该项目会自动合并，因此没有需要等待审查的内容。请选择合并前询问以开启审查智能体。',
    );
  });
});

describe('ReviewAgentCard — Who reviews (MOTIR-10337 · S3, S4)', () => {
  it('is hidden while the review agent is off (S2) and in an auto project', () => {
    renderCard(false);
    expect(screen.queryByRole('radiogroup', { name: 'Who reviews' })).toBeNull();
    cleanup();
    renderCard(true, 'auto');
    expect(screen.queryByRole('radiogroup', { name: 'Who reviews' })).toBeNull();
  });

  it('defaults to Motir’s hosted agent, with the credits gloss and the billing line', () => {
    const { container } = renderCard(true);
    const group = screen.getByRole('radiogroup', { name: 'Who reviews' });
    expect(group).toBeTruthy();
    expect(option(HOSTED).getAttribute('aria-checked')).toBe('true');
    expect(option(OWN).getAttribute('aria-checked')).toBe('false');
    expect(option(HOSTED).textContent).toContain('Uses AI credits.');
    expect(screen.getByText(BILLING)).toBeTruthy();
    expect(container.querySelector('code')?.textContent).toBe('motir review');
  });

  it('with the own source: free, waits for `motir review`, and no hosted billing line', () => {
    renderCard(true, 'manual', { initialSource: 'own' });
    expect(option(OWN).getAttribute('aria-checked')).toBe('true');
    expect(textOf(option(OWN))).toContain(
      'Free. The review waits until someone runs motir review from their own agent. Nothing starts by itself.',
    );
    expect(screen.queryByText(BILLING)).toBeNull();
    // The switch-off note follows the switch, not the source (S4).
    expect(screen.getByText(OFF_NOTE)).toBeTruthy();
  });

  it('choosing own PATCHes the source ALONE, optimistically, then back to hosted', async () => {
    const { spy, calls } = deferredFetch();
    renderCard(true);

    fireEvent.click(option(OWN));
    expect(option(OWN).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText(BILLING)).toBeNull();
    // S7: every control is disabled while the write is in flight.
    expect(option(HOSTED).disabled).toBe(true);
    expect(reviewSwitch().disabled).toBe(true);
    expect(botSwitch().disabled).toBe(true);
    expect(spy.mock.calls[0]![0]).toBe('/api/projects/MOTIR/approval-gates');
    expect(calls[0]!.body).toEqual({ reviewAgentSource: 'own' });
    await act(async () => calls[0]!.answer(settings({ reviewAgentSource: 'own' })));
    expect(await screen.findByText('Saved')).toBeTruthy();
    await waitFor(() => expect(option(HOSTED).disabled).toBe(false));

    fireEvent.click(option(HOSTED));
    expect(calls[1]!.body).toEqual({ reviewAgentSource: 'hosted' });
    await act(async () => calls[1]!.answer(settings({ reviewAgentSource: 'hosted' })));
    await waitFor(() => expect(option(HOSTED).getAttribute('aria-checked')).toBe('true'));
    expect(screen.getByText(BILLING)).toBeTruthy();
    expect(reviewSwitch().getAttribute('aria-checked')).toBe('true');
    expect(botSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('choosing the selected option sends nothing', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    renderCard(true);
    fireEvent.click(option(HOSTED));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('takes the server’s value from the response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => settings({ reviewAgentSource: 'hosted' })),
    );
    renderCard(true);
    fireEvent.click(option(OWN));
    expect(await screen.findByText('Saved')).toBeTruthy();
    await waitFor(() => expect(option(HOSTED).getAttribute('aria-checked')).toBe('true'));
  });

  it('a failed source write puts the old value BACK with the error toast', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ code: 'INTERNAL' }, { status: 500 })),
    );
    renderCard(true);
    fireEvent.click(option(OWN));
    expect(await screen.findByText(SAVE_ERROR)).toBeTruthy();
    expect(option(HOSTED).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(BILLING)).toBeTruthy();
  });

  it('the radio cards are keyboard operable and named', async () => {
    const { spy, calls } = deferredFetch();
    renderCard(true);
    const own = option(OWN);
    own.focus();
    expect(document.activeElement).toBe(own);
    expect(own.tagName).toBe('BUTTON');
    fireEvent.click(own); // a <button> is activated by Enter/Space as a click
    expect(spy).toHaveBeenCalledTimes(1);
    expect(calls[0]!.body).toEqual({ reviewAgentSource: 'own' });
    // Settle it: React entangles every pending async transition, so a write left
    // in flight would hold later tests' transitions pending.
    await act(async () => calls[0]!.answer(settings({ reviewAgentSource: 'own' })));
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

  it('a flip PATCHes reviewBotPostsEnabled ALONE and leaves the switch and the source', async () => {
    const { calls } = deferredFetch();
    renderCard(true, 'manual', { initialSource: 'own' });

    fireEvent.click(botSwitch());
    expect(botSwitch().getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(POSTING_OFF)).toBeTruthy();
    expect(calls[0]!.body).toEqual({ reviewBotPostsEnabled: false });
    await act(async () =>
      calls[0]!.answer(settings({ reviewBotPostsEnabled: false, reviewAgentSource: 'own' })),
    );
    expect(await screen.findByText('Saved')).toBeTruthy();
    await waitFor(() => expect(botSwitch().disabled).toBe(false));
    expect(botSwitch().getAttribute('aria-checked')).toBe('false');
    expect(reviewSwitch().getAttribute('aria-checked')).toBe('true');
    expect(option(OWN).getAttribute('aria-checked')).toBe('true');

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
  it('an OLDER response of the same control never lands over a newer write', async () => {
    const { calls } = deferredFetch();
    renderCard(true);

    act(() => press(option(OWN)));
    act(() => press(option(HOSTED)));
    expect(calls.map((c) => c.body)).toEqual([
      { reviewAgentSource: 'own' },
      { reviewAgentSource: 'hosted' },
    ]);
    await act(async () => calls[1]!.answer(settings({ reviewAgentSource: 'hosted' })));
    await act(async () => calls[0]!.answer(settings({ reviewAgentSource: 'own' })));
    await waitFor(() => expect(option(HOSTED).disabled).toBe(false));
    expect(option(HOSTED).getAttribute('aria-checked')).toBe('true');
  });

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
    renderCard(true);

    act(() => {
      press(option(OWN));
      press(botSwitch());
    });
    expect(calls.map((c) => c.body)).toEqual([
      { reviewAgentSource: 'own' },
      { reviewBotPostsEnabled: false },
    ]);
    // The bot write fails first; the source write then succeeds with a DTO whose
    // bot value is stale — the source control must not apply it.
    await act(async () => calls[1]!.answer(Response.json({ code: 'INTERNAL' }, { status: 500 })));
    await act(async () =>
      calls[0]!.answer(settings({ reviewAgentSource: 'own', reviewBotPostsEnabled: false })),
    );
    await waitFor(() => expect(option(OWN).disabled).toBe(false));
    expect(option(OWN).getAttribute('aria-checked')).toBe('true');
    expect(botSwitch().getAttribute('aria-checked')).toBe('true');
    expect(reviewSwitch().getAttribute('aria-checked')).toBe('true');
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

describe('the exclusion holds under EITHER source (S6)', () => {
  it.each<ReviewAgentSourceValue>(['hosted', 'own'])(
    'source %s: Merge automatically is disabled with the shipped line while the agent is on',
    (source) => {
      renderPair('manual', true, undefined, source);
      expect(option(AUTO).disabled).toBe(true);
      expect(option(AUTO).getAttribute('aria-disabled')).toBe('true');
      expect(screen.getByText(BLOCKED)).toBeTruthy();
      expect(option(source === 'own' ? OWN : HOSTED).getAttribute('aria-checked')).toBe('true');
    },
  );

  it.each<ReviewAgentSourceValue>(['hosted', 'own'])(
    'source %s: an auto project leaves the review agent Unavailable',
    (source) => {
      renderPair('auto', false, undefined, source);
      expect(screen.getByText('Unavailable')).toBeTruthy();
      expect(reviewSwitch().disabled).toBe(true);
      expect(option(AUTO).disabled).toBe(false);
    },
  );

  it('choosing a source does not re-enable Merge automatically', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => settings({ reviewAgentSource: 'own' })),
    );
    renderPair('manual', true);
    fireEvent.click(option(OWN));
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(option(AUTO).disabled).toBe(true);
    expect(screen.getByText(BLOCKED)).toBeTruthy();
  });

  it('renders the source choice and bot posting in zh', () => {
    renderPair('manual', true, 'zh', 'own');
    expect(screen.getByRole('radiogroup', { name: '由谁审查' })).toBeTruthy();
    expect(option('Motir 智能体').getAttribute('aria-checked')).toBe('false');
    expect(option('你自己的智能体').getAttribute('aria-checked')).toBe('true');
    expect(textOf(option('你自己的智能体'))).toContain(
      '免费。审查会等待有人从自己的智能体运行 motir review。不会自动开始。',
    );
    expect(botSwitch('在拉取请求上发布智能体审查').getAttribute('aria-checked')).toBe('true');
    expect(
      screen.getByText(
        'Motir 的 GitHub 应用会在拉取请求上评论每个结论，并在退回时要求修改。它从不批准。',
      ),
    ).toBeTruthy();
    expect(screen.getByText('关闭审查智能体后才能自动合并。')).toBeTruthy();
  });
});
