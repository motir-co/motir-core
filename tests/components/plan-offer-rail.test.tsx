// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  usePathname: () => '/items/ACME-40',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));

import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import type {
  PlanAnswerOfferDto,
  PlanChangeSessionDto,
  PlanChangeTurnDto,
} from '@/lib/dto/planChange';
import type { WorkItemRefSummaryDto } from '@/lib/dto/workItems';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

// No jest-dom (project convention): assertions read the DOM directly.
// THE PLAN OFFER in the rail (Story MOTIR-9219 · MOTIR-9294), drawn to MOTIR-9286's
// `design/ai-chat/plan-offer.mock.html`. The rail is presentational, so each state
// is asserted by handing it the thread core served.

const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project' });
const en = enMessages.planningWorkspace.planOffer;

function turn(
  seq: number,
  role: PlanChangeTurnDto['role'] = 'user',
  extra: Partial<PlanChangeTurnDto> = {},
): PlanChangeTurnDto {
  return {
    id: `t${seq}`,
    seq,
    role,
    body: role === 'user' ? 'How does export work?' : 'Export runs nightly.',
    jobId: role === 'assistant' ? 'job-1' : null,
    question: null,
    confirm: null,
    isAnswer: role === 'assistant',
    intent: null,
    intentCorrected: false,
    citations: [],
    authorId: role === 'user' ? 'u1' : null,
    createdAt: '2026-10-22T10:00:00.000Z',
    ...extra,
  };
}

function offer(extra: Partial<PlanAnswerOfferDto> = {}): PlanAnswerOfferDto {
  return {
    kind: 'plan',
    requestMd: 'Add a CSV export to the reports page.',
    targetKey: 'ACME-40',
    declinedAt: null,
    declinedById: null,
    confirmedAt: null,
    confirmedById: null,
    confirmedSessionId: null,
    state: 'undecided',
    cannotStart: null,
    ...extra,
  };
}

const READABLE: WorkItemRefSummaryDto = {
  accessible: true,
  id: 'wi-40',
  identifier: 'ACME-40',
  title: 'Reports export',
  kind: 'story',
  archived: false,
  status: null,
  type: null,
  assignee: null,
};

function session(
  turns: PlanChangeTurnDto[],
  extra: Partial<PlanChangeSessionDto> = {},
): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: ['ACME-40'],
    turnCount: turns.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-10-22T10:00:00.000Z',
    origin: 'conversation',
    startedByViewer: true,
    createdAt: '2026-10-22T09:00:00.000Z',
    updatedAt: '2026-10-22T10:00:00.000Z',
    turns,
    workItemRefs: {},
    ...extra,
  };
}

/** A thread whose latest turn is the answer carrying `o`. */
function offered(o: PlanAnswerOfferDto | null, extra: Partial<PlanChangeSessionDto> = {}) {
  return session([turn(0), turn(1, 'assistant', { offer: o })], extra);
}

const BASE: PlanChangeConversationState = {
  phase: 'idle',
  session: offered(offer()),
  progress: null,
  review: null,
  liveReview: null,
  liveVersion: 0,
  liveFailing: false,
  discardedReview: null,
  decided: null,
  jobId: null,
  planId: null,
  approved: null,
  errorCode: null,
  outOfCredits: false,
  stopping: false,
  stopped: false,
  queued: [],
  earlier: null,
  reopened: null,
  readOnly: false,
  acts: [],
};

const onConfirmPlanOffer = vi.fn();
const onDeclinePlanOffer = vi.fn();

function rail(
  state: Partial<PlanChangeConversationState> = {},
  opts: {
    withActions?: boolean;
    answering?: string | null;
    refusal?: { turnId: string; code: string } | null;
  } = {},
) {
  const merged = { ...BASE, ...state };
  return (
    <PlanChangeRail
      launch={LAUNCH}
      projectName="PayFlow"
      state={merged}
      index={indexPlanReview(merged.review)}
      targets={[]}
      onSend={vi.fn()}
      onRetry={vi.fn()}
      onCorrectTurn={vi.fn()}
      onApprove={vi.fn()}
      onDiscard={vi.fn()}
      onAddTarget={vi.fn()}
      onRemoveTarget={vi.fn()}
      onStop={vi.fn()}
      {...(opts.withActions === false ? {} : { onConfirmPlanOffer, onDeclinePlanOffer })}
      offerAnsweringTurnId={opts.answering ?? null}
      offerRefusal={opts.refusal ?? null}
    />
  );
}

