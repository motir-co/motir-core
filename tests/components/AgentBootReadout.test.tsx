// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { AgentBootReadout } from '@/app/(authed)/my-agents/_components/AgentBootReadout';
import { applyBootFrame, useAgentBoot } from '@/app/(authed)/my-agents/_components/useAgentBoot';
import type { AgentInstanceBootDto, AgentInstanceBootStepDto } from '@/lib/dto/agentInstances';

// THE BOOT READ-OUT (Story MOTIR-7393 · MOTIR-7400), held to the approved delta
// `design/my-agents/my-agents--boot.mock.html` (MOTIR-7395): each step state's
// row, the failed way out, a wake's skipped clones, the running summary — and the
// stream hook's sequencing and resume.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const T0 = Date.parse('2026-10-02T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

function step(
  ordinal: number,
  over: Partial<AgentInstanceBootStepDto> = {},
): AgentInstanceBootStepDto {
  return {
    seq: ordinal + 1,
    step: 'provision',
    repository: null,
    ordinal,
    state: 'waiting',
    startedAt: null,
    endedAt: null,
    detail: null,
    waiting: null,
    waited: null,
    ...over,
  };
}

function boot(over: Partial<AgentInstanceBootDto> = {}): AgentInstanceBootDto {
  return {
    attempt: 1,
    kind: 'create',
    startedAt: at(0),
    endedAt: null,
    outcome: null,
    seq: 8,
    steps: [
      step(0, { step: 'provision', state: 'done', startedAt: at(0), endedAt: at(3) }),
      step(1, { step: 'machine_start', state: 'in_progress', startedAt: at(3) }),
      step(2, { step: 'clone', repository: 'acme/web' }),
      step(3, { step: 'clone', repository: 'acme/api' }),
      step(4, { step: 'terminal_check' }),
      step(5, { step: 'ready' }),
    ],
    ...over,
  };
}

const noop = () => {};
const readout = (b: AgentInstanceBootDto, agentState = 'starting', extra = {}) =>
  render(
    <AgentBootReadout
      boot={b}
      agentState={agentState}
      waking={false}
      onWake={noop}
      onDelete={noop}
      {...extra}
    />,
  );
const rows = () => [...document.querySelectorAll('[data-testid="agent-boot"] li')];

describe('the read-out while booting', () => {
  it('bounds a tall read-out so it scrolls inside its own box instead of crushing the terminal area (MOTIR-8845)', () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      step(i, { step: 'clone', repository: `acme/repo-${i}` }),
    );
    readout(boot({ steps: many }));
    const section = screen.getByTestId('agent-boot');
    expect(section.className).toContain('max-h-[45%]');
    expect(section.className).toContain('overflow-y-auto');
    expect(section.className).toContain('shrink-0');
  });

  it('draws one row per step in order, each state with its words, the done duration and the live clock', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(T0 + 44_000);
    readout(boot());
    const section = screen.getByRole('region', { name: 'Boot steps' });
    expect(within(section).getByRole('heading', { name: 'Booting' })).toBeTruthy();
    expect(rows().map((r) => r.getAttribute('data-state'))).toEqual([
      'done',
      'in_progress',
      'waiting',
      'waiting',
      'waiting',
      'waiting',
    ]);
    expect(rows()[0]!.textContent).toContain('Machine provisioned');
    expect(rows()[0]!.textContent).toContain('— Done');
    expect(rows()[0]!.textContent).toContain('3s');
    // The in-progress row ticks from its own start: 41 seconds in.
    expect(rows()[1]!.textContent).toContain('0:41');
    expect(rows()[2]!.textContent).toContain('Cloning acme/web');
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(rows()[1]!.textContent).toContain('0:42');
  });

  it('a wake skips its clone rows, in words, and is headed Waking', () => {
    readout(
      boot({
        kind: 'wake',
        steps: [
          step(0, { state: 'done', startedAt: at(0), endedAt: at(1) }),
          step(1, { step: 'machine_start', state: 'in_progress', startedAt: at(1) }),
          step(2, { step: 'clone', repository: 'acme/web', state: 'skipped' }),
          step(3, { step: 'terminal_check', state: 'skipped' }),
          step(4, { step: 'ready' }),
        ],
      }),
      'waking',
    );
    expect(screen.getByRole('heading', { name: 'Waking' })).toBeTruthy();
    expect(rows()[2]!.getAttribute('data-state')).toBe('skipped');
    expect(rows()[2]!.textContent).toContain('Skipped — a wake keeps the home');
    expect(rows()[3]!.textContent).toContain('Skipped — no terminal on this deployment');
  });
});

