// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import type { DevelopmentGateActions } from '@/components/github/DevelopmentGateFrame';
import { couldNotRunCopyOf, firstParagraph } from '@/components/github/AgentReviewBand';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import type { AgentReviewViewDto } from '@/lib/dto/agentReview';
import type { WorkItemRepairViewDto } from '@/lib/dto/workItemRepair';
import { AWAITING_MERGE_GATE, CORE_PR, GATEWAY_PR, recordDto } from '../helpers/howToTestFixtures';

// THE AGENT REVIEW IN THE DEVELOPMENT FRAME (Story MOTIR-1626 · MOTIR-6825), to
// `design/github/design-notes.md` § 30 — every state from a gate fixture in that state, with
// the verbs present and absent in each. The block is mounted whole, as the item page mounts
// it: `handOver` set and `retryMember` alone among the gate actions — NO decide door. The
// page's *Continue without the review* hands over to the approval overlay (MOTIR-6323's rule:
// every decision is made there); the overlay's half is `approval-overlay-agent-review.test.tsx`.

const { refreshSpy } = vi.hoisted(() => ({ refreshSpy: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshSpy }),
  usePathname: () => '/items/ACME-12',
  useSearchParams: () => new URLSearchParams(),
}));
const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ar = en.approvalGate.agentReview;
const pra = en.approvalGate.pullRequestApproval;

const CORE_V = `moooon/motir-core#131@${CORE_PR.headSha}`;
const GATEWAY_V = `moooon/motir-gateway#57@${GATEWAY_PR.headSha}`;
const SET = [CORE_V, GATEWAY_V].sort().join(',');

const FINDINGS = [
  "Two of the card's acceptance criteria are not met yet. The rest of the change reads well.",
  '',
  '## 1 · The limit is per IP address, not per API key',
  '',
  '```ts',
  'const bucket = buckets.get(req.ip); // should be key.id',
  '```',
].join('\n');

let seq = 0;
function reviewGate(over: Partial<ApprovalGateDTO> = {}): ApprovalGateDTO {
  return {
    ...AWAITING_MERGE_GATE,
    id: `gate-review-${++seq}`,
    kind: 'agent_review',
    subjectVersion: SET,
    createdAt: '2026-09-29T09:40:00.000Z',
    ...over,
  };
}

const RUN = {
  id: 'run-611',
  label: 'motir review · 2026-09-29 09:41 UTC',
  startedAt: '2026-09-29T09:41:00.000Z',
};

function view(gate: ApprovalGateDTO, over: Partial<AgentReviewViewDto> = {}): AgentReviewViewDto {
  return {
    gate,
    canDecide: true,
    routedToLabel: 'Zhu Yue',
    stamp: 'stamp-review',
    reviewUnavailableReason: null,
    run: RUN,
    settingsDoorHref: null,
    findingsRefs: {},
    ...over,
  };
}

const REVIEW_REPAIR: WorkItemRepairViewDto = {
  state: 'offer',
  repairClass: 'review',
  acceptanceRefusal: null,
  failing: [
    {
      repo: 'moooon/motir-core',
      number: 131,
      ci: 'passing',
      queueExit: null,
      conflict: null,
      outOfDate: null,
    },
    {
      repo: 'moooon/motir-gateway',
      number: 57,
      ci: 'passing',
      queueExit: null,
      conflict: null,
      outOfDate: null,
    },
  ],
  lastGaveUp: null,
};

const pageActions = () => ({ retryMember: vi.fn() }) as unknown as DevelopmentGateActions;

/** The item page's block with the agent review leading the frame. */
function renderLeading(
  review: AgentReviewViewDto,
  {
    repair = null,
    messages,
  }: {
    repair?: WorkItemRepairViewDto | null;
    messages?: Record<string, unknown>;
  } = {},
) {
  return render(
    <DevelopmentSectionBody
      pullRequests={[CORE_PR, GATEWAY_PR]}
      itemIdentifier="ACME-12"
      manualLinkable
      howToTest={recordDto()}
      repair={repair}
      mergeGate={{
        gate: review.gate,
        canDecide: review.canDecide,
        routedToLabel: review.routedToLabel,
        stamp: review.stamp,
        members: [],
      }}
      gateActions={pageActions()}
      handOver={{ routedToViewer: true }}
      agentReview={review}
    />,
    messages ? { messages, locale: 'zh' } : {},
  );
}

