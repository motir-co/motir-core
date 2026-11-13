// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import {
  HostedRunProvider,
  continueDoorOf,
  continueRefusalOf,
} from '@/app/(authed)/items/[key]/_components/HostedRunProvider';
import { RunHostedButton } from '@/app/(authed)/items/[key]/_components/RunHostedButton';
import { StartBar } from '@/app/(authed)/items/[key]/_components/StartBar';
import {
  ContinueHostedDoor,
  ContinueHostedNotice,
} from '@/app/(authed)/items/[key]/_components/ContinueHostedDoor';
import { ContinuePart } from '@/components/github/ContinuePart';
import type { DeadRunDto, WorkItemContinueViewDto } from '@/lib/dto/workItemContinue';

// CONTINUE HOSTED (Story MOTIR-6527 · MOTIR-6796), built to `design/runs/design-notes.md`
// § Continue hosted, Panels C1–C7. Mounted as the late stack mounts it: ONE provider
// around the Run section's header door and the Development block's continue part.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

type Handler = (init?: RequestInit) => { status: number; body: unknown };
let routes: Record<string, Handler> = {};
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`;
  const handler = routes[key];
  if (!handler) return new Response(null, { status: 500 });
  const { status, body } = handler(init);
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
});
const calls = (key: string) =>
  fetchMock.mock.calls.filter(
    ([input, init]) => `${init?.method ?? 'GET'} ${String(input).split('?')[0]}` === key,
  );

const MODELS = 'GET /api/hosted-runs/models';
const START = 'POST /api/work-items/ACME-12/hosted-runs';
const START_PARENT = 'POST /api/work-items/ACME-1/hosted-runs';
const NOW = Date.parse('2026-09-27T14:30:00Z');

beforeEach(() => {
  refresh.mockReset();
  fetchMock.mockClear();
  routes = {
    [MODELS]: () => ({
      status: 200,
      body: { models: [{ id: 'claude-sonnet-5', provider: 'anthropic' }], default: null },
    }),
  };
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const deadRun: DeadRunDto = {
  id: 'run_1',
  command: 'run',
  origin: 'local',
  status: 'timed_out',
  stopReason: 'abandoned',
  startedAt: '2026-09-27T13:30:00.000Z',
  lastHeardAt: '2026-09-27T14:10:00.000Z',
  dispatcher: { id: 'usr_1', name: 'Ana' },
};

type Died = Extract<WorkItemContinueViewDto, { state: 'died' }>;
function died(over: Partial<Died> = {}): WorkItemContinueViewDto {
  return {
    state: 'died',
    deadRun,
    reason: 'lapsed',
    branch: 'motir/ACME-12-export',
    branches: [{ repository: null, branch: 'motir/ACME-12-export', pullRequest: null }],
    pullRequest: null,
    refusal: null,
    parentKey: null,
    ...over,
  };
}

async function mount(
  view: WorkItemContinueViewDto,
  { hosted = true, zh = false }: { hosted?: boolean; zh?: boolean } = {},
) {
  const part = (
    <ContinuePart
      view={view}
      itemIdentifier="ACME-12"
      statusLabel="In Progress"
      now={NOW}
      hosted={hosted ? { door: <ContinueHostedDoor />, notice: <ContinueHostedNotice /> } : null}
    />
  );
  render(
    hosted ? (
      <HostedRunProvider
        itemKey="ACME-12"
        ready
        openBlockers={0}
        continueView={view}
        viewerId="usr_me"
      >
        <RunHostedButton />
        {/* Revision 2 (MOTIR-7028): the Run door lives in the start bar. */}
        <StartBar />
        {part}
      </HostedRunProvider>
    ) : (
      part
    ),
    zh ? { locale: 'zh', messages: zhMessages } : {},
  );
  await act(async () => {});
}

const press = async () =>
  act(async () => {
    fireEvent.click(screen.getByTestId('continue-hosted'));
  });

describe('C1 — died, continuable', () => {
  it('offers Continue hosted as the primary path, the command second, and hides Run', async () => {
    await mount(died());
    const text = screen.getByTestId('continue-part').textContent ?? '';
    expect(text).toContain('Continue it here, in Motir agent — no terminal needed:');
    expect(screen.getByTestId('continue-hosted').textContent).toBe('Continue');
    expect(text).toContain('Or carry it on from your terminal:');
    expect(text).toContain('motir continue ACME-12');
    // C7: the run died, so a fresh run is not the way forward.
    expect(screen.queryByTestId('run-hosted')).toBeNull();
  });

  it('reads the models ONCE for both doors', async () => {
    await mount(died());
    expect(calls(MODELS)).toHaveLength(1);
  });

  it('sends mode continue with the selected model and a press key, then refreshes', async () => {
    routes[START] = () => ({ status: 201, body: { dispatchRunId: 'run_2', created: true } });
    await mount(died());
    await press();
    const [, init] = calls(START)[0]!;
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: 'claude-sonnet-5', mode: 'continue' });
    expect(typeof body.idempotencyKey).toBe('string');
    expect(refresh).toHaveBeenCalled();
  });

  it('lists every repository when the run spans several (C2)', async () => {
    await mount(
      died({
        branches: [
          { repository: 'acme/app', branch: 'motir/ACME-12', pullRequest: null },
          {
            repository: 'acme/api',
            branch: 'motir/ACME-12',
            pullRequest: { repo: 'acme/api', number: 7, url: 'https://x/7' },
          } as Died['branches'][number],
        ],
      }),
    );
    expect(screen.getByTestId('continue-part').textContent).toContain(
      'Its work is on a branch in each of its 2 repositories:',
    );
    const rows = screen.getByTestId('continue-branches').textContent ?? '';
    expect(rows).toContain('acme/app · motir/ACME-12');
    expect(rows).toContain('acme/api · motir/ACME-12 · pull request acme/api · #7');
  });
});

describe('C3 — a child of a dead parent run', () => {
  it('continues the PARENT, by its key', async () => {
    routes[START_PARENT] = () => ({ status: 201, body: { dispatchRunId: 'run_3', created: true } });
    await mount(died({ refusal: 'continue_the_parent', parentKey: 'ACME-1' }));
    expect(screen.getByTestId('continue-hosted').textContent).toBe('Continue ACME-1');
    await press();
    expect(calls(START_PARENT)).toHaveLength(1);
    expect(calls(START)).toHaveLength(0);
  });
});

describe('C5 — what the door answers', () => {
  it.each([
    [
      { code: 'hosted_continue_taken', holder: { id: 'usr_2', name: 'Bo' }, startedAt: null },
      'taken',
      'Not started — Bo is already continuing this work item',
    ],
    [
      { code: 'hosted_continue_taken', holder: { id: 'usr_me', name: 'Me' }, startedAt: null },
      'taken',
      'Not started — you are already continuing this work item',
    ],
    [
      { code: 'hosted_continue_run_alive', holder: { id: 'usr_2', name: 'Bo' } },
      'runAlive',
      "Not started — Bo's run is still reporting",
    ],
    [
      { code: 'hosted_continue_nothing_pushed' },
      'nothingPushed',
      'the run pushed nothing to continue from',
    ],
    [{ code: 'hosted_continue_use_fix' }, 'useFix', 'the pull request is open'],
    [{ code: 'hosted_continue_not_in_progress' }, 'notInProgress', 'not In Progress any more'],
    [{ code: 'hosted_continue_no_dead_run' }, 'noDeadRun', 'no run of this work item died'],
    [
      { code: 'hosted_continue_the_parent', parentKey: 'ACME-1' },
      'theParent',
      "this is part of ACME-1's run",
    ],
  ])('%j → %s', async (body, kind, copy) => {
    routes[START] = () => ({ status: 409, body });
    await mount(died());
    await press();
    const notice = screen.getByTestId(`continue-hosted-refused-${kind}`);
    expect(notice.textContent).toContain(copy);
    expect(notice.textContent).toContain('Nothing was booted and nothing was charged.');
    // The page is stale: its view is re-read.
    expect(refresh).toHaveBeenCalled();
  });

  it('out of credits keeps the terminal path in its body, and does not re-read', async () => {
    routes[START] = () => ({ status: 402, body: { code: 'hosted_run_out_of_credits' } });
    await mount(died());
    await press();
    expect(screen.getByTestId('continue-hosted-refused-outOfCredits').textContent).toContain(
      'Continue works again once the organization has credits — or carry it on from your terminal.',
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it('draws each continue refusal in zh too', async () => {
    routes[START] = () => ({ status: 409, body: { code: 'hosted_continue_no_dead_run' } });
    await mount(died(), { zh: true });
    expect(screen.getByTestId('continue-hosted').textContent).toBe('继续');
    await press();
    expect(screen.getByTestId('continue-hosted-refused-noDeadRun').textContent).toContain(
      '未启动——此工作项没有中断的运行。',
    );
  });
});

describe('C6 — not offered', () => {
  it('a reader with no door sees the part exactly as it ships', async () => {
    await mount(died(), { hosted: false });
    expect(screen.queryByTestId('continue-hosted')).toBeNull();
    expect(screen.getByTestId('continue-part').textContent).toContain(
      'Carry it on from your terminal:',
    );
  });

  it('a run that pushed nothing offers no door', async () => {
    await mount(died({ branch: null, branches: [] }));
    expect(screen.queryByTestId('continue-hosted')).toBeNull();
  });

  it('a live run offers no continue and keeps Run', async () => {
    await mount({ state: 'alive' });
    expect(screen.queryByTestId('continue-hosted')).toBeNull();
    expect(screen.getByTestId('run-hosted')).toBeTruthy();
  });
});

describe('continuing, hosted', () => {
  it('says it is hosted and points the continuer at Run above', async () => {
    await mount({
      state: 'continuing',
      holder: { id: 'usr_me', name: 'Me' },
      byViewer: true,
      origin: 'hosted',
      startedAt: '2026-09-27T14:20:00.000Z',
      branch: 'motir/ACME-12-export',
      branches: [{ repository: null, branch: 'motir/ACME-12-export', pullRequest: null }],
      tookOverFrom: null,
    });
    const text = screen.getByTestId('continue-part').textContent ?? '';
    expect(text).toContain('Being continued by you in Motir agent');
    expect(text).toContain('Watch it work in Run above.');
  });
});

describe('the pure maps', () => {
  it('a died card set back from In Progress keeps Run', () => {
    expect(continueDoorOf(died({ refusal: 'not_in_progress' })).runDoorHidden).toBe(false);
    expect(continueDoorOf(died()).runDoorHidden).toBe(true);
  });

  it('a stale not-ready answer is not a readiness refusal on a continue', () => {
    expect(continueRefusalOf(409, { code: 'hosted_run_card_not_ready' }, 'm')).toEqual({
      kind: 'failed',
    });
  });
});

describe('the door’s other answers (coverage floor, MOTIR-6797)', () => {
  it('models UNAVAILABLE: says so under the door, and Try again re-reads them', async () => {
    routes[MODELS] = () => ({ status: 503, body: { code: 'hosted_models_unavailable' } });
    await mount(died());
    expect((screen.getByTestId('continue-hosted') as HTMLButtonElement).disabled).toBe(true);
    const notice = screen.getByTestId('continue-hosted-models-unavailable');
    await act(async () => {
      fireEvent.click(notice.querySelector('button')!);
    });
    expect(calls(MODELS)).toHaveLength(2);
  });

  it('models EMPTY: says so, with nothing to retry', async () => {
    routes[MODELS] = () => ({ status: 200, body: { models: [], default: null } });
    await mount(died());
    expect(screen.getByTestId('continue-hosted-models-empty').querySelector('button')).toBeNull();
  });

  it('`taken` with a start time draws when; a holder-less answer draws a dash', async () => {
    routes[START] = () => ({
      status: 409,
      body: {
        code: 'hosted_continue_taken',
        holder: { id: 'usr_2', name: 'Bo' },
        startedAt: '2026-09-27T14:20:00.000Z',
      },
    });
    await mount(died());
    await press();
    const notice = screen.getByTestId('continue-hosted-refused-taken');
    expect(notice.querySelector('time')?.getAttribute('datetime')).toBe('2026-09-27T14:20:00.000Z');
  });

  it('`run_alive` with no holder names nobody', async () => {
    routes[START] = () => ({ status: 409, body: { code: 'hosted_continue_run_alive' } });
    await mount(died());
    await press();
    expect(screen.getByTestId('continue-hosted-refused-runAlive').textContent).toContain('—');
  });

  it('not writable lists every repository with a way to fix it', async () => {
    routes[START] = () => ({
      status: 409,
      body: {
        code: 'hosted_repository_not_writable',
        repositories: [
          { repository: 'acme/web', reason: 'The App lost access.', fix: 'reconnect' },
        ],
        totalRepositories: 2,
      },
    });
    await mount(died());
    await press();
    const notice = screen.getByTestId('continue-hosted-refused-notWritable');
    expect(notice.textContent).toContain('acme/web');
    expect(notice.textContent).toContain('The App lost access.');
    expect(notice.querySelector('a')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('not writable with no total still says how many', async () => {
    routes[START] = () => ({
      status: 409,
      body: { code: 'hosted_repository_not_writable', repositories: 'nope' },
    });
    await mount(died());
    await press();
    expect(screen.getByTestId('continue-hosted-refused-notWritable')).toBeTruthy();
  });

  it('a model withdrawn since the page loaded: says so and re-reads the list', async () => {
    routes[START] = () => ({ status: 422, body: { code: 'hosted_model_not_offered' } });
    await mount(died());
    await press();
    expect(screen.getByTestId('continue-hosted-refused-modelNotOffered').textContent).toContain(
      'claude-sonnet-5',
    );
    expect(calls(MODELS)).toHaveLength(2);
  });

  it.each([
    [503, { code: 'hosted_run_unavailable' }, 'unavailable', false],
    [503, { code: 'hosted_run_boot_failed', dispatchRunId: 'r' }, 'bootFailed', true],
    [500, null, 'failed', false],
  ])('%s %j → %s', async (status, body, kind, reread) => {
    routes[START] = () => ({ status, body });
    await mount(died());
    await press();
    expect(screen.getByTestId(`continue-hosted-refused-${kind}`)).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(reread ? 1 : 0);
  });

  it('a network failure is `failed`, and the door is usable again', async () => {
    routes[START] = () => {
      throw new Error('offline');
    };
    await mount(died());
    await press();
    expect(screen.getByTestId('continue-hosted-refused-failed')).toBeTruthy();
    expect((screen.getByTestId('continue-hosted') as HTMLButtonElement).disabled).toBe(false);
  });

  it('with no `crypto.randomUUID` (an insecure origin) a press still carries a key', async () => {
    vi.stubGlobal('crypto', {});
    routes[START] = () => ({ status: 201, body: { dispatchRunId: 'run_2', created: true } });
    await mount(died());
    await press();
    const body = JSON.parse(String(calls(START)[0]![1]?.body));
    expect(body.idempotencyKey).toMatch(/^press-/);
  });

  it('a card with no door has neither door nor notice', async () => {
    render(
      <>
        <ContinueHostedDoor />
        <ContinueHostedNotice />
      </>,
    );
    expect(screen.queryByTestId('continue-hosted-door')).toBeNull();
  });
});

describe('continueRefusalOf — malformed answers', () => {
  it('a holder that is not an actor, a missing time and a missing parent read as null', () => {
    expect(continueRefusalOf(409, { code: 'hosted_continue_taken', holder: 'x' }, 'm')).toEqual({
      kind: 'taken',
      holder: null,
      startedAt: null,
    });
    expect(continueRefusalOf(409, { code: 'hosted_continue_the_parent' }, 'm')).toEqual({
      kind: 'theParent',
      parentKey: null,
    });
    expect(continueRefusalOf(402, {}, 'm')).toEqual({ kind: 'outOfCredits' });
  });

  it('a view that is not died offers no continue and hides nothing', () => {
    expect(continueDoorOf(null)).toMatchObject({ runDoorHidden: false });
    expect(continueDoorOf({ state: 'alive' }).continueTarget('X-1')).toBeNull();
    expect(
      continueDoorOf(died({ refusal: 'continue_the_parent', parentKey: null })).continueTarget(
        'X-1',
      ),
    ).toBeNull();
  });
});