function renderRail(...args: Parameters<typeof rail>) {
  return renderWithIntl(rail(...args));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('an answer with no offer', () => {
  it('renders the answer exactly as before — no row, no placeholder', () => {
    renderRail({
      session: session([
        turn(0),
        turn(1, 'assistant', {
          offer: null,
          citations: [{ workItemId: 'wi-40', identifier: 'ACME-40' }] as never,
        }),
      ]),
    });
    expect(screen.getByTestId('plan-change-report').textContent).toContain('Export runs nightly.');
    expect(screen.getByTestId('plan-change-citation-count')).toBeTruthy();
    expect(screen.queryByTestId('plan-offer')).toBeNull();
    expect(screen.queryByTestId('plan-offer-cannot-start')).toBeNull();
  });
});

describe('the undecided offer', () => {
  it('draws the request, the target and both controls, and fires each once with the turn id', () => {
    renderRail();
    const row = screen.getByTestId('plan-offer');
    expect(row.getAttribute('data-offer-state')).toBe('undecided');
    expect(row.getAttribute('aria-label')).toBe(en.label);
    expect(screen.getByTestId('plan-offer-request').textContent).toContain(
      'Add a CSV export to the reports page.',
    );
    expect(screen.getByTestId('plan-offer-target-chip').textContent).toContain('ACME-40');
    expect(onConfirmPlanOffer).not.toHaveBeenCalled();
    expect(onDeclinePlanOffer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('plan-offer-confirm'));
    expect(onConfirmPlanOffer).toHaveBeenCalledTimes(1);
    expect(onConfirmPlanOffer).toHaveBeenCalledWith('t1');
    fireEvent.click(screen.getByTestId('plan-offer-decline'));
    expect(onDeclinePlanOffer).toHaveBeenCalledTimes(1);
    expect(onDeclinePlanOffer).toHaveBeenCalledWith('t1');
    expect(screen.queryByTestId('plan-offer-mid-planning')).toBeNull();
  });

  it('disables both controls while its answer is in flight', () => {
    renderRail({}, { answering: 't1' });
    expect((screen.getByTestId('plan-offer-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('plan-offer-decline') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('plan-offer-confirm'));
    expect(onConfirmPlanOffer).not.toHaveBeenCalled();
  });

  it('the pressed control carries its loading label while its answer is out', () => {
    for (const [id, label] of [
      ['plan-offer-confirm', en.confirming],
      ['plan-offer-decline', en.declining],
    ] as const) {
      const { rerender } = renderRail();
      fireEvent.click(screen.getByTestId(id));
      rerender(rail({}, { answering: 't1' }));
      expect(screen.getByTestId(id).textContent).toContain(label);
      cleanup();
    }
  });

  it('draws the no-target line and keeps Confirm when the offer carries no target', () => {
    renderRail({ session: offered(offer({ targetKey: null })) });
    expect(screen.getByTestId('plan-offer-no-target').textContent).toContain(en.noTarget);
    expect(screen.queryByTestId('plan-offer-target')).toBeNull();
    expect((screen.getByTestId('plan-offer-confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  it('says when the target is not the card the conversation was opened on', () => {
    renderRail({ session: offered(offer({ targetKey: 'ACME-77' })) });
    expect(screen.getByTestId('plan-offer-target').textContent).toContain(
      'ACME-77 is not the work item this conversation was opened on.',
    );
  });

  it('clamps a long request behind Show all', () => {
    renderRail({ session: offered(offer({ requestMd: 'x'.repeat(600) })) });
    const toggle = screen.getByTestId('plan-offer-show-all');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toContain(en.showLess);
  });
});

describe('the decided offers — read from the served state alone', () => {
  it('confirmed: the record and no controls, identical on a re-render', () => {
    const state = {
      session: offered(
        offer({
          state: 'confirmed',
          confirmedAt: '2026-10-22T10:05:00.000Z',
          confirmedSessionId: 's1',
        }),
      ),
    };
    const { rerender } = renderRail(state);
    const before = screen.getByTestId('plan-offer').outerHTML;
    expect(screen.getByTestId('plan-offer-confirmed').textContent).toContain(en.started);
    expect(screen.getByTestId('plan-offer-confirmed').textContent).toContain(en.startedHere);
    expect(screen.queryByTestId('plan-offer-confirm')).toBeNull();
    expect(screen.queryByTestId('plan-offer-decline')).toBeNull();
    rerender(rail(state));
    expect(screen.getByTestId('plan-offer').outerHTML).toBe(before);
  });

  it('declined: the declined block and no controls', () => {
    renderRail({
      session: offered(offer({ state: 'declined', declinedAt: '2026-10-22T10:05:00.000Z' })),
    });
    expect(screen.getByTestId('plan-offer').getAttribute('data-offer-state')).toBe('declined');
    expect(screen.getByTestId('plan-offer-declined').textContent).toContain(en.recorded);
    expect(screen.queryByTestId('plan-offer-confirm')).toBeNull();
  });

  it('a decided offer whose time is not on the record draws no by-line', () => {
    renderRail({ session: offered(offer({ state: 'confirmed', confirmedSessionId: 's1' })) });
    const confirmed = screen.getByTestId('plan-offer-confirmed').textContent ?? '';
    expect(confirmed).toContain(en.startedHere);
    expect(confirmed).not.toContain(en.startedBy.split('{')[0]!.trim());
    cleanup();
    renderRail({ session: offered(offer({ state: 'declined' })) });
    const declined = screen.getByTestId('plan-offer-declined').textContent ?? '';
    expect(declined).toContain(en.recorded);
    expect(declined).not.toContain(en.declinedBy.split('{')[0]!.trim());
  });

  it('superseded: the one replaced line', () => {
    renderRail({ session: offered(offer({ state: 'superseded' })) });
    const row = screen.getByTestId('plan-offer');
    expect(row.getAttribute('data-offer-state')).toBe('superseded');
    expect(row.textContent).toContain(en.replaced);
    expect(screen.queryByTestId('plan-offer-request')).toBeNull();
  });

  it('an undecided offer that is no longer the live one is a record with no controls', () => {
    // A lagging stored write: the served state still reads undecided, but a later
    // answer sits after it, so at most one Confirm is ever live on the thread.
    renderRail({
      session: session([
        turn(0),
        turn(1, 'assistant', { offer: offer() }),
        turn(2),
        turn(3, 'assistant', { offer: offer({ requestMd: 'Plan the importer.' }) }),
      ]),
    });
    expect(screen.getAllByTestId('plan-offer')).toHaveLength(2);
    expect(screen.getAllByTestId('plan-offer-confirm')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('plan-offer-confirm'));
    expect(onConfirmPlanOffer).toHaveBeenCalledWith('t3');
  });
});

describe('an offer that cannot start — one more Motir AI line, no panel', () => {
  it.each([
    ['planning_unavailable', en.cannotStart.planningUnavailable],
    ['out_of_credits', en.cannotStart.outOfCredits],
    // A closed target is a conversation, never an offer: served anyway, it is generic.
    ['target_closed', en.cannotStart.generic],
    ['something_new', en.cannotStart.generic],
  ])('%s draws its line and no Confirm or Decline', (code, line) => {
    renderRail({ session: offered(offer({ cannotStart: code as never })) });
    const el = screen.getByTestId('plan-offer-cannot-start');
    expect(el.getAttribute('data-reason')).toBe(code);
    expect(el.textContent).toContain(line);
    expect(screen.queryByTestId('plan-offer')).toBeNull();
    expect(screen.queryByTestId('plan-offer-confirm')).toBeNull();
    expect(screen.queryByTestId('plan-offer-decline')).toBeNull();
  });

  it('a target being planned draws the being-planned line', () => {
    renderRail({ session: offered(offer({ cannotStart: 'target_held', targetKey: 'ACME-77' })) });
    expect(screen.getByTestId('plan-offer-being-planned').textContent).toContain(
      'ACME-77 is being planned right now',
    );
    expect(screen.queryByTestId('plan-offer-confirm')).toBeNull();
  });

  it('…and says it is being planned HERE when this conversation is the one planning it', () => {
    renderRail({
      phase: 'streaming',
      planId: 'plan-1',
      jobId: 'job-2',
      session: offered(offer({ cannotStart: 'target_held' })),
    });
    expect(screen.getByTestId('plan-offer-being-planned').textContent).toContain(
      'ACME-40 is already being planned here',
    );
  });
});

describe('the mid-planning variant', () => {
  it('a planning run in flight draws the mid-planning label and line, with pressable controls', () => {
    renderRail({ phase: 'streaming', planId: 'plan-1', jobId: 'job-2' });
    expect(screen.getByTestId('plan-offer').getAttribute('aria-label')).toBe(en.labelMidPlanning);
    expect(screen.getByTestId('plan-offer-mid-planning').textContent).toContain(en.midPlanning);
    fireEvent.click(screen.getByTestId('plan-offer-confirm'));
    expect(onConfirmPlanOffer).toHaveBeenCalledWith('t1');
  });

  it('an ask turn running holds both controls still', () => {
    renderRail({ phase: 'streaming', planId: null, jobId: 'job-2' });
    expect((screen.getByTestId('plan-offer-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('plan-offer-mid-planning')).toBeNull();
  });
});

describe('who may press', () => {
  it('a read-only reader sees the offer with no controls', () => {
    renderRail({ readOnly: true });
    expect(screen.getByTestId('plan-offer-request')).toBeTruthy();
    expect(screen.queryByTestId('plan-offer-confirm')).toBeNull();
    expect(screen.queryByTestId('plan-offer-decline')).toBeNull();
  });

  it('a host with no actions draws the offer as a record', () => {
    renderRail({}, { withActions: false });
    expect(screen.getByTestId('plan-offer')).toBeTruthy();
    expect(screen.queryByTestId('plan-offer-confirm')).toBeNull();
  });
});

describe('a refused press', () => {
  it.each([
    ['MOTIR_AI_OUT_OF_CREDITS', en.cannotStart.outOfCredits],
    ['target_not_available', 'You can no longer open ACME-40, so planning can’t start.'],
    ['already_planning', en.cannotStart.generic],
    ['NOT_A_CODE', en.cannotStart.generic],
  ])('%s replaces both buttons with its line', (code, line) => {
    renderRail({}, { refusal: { turnId: 't1', code } });
    const el = screen.getByTestId('plan-offer-cannot-start');
    expect(el.textContent).toContain(line);
    expect(within(screen.getByTestId('plan-offer')).queryByRole('button')).toBeNull();
    expect(screen.getByTestId('plan-offer-target-chip')).toBeTruthy();
  });

  it('a refusal for another offer leaves this one pressable', () => {
    renderRail({}, { refusal: { turnId: 't9', code: 'NOT_A_CODE' } });
    expect((screen.getByTestId('plan-offer-confirm') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('the target chip', () => {
  it('draws the key alone with no summary', () => {
    renderRail();
    expect(screen.getByTestId('plan-offer-target-chip').textContent).toMatch(/^ACME-40$/);
  });

  it('draws the key alone for the inaccessible arm', () => {
    renderRail({
      session: offered(offer(), { workItemRefs: { 'wi-40': { accessible: false, id: 'wi-40' } } }),
    });
    expect(screen.getByTestId('plan-offer-target-chip').textContent).toMatch(/^ACME-40$/);
  });

  it('draws the key and its title for a readable summary', () => {
    renderRail({ session: offered(offer(), { workItemRefs: { 'wi-40': READABLE } }) });
    const chip = screen.getByTestId('plan-offer-target-chip');
    expect(chip.textContent).toContain('ACME-40');
    expect(chip.textContent).toContain('Reports export');
  });
});

describe('only an assistant turn mounts the row', () => {
  it('an offer on a user or system turn renders nothing extra', () => {
    renderRail({
      session: session([
        turn(0, 'user', { offer: offer() }),
        turn(1, 'system', { offer: offer(), body: 'marker' }),
      ]),
    });
    expect(screen.queryByTestId('plan-offer')).toBeNull();
  });
});

describe('the other offers are untouched', () => {
  it('a forward offer still draws inside the answer bubble beside a plan offer', () => {
    renderRail({
      session: session([
        turn(0),
        turn(1, 'assistant', { forwardOffer: 'Forward this?', offer: offer() }),
      ]),
    });
    expect(within(screen.getByTestId('plan-change-report')).queryByTestId('plan-offer')).toBeNull();
    expect(screen.getByTestId('plan-offer')).toBeTruthy();
  });
});

describe('the catalogue', () => {
  it('draws Chinese at locale zh', () => {
    renderWithIntl(rail(), { messages: zhMessages, locale: 'zh' });
    const zh = zhMessages.planningWorkspace.planOffer;
    expect(screen.getByTestId('plan-offer').getAttribute('aria-label')).toBe(zh.label);
    expect(screen.getByTestId('plan-offer-confirm').textContent).toContain(zh.confirm);
    expect(screen.getByTestId('plan-offer-decline').textContent).toContain(zh.decline);
    expect(screen.getByTestId('plan-offer').textContent).toContain(zh.declineHelp);
  });
});

// THE COMPOSED REQUIREMENT's two rail lines (MOTIR-9438; design
// `plan-offer--requirement.mock.html`). Both read the served offer alone.
describe('the requirement page link and the cannot-save line', () => {
  const PAGE = { pageId: 'p1', title: 'Export the board' };
  const confirmed = (extra: Partial<PlanAnswerOfferDto> = {}) =>
    offer({
      state: 'confirmed',
      confirmedAt: '2026-10-22T10:05:00.000Z',
      confirmedSessionId: 's1',
      targetKey: null,
      ...extra,
    });

  it('a confirmed no-target offer links the saved page and names the folder', () => {
    renderRail({ session: offered(confirmed({ requirementPage: PAGE })) });
    const line = screen.getByTestId('plan-offer-requirement-page');
    expect(screen.getByTestId('plan-offer-confirmed').contains(line)).toBe(true);
    const link = within(line).getByRole('link', { name: 'Export the board' });
    expect(link.getAttribute('href')).toBe('/pages/p1');
    expect(line.textContent).toBe('Saved as Export the board in Requirements Docs.');
  });

  it('draws no link line without a saved page, on a targeted offer or on a bug offer', () => {
    renderRail({ session: offered(confirmed()) });
    expect(screen.queryByTestId('plan-offer-requirement-page')).toBeNull();
    cleanup();
    renderRail({
      session: offered(confirmed({ targetKey: 'ACME-40', requirementPage: PAGE })),
    });
    expect(screen.queryByTestId('plan-offer-requirement-page')).toBeNull();
    cleanup();
    renderRail({
      session: offered(confirmed({ kind: 'log_bug', requirementPage: PAGE })),
    });
    expect(screen.queryByTestId('plan-offer-requirement-page')).toBeNull();
  });

  it('a failed save draws the alert line and keeps both controls enabled', () => {
    renderRail({
      session: offered(offer({ targetKey: null, requirementSaveFailed: true })),
    });
    const line = screen.getByTestId('plan-offer-requirement-not-saved');
    expect(line.getAttribute('role')).toBe('alert');
    expect(line.textContent).toContain('Couldn’t save the requirement.');
    expect(line.textContent).toContain('Confirm is still here');
    expect(screen.queryByTestId('plan-offer-cannot-start')).toBeNull();
    const confirm = screen.getByTestId('plan-offer-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    expect((screen.getByTestId('plan-offer-decline') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirmPlanOffer).toHaveBeenCalledWith('t1');
  });

  it('draws no cannot-save line on a targeted offer or a plain pending one', () => {
    renderRail({ session: offered(offer({ requirementSaveFailed: true })) });
    expect(screen.queryByTestId('plan-offer-requirement-not-saved')).toBeNull();
    cleanup();
    renderRail({ session: offered(offer({ targetKey: null })) });
    expect(screen.queryByTestId('plan-offer-requirement-not-saved')).toBeNull();
  });

  it('a real refusal still replaces both buttons, even beside a failed save', () => {
    renderRail(
      { session: offered(offer({ targetKey: null, requirementSaveFailed: true })) },
      { refusal: { turnId: 't1', code: 'MOTIR_AI_OUT_OF_CREDITS' } },
    );
    expect(screen.getByTestId('plan-offer-cannot-start')).toBeTruthy();
    expect(screen.queryByTestId('plan-offer-confirm')).toBeNull();
  });
});
