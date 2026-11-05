// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { refuseWithReason } from '../helpers/refuseWithReason';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import type {
  DevelopmentGateActions,
  DevelopmentGateRead,
} from '@/components/github/DevelopmentGateFrame';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import { AWAITING_MERGE_GATE, CORE_PR, GATEWAY_PR, recordDto } from '../helpers/howToTestFixtures';

// THE DEVELOPMENT FRAME GETS ITS VERBS (Story MOTIR-4909 · Subtask MOTIR-5484;
// `design/github/design-notes.md` §20 *The verbs and their states*, Panels 12p–12w).
//
// The block is mounted whole — the real rows, the real How to test, the real frame — and only
// the SERVER ACTIONS are fakes, handed in as the item page hands the real ones. Every state
// the card names is driven here: at rest, confirm, the press's merged / queued / refused
// outcomes, Retry on one row, the reload that has lost the refusal's reason, a bystander, and
// a withdrawal by a push.

const { refreshSpy } = vi.hoisted(() => ({ refreshSpy: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const pra = en.approvalGate.pullRequestApproval;
const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key]));

const CORE_SHA = '3f2a91c0000000000000000000000000000000aa';
const GATEWAY_SHA = 'aa11bb2000000000000000000000000000000000';
const CORE_V = `moooon/motir-core#131@${CORE_SHA}`;
const GATEWAY_V = `moooon/motir-gateway#57@${GATEWAY_SHA}`;
const CORE_NAME = 'moooon/motir-core · #131';
const GATEWAY_NAME = 'moooon/motir-gateway · #57';

const AWAITING: ApprovalGateDTO = {
  ...AWAITING_MERGE_GATE,
  subjectVersion: [CORE_V, GATEWAY_V].sort().join(','),
};
const APPROVED: ApprovalGateDTO = {
  ...AWAITING,
  state: 'approved',
  decidedById: 'user-2',
  decidedByLabel: 'Ada L.',
  decidedAt: '2026-09-15T14:22:00.000Z',
  outcomeRef: 'approved',
};
const TWO_REPO_STORY = recordDto();

function fakeActions(overrides: Partial<Record<keyof DevelopmentGateActions, unknown>> = {}) {
  return {
    decide: vi.fn(),
    approveAndMerge: vi.fn(),
    retryMember: vi.fn(),
    ...overrides,
  } as unknown as DevelopmentGateActions & {
    decide: ReturnType<typeof vi.fn>;
    approveAndMerge: ReturnType<typeof vi.fn>;
    retryMember: ReturnType<typeof vi.fn>;
  };
}

function renderFrame(
  read: Partial<DevelopmentGateRead> & { gate: ApprovalGateDTO },
  actions?: DevelopmentGateActions,
) {
  return render(
    <DevelopmentSectionBody
      pullRequests={[CORE_PR, GATEWAY_PR]}
      itemIdentifier="ACME-12"
      manualLinkable
      howToTest={TWO_REPO_STORY}
      mergeGate={{
        canDecide: true,
        routedToLabel: 'Mara S.',
        members: [],
        stamp: 'v1.stamp-on-screen',
        ...read,
      }}
      gateActions={actions}
    />,
  );
}

const rowOf = (title: string) => screen.getByText(title).closest('li')!;
const proceedLabel = fill(en.approvalGate.confirm.proceed, { verb: pra.verb.approveAndMerge });

async function pressApproveAndMerge() {
  fireEvent.click(screen.getByRole('button', { name: pra.verb.approveAndMerge }));
  fireEvent.click(screen.getByRole('button', { name: proceedLabel }));
  await waitFor(() => expect(screen.getByText(en.approvalGate.state.approved)).toBeTruthy());
}