describe('the read-out once failed', () => {
  it('names the failed step with its reason in words, leaves the rest waiting, and offers Wake and Delete…', () => {
    const onWake = vi.fn();
    const onDelete = vi.fn();
    readout(
      boot({
        outcome: 'failed',
        endedAt: at(72),
        steps: [
          step(0, { state: 'done', startedAt: at(0), endedAt: at(3) }),
          step(1, {
            step: 'machine_start',
            state: 'failed',
            startedAt: at(3),
            endedAt: at(72),
            detail: 'exit code 0',
          }),
          step(2, { step: 'clone', repository: 'acme/web' }),
          step(3, { step: 'ready' }),
        ],
      }),
      'failed',
      { onWake, onDelete },
    );
    expect(screen.getByRole('heading', { name: 'Failed after 1m 12s' })).toBeTruthy();
    expect(rows()[1]!.getAttribute('data-state')).toBe('failed');
    expect(rows()[1]!.textContent).toContain('The machine exited during boot (exit code 0)');
    expect(rows()[2]!.getAttribute('data-state')).toBe('waiting');
    expect(screen.getByText('Wake to try again, or delete it.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Wake' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(onWake).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it('shows a reason Motir did not write as sent, and the deadline in minutes', () => {
    readout(
      boot({
        outcome: 'failed',
        endedAt: at(600),
        steps: [
          step(0, {
            state: 'failed',
            startedAt: at(0),
            endedAt: at(2),
            detail: 'flyio: region iad is at capacity',
          }),
          step(1, {
            step: 'machine_start',
            state: 'failed',
            startedAt: at(2),
            endedAt: at(600),
            detail: 'the machine did not start in time',
          }),
        ],
      }),
      'failed',
    );
    expect(rows()[0]!.textContent).toContain('flyio: region iad is at capacity');
    expect(rows()[1]!.textContent).toContain('The boot didn’t finish within 10 minutes');
  });

  it('a deletion mid-boot is the reader’s own act: struck through, no danger, the panel’s last word', () => {
    readout(
      boot({
        outcome: 'deleted',
        endedAt: at(20),
        steps: [
          step(0, { state: 'done', startedAt: at(0), endedAt: at(3) }),
          step(1, {
            step: 'machine_start',
            state: 'failed',
            startedAt: at(3),
            endedAt: at(20),
            detail: 'deleted',
          }),
        ],
      }),
      'deleting',
    );
    expect(screen.getByRole('heading', { name: 'Deleted — this panel closes' })).toBeTruthy();
    expect(rows()[1]!.getAttribute('data-state')).toBe('deleted');
    expect(screen.queryByRole('button', { name: 'Wake' })).toBeNull();
  });
});

describe('once running', () => {
  it('collapses to one summary line, with Show steps / Hide steps', () => {
    readout(
      boot({
        outcome: 'running',
        endedAt: at(72),
        steps: [step(0, { state: 'done', startedAt: at(0), endedAt: at(3) })],
      }),
      'running',
    );
    expect(screen.getByText('Booted in 1m 12s')).toBeTruthy();
    expect(rows()).toHaveLength(0);
    const toggle = screen.getByRole('button', { name: 'Show steps' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(rows()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Hide steps' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('a wake says Woke in, and renders in Chinese from the zh catalog', () => {
    render(
      <AgentBootReadout
        boot={boot({ kind: 'wake', outcome: 'running', endedAt: at(5), steps: [] })}
        agentState="running"
        waking={false}
        onWake={noop}
        onDelete={noop}
      />,
      { messages: zhMessages as Record<string, unknown>, locale: 'zh' },
    );
    expect(screen.getByText('唤醒用时 5 秒')).toBeTruthy();
  });
});

describe('the read-out’s edges', () => {
  it('words each reason it can, and draws what it cannot as sent', () => {
    readout(
      boot({
        outcome: 'failed',
        steps: [
          step(0, { step: 'provision', state: 'failed', startedAt: at(0), endedAt: at(1) }),
          step(1, {
            step: 'clone',
            repository: 'acme/web',
            state: 'failed',
            startedAt: at(1),
            endedAt: at(2),
            detail: 'the GitHub App is not installed on acme',
          }),
          step(2, {
            step: 'clone',
            repository: 'acme/api',
            state: 'skipped',
            detail: 'no longer connected to the project',
          }),
          step(3, { step: 'machine_start', state: 'in_progress', startedAt: null }),
        ],
      }),
      'failed',
    );
    const [provision, web, api, machine] = rows();
    expect(provision!.getAttribute('data-state')).toBe('failed');
    expect(web!.textContent).toMatch(/acme\/web/);
    expect(web!.textContent).not.toMatch(/not installed on acme/);
    expect(api!.textContent).toContain('no longer connected to the project');
    expect(machine!.textContent).toContain('0:00');
  });

  it('announces the newest change of state, never the first paint', () => {
    const first = boot();
    const view = readout(first);
    expect(screen.getByRole('status').textContent).toBe('');
    const next = boot({
      seq: 9,
      steps: first.steps.map((s) =>
        s.ordinal === 1 ? { ...s, state: 'done', endedAt: at(20), seq: 9 } : s,
      ),
    });
    view.rerender(
      <AgentBootReadout
        boot={next}
        agentState="starting"
        waking={false}
        onWake={noop}
        onDelete={noop}
      />,
    );
    expect(screen.getByRole('status').textContent).toMatch(/Machine started/);
  });

  it('draws nothing for a running attempt once the agent has moved on', () => {
    readout(boot({ outcome: 'running' }), 'hibernated');
    expect(document.querySelector('[data-testid="agent-boot"]')).toBeNull();
  });
});

describe('waiting for room (MOTIR-9475, the waiting delta)', () => {
  const waitingBoot = (reason: 'pool' | 'account', kind: 'create' | 'wake' = 'create') =>
    boot({
      kind,
      steps: [
        step(0, {
          state: 'in_progress',
          startedAt: at(0),
          detail: `waiting_for_room:${reason}`,
          waiting: { reason, since: at(0) },
        }),
        step(1, { step: 'machine_start' }),
        step(2, {
          step: 'clone',
          repository: 'acme/web',
          state: kind === 'wake' ? 'skipped' : 'waiting',
        }),
        step(3, { step: 'terminal_check' }),
        step(4, { step: 'ready' }),
      ],
    });

  it('a new agent: the waiting row in front of the provision row, the new-agent reason, no failed look and no retry', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(T0 + 65_000);
    readout(waitingBoot('pool'));
    const states = rows().map((r) => r.getAttribute('data-state'));
    expect(states.slice(0, 3)).toEqual(['waiting-for-room', 'waiting', 'waiting']);
    const row = rows()[0]!;
    expect(row.textContent).toContain('Waiting for room');
    expect(row.textContent).toContain(
      'All machines for agents are in use right now. Yours will be created as soon as there is room.',
    );
    expect(row.textContent).toContain('A new agent — it starts wherever room frees up first.');
    expect(row.textContent).toContain('1:05');
    expect(row.className).toContain('bg-(--el-tint-sky)');
    expect(row.className).not.toContain('danger');
    // The provision row waits behind it.
    expect(rows()[1]!.textContent).toContain('Machine provisioned');
    expect(document.querySelector('[data-state="failed"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /wake|retry|try again/i })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Booting' })).toBeTruthy();
  });

  it('a woken agent: its files live in one place, so it waits there, and they are safe', () => {
    readout(waitingBoot('account', 'wake'), 'waking');
    const row = rows()[0]!;
    expect(row.textContent).toContain(
      'This agent’s files live in one place, so it waits for room there. Your files and your sign-in are safe.',
    );
    expect(row.textContent).toContain('Waking — it can only start where its files are.');
    expect(screen.getByRole('heading', { name: 'Waking' })).toBeTruthy();
  });

  it('the since line reads whole minutes from ten minutes on, and follows the clock', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(T0 + 9 * 60_000 + 59_000);
    readout(waitingBoot('pool'));
    expect(screen.queryByTestId('agent-boot-waiting-since')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId('agent-boot-waiting-since').textContent).toBe(
      'Waiting for 10 minutes — Motir keeps trying by itself.',
    );
    act(() => {
      vi.advanceTimersByTime(2 * 60_000);
    });
    expect(screen.getByTestId('agent-boot-waiting-since').textContent).toContain(
      'Waiting for 12 minutes',
    );
  });

  it('once room is found the row is a done Room found row, and the boot carries on as before', () => {
    readout(
      boot({
        steps: [
          step(0, {
            state: 'done',
            startedAt: at(0),
            endedAt: at(125),
            detail: 'waiting_for_room:pool',
            waited: { reason: 'pool', since: at(0), until: at(125) },
          }),
          step(1, { step: 'machine_start', state: 'in_progress', startedAt: at(125) }),
          step(2, { step: 'ready' }),
        ],
      }),
    );
    expect(rows().map((r) => r.getAttribute('data-state'))).toEqual([
      'room-found',
      'done',
      'in_progress',
      'waiting',
    ]);
    expect(rows()[0]!.textContent).toContain('Room found');
    expect(rows()[0]!.textContent).toContain('2m 05s');
    expect(rows()[0]!.textContent).not.toContain('All machines');
    expect(rows()[1]!.textContent).toContain('Machine provisioned');
    expect(rows()[1]!.textContent).toContain('0s');
  });

  it('a waiting step is never drawn failed, and a genuine failure keeps its look', () => {
    readout(
      boot({ outcome: 'failed', endedAt: at(30), ...{ steps: waitingBoot('pool').steps } }),
      'failed',
    );
    expect(rows()[0]!.getAttribute('data-state')).toBe('waiting-for-room');
    expect(rows()[0]!.className).not.toContain('danger');
    cleanup();
    readout(
      boot({
        outcome: 'failed',
        endedAt: at(30),
        steps: [
          step(0, { state: 'failed', startedAt: at(0), endedAt: at(30), detail: 'exit code 3' }),
          step(1, { step: 'ready' }),
        ],
      }),
      'failed',
    );
    expect(rows()[0]!.getAttribute('data-state')).toBe('failed');
    expect(rows()[0]!.className).toContain('border-(--el-danger)');
  });

  it('announces Waiting for room as a change of state, then its end — never the clock', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(T0 + 5_000);
    const plain = boot({
      steps: [step(0, { state: 'in_progress', startedAt: at(0) }), step(1, { step: 'ready' })],
    });
    const view = readout(plain);
    const rerender = (b: AgentInstanceBootDto) =>
      view.rerender(
        <AgentBootReadout
          boot={b}
          agentState="starting"
          waking={false}
          onWake={noop}
          onDelete={noop}
        />,
      );
    const waitingNow = boot({
      seq: 9,
      steps: [
        step(0, {
          state: 'in_progress',
          startedAt: at(0),
          waiting: { reason: 'pool', since: at(0) },
        }),
        step(1, { step: 'ready' }),
      ],
    });
    rerender(waitingNow);
    expect(screen.getByRole('status').textContent).toBe('Waiting for room: In progress');
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByRole('status').textContent).toBe('Waiting for room: In progress');
    rerender(
      boot({
        seq: 10,
        steps: [
          step(0, {
            state: 'done',
            startedAt: at(0),
            endedAt: at(9),
            waited: { reason: 'pool', since: at(0), until: at(9) },
          }),
          step(1, { step: 'ready' }),
        ],
      }),
    );
    expect(screen.getByRole('status').textContent).toBe('Waiting for room: Done');
  });

  it('names no provider, account, zone, shard or quota', () => {
    readout(waitingBoot('pool'));
    const text = screen.getByTestId('agent-boot').textContent!.toLowerCase();
    for (const word of ['aws', 'fly', 'account', 'zone', 'shard', 'quota', 'ec2']) {
      expect(text).not.toContain(word);
    }
  });

  it('renders in Chinese from the zh catalog', () => {
    readout(waitingBoot('pool'), 'starting', {});
    cleanup();
    render(
      <AgentBootReadout
        boot={waitingBoot('pool')}
        agentState="starting"
        waking={false}
        onWake={noop}
        onDelete={noop}
      />,
      { locale: 'zh', messages: zhMessages },
    );
    expect(rows()[0]!.textContent).toContain('等待空位');
  });
});

describe('applyBootFrame — a stale frame never overwrites a newer one', () => {
  it('applies a newer step, ignores an older seq, another attempt and an older snapshot', () => {
    const b = boot();
    const newer = applyBootFrame(b, {
      event: 'step',
      data: { ...b.steps[1]!, state: 'done', endedAt: at(40), seq: 9, attempt: 1 },
    })!;
    expect(newer.steps[1]!.state).toBe('done');
    expect(newer.seq).toBe(9);
    const stale = applyBootFrame(newer, {
      event: 'step',
      data: { ...b.steps[1]!, state: 'in_progress', seq: 7, attempt: 1 },
    });
    expect(stale).toBe(newer);
    const otherAttempt = applyBootFrame(newer, {
      event: 'step',
      data: { ...b.steps[1]!, seq: 20, attempt: 2 },
    });
    expect(otherAttempt).toBe(newer);
    const wake = boot({ attempt: 2, kind: 'wake' });
    expect(applyBootFrame(newer, { event: 'snapshot', data: wake })).toBe(wake);
    expect(applyBootFrame(wake, { event: 'snapshot', data: b })).toBe(wake);
    expect(
      applyBootFrame(newer, { event: 'done', data: { state: 'running', seq: 12 } })!.outcome,
    ).toBe('running');
  });
});

describe('useAgentBoot — resume and stop', () => {
  function sse(frames: string[], close: boolean): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(f));
        if (close) controller.close();
      },
    });
    return { ok: true, status: 200, body } as Response;
  }
  const frame = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  function Probe() {
    const { boot: b } = useAgentBoot({
      projectKey: 'MOTIR',
      agentId: 'a1',
      live: true,
      epoch: 'x',
    });
    return (
      <p data-testid="probe">
        {b ? `${b.attempt}:${b.steps[1]!.state}:${b.outcome ?? 'open'}` : 'none'}
      </p>
    );
  }

  it('resumes with ?since=<last seq> after a dropped stream, and reads nothing after done', async () => {
    const b = boot();
    const fetchMock = vi
      .fn()
      // The first stream sends the snapshot, then drops.
      .mockResolvedValueOnce(sse([frame('snapshot', b)], true))
      .mockResolvedValueOnce(
        sse(
          [
            frame('snapshot', b),
            frame('step', { ...b.steps[1]!, state: 'done', seq: 9, attempt: 1 }),
            frame('done', { state: 'running', seq: 9 }),
          ],
          false,
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('1:in_progress:open'));
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('1:done:running'), {
      timeout: 4_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/boot/stream?since=0');
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/boot/stream?since=8');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('skips frames that are not the boot’s, retries a failed fetch, and stops on a refusal', async () => {
    const b = boot();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(
        sse([': heartbeat\n\n', frame('error', { seq: 99 }), frame('snapshot', b)], true),
      )
      .mockResolvedValueOnce({ ok: false, status: 404, body: null } as Response);
    vi.stubGlobal('fetch', fetchMock);
    render(<Probe />);
    await waitFor(
      () => expect(screen.getByTestId('probe').textContent).toBe('1:in_progress:open'),
      {
        timeout: 4_000,
      },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3), { timeout: 6_000 });
    // The error frame's seq never moved the cursor.
    expect(String(fetchMock.mock.calls[2]![0])).toContain('since=8');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 15_000);

  it('stops reading when the panel goes away mid-stream', async () => {
    let push: (chunk: string) => void = () => {};
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => controller.enqueue(encoder.encode(chunk));
      },
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, body } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const view = render(<Probe />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    view.unmount();
    push(frame('snapshot', boot()));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a done frame changes nothing before a snapshot, or after the outcome is set', () => {
    expect(applyBootFrame(null, { event: 'done', data: { state: 'running', seq: 3 } })).toBeNull();
    const ended = boot({ outcome: 'failed' });
    expect(applyBootFrame(ended, { event: 'done', data: { state: 'running', seq: 30 } })).toBe(
      ended,
    );
  });
});