const band = () => screen.getByTestId('agent-review-band');
const button = (name: string) => screen.queryByRole('button', { name });

describe('Reviewing (Panel 1)', () => {
  it('names the kind, the Reviewing pill, the run, and draws no verbs', () => {
    renderLeading(
      view(reviewGate(), { settingsDoorHref: '/settings/project/approvals#review-agent' }),
    );
    expect(screen.getByText(ar.kindLabel)).toBeTruthy();
    expect(screen.getByText(ar.state.reviewing)).toBeTruthy();
    expect(band().dataset.state).toBe('reviewing');
    expect(within(band()).getByText(ar.reviewing.title)).toBeTruthy();
    const link = within(band()).getByTestId('agent-review-run-link');
    expect(link.getAttribute('href')).toBe('/runs?run=run-611');
    expect(link.textContent).toBe(RUN.label);
    expect(screen.getByText(ar.reviewing.why)).toBeTruthy();
    // No Approve verbs, no review verbs, no call-to-action band into the overlay.
    expect(button(pra.verb.approveAndMerge)).toBeNull();
    expect(button(ar.verb.reviewAgain)).toBeNull();
    expect(button(ar.verb.continueWithout)).toBeNull();
    // The settings door, handed only to a holder of `workflow:manage`.
    const door = screen.getByRole('link', { name: en.approvalGate.settingsDoor.reviewAgent });
    expect(door.getAttribute('href')).toBe('/settings/project/approvals#review-agent');
  });

  it('a reader it is not routed to reads the same line, and still no verbs', () => {
    renderLeading(view(reviewGate(), { canDecide: false }));
    expect(screen.getByText(ar.reviewing.why)).toBeTruthy();
    expect(
      screen.queryAllByRole('button').filter((b) => b.textContent === ar.verb.reviewAgain),
    ).toHaveLength(0);
  });
});

describe('Review could not run (Panels 4a, 4b, 4d)', () => {
  const cases: Array<[string, string]> = [
    ['hosted_run_out_of_credits', ar.couldNotRun.reason.no_credits],
    ['CI_CREDITS_EXHAUSTED', ar.couldNotRun.reason.no_credits],
    ['hosted_no_model_offered', ar.couldNotRun.reason.no_model],
    ['hosted_models_unavailable', ar.couldNotRun.reason.no_model],
    ['hosted_repository_not_readable', ar.couldNotRun.reason.repository_unreadable],
    ['hosted_run_boot_failed', ar.couldNotRun.reason.boot_failed],
    ['review_no_actor', ar.couldNotRun.reason.no_actor],
    // The review's model has no agent-run capacity right now (MOTIR-9633).
    ['hosted_run_no_capacity', ar.couldNotRun.reason.noCapacity],
    ['review_start_failed', ar.couldNotRun.reason.unknown],
  ];
  it.each(cases)('code %s reads its own line', (code, line) => {
    renderLeading(view(reviewGate(), { reviewUnavailableReason: code }));
    expect(band().textContent).toContain('Review could not run:');
    expect(band().textContent).toContain(line);
  });

  it('no_verdict links the run that ended without one', () => {
    renderLeading(view(reviewGate(), { reviewUnavailableReason: 'no_verdict' }));
    expect(band().textContent).toContain('the review run ended without a verdict');
    expect(within(band()).getByTestId('agent-review-run-link').getAttribute('href')).toBe(
      '/runs?run=run-611',
    );
  });

  it('routed: the Could not run pill, the why line, Continue without and Review again', () => {
    renderLeading(view(reviewGate(), { reviewUnavailableReason: 'hosted_run_out_of_credits' }));
    expect(screen.getByText(ar.state.couldNotRun)).toBeTruthy();
    expect(screen.getByText(ar.couldNotRun.why)).toBeTruthy();
    expect(button(ar.verb.reviewAgain)).toBeTruthy();
    expect(button(ar.verb.continueWithout)).toBeTruthy();
    expect(button(pra.verb.approveAndMerge)).toBeNull();
  });

  it('not routed (state B): the reason, who it waits on, and NO verbs', () => {
    renderLeading(
      view(reviewGate(), {
        reviewUnavailableReason: 'hosted_run_out_of_credits',
        canDecide: false,
      }),
    );
    expect(band().textContent).toContain(ar.couldNotRun.reason.no_credits);
    expect(
      screen.getByText(
        'Waiting on Zhu Yue. Nothing merges until the review runs, or they continue without it.',
      ),
    ).toBeTruthy();
    expect(screen.getByText(en.approvalGate.state.awaiting)).toBeTruthy();
    expect(button(ar.verb.reviewAgain)).toBeNull();
    expect(button(ar.verb.continueWithout)).toBeNull();
  });
});