describe('at rest and confirming (Panels 12p, 12q)', () => {
  it('offers Approve and merge and Request changes, and NAMES both pull requests', () => {
    renderFrame({ gate: AWAITING }, fakeActions());
    expect(screen.getByRole('button', { name: pra.verb.approveAndMerge })).toBeTruthy();
    expect(screen.getByRole('button', { name: en.approvalGate.verb.requestChanges })).toBeTruthy();
    const pair = fill(pra.list.pair, { a: CORE_NAME, b: GATEWAY_NAME });
    expect(
      screen.getByText(fill(pra.consequence.named, { prs: pair, key: 'ACME-12' })),
    ).toBeTruthy();
  });

  it('COUNTS three or more in the consequence line, and the confirm step still lists every one', () => {
    const AI_V = 'moooon/motir-ai#88@bb22cc3000000000000000000000000000000000';
    renderFrame(
      { gate: { ...AWAITING, subjectVersion: [CORE_V, GATEWAY_V, AI_V].sort().join(',') } },
      fakeActions(),
    );
    expect(
      screen.getByText(fill(pra.consequence.counted, { count: 3, key: 'ACME-12' })),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: pra.verb.approveAndMerge }));
    for (const name of ['moooon/motir-ai · #88', CORE_NAME, GATEWAY_NAME]) {
      expect(screen.getByText(fill(pra.confirm.mergeOrQueue, { pr: name }))).toBeTruthy();
    }
    expect(
      screen.getByText('record that you approved these 3 commits, with the time;'),
    ).toBeTruthy();
    expect(screen.getByText(fill(pra.confirm.movesToApproved, { key: 'ACME-12' }))).toBeTruthy();
  });

  it('sits FLUSH in the Development card — no chrome of its own, the port keeping its floor, ceiling and Expand', () => {
    renderFrame({ gate: AWAITING }, fakeActions());
    const port = screen.getByRole('group', { name: en.approvalGate.port.label });
    const frame = port.parentElement!;
    expect(frame.className).toBe('flex flex-col overflow-hidden');
    expect(frame.className).not.toContain('rounded-(--radius-card)');
    // Out of the card body's padding, so the bands meet the card's edges.
    expect(frame.parentElement!.className).toContain('-mx-(--spacing-card-padding)');
    expect(port.className).toContain('min-h-[12.25rem]');
    expect(port.className).toContain('max-h-[34rem]');
    expect(screen.getByRole('button', { name: en.approvalGate.port.expand })).toBeTruthy();
  });
});

