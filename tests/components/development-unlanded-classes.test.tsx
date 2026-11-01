// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import type {
  DevelopmentGateActions,
  DevelopmentGateRead,
} from '@/components/github/DevelopmentGateFrame';
import { OptimisticStatusProvider } from '@/app/(authed)/items/[key]/_components/OptimisticStatusProvider';
import type {
  ApprovalGateDTO,
  PullRequestApprovalMemberDTO,
  PullRequestQueueExitDTO,
} from '@/lib/dto/approvalGate';
import type { WorkItemRepairViewDto } from '@/lib/dto/workItemRepair';
import { AWAITING_MERGE_GATE, CORE_PR, GATEWAY_PR, recordDto } from '../helpers/howToTestFixtures';

// EVERY UN-LANDED CLASS, AS THE ROW DRAWS IT (Story MOTIR-5799 · MOTIR-5806;
// `design/github/design-notes.md` § 28, `approve-and-merge--ejected--reasked.mock.html`
// panels 1–4; `docs/decisions/approval-gates.md` § 4 FOURTH AMENDMENT, point 2).
//
// One approval authorizes ONE merge or enqueue action, and what the row offers after one
// that did not land is decided by the REASON's class:
//
//   · RETRYABLE — *Queue again* / *Retry merge*, and pressing it IS the new approval;
//   · BLOCKED BY A SETTING — *Retry merge*, with the setting NAMED;
//   · CAN'T LAND — no verb at all; `motir fix` is the way forward.
//
// The block is mounted whole from a fixture read, as `development-ejection` mounts it;
// only the server actions are fakes.

const { refreshSpy } = vi.hoisted(() => ({ refreshSpy: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const pra = en.approvalGate.pullRequestApproval;
const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));
/** A rich message as the DOM reads it — its tags gone, so one `getByText` matches it. */
const RICH_TAGS = ['<b>', '</b>', '<code>', '</code>'] as const;
const plain = (text: string) => RICH_TAGS.reduce((out, tag) => out.split(tag).join(''), text);
/** Matched WHOLE: `getByText` with a string matches a node whose text is exactly it, and
 *  a sentence split across `<b>` children is not one node — so the matcher reads the
 *  element's own `textContent`. */
const whole = (text: string) => (_: string, el: Element | null) =>
  el?.textContent === text && Array.from(el.children).every((child) => child.textContent !== text);
const GATEWAY_NAME = 'moooon/motir-gateway · #57';
const GATEWAY_SHA = 'aa11bb2000000000000000000000000000000000';
const CORE_SHA = '3f2a91c0000000000000000000000000000000aa';
const CORE_V = `moooon/motir-core#131@${CORE_SHA}`;
const GATEWAY_V = `moooon/motir-gateway#57@${GATEWAY_SHA}`;

/** The RE-ASKED gate: awaiting, over the same two commits — what the row's press decides. */
const REASKED: ApprovalGateDTO = {
  ...AWAITING_MERGE_GATE,
  subjectVersion: [CORE_V, GATEWAY_V].sort().join(','),
  state: 'awaiting',
};
const STORY = recordDto();

/** A standing exit. The default is BRANCH PROTECTION — the queue failure that still
 *  RE-ASKS: since the FIFTH AMENDMENT (MOTIR-6596) `CI_FAILURE` and its siblings are
 *  CAN'T-LAND, so the tests of the re-ask's own machinery eject for a setting. */
function queueExit(over: Partial<PullRequestQueueExitDTO> = {}): PullRequestQueueExitDTO {
  return {
    rawReason: 'BRANCH_PROTECTIONS',
    disposition: 'failure',
    headSha: GATEWAY_SHA,
    exitedAt: '2026-09-19T15:00:00.000Z',
    requeuedAt: null,
    failingCheckName: 'CI complete',
    failingCheckUrl: 'https://github.com/moooon/motir-gateway/actions/runs/1/job/2',
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
      retryDecidesGateId: REASKED.id,
    },
    {
      subjectVersion: GATEWAY_V,
      pullRequestId: GATEWAY_PR.id,
      queued: false,
      retryable: false,
      exit: null,
      exitAtApprovedHead: true,
      requeueable: false,
      refusal: null,
      retryDecidesGateId: REASKED.id,
      ...over,
    },
  ];
}