describe('Review again (§12.6)', () => {
  it('calls the start card route, then reads Reviewing again and re-reads the page', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ gateId: 'g' }), { status: 202 }));
    const review = view(reviewGate(), { reviewUnavailableReason: 'hosted_run_out_of_credits' });
    renderLeading(review);
    await act(async () => {
      fireEvent.click(button(ar.verb.reviewAgain)!);
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/approval-gates/${review.gate.id}/review-again`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(refreshSpy).toHaveBeenCalled();
    expect(band().dataset.state).toBe('reviewing');
    expect(screen.getByText(ar.state.reviewing)).toBeTruthy();
    expect(button(ar.verb.reviewAgain)).toBeNull();
    fetchSpy.mockRestore();
  });

  it('a refused press is drawn in place and the review is unchanged', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ code: 'X' }), { status: 403 }));
    renderLeading(view(reviewGate(), { reviewUnavailableReason: 'hosted_run_out_of_credits' }));
    await act(async () => {
      fireEvent.click(button(ar.verb.reviewAgain)!);
    });
    expect(screen.getByRole('alert').textContent).toContain(
      en.approvalGate.refusal.notAuthorised.title,
    );
    expect(band().dataset.state).toBe('could-not-run');
    expect(refreshSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('Continue without the review hands over to the approval overlay (§12.3, MOTIR-6323)', () => {
  it('opens the overlay on the card’s agent_review gate — no confirm here, nothing decided', async () => {
    window.history.replaceState(null, '', '/items/ACME-12?tab=activity');
    renderLeading(view(reviewGate(), { reviewUnavailableReason: 'hosted_run_out_of_credits' }));
    await act(async () => {
      fireEvent.click(button(ar.verb.continueWithout)!);
    });
    // The page's own address, every parameter kept, plus the overlay's two.
    expect(shallowPush).toHaveBeenCalledTimes(1);
    expect(shallowPush).toHaveBeenCalledWith(
      '/items/ACME-12?tab=activity&approval=ACME-12&approvalKind=agent_review',
    );
    // The decision is the overlay's: no confirm band, no note field, no refusal here.
    expect(screen.queryByText(ar.override.title)).toBeNull();
    expect(screen.queryByLabelText(ar.override.label)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(refreshSpy).not.toHaveBeenCalled();
    // The frame still stands, with both of its buttons.
    expect(band().dataset.state).toBe('could-not-run');
    expect(button(ar.verb.reviewAgain)).toBeTruthy();
    expect(button(ar.verb.continueWithout)).toBeTruthy();
  });
});

describe('Sent back by the review agent (Panel 3)', () => {
  it('draws the findings in full, the record band, motir fix — and no verbs', () => {
    const gate = reviewGate({
      state: 'changes_requested',
      noteMd: FINDINGS,
      decidedAt: '2026-09-29T09:52:00.000Z',
      decidedUnderAuthority: 'review_agent',
      decidedByLabel: 'Ada L.',
    });
    renderLeading(view(gate), { repair: REVIEW_REPAIR });
    expect(band().dataset.state).toBe('sent-back');
    expect(within(band()).getByText(ar.sentBack.title)).toBeTruthy();
    // Markdown, in full: the heading and the fenced block with its Copy.
    expect(
      within(band()).getByText('1 · The limit is per IP address, not per API key'),
    ).toBeTruthy();
    expect(band().textContent).toContain('buckets.get(req.ip)');
    // Band 1's pill and the record band, naming the AGENT — never the attributed user.
    expect(screen.getByText(en.approvalGate.state.changesRequested)).toBeTruthy();
    expect(document.body.textContent).toContain('Sent back by the review agent ·');
    expect(screen.getByText(ar.sentBack.why)).toBeTruthy();
    expect(document.body.textContent).not.toContain('Ada L.');
    // The findings are not quoted a second time in the record.
    expect(document.body.textContent?.split('buckets.get(req.ip)').length).toBe(2);
    // The repair: § 21's fix part, with the agent's sent-back line and `motir fix`.
    const part = screen.getByTestId('repair-fix-part');
    expect(within(part).getByText(en.github.development.fix.titleSentBack)).toBeTruthy();
    expect(within(part).getByTestId('repair-sent-back-line').dataset.sentBackBy).toBe('agent');
    expect(part.textContent).toContain('The review agent sent these commits back.');
    expect(part.textContent).toContain('motir fix ACME-12');
    expect(part.textContent).toContain(en.github.development.fix.reviewedAgain);
    expect(part.textContent).not.toContain('Checks are failing');
    // No verbs of any kind.
    expect(button(pra.verb.approveAndMerge)).toBeNull();
    expect(button(ar.verb.reviewAgain)).toBeNull();
  });
});

/** The approve-and-merge gate leading, with the review decided at the SAME version. */
function renderMerge(
  review: AgentReviewViewDto,
  { handOver = true, canDecide = true }: { handOver?: boolean; canDecide?: boolean } = {},
) {
  const merge: ApprovalGateDTO = {
    ...AWAITING_MERGE_GATE,
    id: `gate-merge-${++seq}`,
    subjectVersion: SET,
  };
  return render(
    <DevelopmentSectionBody
      pullRequests={[CORE_PR, GATEWAY_PR]}
      itemIdentifier="ACME-12"
      howToTest={recordDto()}
      mergeGate={{ gate: merge, canDecide, routedToLabel: 'Zhu Yue', stamp: 's', members: [] }}
      gateActions={pageActions()}
      {...(handOver ? { handOver: { routedToViewer: true } } : {})}
      agentReview={review}
    />,
  );
}

describe('Review passed (Panels 2a, 2b)', () => {
  const passed = () =>
    view(
      reviewGate({
        state: 'approved',
        noteMd: 'The change does what ACME-12 asks.\n\n## Notes\n\n- DEFAULT_BURST is read twice.',
        decidedAt: '2026-09-29T09:52:00.000Z',
        decidedUnderAuthority: 'review_agent',
      }),
    );

  it('draws the summary above the approve-and-merge gate, the findings behind the disclosure', () => {
    renderMerge(passed());
    expect(band().dataset.state).toBe('passed');
    expect(within(band()).getByText(ar.passed.title)).toBeTruthy();
    expect(within(band()).getByText(ar.passed.pill)).toBeTruthy();
    expect(screen.getByTestId('agent-review-summary').textContent).toBe(
      'The change does what ACME-12 asks.',
    );
    expect(within(band()).queryByText('DEFAULT_BURST is read twice.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: ar.findings.show }));
    expect(within(band()).getByText('DEFAULT_BURST is read twice.')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: ar.findings.hide }).getAttribute('aria-expanded'),
    ).toBe('true');
    // The ordinary gate is below it: on the item page, its call to action.
    expect(
      screen.getByRole('link', { name: en.approvalGate.statusHeld.reviewAndApprove }),
    ).toBeTruthy();
  });

  it('inside the frame (not handed over) the band sits between band 1 and the port', () => {
    renderMerge(passed(), { handOver: false, canDecide: false });
    expect(band().dataset.state).toBe('passed');
    expect(screen.getByText(pra.kindLabel)).toBeTruthy();
  });

  it('a pass with empty findings draws the head alone', () => {
    const p = passed();
    renderMerge({ ...p, gate: { ...p.gate, noteMd: null } });
    expect(screen.queryByTestId('agent-review-summary')).toBeNull();
    expect(screen.queryByRole('button', { name: ar.findings.show })).toBeNull();
  });

  it('a review of OTHER commits draws nothing above the gate', () => {
    const p = passed();
    renderMerge({ ...p, gate: { ...p.gate, subjectVersion: CORE_V } });
    expect(screen.queryByTestId('agent-review-band')).toBeNull();
  });
});

describe('The override, decided (Panel 5)', () => {
  it('names the person, the time and the note — never Passed, never the agent', () => {
    renderMerge(
      view(
        reviewGate({
          state: 'approved',
          noteMd: 'Credits run out on the 1st — I read the diff myself.',
          decidedAt: '2026-09-29T10:14:00.000Z',
          decidedUnderAuthority: 'assignee',
          decidedByLabel: 'Zhu Yue',
        }),
      ),
    );
    expect(band().dataset.state).toBe('override');
    expect(within(band()).getByText(ar.override.bandTitle)).toBeTruthy();
    expect(band().textContent).toContain('The review agent did not review these 2 commits.');
    expect(band().textContent).toContain('Continued without the review by Zhu Yue');
    expect(band().textContent).toContain('“Credits run out on the 1st — I read the diff myself.”');
    expect(band().textContent).not.toContain(ar.passed.pill);
  });
});

describe("a person's Changes requested (Panel 3e, §12.7)", () => {
  it('the fix part names the person and offers motir fix', () => {
    const merge: ApprovalGateDTO = {
      ...AWAITING_MERGE_GATE,
      id: `gate-merge-${++seq}`,
      subjectVersion: SET,
      state: 'changes_requested',
      decidedByLabel: 'Mei Lin',
      decidedAt: '2026-09-29T11:20:00.000Z',
      noteMd: 'The empty state should name the reviewer.',
    };
    render(
      <DevelopmentSectionBody
        pullRequests={[CORE_PR, GATEWAY_PR]}
        itemIdentifier="ACME-12"
        howToTest={recordDto()}
        repair={REVIEW_REPAIR}
        mergeGate={{ gate: merge, canDecide: true, routedToLabel: null, stamp: null, members: [] }}
        gateActions={pageActions()}
        handOver={{ routedToViewer: true }}
      />,
    );
    const part = screen.getByTestId('repair-fix-part');
    expect(within(part).getByTestId('repair-sent-back-line').dataset.sentBackBy).toBe('person');
    expect(part.textContent).toContain('Mei Lin sent these commits back.');
    expect(part.textContent).toContain('motir fix ACME-12');
    expect(part.textContent).not.toContain('motir run');
  });
});

describe('zh', () => {
  it('renders every state without a missing key', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const states: AgentReviewViewDto[] = [
      view(reviewGate()),
      view(reviewGate(), { reviewUnavailableReason: 'no_verdict' }),
      view(reviewGate(), { reviewUnavailableReason: 'weird_code' }),
      view(reviewGate(), { reviewUnavailableReason: 'hosted_run_no_capacity' }),
      view(reviewGate({ state: 'changes_requested', noteMd: FINDINGS })),
    ];
    for (const s of states) {
      renderLeading(s, { messages: zh, repair: REVIEW_REPAIR });
      expect(document.body.textContent).toContain(zh.approvalGate.agentReview.kindLabel);
      expect(document.body.textContent).not.toMatch(/approvalGate\.agentReview\./);
      cleanup();
    }
    const missing = errors.mock.calls.filter((c) => String(c[0]).includes('MISSING_MESSAGE'));
    expect(missing).toEqual([]);
    errors.mockRestore();
  });
});

describe('the helpers', () => {
  it('maps every code MOTIR-6820 writes, and a generic line for anything else', () => {
    expect(couldNotRunCopyOf('hosted_run_out_of_credits')).toBe('no_credits');
    expect(couldNotRunCopyOf('something_new')).toBe('unknown');
    expect(couldNotRunCopyOf('hosted_run_no_capacity')).toBe('noCapacity');
  });

  it('the no-capacity line reads in zh, never the unknown fallback (MOTIR-9633)', () => {
    renderLeading(view(reviewGate(), { reviewUnavailableReason: 'hosted_run_no_capacity' }), {
      messages: zh,
    });
    expect(band().textContent).toContain(zh.approvalGate.agentReview.couldNotRun.reason.noCapacity);
    expect(band().getAttribute('data-reason')).toBe('noCapacity');
  });
  it('takes the findings first paragraph, skipping headings and fences', () => {
    expect(firstParagraph('## Head\n\nFirst para\nline two.\n\nSecond.')).toBe(
      'First para\nline two.',
    );
    expect(firstParagraph(null)).toBe('');
  });
});