describe('the press (Panels 12s, 12t, 12u)', () => {
  it('records the approval, then shows each row merged or Queued to merge — the card stays Approved', async () => {
    const actions = fakeActions({
      approveAndMerge: vi.fn().mockResolvedValue({
        ok: true,
        gate: APPROVED,
        members: [
          {
            subjectVersion: CORE_V,
            pullRequestId: CORE_PR.id,
            outcome: 'merged',
          },
          {
            subjectVersion: GATEWAY_V,
            pullRequestId: GATEWAY_PR.id,
            outcome: 'enqueued',
          },
        ],
      }),
    });
    renderFrame({ gate: AWAITING }, actions);
    await pressApproveAndMerge();

    expect(actions.approveAndMerge).toHaveBeenCalledWith({
      gateId: AWAITING.id,
      identifier: 'ACME-12',
      // What the read handed this frame — the record of what is on screen (MOTIR-5235).
      stamp: 'v1.stamp-on-screen',
    });
    expect(within(rowOf(CORE_PR.title)).getByText(pra.outcome.merged)).toBeTruthy();
    expect(within(rowOf(GATEWAY_PR.title)).getByText(pra.outcome.queued)).toBeTruthy();
    // The CI pill has nothing left to say once the press reported.
    expect(
      within(rowOf(CORE_PR.title)).queryByText(en.github.development.ciState.passing),
    ).toBeNull();
    expect(
      screen.getByText(fill(pra.queued.why, { key: 'ACME-12', pr: GATEWAY_NAME })),
    ).toBeTruthy();
    expect(screen.getByText('2 commits')).toBeTruthy();
    expect(screen.getByText(/Approved by you just now · 2 pull requests/)).toBeTruthy();
    // The verbs are gone: the approval is committed, and there is nothing left to press.
    expect(screen.queryByRole('button', { name: pra.verb.approveAndMerge })).toBeNull();
    expect(refreshSpy).toHaveBeenCalled();
  });

  // Bug MOTIR-6735: a SETTING refusal at the press quotes the host's own words beneath the
  // union's copy — the only thing that names which setting refused the merge.
  it('a setting refusal at the press quotes GitHub’s own message under the refusal', async () => {
    const message =
      'Repository rule violations found: changes must be made through a pull request.';
    const actions = fakeActions({
      approveAndMerge: vi.fn().mockResolvedValue({
        ok: true,
        gate: APPROVED,
        members: [
          { subjectVersion: CORE_V, pullRequestId: CORE_PR.id, outcome: 'merged' },
          {
            subjectVersion: GATEWAY_V,
            pullRequestId: GATEWAY_PR.id,
            outcome: 'refused',
            refusal: { tag: 'MERGE_BRANCH_PROTECTED', reason: message },
          },
        ],
      }),
    });
    renderFrame({ gate: AWAITING }, actions);
    await pressApproveAndMerge();

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(en.approvalGate.refusal.mergeBranchProtected.title);
    expect(alert.textContent).toContain(fill(pra.setting.hostReason, { reason: message }));
  });

  it('one refused: the approval stands, the refusal is named in place, and Retry merge repaints only that row', async () => {
    const actions = fakeActions({
      approveAndMerge: vi.fn().mockResolvedValue({
        ok: true,
        gate: APPROVED,
        members: [
          {
            subjectVersion: CORE_V,
            pullRequestId: CORE_PR.id,
            outcome: 'merged',
          },
          {
            subjectVersion: GATEWAY_V,
            pullRequestId: GATEWAY_PR.id,
            outcome: 'refused',
            refusal: { tag: 'MERGE_CONFLICT' },
          },
        ],
      }),
      retryMember: vi.fn().mockResolvedValue({
        ok: true,
        member: {
          subjectVersion: GATEWAY_V,
          pullRequestId: GATEWAY_PR.id,
          outcome: 'merged',
        },
      }),
    });
    renderFrame({ gate: AWAITING }, actions);
    await pressApproveAndMerge();

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(fill(pra.refused.title, { pr: GATEWAY_NAME }));
    expect(alert.textContent).toContain(en.approvalGate.refusal.mergeConflict.title);
    expect(alert.textContent).toContain(fill(pra.refused.stands, { other: CORE_NAME }));
    expect(within(rowOf(GATEWAY_PR.title)).getByText(pra.outcome.refused)).toBeTruthy();
    expect(
      within(rowOf(CORE_PR.title)).queryByRole('button', { name: pra.outcome.retry }),
    ).toBeNull();

    fireEvent.click(
      within(rowOf(GATEWAY_PR.title)).getByRole('button', { name: pra.outcome.retry }),
    );
    await waitFor(() =>
      expect(within(rowOf(GATEWAY_PR.title)).getByText(pra.outcome.merged)).toBeTruthy(),
    );
    expect(actions.retryMember).toHaveBeenCalledWith({
      approvalGateId: APPROVED.id,
      pullRequestId: GATEWAY_PR.id,
      identifier: 'ACME-12',
      // As above: the row's press carries the stamp (MOTIR-5802).
      stamp: 'v1.stamp-on-screen',
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(within(rowOf(CORE_PR.title)).getByText(pra.outcome.merged)).toBeTruthy();
  });

  it('a refusal of the APPROVAL itself is drawn by the frame, and no row reports a merge', async () => {
    const actions = fakeActions({
      approveAndMerge: vi.fn().mockResolvedValue({
        ok: false,
        refusal: { tag: 'APPROVAL_GATE_ALREADY_DECIDED', decidedByLabel: 'Ada L.' },
      }),
    });
    renderFrame({ gate: AWAITING }, actions);
    fireEvent.click(screen.getByRole('button', { name: pra.verb.approveAndMerge }));
    fireEvent.click(screen.getByRole('button', { name: proceedLabel }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain(
      fill(en.approvalGate.refusal.alreadyDecided.byName, { name: 'Ada L.' }),
    );
    expect(screen.queryByText(pra.outcome.merged)).toBeNull();
    expect(screen.queryByText(pra.outcome.merging)).toBeNull();
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

describe('after a reload (Panels 12s, 12u′)', () => {
  it('reads Queued to merge and Not merged yet with Retry merge — and never a refusal reason', () => {
    renderFrame(
      {
        gate: APPROVED,
        members: [
          {
            subjectVersion: CORE_V,
            pullRequestId: CORE_PR.id,
            queued: true,
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
            retryable: true,
            exit: null,
            exitAtApprovedHead: false,
            requeueable: false,
            refusal: null,
            retryDecidesGateId: null,
          },
        ],
      },
      fakeActions(),
    );
    expect(within(rowOf(CORE_PR.title)).getByText(pra.outcome.queued)).toBeTruthy();
    const gateway = rowOf(GATEWAY_PR.title);
    expect(within(gateway).getByText(pra.outcome.notMergedYet)).toBeTruthy();
    expect(within(gateway).getByRole('button', { name: pra.outcome.retry })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      screen.getByText(fill(pra.notMergedYet.why, { pr: GATEWAY_NAME, host: pra.host })),
    ).toBeTruthy();
    expect(screen.getByText(/Approved by Ada L\. · 2 pull requests/)).toBeTruthy();
  });

  // ⚠️ A FIRST ASK, not a re-asked one (MOTIR-5802): nothing has been attempted under this
  // gate, so the read carries no outcome to draw — `retryable` is false on every `awaiting`
  // member (`pullRequestApprovalMembersService`). The re-asked gate, which DOES draw the
  // reason its predecessor did not land, is `development-unlanded-classes.test.tsx`.
  it('a gate that still awaits, with nothing attempted, reports no outcome on any row', () => {
    renderFrame(
      {
        gate: AWAITING,
        members: [
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
        ],
      },
      fakeActions(),
    );
    expect(screen.queryByText(pra.outcome.notMergedYet)).toBeNull();
    expect(
      within(rowOf(CORE_PR.title)).getByText(en.github.development.ciState.passing),
    ).toBeTruthy();
  });
});

describe('who else sees it (Panels 12w, 12v)', () => {
  it('a bystander sees the port and who it waits on, and no verb — not even Retry', () => {
    renderFrame(
      {
        gate: APPROVED,
        canDecide: false,
        members: [
          {
            subjectVersion: GATEWAY_V,
            pullRequestId: GATEWAY_PR.id,
            queued: false,
            retryable: true,
            exit: null,
            exitAtApprovedHead: false,
            requeueable: false,
            refusal: null,
            retryDecidesGateId: null,
          },
        ],
      },
      fakeActions(),
    );
    expect(within(rowOf(GATEWAY_PR.title)).getByText(pra.outcome.notMergedYet)).toBeTruthy();
    expect(screen.queryByRole('button', { name: pra.outcome.retry })).toBeNull();

    cleanup();
    renderFrame({ gate: AWAITING, canDecide: false }, fakeActions());
    expect(screen.queryByRole('button', { name: pra.verb.approveAndMerge })).toBeNull();
    expect(document.body.textContent).toContain('Mara S.');
  });

  it('a withdrawn gate is state G, naming the pull request whose head a push moved', () => {
    const MOVED_CORE_V = 'moooon/motir-core#131@0000000000000000000000000000000000000001';
    renderFrame(
      {
        gate: {
          ...AWAITING,
          state: 'superseded',
          // The cause the row records (MOTIR-5884): a NULL cause reads as *not recorded*
          // and never borrows one from a moved head (§ 29's cause table).
          supersededCause: 'head_moved',
          subjectVersion: [MOVED_CORE_V, GATEWAY_V].sort().join(','),
        },
      },
      fakeActions(),
    );
    expect(screen.getByText(en.approvalGate.state.withdrawn)).toBeTruthy();
    expect(screen.getByText(fill(pra.withdrawn.port, { pr: CORE_NAME }))).toBeTruthy();
    expect(screen.getByText(pra.withdrawn.portCite)).toBeTruthy();
    expect(screen.queryByRole('button', { name: pra.verb.approveAndMerge })).toBeNull();
  });

  // STATE `G` KEEPS THE RECORD (Bug MOTIR-5884; § 29, Panel 1 — the MOTIR-5604 case). The
  // withdrawal takes the verbs; the rows and How to test stay, beneath the withdrawn band.
  it('a push withdrawal keeps the rows and How to test under the band, with no Expand and no verbs', () => {
    const MOVED_CORE_V = 'moooon/motir-core#131@0000000000000000000000000000000000000001';
    const { container } = renderFrame(
      {
        gate: {
          ...AWAITING,
          state: 'superseded',
          supersededCause: 'head_moved',
          subjectVersion: [MOVED_CORE_V, GATEWAY_V].sort().join(','),
        },
      },
      fakeActions(),
    );
    const band = container.querySelector('[data-withdrawn-band]') as HTMLElement;
    expect(band.getAttribute('role')).toBe('status');
    expect(band.textContent).toContain(fill(pra.withdrawn.port, { pr: CORE_NAME }));
    // Both rows and How to test render — and AFTER the band, which sits above the port.
    const port = screen.getByRole('group', { name: en.approvalGate.port.label });
    expect(within(port).getByText(CORE_PR.title)).toBeTruthy();
    expect(within(port).getByText(GATEWAY_PR.title)).toBeTruthy();
    expect(
      within(port).getByRole('group', { name: en.github.development.howToTest.title }),
    ).toBeTruthy();
    expect(band.compareDocumentPosition(port) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Floorless: nothing is being decided, so no decision surface is held open.
    expect(port.className).toContain('min-h-0');
    expect(port.className).not.toContain('min-h-[12.25rem]');
    expect(screen.queryByRole('button', { name: en.approvalGate.port.expand })).toBeNull();
    expect(screen.queryByRole('button', { name: pra.verb.approveAndMerge })).toBeNull();
    expect(screen.queryByRole('button', { name: en.approvalGate.verb.requestChanges })).toBeNull();
  });

  it('a member closed without merging names it and says unlinking re-asks (Panel 3c)', () => {
    const { container } = render(
      <DevelopmentSectionBody
        pullRequests={[{ ...CORE_PR, state: 'closed' }, GATEWAY_PR]}
        itemIdentifier="ACME-12"
        howToTest={TWO_REPO_STORY}
        mergeGate={{
          canDecide: true,
          routedToLabel: 'Mara S.',
          members: [],
          stamp: null,
          gate: { ...AWAITING, state: 'superseded', supersededCause: 'member_closed' },
        }}
        gateActions={fakeActions()}
      />,
    );
    const band = container.querySelector('[data-withdrawn-band]') as HTMLElement;
    expect(band.textContent).toContain(fill(pra.withdrawn.portClosed, { pr: CORE_NAME }));
    expect(band.textContent).toContain(
      fill(pra.withdrawn.citeUnlink, { pr: CORE_NAME, key: 'ACME-12' }),
    );
    expect(container.textContent).toContain(
      `2 pull requests · ${CORE_NAME} closed without merging`,
    );
    expect(screen.getByText(CORE_PR.title)).toBeTruthy();
  });

  it('on a DONE-category card the cite promises no re-ask, whatever the cause', () => {
    const { container } = render(
      <DevelopmentSectionBody
        pullRequests={[{ ...CORE_PR, state: 'merged' }, GATEWAY_PR]}
        itemIdentifier="ACME-12"
        howToTest={TWO_REPO_STORY}
        cardTerminal
        mergeGate={{
          canDecide: true,
          routedToLabel: 'Mara S.',
          members: [],
          stamp: null,
          gate: { ...AWAITING, state: 'superseded', supersededCause: 'member_closed' },
        }}
        gateActions={fakeActions()}
      />,
    );
    const band = container.querySelector('[data-withdrawn-band]') as HTMLElement;
    expect(band.textContent).toContain(
      fill(pra.withdrawn.portMerged, { pr: CORE_NAME, host: pra.host }),
    );
    expect(band.textContent).toContain(en.approvalGate.withdrawn.portCite);
    expect(band.textContent).not.toContain(pra.withdrawn.portCite);
    expect(container.textContent).toContain(`2 pull requests · ${CORE_NAME} merged on GitHub`);
  });
});

describe('the arms around the press (MOTIR-5486 coverage floor)', () => {
  it('Request changes decides through the door, repaints from the response and presses no merge', async () => {
    const actions = fakeActions({
      decide: vi.fn().mockResolvedValue({
        ok: true,
        gate: { ...AWAITING, state: 'changes_requested', decidedByLabel: 'Ada L.' },
        filesKept: null,
      }),
    });
    renderFrame({ gate: AWAITING }, actions);

    await refuseWithReason();

    await waitFor(() =>
      expect(screen.getByText(en.approvalGate.state.changesRequested)).toBeTruthy(),
    );
    expect(actions.decide).toHaveBeenCalledWith({
      gateId: AWAITING.id,
      decision: 'request_changes',
      identifier: 'ACME-12',
      stamp: 'v1.stamp-on-screen',
      // A refusal SAYS WHY (MOTIR-6075) — the band's reason travels with the press.
      noteMd: 'Needs changes.',
    });
    expect(actions.approveAndMerge).not.toHaveBeenCalled();
    expect(refreshSpy).toHaveBeenCalled();
    // Nothing was merged, so no row reports anything.
    expect(screen.queryByText(pra.outcome.merged)).toBeNull();
  });

  it('an EMPTY Request changes is refused in place and reaches no door (MOTIR-6075)', async () => {
    const actions = fakeActions({ decide: vi.fn() });
    renderFrame({ gate: AWAITING }, actions);

    fireEvent.click(screen.getByRole('button', { name: en.approvalGate.verb.requestChanges }));
    // The pull requests' own words: the commits go back, nothing merges.
    expect(screen.getByText(en.approvalGate.reason.consequence.commitsBack)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: en.approvalGate.reason.proceed }));

    expect(screen.getByText(en.approvalGate.reason.required)).toBeTruthy();
    expect(actions.decide).not.toHaveBeenCalled();
    expect(actions.approveAndMerge).not.toHaveBeenCalled();
  });

  it('a Request changes the door refuses is drawn by the frame, and nothing repaints', async () => {
    const actions = fakeActions({
      decide: vi
        .fn()
        .mockResolvedValue({ ok: false, refusal: { tag: 'APPROVAL_GATE_SUPERSEDED' } }),
    });
    renderFrame({ gate: AWAITING }, actions);

    await refuseWithReason();

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain(
      en.approvalGate.refusal.superseded.title,
    );
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('a member the press found NO merge gate for keeps its row unchanged, CI pill and all', async () => {
    const actions = fakeActions({
      approveAndMerge: vi.fn().mockResolvedValue({
        ok: true,
        gate: APPROVED,
        members: [
          {
            subjectVersion: CORE_V,
            pullRequestId: CORE_PR.id,
            outcome: 'merged',
          },
          {
            subjectVersion: GATEWAY_V,
            pullRequestId: null,
            outcome: 'no_merge_gate',
          },
        ],
      }),
    });
    renderFrame({ gate: AWAITING }, actions);
    await pressApproveAndMerge();

    expect(within(rowOf(CORE_PR.title)).getByText(pra.outcome.merged)).toBeTruthy();
    const gateway = rowOf(GATEWAY_PR.title);
    for (const label of Object.values(pra.outcome)) {
      expect(within(gateway).queryByText(label)).toBeNull();
    }
    // Neither every-merged nor anything-waiting: the record names no reason.
    expect(screen.queryByText(fill(pra.merged.why, { key: 'ACME-12', host: pra.host }))).toBeNull();
  });

  it('every member merged: the record says the card waits on the host, and a merged row empties its slot', async () => {
    const actions = fakeActions({
      approveAndMerge: vi.fn().mockResolvedValue({
        ok: true,
        gate: APPROVED,
        members: [
          {
            subjectVersion: CORE_V,
            pullRequestId: CORE_PR.id,
            outcome: 'merged',
          },
          {
            subjectVersion: GATEWAY_V,
            pullRequestId: GATEWAY_PR.id,
            outcome: 'merged',
          },
        ],
      }),
    });
    render(
      <DevelopmentSectionBody
        // The host already reports the core pull request merged.
        pullRequests={[{ ...CORE_PR, state: 'merged' }, GATEWAY_PR]}
        itemIdentifier="ACME-12"
        manualLinkable
        howToTest={TWO_REPO_STORY}
        mergeGate={{
          gate: AWAITING,
          canDecide: true,
          routedToLabel: 'Mara S.',
          members: [],
          stamp: 'v1.stamp-on-screen',
        }}
        gateActions={actions}
      />,
    );
    await pressApproveAndMerge();

    expect(screen.getByText(fill(pra.merged.why, { key: 'ACME-12', host: pra.host }))).toBeTruthy();
    const core = rowOf(CORE_PR.title);
    // The derived state pill says Merged; the slot adds nothing and the CI pill is gone.
    expect(within(core).getAllByText(en.github.development.prState.merged)).toHaveLength(1);
    expect(within(core).queryByText(en.github.development.ciState.passing)).toBeNull();
    expect(within(rowOf(GATEWAY_PR.title)).getByText(pra.outcome.merged)).toBeTruthy();
  });

  it('an approved member a reload knows nothing pending about reports nothing', () => {
    renderFrame(
      {
        gate: APPROVED,
        members: [
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
        ],
      },
      fakeActions(),
    );
    expect(
      within(rowOf(CORE_PR.title)).getByText(en.github.development.ciState.passing),
    ).toBeTruthy();
    expect(screen.queryByText(pra.outcome.notMergedYet)).toBeNull();
    expect(screen.queryByText(pra.outcome.queued)).toBeNull();
  });

  it('a withdrawal with no moved head says the set changed', () => {
    renderFrame(
      { gate: { ...AWAITING, state: 'superseded', supersededCause: 'set_changed' } },
      fakeActions(),
    );
    expect(screen.getByText(pra.withdrawn.portSet)).toBeTruthy();
  });
});

describe('a STALE press on the item page (Story MOTIR-5232 · Subtask MOTIR-5235)', () => {
  const stale = en.approvalGate.refusal.stale;

  it('refuses in place naming the pull requests, and “Show the current version” re-reads the PAGE — nothing merged', async () => {
    const actions = fakeActions({
      approveAndMerge: vi.fn().mockResolvedValue({
        ok: false,
        refusal: { tag: 'APPROVAL_GATE_STALE_SUBJECT', moved: ['pull_requests'] },
      }),
    });
    refreshSpy.mockClear();
    renderFrame({ gate: AWAITING }, actions);
    fireEvent.click(screen.getByRole('button', { name: pra.verb.approveAndMerge }));
    fireEvent.click(screen.getByRole('button', { name: proceedLabel }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(stale.pullRequests)).toBeTruthy();
    // A refusal repaints nothing on its own…
    expect(refreshSpy).not.toHaveBeenCalled();
    // …and the reader's control re-runs the read this block came from: the page's.
    fireEvent.click(within(alert).getByRole('button', { name: stale.control }));
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(actions.retryMember).not.toHaveBeenCalled();
  });

  it('a fresh stamp from that re-read is a fresh frame: the refusal clears and the verbs return', async () => {
    const actions = fakeActions({
      decide: vi.fn().mockResolvedValue({
        ok: false,
        refusal: { tag: 'APPROVAL_GATE_STALE_SUBJECT', moved: ['criteria'] },
      }),
    });
    const { rerender } = renderFrame({ gate: AWAITING }, actions);
    await refuseWithReason();
    await screen.findByRole('alert');
    rerender(
      <DevelopmentSectionBody
        pullRequests={[CORE_PR, GATEWAY_PR]}
        itemIdentifier="ACME-12"
        manualLinkable
        howToTest={TWO_REPO_STORY}
        mergeGate={{
          gate: AWAITING,
          canDecide: true,
          routedToLabel: 'Mara S.',
          members: [],
          stamp: 'v1.the-current-version',
        }}
        gateActions={actions}
      />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      (
        screen.getByRole('button', {
          name: en.approvalGate.verb.requestChanges,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
});

describe('the remaining frame arms (MOTIR-5486 coverage floor)', () => {
  it('a retry the DOOR refuses keeps the row refused, with that refusal named, and repaints nothing', async () => {
    const actions = fakeActions({
      approveAndMerge: vi.fn().mockResolvedValue({
        ok: true,
        gate: APPROVED,
        members: [
          {
            subjectVersion: CORE_V,
            pullRequestId: CORE_PR.id,
            outcome: 'refused',
            refusal: { tag: 'MERGE_CONFLICT' },
          },
          {
            subjectVersion: GATEWAY_V,
            pullRequestId: GATEWAY_PR.id,
            outcome: 'refused',
            refusal: { tag: 'MERGE_CONFLICT' },
          },
        ],
      }),
      retryMember: vi.fn().mockResolvedValue({
        ok: false,
        refusal: { tag: 'APPROVAL_GATE_NOT_AUTHORISED' },
      }),
    });
    renderFrame({ gate: AWAITING }, actions);
    await pressApproveAndMerge();
    // ⚠️ NOTHING MERGED, SO THE ALERT CLAIMS NOTHING (MOTIR-5834): the *Your approval
    // stands* line is gone — a press that did not land SPENT the approval — and the
    // member's own line is the whole of what the band says.
    const band = screen.getByRole('alert').textContent ?? '';
    expect(band).toContain(fill(pra.refused.title, { pr: CORE_NAME }));
    expect(band).not.toContain('approval stands');
    refreshSpy.mockClear();

    fireEvent.click(within(rowOf(CORE_PR.title)).getByRole('button', { name: pra.outcome.retry }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        en.approvalGate.refusal.notAuthorised.title,
      ),
    );
    expect(within(rowOf(CORE_PR.title)).getByText(pra.outcome.refused)).toBeTruthy();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('band 1 counts the set when no run is named, and after a sending-back', () => {
    render(
      <DevelopmentSectionBody
        pullRequests={[CORE_PR, GATEWAY_PR]}
        itemIdentifier="ACME-12"
        manualLinkable
        mergeGate={{
          gate: { ...AWAITING, state: 'changes_requested' },
          canDecide: true,
          routedToLabel: null,
          members: [],
          stamp: null,
        }}
      />,
    );
    expect(screen.getByText('2 pull requests')).toBeTruthy();
  });
});

// A CONFLICT FOUND BEFORE ANY PRESS (MOTIR-5916; design/github § 30). Panels 1–2: the gate
// was withdrawn with cause `conflict`, the conflicted row carries *Conflicts with {base}*,
// and nothing can be pressed. Panels 5a–5b: the press refusals say nothing was written.
describe('a conflicted pull request — the withdrawn frame and the press (MOTIR-5916)', () => {
  const CONFLICTED_GATEWAY = { ...GATEWAY_PR, ci: 'passing' as const, conflicted: true };
  const WITHDRAWN: ApprovalGateDTO = {
    ...AWAITING,
    state: 'superseded',
    supersededCause: 'conflict',
  };

  function renderWith(
    pullRequests: (typeof CORE_PR)[],
    gate: ApprovalGateDTO,
    actions: DevelopmentGateActions = fakeActions(),
  ) {
    return render(
      <DevelopmentSectionBody
        pullRequests={pullRequests}
        itemIdentifier="ACME-12"
        manualLinkable
        howToTest={TWO_REPO_STORY}
        mergeGate={{
          canDecide: true,
          routedToLabel: 'Mara S.',
          members: [],
          stamp: 'v1.stamp-on-screen',
          gate,
        }}
        gateActions={actions}
      />,
    );
  }

  it('Panel 2: two pull requests, ONE conflicted — the band names it, only its row carries the pill, and no verb is offered', () => {
    const { container } = renderWith([CORE_PR, CONFLICTED_GATEWAY], WITHDRAWN);

    const band = container.querySelector('[data-withdrawn-band]') as HTMLElement;
    expect(band.textContent).toContain(
      fill(pra.withdrawn.portConflict, { pr: GATEWAY_NAME, base: 'main' }),
    );
    expect(band.textContent).toContain(pra.withdrawn.citeConflict);
    expect(
      within(rowOf(GATEWAY_PR.title)).getByText(fill(pra.row.conflicts, { base: 'main' })),
    ).toBeTruthy();
    expect(within(rowOf(CORE_PR.title)).queryByTestId('pr-row-conflict')).toBeNull();
    expect(screen.queryByRole('button', { name: pra.verb.approveAndMerge })).toBeNull();
    expect(screen.queryByRole('button', { name: en.approvalGate.verb.requestChanges })).toBeNull();
  });

  it('Panel 7: a row that never recorded its base reads *its base branch*, on the pill and in the band', () => {
    const { container } = renderWith([{ ...CONFLICTED_GATEWAY, baseRef: null }], {
      ...WITHDRAWN,
      subjectVersion: GATEWAY_V,
    });
    const band = container.querySelector('[data-withdrawn-band]') as HTMLElement;
    expect(band.textContent).toContain(
      fill(pra.withdrawn.portConflictNoBase, { pr: GATEWAY_NAME }),
    );
    expect(within(rowOf(GATEWAY_PR.title)).getByText(pra.row.conflictsNoBase)).toBeTruthy();
  });

  it('Panel 6: `mergeable: null` — an unknown reading — draws nothing new: no pill, the verbs live', () => {
    renderWith([CORE_PR, GATEWAY_PR], AWAITING);
    expect(screen.queryByTestId('pr-row-conflict')).toBeNull();
    expect(screen.getByRole('button', { name: pra.verb.approveAndMerge })).toBeTruthy();
  });

  it('Panel 5a: a press the host refuses as conflicted says nothing was written, and never that the approval was spent', async () => {
    const actions = fakeActions({
      approveAndMerge: vi.fn().mockResolvedValue({
        ok: false,
        refusal: {
          tag: 'MERGE_CONFLICT',
          atPress: true,
          conflicts: [{ pullRequest: 'moooon/motir-gateway#57', baseRef: 'main' }],
        },
      }),
    });
    renderWith([CORE_PR, GATEWAY_PR], AWAITING, actions);

    fireEvent.click(screen.getByRole('button', { name: pra.verb.approveAndMerge }));
    fireEvent.click(screen.getByRole('button', { name: proceedLabel }));
    const alert = await screen.findByRole('alert');

    expect(alert.textContent).toContain(en.approvalGate.refusal.mergeConflict.title);
    expect(alert.textContent).toContain(
      fill(en.approvalGate.refusal.mergeConflict.atPress, {
        host: 'GitHub',
        pr: GATEWAY_NAME,
        base: 'main',
        key: 'ACME-12',
      }),
    );
    expect(alert.textContent).toContain(en.approvalGate.refusal.mergeConflict.next);
    expect(alert.textContent).not.toContain('spent');
  });

  it('Panel 5b: a press on a tab that had not heard the withdrawal reads the cause sentence and the stale-tab line', async () => {
    const actions = fakeActions({
      approveAndMerge: vi.fn().mockResolvedValue({
        ok: false,
        refusal: { tag: 'APPROVAL_GATE_SUPERSEDED', supersedeCause: 'conflict' },
      }),
    });
    renderWith([CORE_PR, GATEWAY_PR], AWAITING, actions);

    fireEvent.click(screen.getByRole('button', { name: pra.verb.approveAndMerge }));
    fireEvent.click(screen.getByRole('button', { name: proceedLabel }));
    const alert = await screen.findByRole('alert');

    expect(alert.textContent).toContain(en.approvalGate.withdrawn.cause.conflict);
    expect(alert.textContent).toContain(
      fill(en.approvalGate.refusal.superseded.staleTab, { key: 'ACME-12' }),
    );
  });
});

describe('a conflicted pull request — in zh (MOTIR-5916)', () => {
  it('Panel 2 in zh: the band and the pill use the zh catalog', async () => {
    const zh = (await import('@/messages/zh.json')).default;
    const zpra = zh.approvalGate.pullRequestApproval;
    const { container } = render(
      <DevelopmentSectionBody
        pullRequests={[CORE_PR, { ...GATEWAY_PR, ci: 'passing', conflicted: true }]}
        itemIdentifier="ACME-12"
        manualLinkable
        howToTest={TWO_REPO_STORY}
        mergeGate={{
          canDecide: true,
          routedToLabel: 'Mara S.',
          members: [],
          stamp: 'v1.stamp-on-screen',
          gate: { ...AWAITING, state: 'superseded', supersededCause: 'conflict' },
        }}
        gateActions={fakeActions()}
      />,
      { locale: 'zh', messages: zh },
    );
    const band = container.querySelector('[data-withdrawn-band]') as HTMLElement;
    expect(band.textContent).toContain(
      fill(zpra.withdrawn.portConflict, { pr: GATEWAY_NAME, base: 'main' }),
    );
    expect(screen.getByText(fill(zpra.row.conflicts, { base: 'main' }))).toBeTruthy();
  });
});

// THE DONE CARD'S APPROVAL RECORD (MOTIR-10338; design § 32.9) — the review it stood on.
describe('the approved frame names the review the merge stood on', () => {
  it('draws the record line in the record strip, from the approved version', () => {
    renderFrame(
      {
        gate: APPROVED,
        approvedReview: { kind: 'reviewed', commits: 'moooon/motir-core#131 @ 3f2a91c' },
      },
      fakeActions(),
    );
    const line = screen.getByTestId('approval-review-line');
    expect(line.textContent).toBe(
      'Approved by Ada L. · reviewed by agent at moooon/motir-core#131 @ 3f2a91c',
    );
  });

  it('draws no line when the read carries none, nor on a gate still awaiting', () => {
    renderFrame({ gate: APPROVED }, fakeActions());
    expect(screen.queryByTestId('approval-review-line')).toBeNull();
    cleanup();
    renderFrame({ gate: AWAITING, approvedReview: { kind: 'none' } }, fakeActions());
    expect(screen.queryByTestId('approval-review-line')).toBeNull();
  });
});