/** F1: the part offers `motir fix ACME-12` for the member the queue threw out. */
const repairOffer = (): WorkItemRepairViewDto => ({
  state: 'offer',
  repairClass: 'ci',
  acceptanceRefusal: null,
  failing: [
    {
      repo: 'moooon/motir-gateway',
      number: 57,
      // Its OWN checks are green — it is failing only because the queue removed it
      // (MOTIR-5719), which is what the which-to-use line reads.
      ci: 'passing',
      queueExit: {
        rawReason: 'CI_FAILURE',
        disposition: 'failure' as const,
        failingCheckName: 'CI complete',
      },
      conflict: null,
      outOfDate: null,
    },
  ],
  lastGaveUp: null,
});

function fakeActions(retryMember: ReturnType<typeof vi.fn> = vi.fn()) {
  return {
    decide: vi.fn(),
    approveAndMerge: vi.fn(),
    retryMember,
  } as unknown as DevelopmentGateActions;
}

function renderBlock(
  read: Partial<DevelopmentGateRead>,
  opts: { repair?: WorkItemRepairViewDto | null; status?: string } = {},
  actions: DevelopmentGateActions = fakeActions(),
) {
  return render(
    <OptimisticStatusProvider serverStatus={opts.status ?? 'in_review'}>
      <DevelopmentSectionBody
        pullRequests={[{ ...CORE_PR, state: 'merged' }, GATEWAY_PR]}
        itemIdentifier="ACME-12"
        manualLinkable
        howToTest={STORY}
        repair={opts.repair ?? null}
        mergeGate={{
          gate: REASKED,
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

const gatewayRow = () => screen.getByText(GATEWAY_PR.title).closest('li')!;
const rowButton = (name: string) => within(gatewayRow()).queryByRole('button', { name });
const fixPart = () => screen.getByRole('group', { name: en.github.development.fix.aria.part });

describe('the row draws the class, and offers only what that class allows', () => {
  // ⚠️ AMENDED by MOTIR-6596 (§4 FIFTH AMENDMENT; design § 31 panel 1): a queue FAILURE is
  // CAN'T-LAND. The row keeps § 22's *Left the queue* pill and offers NOTHING — no *Queue
  // again*, no *Retry merge*, no Approve — the failed check is named and `motir fix` is
  // the way forward. The CLASS decides, so every failure reason reads the same shape.
  it.each([
    ['CI_FAILURE', 'CI complete', 'checks'],
    ['CI_TIMEOUT', 'CI complete', 'timedOut'],
    ['INVALID_MERGE_COMMIT', null, 'mergeCommit'],
    ['GIT_TREE_INVALID', null, 'mergeCommit'],
  ] as const)(
    'CAN’T LAND, a queue %s: held — Left the queue, no verb, the failure named, and `motir fix`',
    (rawReason, check, sentenceKey) => {
      renderBlock(
        {
          members: members({
            exit: queueExit({
              rawReason,
              failingCheckName: check,
              failingCheckUrl: check
                ? 'https://github.com/moooon/motir-gateway/actions/runs/1'
                : null,
            }),
          }),
        },
        { repair: repairOffer(), status: 'implemented' },
      );

      expect(within(gatewayRow()).getByText(pra.outcome.leftQueue)).toBeTruthy();
      expect(rowButton(pra.outcome.queueAgain)).toBeNull();
      expect(rowButton(pra.outcome.retry)).toBeNull();
      expect(
        screen.getByText(
          whole(
            plain(fill(pra.exit.failed[sentenceKey], { pr: GATEWAY_NAME, check: check ?? '' })),
          ),
        ),
      ).toBeTruthy();
      expect(
        screen.getByText(whole(plain(fill(pra.exit.failed.held, { key: 'ACME-12' })))),
      ).toBeTruthy();
      expect(fixPart().textContent).toContain('motir fix ACME-12');
    },
  );

  it('RETRYABLE, a failure that still re-asks (a setting): Left the queue, Queue again, the re-ask', () => {
    renderBlock({ members: members({ exit: queueExit(), requeueable: true }) });

    expect(within(gatewayRow()).getByText(pra.outcome.leftQueue)).toBeTruthy();
    expect(rowButton(pra.outcome.queueAgain)).toBeTruthy();
  });

  it('RETRYABLE, a neutral removal: the same verb, and NO `motir fix` — no code change is implied', () => {
    renderBlock(
      {
        members: members({
          exit: queueExit({
            rawReason: 'MANUAL',
            disposition: 'neutral',
            failingCheckName: null,
            failingCheckUrl: null,
          }),
          requeueable: true,
        }),
      },
      // The claim refuses a neutral removal (`repair_not_code`, MOTIR-5803), so the page
      // is handed no repair view at all.
      { repair: null },
    );

    expect(within(gatewayRow()).getByText(pra.outcome.removedFromQueue)).toBeTruthy();
    expect(rowButton(pra.outcome.queueAgain)).toBeTruthy();
    expect(screen.queryByText(/motir fix ACME-12/)).toBeNull();
  });

  it('CAN’T LAND, a conflict: no verb at all, the cannot-merge pill, and `motir fix` alone', () => {
    renderBlock(
      {
        members: members({
          exit: queueExit({
            rawReason: 'MERGE_CONFLICT',
            failingCheckName: null,
            failingCheckUrl: null,
          }),
        }),
      },
      { repair: repairOffer(), status: 'implemented' },
    );

    expect(within(gatewayRow()).getByText(pra.outcome.cannotLand)).toBeTruthy();
    expect(rowButton(pra.outcome.queueAgain)).toBeNull();
    expect(rowButton(pra.outcome.retry)).toBeNull();
    expect(fixPart().textContent).toContain('motir fix ACME-12');
    // The pill says the CLASS; the band beneath says why, because no verb can (§ 28
    // panel 3). A pill with nothing under it would leave the reason nowhere.
    expect(screen.getByText(whole(plain(pra.exit.cannotLand)))).toBeTruthy();
  });

  it('CAN’T LAND, a host refusal on red checks: the same shape, worded for the checks', () => {
    renderBlock({
      members: members({
        refusal: {
          code: 'checks_not_green',
          landingClass: 'cant_land',
          refusedAt: '2026-09-19T15:10:00.000Z',
          permission: null,
          reason: null,
        },
      }),
    });

    // The SAME pill — the class, not the reason (§ 28's slot table) — and the refusal's
    // own line beneath it, which a host refusal has instead of a queue exit.
    expect(within(gatewayRow()).getByText(pra.outcome.cannotLand)).toBeTruthy();
    expect(rowButton(pra.outcome.retry)).toBeNull();
    expect(
      screen.getByText(whole(plain(fill(pra.cannotLand.line, { pr: GATEWAY_NAME })))),
    ).toBeTruthy();
  });

  it('BLOCKED BY A SETTING: the setting is NAMED and Retry merge is offered', () => {
    renderBlock({
      members: members({
        requeueable: true,
        refusal: {
          code: 'app_permission_missing',
          landingClass: 'setting',
          refusedAt: '2026-09-19T15:10:00.000Z',
          permission: 'contents: write',
          reason: null,
        },
      }),
    });

    expect(within(gatewayRow()).getByText(pra.outcome.settingHeld)).toBeTruthy();
    // ⚠️ THE PERMISSION IS NAMED IN THE BAND, NOT IN THE PILL (§ 28's slot table): the
    // pill is read at a glance, and *Blocked: contents: write* reads as the row's state
    // rather than as something somebody can go and grant.
    expect(
      screen.getByText(
        whole(
          plain(
            fill(pra.setting.linePermission, {
              pr: GATEWAY_NAME,
              permission: 'contents: write',
            }),
          ),
        ),
      ),
    ).toBeTruthy();
    expect(screen.getByText(whole(plain(pra.setting.reasked)))).toBeTruthy();
    expect(rowButton(pra.outcome.retry)).toBeTruthy();
  });

  it('BLOCKED BY A SETTING with no permission named: the general sentence, and still the verb', () => {
    renderBlock({
      members: members({
        requeueable: true,
        refusal: {
          code: 'branch_protected',
          landingClass: 'setting',
          refusedAt: '2026-09-19T15:10:00.000Z',
          permission: null,
          reason: null,
        },
      }),
    });

    expect(within(gatewayRow()).getByText(pra.outcome.settingHeld)).toBeTruthy();
    expect(
      screen.getByText(whole(plain(fill(pra.setting.line, { pr: GATEWAY_NAME })))),
    ).toBeTruthy();
    expect(rowButton(pra.outcome.retry)).toBeTruthy();
  });

  // Bug MOTIR-6735: the classifier files every host error it does not recognise under
  // `branch_protected`, so the general sentence cannot say WHICH setting — and the host's
  // own message, kept on the refusal, is drawn beneath it as the host's words.
  it('BLOCKED BY A SETTING the host NAMED: GitHub’s own message is quoted under the line', () => {
    const message = 'Repository rule violations found: 2 of 2 required status checks are expected.';
    renderBlock({
      members: members({
        requeueable: true,
        refusal: {
          code: 'branch_protected',
          landingClass: 'setting',
          refusedAt: '2026-09-19T15:10:00.000Z',
          permission: null,
          reason: message,
        },
      }),
    });

    expect(
      screen.getByText(whole(plain(fill(pra.setting.line, { pr: GATEWAY_NAME })))),
    ).toBeTruthy();
    expect(
      screen.getByText(whole(plain(fill(pra.setting.hostReason, { reason: message })))),
    ).toBeTruthy();
  });

  it('BLOCKED BY A SETTING the host did NOT name: no quoted line at all, never an empty one', () => {
    const { container } = renderBlock({
      members: members({
        requeueable: true,
        refusal: {
          code: 'branch_protected',
          landingClass: 'setting',
          refusedAt: '2026-09-19T15:10:00.000Z',
          permission: null,
          reason: null,
        },
      }),
    });

    expect(container.querySelector('[data-merge-refusal]')).not.toBeNull();
    expect(container.querySelector('[data-merge-refusal-reason]')).toBeNull();
  });

  // Bug MOTIR-6116: a conflict FIXED BY A PUSH. The fresh gate names the new head, and the
  // members read no longer carries an exit left at an older one — so this is the member
  // it hands the frame. Nothing about these commits failed to land.
  it('a conflict a push fixed: no pill, no conflict line, not a re-ask — the gate’s own Approve and merge', () => {
    renderBlock({ members: members({ exitAtApprovedHead: false }) });

    expect(within(gatewayRow()).queryByText(pra.outcome.cannotLand)).toBeNull();
    expect(screen.queryByText(whole(plain(pra.exit.cannotLand)))).toBeNull();
    expect(screen.queryByText(/Asked again after the merge queue/)).toBeNull();
    expect(screen.getByRole('button', { name: pra.verb.approveAndMerge })).toBeTruthy();
  });

  it('the row’s press asks FIRST — one confirm, and it says the press is a NEW approval', () => {
    const retryMember = vi.fn().mockResolvedValue({ ok: true, member: { outcome: 'enqueued' } });
    renderBlock(
      { members: members({ exit: queueExit(), requeueable: true }) },
      {},
      fakeActions(retryMember),
    );

    fireEvent.click(rowButton(pra.outcome.queueAgain)!);

    // ⚠️ NOTHING RAN YET (§ 28 panel 8a): the press IS an approval, so it is asked for the
    // same way the frame's own Approve is — one band, in the frame, over the verbs.
    expect(retryMember).not.toHaveBeenCalled();
    // ICU plural, so the rendered sentence is asserted rather than the template.
    expect(
      screen.getByText(
        'record that you approved these 2 commits again, with the time — a new approval, not the spent one;',
      ),
    ).toBeTruthy();
    expect(screen.getByText(fill(pra.reasked.confirm.requeue, { pr: GATEWAY_NAME }))).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', {
        name: fill(en.approvalGate.confirm.proceed, { verb: pra.outcome.queueAgain }),
      }),
    );

    expect(retryMember).toHaveBeenCalledWith({
      approvalGateId: REASKED.id,
      pullRequestId: GATEWAY_PR.id,
      identifier: 'ACME-12',
      stamp: 'v1.stamp-on-screen',
    });
  });

  it('CANCEL on that confirm decides nothing, and the row keeps its verb', () => {
    const retryMember = vi.fn();
    renderBlock(
      { members: members({ exit: queueExit(), requeueable: true }) },
      {},
      fakeActions(retryMember),
    );

    fireEvent.click(rowButton(pra.outcome.queueAgain)!);
    fireEvent.click(screen.getByRole('button', { name: en.approvalGate.confirm.cancel }));

    expect(retryMember).not.toHaveBeenCalled();
    expect(rowButton(pra.outcome.queueAgain)).toBeTruthy();
  });

  it('the re-asked frame SAYS it is a re-ask, and why — band 1, the record band, band 3', () => {
    renderBlock({ members: members({ exit: queueExit(), requeueable: true }) });

    // Band 1: not *Delivered by run N* — nothing was delivered just now.
    expect(screen.getByText('Asked again after the merge queue · 2 pull requests')).toBeTruthy();
    // The record band: the reason, its failing check, and that the approval was SPENT.
    expect(
      screen.getByText(
        whole(
          plain(
            fill(pra.exit.left, { pr: GATEWAY_NAME, reason: pra.exit.reason.BRANCH_PROTECTIONS }),
          ),
        ),
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', { name: fill(pra.exit.openCheck, { check: 'CI complete' }) }),
    ).toBeTruthy();
    expect(screen.getByText(whole(plain(pra.exit.reasked.failure)))).toBeTruthy();
    // Band 3: what THIS approval does — the member that did not land, not the whole set.
    expect(
      screen.getByText(fill(pra.reasked.why, { pr: GATEWAY_NAME, key: 'ACME-12' })),
    ).toBeTruthy();
  });
});

// THE SPENT APPROVAL, NAMED (Bug MOTIR-5863; § 28 panel 1's `af-record`, FIRST span). The
// re-asked gate is a fresh `awaiting` row, so its own `decidedByLabel` / `decidedAt` are null —
// the band's provenance line comes from the read's `earlierApproval`, never from the gate.
describe('the re-asked record band opens with the approval that was spent', () => {
  const SPENT_AT = '2026-09-15T14:22:00.000Z';
  // As the reader SEES it — the ICU plural resolved, the bold name flattened (the mould this
  // file's band-1 assertion uses).
  const earlierLine = (name: string, commits: number) =>
    `Approved earlier by ${name} · ${new Date(SPENT_AT).toLocaleString()} · ${commits} commits — not merged`;
  const reaskedMembers = () => members({ exit: queueExit(), requeueable: true });

  it('names who approved, when and over how many commits — FIRST, before the reason', () => {
    renderBlock({
      members: reaskedMembers(),
      earlierApproval: { decidedByLabel: 'Ada L.', decidedAt: SPENT_AT, commits: 2 },
    });

    const line = screen.getByText(whole(earlierLine('Ada L.', 2)));
    const exit = screen.getByText(
      whole(
        plain(
          fill(pra.exit.left, { pr: GATEWAY_NAME, reason: pra.exit.reason.BRANCH_PROTECTIONS }),
        ),
      ),
    );
    // Panel 1's order: the provenance, then the exit it explains.
    expect(line.compareDocumentPosition(exit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('counts the SPENT approval’s commits, not the set now being asked about', () => {
    renderBlock({
      members: reaskedMembers(),
      earlierApproval: { decidedByLabel: 'Ada L.', decidedAt: SPENT_AT, commits: 3 },
    });
    expect(screen.getByText(whole(earlierLine('Ada L.', 3)))).toBeTruthy();
  });

  it('an unattributable decider reads as such — never as nobody', () => {
    renderBlock({
      members: reaskedMembers(),
      earlierApproval: { decidedByLabel: null, decidedAt: SPENT_AT, commits: 2 },
    });
    expect(
      screen.getByText(whole(earlierLine(en.approvalGate.record.unattributed, 2))),
    ).toBeTruthy();
  });

  it('no earlier approval on the read ⇒ no line — the band is not faked from the fresh gate', () => {
    renderBlock({ members: reaskedMembers(), earlierApproval: null });
    expect(screen.queryByText(/Approved earlier by/)).toBeNull();
    // The rest of the band is untouched.
    expect(screen.getByText(whole(plain(pra.exit.reasked.failure)))).toBeTruthy();
  });

  it('a gate that is NOT re-asked keeps its band — the line rides only on the re-ask', () => {
    renderBlock({
      members: members({}),
      earlierApproval: { decidedByLabel: 'Ada L.', decidedAt: SPENT_AT, commits: 2 },
    });
    expect(screen.queryByText(/Approved earlier by/)).toBeNull();
  });
});

// §4 SIXTH AMENDMENT (MOTIR-6849; design § 32, `approve-and-merge--queue-exit--check-cancelled`
// panels 1a–1c): a queue exit whose check HUNG is stored NEUTRAL and re-asked. The row
// takes § 31 Panel 6a's shape — *Removed from the queue* and *Queue again* — and the exit
// line names the check and says it was cancelled / timed out, never "failed".
describe('a queue exit whose check HUNG — re-asked, the check named, nothing "failed"', () => {
  const hung = (over: Partial<PullRequestQueueExitDTO>) =>
    queueExit({ rawReason: 'CI_FAILURE', disposition: 'neutral', ...over });
  const renderHung = (exit: PullRequestQueueExitDTO, locale?: 'zh') =>
    locale
      ? render(
          <OptimisticStatusProvider serverStatus="in_review">
            <DevelopmentSectionBody
              pullRequests={[{ ...CORE_PR, state: 'merged' }, GATEWAY_PR]}
              itemIdentifier="ACME-12"
              manualLinkable
              howToTest={STORY}
              repair={null}
              mergeGate={{
                gate: REASKED,
                canDecide: true,
                routedToLabel: null,
                stamp: 'v1.stamp-on-screen',
                members: members({ exit, requeueable: true }),
              }}
              gateActions={fakeActions()}
            />
          </OptimisticStatusProvider>,
          { locale: 'zh', messages: zh },
        )
      : renderBlock({ members: members({ exit, requeueable: true }) }, { repair: null });

  it.each([
    ['cancelled', 'cancelled'],
    ['timed_out', 'timedOut'],
  ] as const)(
    'a check that concluded %s: Removed from the queue, Queue again, the stopped check linked',
    (conclusion, key) => {
      renderHung(hung({ failingCheckName: 'TypeScript', failingCheckConclusion: conclusion }));

      expect(within(gatewayRow()).getByText(pra.outcome.removedFromQueue)).toBeTruthy();
      expect(rowButton(pra.outcome.queueAgain)).toBeTruthy();
      expect(
        screen.getByText(
          whole(plain(fill(pra.exit.hung[key], { pr: GATEWAY_NAME, check: 'TypeScript' }))),
        ),
      ).toBeTruthy();
      expect(screen.getByText(whole(plain(pra.exit.hung.reasked)))).toBeTruthy();
      expect(
        screen.getByRole('link', {
          name: fill(pra.exit.openStoppedCheck, { check: 'TypeScript' }),
        }),
      ).toBeTruthy();
      expect(screen.queryByText(/Failing check/)).toBeNull();
      expect(screen.queryByText(/motir fix ACME-12/)).toBeNull();
      const block = document.querySelector('[data-queue-exit]')!;
      // The only "failed" is the sentence saying nothing did.
      expect(block.textContent!.replace(/Nothing failed in the code\./g, '')).not.toMatch(
        /failed/i,
      );
    },
  );

  it('a CI_TIMEOUT with no check named: the queue’s own wait, and no check line', () => {
    renderHung(
      hung({
        rawReason: 'CI_TIMEOUT',
        failingCheckName: null,
        failingCheckUrl: null,
        failingCheckConclusion: null,
      }),
    );

    expect(within(gatewayRow()).getByText(pra.outcome.removedFromQueue)).toBeTruthy();
    expect(
      screen.getByText(whole(plain(fill(pra.exit.hung.noCheck, { pr: GATEWAY_NAME })))),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: /stopped check/i })).toBeNull();
  });

  it('a check that FAILED is unchanged — held, the failure named, `motir fix`', () => {
    renderBlock(
      {
        members: members({
          exit: queueExit({ rawReason: 'CI_FAILURE', failingCheckConclusion: 'failure' }),
        }),
      },
      { repair: repairOffer(), status: 'implemented' },
    );

    expect(within(gatewayRow()).getByText(pra.outcome.leftQueue)).toBeTruthy();
    expect(
      screen.getByText(
        whole(plain(fill(pra.exit.failed.checks, { pr: GATEWAY_NAME, check: 'CI complete' }))),
      ),
    ).toBeTruthy();
    expect(fixPart().textContent).toContain('motir fix ACME-12');
  });

  it('zh: the cancelled sentence and the stopped-check label, with no 失败 about the check', () => {
    const zpra = zh.approvalGate.pullRequestApproval;
    renderHung(hung({ failingCheckName: 'TypeScript', failingCheckConclusion: 'cancelled' }), 'zh');

    expect(
      screen.getByText(
        whole(plain(fill(zpra.exit.hung.cancelled, { pr: GATEWAY_NAME, check: 'TypeScript' }))),
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', { name: fill(zpra.exit.openStoppedCheck, { check: 'TypeScript' }) }),
    ).toBeTruthy();
    for (const key of ['cancelled', 'timedOut', 'noCheck', 'reasked'] as const) {
      expect(zpra.exit.hung[key]).not.toMatch(/失败(?!。)/);
      expect(pra.exit.hung[key].replace('Nothing failed in the code.', '')).not.toMatch(
        /\bfailed\b/,
      );
    }
  });
});

describe('the fix part never names a HUNG exit on its left-the-queue line', () => {
  it('a member whose only standing exit is neutral is not an ejected-only failure', () => {
    renderBlock(
      {
        members: members({
          exit: queueExit({
            rawReason: 'CI_FAILURE',
            disposition: 'neutral',
            failingCheckConclusion: 'cancelled',
          }),
          requeueable: true,
        }),
      },
      {
        repair: {
          ...repairOffer(),
          failing: [
            {
              repo: 'moooon/motir-gateway',
              number: 57,
              ci: 'passing',
              queueExit: {
                rawReason: 'CI_FAILURE',
                disposition: 'neutral',
                failingCheckName: 'TypeScript',
              },
              conflict: null,
              outOfDate: null,
            },
          ],
        } as WorkItemRepairViewDto,
      },
    );

    expect(
      screen.queryByText(
        new RegExp(en.github.development.fix.leftQueueOn.split('{')[0]!.trim().slice(0, 20)),
      ),
    ).toBeNull();
  });
});
