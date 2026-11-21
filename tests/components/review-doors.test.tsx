// @vitest-environment happy-dom
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { HostedModelsProvider } from '@/components/hosted/HostedModelsProvider';
import { ReviewDoors, reviewHostedRefusalOf } from '@/components/github/ReviewDoors';
import {
  ReviewInMyAgentControl,
  reviewInMyAgentRefusalOf,
} from '@/components/agentRuns/ReviewInMyAgentControl';
import type { AgentForCardDto, ReviewInMyAgentDoorDto } from '@/lib/dto/agentInstanceRuns';

// THE REVIEW DOORS (Story MOTIR-11941 · MOTIR-11948; `design/github/design-notes.md` § 33.4–
// § 33.5, `review-path--person-starts.mock.html` Panels 4–5b). DB-free under happy-dom: the
// routes are stubbed, so what is asserted is the REQUEST each press makes and what each
// answer draws — the doors decide nothing themselves.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/items/ACME-12',
  useSearchParams: () => new URLSearchParams(),
}));

const hostedRun = vi.hoisted(() => ({
  value: null as null | { itemKey: string; notifyRunsChanged: () => void },
}));
vi.mock('@/app/(authed)/items/[key]/_components/HostedRunProvider', () => ({
  useHostedRun: () => hostedRun.value,
}));
import { ReviewDoorsDoor } from '@/app/(authed)/items/[key]/_components/ReviewDoorsDoor';

const doors = en.approvalGate.agentReview.doors;
const picker = en.approvalGate.agentReview.picker;
const refused = en.runs.hosted.refused;

