// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import type {
  DevelopmentGateActions,
  DevelopmentGateRead,
} from '@/components/github/DevelopmentGateFrame';
import type { AutoQueueExits } from '@/components/github/QueueExitAutoPart';
import {
  OptimisticStatusProvider,
  useDisplayedStatus,
} from '@/app/(authed)/items/[key]/_components/OptimisticStatusProvider';
import type { WorkItemRepairViewDto } from '@/lib/dto/workItemRepair';
import type {
  ApprovalGateDTO,
  PullRequestApprovalMemberDTO,
  PullRequestQueueExitDTO,
} from '@/lib/dto/approvalGate';
import { AWAITING_MERGE_GATE, CORE_PR, GATEWAY_PR, recordDto } from '../helpers/howToTestFixtures';

// THE DEVELOPMENT FRAME RENDERS THE EJECTION (Story MOTIR-5461 · MOTIR-5635;
// `design/github/design-notes.md` § 22, `approve-and-merge--ejected.mock.html` E1–E7).
//
// The block is mounted whole — real rows, real How to test, real frame — from a FIXTURE
// member read, and only the server actions are fakes, as in `development-gate-verbs`.

const { refreshSpy } = vi.hoisted(() => ({ refreshSpy: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const pra = en.approvalGate.pullRequestApproval;
const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));
/** The tags the ejection's rich messages use — removed by name, not by pattern: a message is
 *  our own catalogue text, and a closed list says exactly what the page drops. */
const RICH_TAGS = ['<b>', '</b>', '<link>', '</link>'] as const;
/** A rich message as the DOM reads it: its tags gone. */
const plain = (text: string, vars: Record<string, string | number> = {}) =>
  RICH_TAGS.reduce((out, tag) => out.split(tag).join(''), fill(text, vars));

const CORE_SHA = '3f2a91c0000000000000000000000000000000aa';
const GATEWAY_SHA = 'aa11bb2000000000000000000000000000000000';
const CORE_V = `moooon/motir-core#131@${CORE_SHA}`;
const GATEWAY_V = `moooon/motir-gateway#57@${GATEWAY_SHA}`;
const GATEWAY_NAME = 'moooon/motir-gateway · #57';
const CHECK_URL = 'https://github.com/moooon/motir-gateway/actions/runs/1/job/2';

const APPROVED: ApprovalGateDTO = {
  ...AWAITING_MERGE_GATE,
  subjectVersion: [CORE_V, GATEWAY_V].sort().join(','),
  state: 'approved',
  decidedById: 'user-2',
  decidedByLabel: 'Ada L.',
  decidedAt: '2026-09-15T14:22:00.000Z',
  outcomeRef: 'approved',
};
const STORY = recordDto();

function exit(over: Partial<PullRequestQueueExitDTO> = {}): PullRequestQueueExitDTO {
  return {
    rawReason: 'CI_FAILURE',
    disposition: 'failure',
    headSha: GATEWAY_SHA,
    exitedAt: '2026-09-15T15:00:00.000Z',
    requeuedAt: null,
    failingCheckName: 'CI complete',
    failingCheckUrl: CHECK_URL,
    failingCheckConclusion: 'failure',
    ...over,
  };
}

/** The core member merged; the gateway member as `over` says. */
function members(over: Partial<PullRequestApprovalMemberDTO>): PullRequestApprovalMemberDTO[] {
  return [
    {
      subjectVersion: CORE_V,
      pullRequestId: CORE_PR.id,
      queued: false,
      retryable: false,
      exit: null,
      exitAtApprovedHead: false,
      requeueable: false,
      refusal: null,
      retryDecidesGateId: null,
    },
    {
      subjectVersion: GATEWAY_V,
      pullRequestId: GATEWAY_PR.id,
      queued: false,
      retryable: false,
      exit: exit(),
      exitAtApprovedHead: true,
      requeueable: true,
      refusal: null,
      retryDecidesGateId: null,
      ...over,
    },
  ];
}

function fakeActions(retryMember: ReturnType<typeof vi.fn> = vi.fn()) {
  return {
    decide: vi.fn(),
    approveAndMerge: vi.fn(),
    retryMember,
  } as unknown as DevelopmentGateActions;
}

function Rail({ server }: { server: string }) {
  return <output aria-label="rail">{useDisplayedStatus(server)}</output>;
}

function renderFrame(
  read: Partial<DevelopmentGateRead>,
  actions: DevelopmentGateActions | undefined = fakeActions(),
  status = 'implemented',
) {
  return render(
    <OptimisticStatusProvider serverStatus={status}>
      <Rail server={status} />
      <DevelopmentSectionBody
        pullRequests={[{ ...CORE_PR, state: 'merged' }, GATEWAY_PR]}
        itemIdentifier="ACME-12"
        manualLinkable
        howToTest={STORY}
        mergeGate={{
          gate: APPROVED,
          canDecide: true,
          routedToLabel: null,
          stamp: 'v1.stamp-on-screen',
          ...read,
        }}
        gateActions={actions}
      />
    </OptimisticStatusProvider>,
  );
}

/** An element whose OWN text (tags and all) is `expected` — a rich message spans a `<b>`. */
const whole = (expected: string) => (_: string, el: Element | null) =>
  el?.textContent === expected &&
  Array.from(el.children).every((child) => child.textContent !== expected);

const rowOf = (title: string) => screen.getByText(title).closest('li')!;
const gatewayRow = () => rowOf(GATEWAY_PR.title);
const queueAgain = () =>
  within(gatewayRow()).queryByRole('button', { name: pra.outcome.queueAgain });
const rail = () => screen.getByRole('status', { name: 'rail' }).textContent;

describe('manual mode, on the card’s decided approval', () => {
  // ⚠️ AMENDED by MOTIR-6596 (§4 FIFTH AMENDMENT; design § 31 panel 1): a queue FAILURE is
  // CAN'T-LAND — held at Implemented, the failed CHECK named in the sentence, the held line
  // beneath it, and NO *Queue again*.
  it('E1 · a failure: Left the queue, the failed check named and linked, held, and NO Queue again', () => {
    renderFrame({ members: members({}) });

    expect(within(gatewayRow()).getByText(pra.outcome.leftQueue)).toBeTruthy();
    expect(queueAgain()).toBeNull();
    // The sibling keeps its own outcome, and no second question is drawn.
    expect(within(rowOf(CORE_PR.title)).queryByText(pra.outcome.leftQueue)).toBeNull();
    expect(screen.queryByRole('button', { name: pra.verb.approveAndMerge })).toBeNull();
    expect(screen.getByText(/Approved by Ada L\./)).toBeTruthy();
    expect(
      screen.getByText(
        whole(plain(pra.exit.failed.checks, { pr: GATEWAY_NAME, check: 'CI complete' })),
      ),
    ).toBeTruthy();
    const link = screen.getByRole('link', {
      name: fill(pra.exit.openCheck, { check: 'CI complete' }),
    });
    expect(link.getAttribute('href')).toBe(CHECK_URL);
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByText(whole(plain(pra.exit.failed.held, { key: 'ACME-12' })))).toBeTruthy();
    expect(screen.queryByText(whole(plain(pra.exit.unchanged)))).toBeNull();
  });

  it('E1 · a timeout names the check that timed out', () => {
    renderFrame({ members: members({ exit: exit({ rawReason: 'CI_TIMEOUT' }) }) });
    expect(
      screen.getByText(
        whole(plain(pra.exit.failed.timedOut, { pr: GATEWAY_NAME, check: 'CI complete' })),
      ),
    ).toBeTruthy();
    expect(queueAgain()).toBeNull();
  });

  it.each(['INVALID_MERGE_COMMIT', 'GIT_TREE_INVALID'])(
    'E1 · %s reads the one could-not-build sentence, held, and NO Queue again',
    (rawReason) => {
      renderFrame({
        members: members({
          exit: exit({ rawReason, failingCheckName: null, failingCheckUrl: null }),
        }),
      });
      expect(
        screen.getByText(whole(plain(pra.exit.failed.mergeCommit, { pr: GATEWAY_NAME }))),
      ).toBeTruthy();
      expect(queueAgain()).toBeNull();
    },
  );

  it('E1 · a failure whose check nobody recorded falls back to the reason in words — nothing invented', () => {
    renderFrame({
      members: members({ exit: exit({ failingCheckName: null, failingCheckUrl: null }) }),
    });
    expect(
      screen.getByText(
        whole(plain(pra.exit.left, { pr: GATEWAY_NAME, reason: pra.exit.reason.CI_FAILURE })),
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Failing check/)).toBeNull();
  });

  it('E6 · no failing check known: the reason stands alone, and nothing is invented', () => {
    renderFrame({
      members: members({
        exit: exit({ rawReason: 'MERGE_CONFLICT', failingCheckName: null, failingCheckUrl: null }),
      }),
    });
    expect(screen.getByText(new RegExp(pra.exit.reason.MERGE_CONFLICT))).toBeTruthy();
    expect(screen.queryByText(/Failing check/)).toBeNull();
    expect(screen.queryByRole('link', { name: /failing check/i })).toBeNull();
  });

  it('E4 · a neutral removal: Removed from the queue, no check line, and Queue again', () => {
    renderFrame(
      {
        members: members({
          exit: exit({
            rawReason: 'MANUAL',
            disposition: 'neutral',
            failingCheckName: null,
            failingCheckUrl: null,
          }),
        }),
      },
      fakeActions(),
      'approved',
    );
    expect(within(gatewayRow()).getByText(pra.outcome.removedFromQueue)).toBeTruthy();
    expect(within(gatewayRow()).queryByText(pra.outcome.leftQueue)).toBeNull();
    expect(queueAgain()).toBeTruthy();
    expect(
      screen.getByText(
        whole(plain(pra.exit.removed, { pr: GATEWAY_NAME, reason: pra.exit.reason.MANUAL })),
      ),
    ).toBeTruthy();
  });

  it('E3 · a moved head: New commits since approval, and no Queue again', () => {
    renderFrame({ members: members({ exitAtApprovedHead: false, requeueable: false }) });
    expect(within(gatewayRow()).getByText(pra.outcome.newCommits)).toBeTruthy();
    expect(queueAgain()).toBeNull();
    expect(screen.getByText(pra.exit.newCommits)).toBeTruthy();
  });

  it('a reader who may not decide sees the exit and no button', () => {
    renderFrame({ canDecide: false, members: members({}) });
    expect(within(gatewayRow()).getByText(pra.outcome.leftQueue)).toBeTruthy();
    expect(queueAgain()).toBeNull();
  });

  it('an unmapped reason never reaches the DOM — it reads as GitHub not saying why', () => {
    const { container } = renderFrame({
      members: members({ exit: exit({ rawReason: 'SOMETHING_NEW_FROM_GITHUB' }) }),
    });
    expect(container.textContent).not.toContain('SOMETHING_NEW_FROM_GITHUB');
    expect(screen.getByText(new RegExp(pra.exit.reason.unknown))).toBeTruthy();
  });

  it('E2 → E2′ · Queue again presses the retry with the gate and pull request, waits, then reads Queued — the rail at Approved', async () => {
    let answer!: (value: unknown) => void;
    const retry = vi.fn(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    // A failure that still RE-ASKS — branch protection (MOTIR-6596: a queue FAILURE is held).
    renderFrame(
      { members: members({ exit: exit({ rawReason: 'BRANCH_PROTECTIONS' }) }) },
      fakeActions(retry),
    );
    expect(rail()).toBe('implemented');

    fireEvent.click(queueAgain()!);

    expect(retry).toHaveBeenCalledWith({
      approvalGateId: APPROVED.id,
      pullRequestId: GATEWAY_PR.id,
      identifier: 'ACME-12',
      // The press carries the stamp this read was shown: on the RE-ASKED gate it IS the
      // approval, and the door refuses one made against a stamp that has moved (MOTIR-5802).
      stamp: 'v1.stamp-on-screen',
    });
    // E2: the pill stays, the button waits, the record says what is happening.
    await waitFor(() => expect((queueAgain() as HTMLButtonElement).disabled).toBe(true));
    expect(within(gatewayRow()).getByText(pra.outcome.leftQueue)).toBeTruthy();
    expect(screen.getByText(fill(pra.requeue.progress, { pr: GATEWAY_NAME }))).toBeTruthy();
    expect(rail()).toBe('approved');

    answer({
      ok: true,
      member: { subjectVersion: GATEWAY_V, pullRequestId: GATEWAY_PR.id, outcome: 'enqueued' },
    });

    await waitFor(() => expect(within(gatewayRow()).getByText(pra.outcome.queued)).toBeTruthy());
    expect(queueAgain()).toBeNull();
    expect(rail()).toBe('approved');
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('E7 · a refused Queue again: named in place, the approval stands, the row still offers it — and the rail rolls back', async () => {
    const retry = vi.fn().mockResolvedValue({
      ok: false,
      refusal: { tag: 'MERGE_ALREADY_REQUEUED' },
    });
    renderFrame(
      { members: members({ exit: exit({ rawReason: 'BRANCH_PROTECTIONS' }) }) },
      fakeActions(retry),
    );

    fireEvent.click(queueAgain()!);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(fill(pra.requeue.refusedTitle, { pr: GATEWAY_NAME }));
    expect(alert.textContent).toContain(en.approvalGate.refusal.mergeAlreadyRequeued.title);
    // ⚠️ AND CLAIMS NOTHING ABOUT THE APPROVAL (MOTIR-5834): nothing merged, so the band
    // says only what its member's line says. *Your approval stands* is retired copy.
    expect(alert.textContent).not.toContain('approval stands');
    expect(within(gatewayRow()).getByText(pra.outcome.leftQueue)).toBeTruthy();
    expect(queueAgain()).toBeTruthy();
    expect(rail()).toBe('implemented');
  });

  it('a Queue again after a NEUTRAL removal predicts no status', async () => {
    const retry = vi.fn().mockResolvedValue({
      ok: false,
      refusal: { tag: 'APPROVAL_GATE_SUPERSEDED' },
    });
    renderFrame(
      {
        members: members({
          exit: exit({ rawReason: 'QUEUE_CLEARED', disposition: 'neutral' }),
        }),
      },
      fakeActions(retry),
      'approved',
    );
    fireEvent.click(queueAgain()!);
    await screen.findByRole('alert');
    expect(rail()).toBe('approved');
  });

  it('an exit already put back reads as its queued merge, with no exit line', () => {
    renderFrame({
      members: members({
        queued: true,
        requeueable: false,
        exit: exit({ requeuedAt: '2026-09-15T15:05:00.000Z' }),
      }),
    });
    expect(within(gatewayRow()).getByText(pra.outcome.queued)).toBeTruthy();
    expect(screen.queryByText(/left the merge queue/)).toBeNull();
  });
});

describe('auto mode — no gate, a flush Merge queue part (E5)', () => {
  function renderAuto(read: Partial<AutoQueueExits>) {
    return render(
      <OptimisticStatusProvider serverStatus="implemented">
        <Rail server="implemented" />
        <DevelopmentSectionBody
          pullRequests={[GATEWAY_PR]}
          itemIdentifier="ACME-12"
          manualLinkable
          howToTest={STORY}
          autoQueueExits={{
            workItemId: 'item-1',
            canEdit: true,
            queueAgain: vi.fn(),
            exits: [
              {
                pullRequestId: GATEWAY_PR.id,
                repo: 'moooon/motir-gateway',
                number: 57,
                exit: exit(),
                requeueable: true,
              },
            ],
            ...read,
          }}
        />
      </OptimisticStatusProvider>,
    );
  }

  it('an editor sees the row, the part, the reason, the check, and Queue again', () => {
    renderAuto({});
    expect(within(gatewayRow()).getByText(pra.outcome.leftQueue)).toBeTruthy();
    expect(queueAgain()).toBeTruthy();
    const part = screen.getByRole('group', { name: pra.exit.partTitle });
    expect(within(part).getByRole('heading', { name: pra.exit.partTitle })).toBeTruthy();
    expect(within(part).getByText(whole(plain(pra.exit.auto)))).toBeTruthy();
    expect(within(part).getByRole('link').getAttribute('href')).toBe(CHECK_URL);
    // No frame: there is no approval to draw.
    expect(screen.queryByRole('group', { name: en.approvalGate.port.label })).toBeNull();
  });

  it('a reader who may not edit sees everything but the button', () => {
    renderAuto({ canEdit: false });
    expect(within(gatewayRow()).getByText(pra.outcome.leftQueue)).toBeTruthy();
    expect(queueAgain()).toBeNull();
  });

  it('pressing calls Queue again’s auto entry point and repaints the rail to In Review', async () => {
    const press = vi.fn().mockResolvedValue({ ok: true, status: 'in_review' });
    renderAuto({ queueAgain: press });
    fireEvent.click(queueAgain()!);
    await waitFor(() => expect(within(gatewayRow()).getByText(pra.outcome.queued)).toBeTruthy());
    expect(press).toHaveBeenCalledWith({
      workItemId: 'item-1',
      pullRequestId: GATEWAY_PR.id,
      identifier: 'ACME-12',
    });
    expect(rail()).toBe('in_review');
    expect(screen.queryByRole('group', { name: pra.exit.partTitle })).toBeNull();
  });

  it('a refusal is named in the part and the rail rolls back', async () => {
    const press = vi.fn().mockResolvedValue({
      ok: false,
      refusal: { tag: 'MERGE_ALREADY_REQUEUED' },
    });
    renderAuto({ queueAgain: press });
    fireEvent.click(queueAgain()!);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(fill(pra.requeue.refusedTitle, { pr: GATEWAY_NAME }));
    expect(rail()).toBe('implemented');
    expect(queueAgain()).toBeTruthy();
  });

  it('a NEUTRAL removal reads Removed from the queue, and its press predicts no status', async () => {
    const press = vi.fn().mockResolvedValue({ ok: false, refusal: { tag: 'UNEXPECTED' } });
    renderAuto({
      queueAgain: press,
      exits: [
        {
          pullRequestId: GATEWAY_PR.id,
          repo: 'moooon/motir-gateway',
          number: 57,
          exit: exit({ rawReason: 'QUEUE_CLEARED', disposition: 'neutral' }),
          requeueable: true,
        },
      ],
    });
    expect(within(gatewayRow()).getByText(pra.outcome.removedFromQueue)).toBeTruthy();
    fireEvent.click(queueAgain()!);
    await screen.findByRole('alert');
    expect(rail()).toBe('implemented');
    expect(press).toHaveBeenCalledTimes(1);
  });

  it('a moved head shows New commits since approval and no button', () => {
    renderAuto({
      exits: [
        {
          pullRequestId: GATEWAY_PR.id,
          repo: 'moooon/motir-gateway',
          number: 57,
          exit: exit(),
          requeueable: false,
        },
      ],
    });
    expect(within(gatewayRow()).getByText(pra.outcome.newCommits)).toBeTruthy();
    expect(queueAgain()).toBeNull();
  });

  it('with no standing exit the block is exactly § 20’s', () => {
    renderAuto({ exits: [] });
    expect(screen.queryByRole('group', { name: pra.exit.partTitle })).toBeNull();
    expect(within(gatewayRow()).queryByText(pra.outcome.leftQueue)).toBeNull();
  });
});

describe('the catalog', () => {
  it('every new key is in zh too', () => {
    const z = zh.approvalGate.pullRequestApproval;
    for (const key of ['leftQueue', 'removedFromQueue', 'newCommits', 'queueAgain'] as const) {
      expect(z.outcome[key]).toBeTruthy();
    }
    expect(Object.keys(z.exit).sort()).toEqual(Object.keys(pra.exit).sort());
    expect(Object.keys(z.exit.reason).sort()).toEqual(Object.keys(pra.exit.reason).sort());
    expect(Object.keys(z.requeue).sort()).toEqual(Object.keys(pra.requeue).sort());
  });
});

// ── `motir fix` BESIDE Queue again (Story MOTIR-5628 · MOTIR-5721; design § 26, X1–X4) ─
//
// The repair view the page reads carries, per failing member, its own `ci` and its
// standing `queueExit` (MOTIR-5719). A member failing ONLY because the queue threw it
// out is named on the left-the-queue line, and the offer state adds the sentence that
// says whether *Queue again* or `motir fix` applies. Queue again itself is untouched.

describe('an EJECTED card offers `motir fix` beside Queue again (MOTIR-5721)', () => {
  const fixMsg = en.github.development.fix;
  const FIX_TAGS = ['<b>', '</b>', '<code>', '</code>', '<prs></prs>'] as const;
  const sentence = (text: string) => FIX_TAGS.reduce((out, tag) => out.split(tag).join(''), text);
  const ejectedRef = (rawReason = 'CI_FAILURE') => ({
    repo: 'moooon/motir-gateway',
    number: 57,
    ci: 'passing' as const,
    queueExit: { rawReason, disposition: 'failure' as const, failingCheckName: 'CI complete' },
    conflict: null,
    outOfDate: null,
  });
  const offer = (rawReason?: string): WorkItemRepairViewDto => ({
    state: 'offer',
    repairClass: 'ci',
    acceptanceRefusal: null,
    failing: [ejectedRef(rawReason)],
    lastGaveUp: null,
  });
  const fixPart = () => screen.getByRole('group', { name: fixMsg.aria.part });

  function renderWithRepair(
    repair: WorkItemRepairViewDto,
    exitOver: Partial<PullRequestQueueExitDTO> = {},
    locale?: { locale: string; messages: Record<string, unknown> },
  ) {
    return render(
      <OptimisticStatusProvider serverStatus="implemented">
        <DevelopmentSectionBody
          pullRequests={[{ ...CORE_PR, state: 'merged' }, GATEWAY_PR]}
          itemIdentifier="ACME-12"
          manualLinkable
          howToTest={STORY}
          repair={repair}
          mergeGate={{
            gate: APPROVED,
            canDecide: true,
            routedToLabel: null,
            stamp: 'v1.stamp-on-screen',
            members: members({ exit: exit(exitOver) }),
          }}
          gateActions={fakeActions()}
        />
      </OptimisticStatusProvider>,
      locale,
    );
  }

  // ⚠️ AMENDED by MOTIR-6596 (§4 FIFTH AMENDMENT; design § 31 panel 1): a queue FAILURE is
  // CAN'T-LAND, so the row keeps *Left the queue* with NO *Queue again*, and the part's
  // sentence is the FAILED one — a new head, never the same commits again.
  it('X1 · failed checks: Left the queue with NO Queue again, and the fix part with the left-the-queue line, the command and the failed sentence', () => {
    renderWithRepair(offer());
    expect(within(gatewayRow()).getByText(pra.outcome.leftQueue)).toBeTruthy();
    expect(queueAgain()).toBeNull();
    const part = fixPart();
    expect(part.textContent).toContain(`${GATEWAY_NAME} left the merge queue.`);
    expect(part.textContent).not.toContain('Checks are failing');
    expect(part.textContent).toContain('motir fix ACME-12');
    expect(within(part).getByTestId('repair-which').textContent).toBe(
      sentence(fixMsg.which.failed),
    );
  });

  // ⚠️ REPLACES "…and Queue again is still offered" (MOTIR-5806; §4 FOURTH AMENDMENT,
  // point 2): a conflict CANNOT LAND as it stands, so the row offers no verb at all and
  // `motir fix` is the one way forward.
  it('X2 · a merge conflict: no verb on the row, the cannot-merge pill, and the conflict sentence', () => {
    renderWithRepair(offer('MERGE_CONFLICT'), {
      rawReason: 'MERGE_CONFLICT',
      failingCheckName: null,
      failingCheckUrl: null,
    });
    expect(queueAgain()).toBeNull();
    expect(within(gatewayRow()).getByText(pra.outcome.cannotLand)).toBeTruthy();
    expect(within(fixPart()).getByTestId('repair-which').textContent).toBe(
      sentence(fixMsg.which.conflict),
    );
  });

  it('X4 · a repair in progress: no command and no sentence, and no Queue again for a held failure', () => {
    renderWithRepair({
      state: 'in_progress',
      repairClass: 'ci',
      acceptanceRefusal: null,
      failing: [ejectedRef()],
      holder: { id: 'u-2', name: 'Mara S.' },
      byViewer: false,
      startedAt: '2026-09-15T15:10:00.000Z',
    });
    expect(queueAgain()).toBeNull();
    const part = fixPart();
    expect(part.textContent).toContain(`${GATEWAY_NAME} left the merge queue.`);
    expect(part.textContent).not.toContain('motir fix');
    expect(within(part).queryByTestId('repair-which')).toBeNull();
  });

  it('the sentence has an exact zh twin', () => {
    renderWithRepair(offer(), {}, { locale: 'zh', messages: zh });
    const zhPart = screen.getByRole('group', { name: zh.github.development.fix.aria.part });
    expect(within(zhPart).getByTestId('repair-which').textContent).toBe(
      sentence(zh.github.development.fix.which.failed),
    );
  });

  it('X3 · auto mode: no frame, and the fix part comes BEFORE the Merge queue part, as the shipped body renders it', () => {
    render(
      <OptimisticStatusProvider serverStatus="implemented">
        <DevelopmentSectionBody
          pullRequests={[GATEWAY_PR]}
          itemIdentifier="ACME-12"
          manualLinkable
          howToTest={STORY}
          repair={offer()}
          autoQueueExits={{
            workItemId: 'item-1',
            canEdit: true,
            queueAgain: vi.fn(),
            exits: [
              {
                pullRequestId: GATEWAY_PR.id,
                repo: 'moooon/motir-gateway',
                number: 57,
                exit: exit(),
                requeueable: true,
              },
            ],
          }}
        />
      </OptimisticStatusProvider>,
    );
    const queuePart = screen.getByRole('group', { name: pra.exit.partTitle });
    const part = fixPart();
    expect(part.compareDocumentPosition(queuePart) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(part).getByTestId('repair-which')).toBeTruthy();
    expect(screen.queryByRole('group', { name: en.approvalGate.port.label })).toBeNull();
  });
});
