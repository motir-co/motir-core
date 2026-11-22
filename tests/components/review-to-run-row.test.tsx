// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { HostedModelsProvider } from '@/components/hosted/HostedModelsProvider';
import { ReviewToRunRow } from '@/components/approvals/ReviewToRunRow';
import type { ReviewToRunRowDTO } from '@/lib/dto/reviewState';

// THE REVIEW-TO-RUN ROW'S HOSTED DOOR (MOTIR-12032; `design/workbench/design-notes.md`
// § 45.2–§ 45.3, `approvals-row--review-to-run-as-fix.mock.html` R1–R3). Line 2's right group
// offers *Review with Motir agent* — the review doors' door 1 — to a reader who may run the
// card hosted, beside the `motir review` chip, with the credits note under it and every
// refusal in the full-width slot below. DB-free under happy-dom: the routes are stubbed, so
// what is asserted is the REQUEST a press makes and what each answer draws. The layout and
// the overlay press are held by `tests/components/review-path-frame.test.tsx`.

const shallowPush = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

const toRun = en.approvalGate.reviewPath.toRun;
const doors = en.approvalGate.agentReview.doors;
const refused = en.runs.hosted.refused;

type Answer = { status: number; body: unknown };
type Handler = () => Answer | Promise<Answer>;
let routes: Record<string, Handler> = {};
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const handler = routes[`${init?.method ?? 'GET'} ${String(input).split('?')[0]}`];
  if (!handler) return new Response('{}', { status: 500 });
  const { status, body } = await handler();
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
});
const callsTo = (key: string) =>
  fetchMock.mock.calls.filter(
    ([input, init]) => `${init?.method ?? 'GET'} ${String(input).split('?')[0]}` === key,
  );

const MODELS = 'GET /api/hosted-runs/models';
const HOSTED = 'POST /api/work-items/ACME-9/review-with-motir-agent';

const ROW: ReviewToRunRowDTO = {
  kind: 'review_to_run',
  gateId: 'g-9',
  workItemId: 'w-9',
  identifier: 'ACME-9',
  title: 'Export button',
  subjectVersion: 'v2',
  raisedAt: '2026-11-05T11:00:00Z',
  command: 'motir review ACME-9',
  canReviewHosted: true,
};

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
  };
  fetchMock.mockClear();
  shallowPush.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mountRow(
  row: Partial<ReviewToRunRowDTO> = {},
  opts: { onChanged?: () => void; provider?: boolean; zh?: boolean } = {},
) {
  const el = (
    <ReviewToRunRow
      row={{ ...ROW, ...row }}
      gridTemplate="1fr auto auto auto"
      onChanged={opts.onChanged}
    />
  );
  render(
    opts.provider === false ? el : <HostedModelsProvider>{el}</HostedModelsProvider>,
    opts.zh ? { locale: 'zh', messages: zh } : {},
  );
  await act(async () => {});
}

const line = () => screen.getByTestId('review-to-run-line-ACME-9');

async function pressHosted() {
  await act(async () => {
    fireEvent.click(screen.getByTestId('review-with-motir-agent'));
  });
}

describe('ReviewToRunRow — Review with Motir agent', () => {
  it('a reader who may run the card hosted gets door 1 before the chip, and the credits note', async () => {
    await mountRow();
    const door = within(line()).getByTestId('review-with-motir-agent');
    expect(door.textContent).toContain(doors.motirAgent);
    const chip = within(line()).getByTestId('review-command-copy-ACME-9');
    expect(
      door.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the command keeps the right edge',
    ).toBeTruthy();
    expect(door.closest('.relative.z-10'), 'above the row link').toBeTruthy();
    expect(within(line()).getByTestId('review-to-run-credits-note').textContent).toBe(
      toRun.creditsNote,
    );
    expect(callsTo(MODELS)).toHaveLength(1);
  });

  it('the press starts the review with the picked model and re-reads the list, never opening the row', async () => {
    const onChanged = vi.fn();
    await mountRow({}, { onChanged });
    await pressHosted();
    expect(callsTo(HOSTED)).toHaveLength(1);
    const body = JSON.parse(String(callsTo(HOSTED)[0]![1]!.body)) as Record<string, unknown>;
    expect(body.model).toBe('claude-opus-5-5');
    expect(typeof body.idempotencyKey).toBe('string');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(shallowPush, 'the door never opens the overlay').not.toHaveBeenCalled();
  });

  it('a reader who may not run the card hosted gets the command only', async () => {
    await mountRow({ canReviewHosted: false });
    expect(screen.queryByTestId('review-with-motir-agent')).toBeNull();
    expect(screen.queryByTestId('review-to-run-credits-note')).toBeNull();
    expect(within(line()).getByTestId('review-command-copy-ACME-9')).toBeTruthy();
  });

  it('with no models provider mounted the door is not drawn', async () => {
    await mountRow({}, { provider: false });
    expect(screen.queryByTestId('review-with-motir-agent')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the hosted kill-switch hides the door and its note, and leaves the command', async () => {
    routes[HOSTED] = () => ({ status: 403, body: { code: 'ORG_FEATURE_DISABLED' } });
    await mountRow();
    await pressHosted();
    expect(screen.queryByTestId('review-with-motir-agent')).toBeNull();
    expect(screen.queryByTestId('review-to-run-credits-note')).toBeNull();
    expect(within(line()).getByTestId('review-command-copy-ACME-9')).toBeTruthy();
  });

  it('a refusal is drawn in the slot under line 2', async () => {
    routes[HOSTED] = () => ({ status: 402, body: { code: 'hosted_run_out_of_credits' } });
    await mountRow();
    await pressHosted();
    expect(within(line()).getByTestId('review-hosted-refused-outOfCredits').textContent).toContain(
      refused.outOfCredits.title,
    );
  });

  it('a stale page re-reads the list', async () => {
    const onChanged = vi.fn();
    routes[HOSTED] = () => ({ status: 409, body: { code: 'REVIEW_START_NOT_OFFERED' } });
    await mountRow({}, { onChanged });
    await pressHosted();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('review-hosted-refused-stale')).toBeTruthy();
  });

  it('an unavailable model list draws its retry in the slot', async () => {
    routes[MODELS] = () => ({ status: 500, body: {} });
    await mountRow();
    expect(screen.getByTestId('review-with-motir-agent').hasAttribute('disabled')).toBe(true);
    expect(within(line()).getByTestId('review-hosted-models-unavailable')).toBeTruthy();
  });

  it('an empty model list says so in the slot', async () => {
    routes[MODELS] = () => ({ status: 200, body: { models: [], default: null } });
    await mountRow();
    expect(within(line()).getByTestId('review-hosted-models-empty')).toBeTruthy();
  });

  it('renders the door and the credits note in zh as the design notes give them', async () => {
    await mountRow({}, { zh: true });
    expect(screen.getByTestId('review-with-motir-agent').textContent).toContain(
      zh.approvalGate.agentReview.doors.motirAgent,
    );
    expect(screen.getByTestId('review-to-run-credits-note').textContent).toBe(
      '用 Motir 智能体审查的费用从你组织的 AI 额度中扣除。motir review 在你自己的智能体中运行。',
    );
  });
});