type Answer = { status: number; body: unknown };
type Handler = (init?: RequestInit) => Answer | Promise<Answer>;
let routes: Record<string, Handler> = {};
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`;
  const handler = routes[key];
  if (!handler) return new Response('{}', { status: 500 });
  const { status, body } = await handler(init);
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
});
const calls = (key: string) =>
  fetchMock.mock.calls.filter(
    ([input, init]) => `${init?.method ?? 'GET'} ${String(input).split('?')[0]}` === key,
  );
const bodyOf = (key: string, at = 0) =>
  JSON.parse(String(calls(key)[at]![1]!.body)) as Record<string, unknown>;

const MODELS = 'GET /api/hosted-runs/models';
const HOSTED = 'POST /api/work-items/ACME-12/review-with-motir-agent';
const DOOR = 'GET /api/work-items/ACME-12/review-in-my-agent';
const START = 'POST /api/work-items/ACME-12/review-in-my-agent';
const AGENTS = 'GET /api/work-items/ACME-12/agent-runs/agents';

function agent(over: Partial<AgentForCardDto> = {}): AgentForCardDto {
  return {
    id: 'ag1',
    name: 'yue-claude',
    profileId: 'claude',
    profileName: 'Claude Code',
    state: 'running',
    runLauncher: 'present',
    signInState: 'signed_in',
    signInCheckedAt: '2026-11-20T08:00:00.000Z',
    runningRun: null,
    refusal: null,
    ...over,
  };
}

const OFFERED = (lastUsedOnItem = false): ReviewInMyAgentDoorDto => ({
  offered: true,
  agent: {
    id: 'ag2',
    name: 'yue-laptop',
    profileId: 'claude',
    profileName: 'Claude Code',
    state: 'running',
  },
  lastUsedOnItem,
  gateId: 'g1',
  subjectVersion: 'v1',
});
const NOT_OFFERED = (
  reason: Extract<ReviewInMyAgentDoorDto, { offered: false }>['reason'],
): ReviewInMyAgentDoorDto => ({ offered: false, reason, run: null, refusal: null });

beforeEach(() => {
  routes = {
    [MODELS]: () => ({
      status: 200,
      body: {
        models: [{ id: 'claude-opus-5-5', provider: 'anthropic' }],
        default: 'claude-opus-5-5',
      },
    }),
    [HOSTED]: () => ({ status: 201, body: { dispatchRunId: 'run_r1', created: true } }),
    [DOOR]: () => ({ status: 200, body: OFFERED() }),
    [START]: () => ({ status: 201, body: { dispatchRunId: 'run_r2' } }),
    [AGENTS]: () => ({
      status: 200,
      body: { agents: [agent(), agent({ id: 'ag2', name: 'yue-laptop' })] },
    }),
  };
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mountDoors(
  props: Partial<React.ComponentProps<typeof ReviewDoors>> = {},
  messages?: Record<string, unknown>,
) {
  render(
    <HostedModelsProvider workItemKey="ACME-12">
      <ReviewDoors
        itemKey="ACME-12"
        command="motir review ACME-12"
        hosted
        myAgent={{ projectName: 'Acme' }}
        {...props}
      />
    </HostedModelsProvider>,
    messages ? { messages, locale: 'zh' } : {},
  );
  await act(async () => {});
}
const pressHosted = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('review-with-motir-agent'));
  });
};

describe('the three doors, in order', () => {
  it('Motir agent, my agent (secondary), or run — and the AI-credits note', async () => {
    await mountDoors();
    const row = screen.getByTestId('review-doors');
    expect(within(row).getByTestId('review-with-motir-agent').textContent).toBe(doors.motirAgent);
    expect(within(row).getByTestId('review-in-my-agent').textContent).toContain(doors.myAgent);
    expect(row.textContent).toContain(doors.orRun);
    expect(row.textContent).toContain('motir review ACME-12');
    expect(screen.getByTestId('review-credits-note').textContent).toBe(doors.creditsNote);
    // Door order in the DOM: hosted, my agent, the command.
    const text = row.textContent!;
    expect(text.indexOf(doors.motirAgent)).toBeLessThan(text.indexOf(doors.myAgent));
    expect(text.indexOf(doors.myAgent)).toBeLessThan(text.indexOf('motir review ACME-12'));
  });

  it('no hosted door: my agent leads as primary, and no credits note', async () => {
    await mountDoors({ hosted: false });
    expect(screen.queryByTestId('review-with-motir-agent')).toBeNull();
    expect(screen.queryByTestId('review-credits-note')).toBeNull();
    expect(screen.getByTestId('review-in-my-agent')).toBeTruthy();
    expect(screen.getByTestId('review-doors').textContent).toContain(doors.orRun);
  });

  it('only the command: no "or run" before it', async () => {
    await mountDoors({ hosted: false, myAgent: null });
    const row = screen.getByTestId('review-doors');
    expect(row.textContent).not.toContain(doors.orRun);
    expect(row.textContent).toContain('motir review ACME-12');
    expect(calls(DOOR)).toHaveLength(0);
  });

  it('renders in zh without a missing key', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await mountDoors({}, zh);
    expect(screen.getByTestId('review-with-motir-agent').textContent).toBe(
      zh.approvalGate.agentReview.doors.motirAgent,
    );
    expect(errors.mock.calls.filter((c) => String(c[0]).includes('MISSING_MESSAGE'))).toEqual([]);
    errors.mockRestore();
  });
});

describe('Review with Motir agent', () => {
  it('POSTs the picked model and a per-press key, then reports the start', async () => {
    const onStarted = vi.fn();
    await mountDoors({ onStarted });
    await pressHosted();
    expect(calls(HOSTED)).toHaveLength(1);
    const body = bodyOf(HOSTED);
    expect(Object.keys(body).sort()).toEqual(['idempotencyKey', 'model']);
    expect(body.model).toBe('claude-opus-5-5');
    expect(typeof body.idempotencyKey).toBe('string');
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it('a double press while the first is pending sends ONE request', async () => {
    let release!: () => void;
    routes[HOSTED] = () =>
      new Promise((r) => {
        release = () => r({ status: 201, body: {} });
      });
    await mountDoors();
    await pressHosted();
    await pressHosted();
    expect(calls(HOSTED)).toHaveLength(1);
    await act(async () => release());
  });

  it('the hosted kill-switch hides the door, the credits note with it', async () => {
    routes[HOSTED] = () => ({ status: 403, body: { code: 'ORG_FEATURE_DISABLED' } });
    await mountDoors();
    await pressHosted();
    expect(screen.queryByTestId('review-with-motir-agent')).toBeNull();
    expect(screen.queryByTestId('review-credits-note')).toBeNull();
    expect(screen.getByTestId('review-in-my-agent')).toBeTruthy();
  });

  it('a stale page re-reads, and the nearest true sentence is drawn', async () => {
    const onStateMoved = vi.fn();
    routes[HOSTED] = () => ({
      status: 409,
      body: { code: 'REVIEW_START_NOT_OFFERED', reason: 'review_in_flight' },
    });
    await mountDoors({ onStateMoved });
    await pressHosted();
    expect(onStateMoved).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('review-hosted-refused-stale').textContent).toContain(
      refused.failed.title,
    );
  });

  it('out of credits reads its own refusal', async () => {
    routes[HOSTED] = () => ({ status: 402, body: { code: 'hosted_run_out_of_credits' } });
    await mountDoors();
    await pressHosted();
    expect(screen.getByTestId('review-hosted-refused-outOfCredits').textContent).toContain(
      refused.outOfCredits.title,
    );
  });

  it.each([
    [{ status: 409, body: { code: 'hosted_model_not_offered' } }, 'modelNotOffered'],
    [{ status: 409, body: { code: 'hosted_run_no_capacity' } }, 'noCapacity'],
    [
      { status: 409, body: { code: 'hosted_repository_not_writable', repositories: [] } },
      'notWritable',
    ],
    [{ status: 409, body: { code: 'hosted_run_card_not_ready' } }, 'notReady'],
  ] as const)('the hosted refusal %j draws its %s notice', async (answer, kind) => {
    routes[HOSTED] = () => answer;
    await mountDoors();
    await pressHosted();
    expect(screen.getByTestId(`review-hosted-refused-${kind}`)).toBeTruthy();
  });

  it('a start answer with no JSON body still settles', async () => {
    routes[HOSTED] = () => ({ status: 201, body: undefined });
    const onStarted = vi.fn();
    await mountDoors({ onStarted });
    await pressHosted();
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it('a network failure reads Not started', async () => {
    routes[HOSTED] = () => Promise.reject(new TypeError('offline'));
    await mountDoors();
    await pressHosted();
    expect(screen.getByTestId('review-hosted-refused-failed')).toBeTruthy();
  });

  it('an unavailable model list draws its retry', async () => {
    routes[MODELS] = () => ({ status: 500, body: {} });
    await mountDoors();
    expect(screen.getByTestId('review-with-motir-agent').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('review-hosted-models-unavailable')).toBeTruthy();
  });

  it('an empty model list says so', async () => {
    routes[MODELS] = () => ({ status: 200, body: { models: [], default: null } });
    await mountDoors();
    expect(screen.getByTestId('review-hosted-models-empty')).toBeTruthy();
  });
});

describe('reviewHostedRefusalOf', () => {
  it('maps the review start’s own codes, and hands every other to the hosted mapping', () => {
    expect(reviewHostedRefusalOf(403, { code: 'ORG_FEATURE_DISABLED' }, 'm')).toEqual({
      kind: 'laneOff',
    });
    expect(reviewHostedRefusalOf(409, { code: 'REVIEW_START_NOT_OFFERED' }, 'm')).toEqual({
      kind: 'stale',
    });
    expect(reviewHostedRefusalOf(403, { code: 'REVIEW_START_FORBIDDEN' }, 'm')).toEqual({
      kind: 'stale',
    });
    expect(reviewHostedRefusalOf(404, {}, 'm')).toEqual({ kind: 'stale' });
    expect(reviewHostedRefusalOf(402, { code: 'hosted_run_out_of_credits' }, 'm').kind).toBe(
      'outOfCredits',
    );
    expect(reviewHostedRefusalOf(500, { code: 42 }, 'm').kind).toBe('failed');
  });
});

describe('Review in my agent', () => {
  async function mountMine(
    props: Partial<React.ComponentProps<typeof ReviewInMyAgentControl>> = {},
  ) {
    render(
      <ReviewInMyAgentControl
        itemKey="ACME-12"
        projectName="Acme"
        variant="secondary"
        {...props}
      />,
    );
    await act(async () => {});
  }
  async function openPicker() {
    await act(async () => {
      fireEvent.click(screen.getByTestId('review-in-my-agent'));
    });
    await waitFor(() => expect(screen.queryByTestId('review-in-my-agent-loading')).toBeNull());
    return screen.getByTestId('review-in-my-agent-picker');
  }
  const row = (name: string) =>
    screen.getAllByTestId('send-to-agent-row').find((r) => r.getAttribute('data-agent') === name)!;

  it('renders nothing until the door read answers', async () => {
    routes[DOOR] = () => new Promise(() => {});
    await mountMine();
    expect(screen.queryByTestId('review-in-my-agent')).toBeNull();
  });

  it('offered: the picker titles the review and lists the agents read', async () => {
    await mountMine();
    const pop = await openPicker();
    expect(pop.textContent).toContain('Review ACME-12 in one of your agents');
    expect(pop.textContent).toContain(
      'Your agent runs motir review ACME-12 and submits its verdict under your name.',
    );
    expect(screen.getAllByTestId('send-to-agent-row')).toHaveLength(2);
    expect(screen.queryByTestId('agent-row-note')).toBeNull();
  });

  it('the agent last used on this item is preselected, with its note', async () => {
    routes[DOOR] = () => ({ status: 200, body: OFFERED(true) });
    await mountMine();
    await openPicker();
    expect(row('yue-laptop').getAttribute('aria-selected')).toBe('true');
    expect(within(row('yue-laptop')).getByTestId('agent-row-note').textContent).toBe(
      picker.lastUsed,
    );
  });

  it('pressing a row IS the start: the agent id and a per-press key, once', async () => {
    const onStarted = vi.fn();
    await mountMine({ onStarted });
    await openPicker();
    await act(async () => {
      fireEvent.click(row('yue-claude'));
    });
    expect(calls(START)).toHaveLength(1);
    const body = bodyOf(START);
    expect(Object.keys(body).sort()).toEqual(['agentInstanceId', 'idempotencyKey']);
    expect(body.agentInstanceId).toBe('ag1');
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it('a start answer with no JSON body still reports the start', async () => {
    routes[START] = () => ({ status: 201, body: undefined });
    const onStarted = vi.fn();
    await mountMine({ onStarted });
    await openPicker();
    await act(async () => {
      fireEvent.click(row('yue-claude'));
    });
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it('a second row press while one is pending sends nothing more', async () => {
    routes[START] = () => new Promise(() => {});
    await mountMine();
    await openPicker();
    await act(async () => {
      fireEvent.click(row('yue-claude'));
    });
    await act(async () => {
      fireEvent.click(row('yue-laptop'));
    });
    expect(calls(START)).toHaveLength(1);
  });

  it('no agent: the button stands and the picker opens on Create one in My agents', async () => {
    routes[DOOR] = () => ({ status: 200, body: NOT_OFFERED('no_agent') });
    routes[AGENTS] = () => ({ status: 200, body: { agents: [] } });
    await mountMine();
    await openPicker();
    expect(screen.getByTestId('review-in-my-agent-empty')).toBeTruthy();
    expect(screen.getByTestId('review-in-my-agent-create').getAttribute('href')).toBe('/my-agents');
  });

  it('agent unusable: the button stands and the rows say why', async () => {
    routes[DOOR] = () => ({
      status: 200,
      body: { ...NOT_OFFERED('agent_unusable'), refusal: 'agent_not_signed_in' },
    });
    routes[AGENTS] = () => ({
      status: 200,
      body: { agents: [agent({ refusal: 'agent_not_signed_in', signInState: 'signed_out' })] },
    });
    await mountMine();
    await openPicker();
    expect(row('yue-claude').getAttribute('aria-disabled')).toBe('true');
  });

  it.each(['review_in_flight', 'cannot_decide'] as const)('%s: draws nothing', async (reason) => {
    routes[DOOR] = () => ({ status: 200, body: NOT_OFFERED(reason as never) });
    await mountMine();
    expect(screen.queryByTestId('review-in-my-agent')).toBeNull();
  });

  it('a failed read draws a notice whose retry re-reads', async () => {
    routes[DOOR] = () => ({ status: 500, body: {} });
    await mountMine();
    expect(screen.getByTestId('review-my-agent-read-failed')).toBeTruthy();
    routes[DOOR] = () => ({ status: 200, body: OFFERED() });
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(screen.getByTestId('review-in-my-agent')).toBeTruthy();
  });

  it('a read that throws is a failed read too', async () => {
    routes[DOOR] = () => Promise.reject(new TypeError('offline'));
    await mountMine();
    expect(screen.getByTestId('review-my-agent-read-failed')).toBeTruthy();
  });

  it('a stale start reports the state moved, re-reads the door, and says so', async () => {
    const onStateMoved = vi.fn();
    routes[START] = () => ({ status: 409, body: { code: 'review_in_my_agent_not_offered' } });
    await mountMine({ onStateMoved });
    await openPicker();
    await act(async () => {
      fireEvent.click(row('yue-claude'));
    });
    expect(onStateMoved).toHaveBeenCalledTimes(1);
    expect(calls(DOOR)).toHaveLength(2);
    expect(screen.getByTestId('review-my-agent-refused-stale').textContent).toContain(
      refused.failed.title,
    );
  });

  it('out of credits and a network failure read their own notices', async () => {
    routes[START] = () => ({ status: 402, body: {} });
    await mountMine();
    await openPicker();
    await act(async () => {
      fireEvent.click(row('yue-claude'));
    });
    expect(screen.getByTestId('review-my-agent-refused-outOfCredits').textContent).toContain(
      refused.outOfCredits.title,
    );
    cleanup();
    routes[START] = () => Promise.reject(new TypeError('offline'));
    await mountMine();
    await openPicker();
    await act(async () => {
      fireEvent.click(row('yue-claude'));
    });
    expect(screen.getByTestId('review-my-agent-refused-failed')).toBeTruthy();
  });
});

describe('reviewInMyAgentRefusalOf', () => {
  it('stale on the door’s own refusal or a 404, credits on 402, else failed', () => {
    expect(reviewInMyAgentRefusalOf(409, { code: 'review_in_my_agent_not_offered' })).toEqual({
      kind: 'stale',
    });
    expect(reviewInMyAgentRefusalOf(404, {})).toEqual({ kind: 'stale' });
    expect(reviewInMyAgentRefusalOf(402, {})).toEqual({ kind: 'outOfCredits' });
    expect(reviewInMyAgentRefusalOf(500, {})).toEqual({ kind: 'failed' });
  });
});

describe('ReviewDoorsDoor — the item page’s placement', () => {
  it('draws nothing outside the Run hosted provider', async () => {
    hostedRun.value = null;
    render(<ReviewDoorsDoor agents={null} />);
    await act(async () => {});
    expect(screen.queryByTestId('review-doors')).toBeNull();
  });

  it('inside it: the doors for the page’s item, and a start re-reads the runs', async () => {
    const notifyRunsChanged = vi.fn();
    hostedRun.value = { itemKey: 'ACME-12', notifyRunsChanged };
    render(
      <HostedModelsProvider workItemKey="ACME-12">
        <ReviewDoorsDoor agents={{ projectName: 'Acme' }} />
      </HostedModelsProvider>,
    );
    await act(async () => {});
    expect(screen.getByTestId('review-doors').textContent).toContain('motir review ACME-12');
    expect(screen.getByTestId('review-in-my-agent')).toBeTruthy();
    await pressHosted();
    expect(notifyRunsChanged).toHaveBeenCalledTimes(1);
    hostedRun.value = null;
  });
});
