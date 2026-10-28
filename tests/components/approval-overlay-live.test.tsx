// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import type { ApprovalGateDTO, ApprovalGateOverlayReadDTO } from '@/lib/dto/approvalGate';
import type { LiveSignalListener, LiveSignalSource } from '@/lib/live/liveSignal';
import { createLiveFlag } from '@/lib/live/liveFlag';

// THE OPEN APPROVAL READS THE SEAM (Story MOTIR-8539 · Subtask MOTIR-8577).
//
// A `workbench` signal from the seam is the only thing that makes the open
// approval look again, and what it does is ONE probe of the gate it holds, carrying
// the held stamp — never a refresh, never a re-render of the port. These cases are
// driven by a fake source through `LiveSignalProvider`, so each signal is one the
// test fires, and each probe is held open until the test answers it:
//
//   · a signal with a held stamp is ONE probe with that stamp; with none, nothing;
//   · a burst during a probe costs ONE more probe after it settles, not one each;
//   · an equal answer changes nothing, a different one updates the notice in place;
//   · the port is not touched, and the reader's scroll, selection, focus and
//     half-typed refusal reason survive the signal and the notice;
//   · an answer for an address or a stamp the reader has left is dropped.

let params = new URLSearchParams();
let pathname = '/workbench';
const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => pathname,
  useSearchParams: () => params,
}));

const { shallowPush } = vi.hoisted(() => ({ shallowPush: vi.fn() }));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

const { fetchApprovalGateOverlay } = vi.hoisted(() => ({ fetchApprovalGateOverlay: vi.fn() }));
vi.mock('@/lib/approvals/approvalOverlayClient', () => ({ fetchApprovalGateOverlay }));

const { decideApprovalGateAction, approveAndMergeAction, retryApproveAndMergeMemberAction } =
  vi.hoisted(() => ({
    decideApprovalGateAction: vi.fn(),
    approveAndMergeAction: vi.fn(),
    retryApproveAndMergeMemberAction: vi.fn(),
  }));
vi.mock('@/app/(authed)/items/[key]/approvalGateActions', () => ({
  decideApprovalGateAction,
  approveAndMergeAction,
  retryApproveAndMergeMemberAction,
}));

const { announceGateDecided } = vi.hoisted(() => ({ announceGateDecided: vi.fn() }));
vi.mock('@/lib/approvals/decidedGates', () => ({
  announceGateDecided,
  // Read only by the item page's hand-over (MOTIR-6323); no announcement reaches it here.
  useDecidedGate: () => null,
  // The press-in-flight mark (MOTIR-9696) has nothing to tell a list here.
  markGatePressPending: () => {},
  clearGatePressPending: () => {},
  useGatePressPending: () => false,
}));

// The design port has its OWN suite (`design-result-panel.test.ts`); here it
// stands in for itself so every assertion is about the OVERLAY.
vi.mock('@/app/(authed)/items/[key]/_components/DesignResultPanel', () => ({
  DesignResultPanel: ({ evidence }: { evidence: { id: string } | null }) => (
    <div data-testid="design-port" data-evidence={evidence?.id ?? ''} />
  ),
}));

const { ApprovalOverlay } = await import('@/components/approvals/ApprovalOverlay');
const { LiveSignalProvider } = await import('@/lib/live/liveSignal');

const GATE: ApprovalGateDTO = {
  id: 'gate-1',
  workItemId: 'wi-1',
  kind: 'design_result',
  subjectId: 'ev-1',
  state: 'awaiting',
  decidedById: null,
  decidedAt: null,
  noteMd: null,
  supersededCause: null,
  subjectVersion: '9840d00ea1b2',
  decidedByLabel: null,
  routedToId: 'user-2',
  decidedUnderAuthority: null,
  decisionSource: null,
  outcomeRef: null,
  confirmedRecord: null,
  refusalVerdict: null,
  offersRefusalVerdict: false,
  replanOwed: null,
  chosenOption: null,
  createdAt: '2026-09-08T04:00:00.000Z',
  updatedAt: '2026-09-08T04:00:00.000Z',
};

function readOf(overrides: Partial<ApprovalGateOverlayReadDTO> = {}): ApprovalGateOverlayReadDTO {
  return {
    workItem: {
      id: 'wi-1',
      identifier: 'GATE-1',
      title: 'Draw the row for a published design',
      status: 'in_review',
      parentIdentifier: null,
    },
    statuses: [],
    gate: GATE,
    canDecide: true,
    canReplan: false,
    routedToLabel: 'Riley Reviewer',
    stamp: 'v1.stamp-the-read-handed-over',
    // NOTHING HAS MOVED since this reader opened it (Story MOTIR-5238 · MOTIR-5243).
    // The field is REQUIRED rather than optional so a read that forgot to answer
    // *what changed?* is a compile error and not a silent empty notice.
    movedSince: [],
    earlierApproval: null,
    subject: {
      state: 'resolved',
      kind: 'design_result',
      evidence: { id: 'ev-1' } as never,
      filesKept: false,
    },
    ...overrides,
  };
}

function openAt(key: string, kind: string) {
  pathname = '/workbench';
  params = new URLSearchParams(`tab=approvals&approval=${key}&approvalKind=${kind}`);
}

function fakeSource() {
  const listeners = new Set<LiveSignalListener>();
  let seq = 0;
  const source: LiveSignalSource = {
    subscribe(topic, onSignal) {
      if (topic.kind !== 'workbench') return () => {};
      listeners.add(onSignal);
      return () => listeners.delete(onSignal);
    },
    reconnecting: createLiveFlag(false),
  };
  return {
    source,
    listening: () => listeners.size,
    async fire(times = 1) {
      await act(async () => {
        for (let i = 0; i < times; i += 1) {
          seq += 1;
          for (const l of [...listeners]) l({ topic: { kind: 'workbench' }, seq, moved: [] });
        }
      });
    },
  };
}

/**
 * The overlay's reads: the LOAD (no `since`) answers at once with `first`; every
 * PROBE (a `since` stamp) waits in `probes` until the test answers it.
 */
function reads(first: ApprovalGateOverlayReadDTO) {
  const probes: {
    args: unknown[];
    answer: (read: ApprovalGateOverlayReadDTO | null) => Promise<void>;
    fail: () => Promise<void>;
  }[] = [];
  fetchApprovalGateOverlay.mockImplementation((...args: unknown[]) => {
    if (args[3] === undefined) return Promise.resolve(first);
    return new Promise((resolve, reject) => {
      probes.push({
        args,
        answer: async (read) => {
          await act(async () => {
            resolve(read);
          });
          await act(async () => {});
        },
        fail: async () => {
          await act(async () => {
            reject(new Error('offline'));
          });
          await act(async () => {});
        },
      });
    });
  });
  return probes;
}

async function mount(fake: ReturnType<typeof fakeSource>) {
  const utils = render(
    <LiveSignalProvider source={fake.source}>
      <ApprovalOverlay />
    </LiveSignalProvider>,
  );
  await act(async () => {});
  return utils;
}

function observe(target: Node) {
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((r) => records.push(...r));
  observer.observe(target, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  return {
    records,
    stop: () => {
      records.push(...observer.takeRecords());
      observer.disconnect();
    },
  };
}

const STAMP = 'v1.stamp-the-read-handed-over';

beforeEach(() => {
  openAt('GATE-1', 'design_result');
  fetchApprovalGateOverlay.mockReset();
  decideApprovalGateAction.mockReset();
  announceGateDecided.mockReset();
  shallowPush.mockReset();
  push.mockReset();
  refresh.mockReset();
});

afterEach(cleanup);

describe('a signal is ONE probe of the held gate, carrying the held stamp', () => {
  it('probes once with the stamp, and refreshes nothing', async () => {
    const probes = reads(readOf());
    const fake = fakeSource();
    await mount(fake);

    await fake.fire();
    expect(probes).toHaveLength(1);
    expect(probes[0]!.args[0]).toBe('GATE-1');
    expect(probes[0]!.args[1]).toBe('design_result');
    expect(probes[0]!.args[3]).toBe(STAMP);
    await probes[0]!.answer(readOf());
    expect(refresh).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('with no held stamp — nothing on screen yet — a signal probes nothing', async () => {
    const fake = fakeSource();
    // The load never answers, so there is no stamp to compare against.
    fetchApprovalGateOverlay.mockImplementation(() => new Promise(() => {}));
    await mount(fake);

    await fake.fire(3);
    expect(fetchApprovalGateOverlay).toHaveBeenCalledTimes(1);
    expect(fake.listening()).toBe(0);
  });
});

describe('a burst costs one probe in flight plus ONE more', () => {
  it('ten signals during one probe produce exactly one further probe', async () => {
    const probes = reads(readOf());
    const fake = fakeSource();
    await mount(fake);

    await fake.fire();
    await fake.fire(10);
    expect(probes).toHaveLength(1);

    await probes[0]!.answer(readOf());
    expect(probes).toHaveLength(2);
    await probes[1]!.answer(readOf());
    expect(probes).toHaveLength(2);
  });

  it('a failed probe changes nothing and the next signal probes again', async () => {
    const probes = reads(readOf());
    const fake = fakeSource();
    await mount(fake);

    await fake.fire();
    await probes[0]!.fail();
    expect(screen.queryByTestId('approval-subject-moved')).toBeNull();
    await fake.fire();
    expect(probes).toHaveLength(2);
  });
});

describe('the notice is a set, applied apart from the port', () => {
  it('a different answer draws the notice, a second updates it, an equal one changes nothing', async () => {
    const probes = reads(readOf());
    const fake = fakeSource();
    await mount(fake);
    const dialog = screen.getByRole('dialog');

    await fake.fire();
    await probes[0]!.answer(readOf({ movedSince: ['subject'] }));
    expect(screen.getAllByTestId('approval-subject-moved')).toHaveLength(1);

    await fake.fire();
    await probes[1]!.answer(readOf({ movedSince: ['subject', 'criteria'] }));
    // Updated in place — never a second notice.
    expect(screen.getAllByTestId('approval-subject-moved')).toHaveLength(1);

    const seen = observe(dialog);
    await fake.fire();
    await probes[2]!.answer(readOf({ movedSince: ['subject', 'criteria'] }));
    seen.stop();
    expect(seen.records).toHaveLength(0);
  });

  it('the port is not touched while the notice appears, and Approve stays live', async () => {
    const probes = reads(readOf());
    const fake = fakeSource();
    await mount(fake);
    const port = screen.getByTestId('design-port');

    const seen = observe(port);
    await fake.fire();
    await probes[0]!.answer(
      readOf({
        movedSince: ['subject'],
        subject: {
          state: 'resolved',
          kind: 'design_result',
          evidence: { id: 'ev-2' } as never,
          filesKept: false,
        },
      }),
    );
    seen.stop();

    expect(screen.getByTestId('approval-subject-moved')).toBeTruthy();
    expect(screen.getByTestId('design-port')).toBe(port);
    // The probe's newer subject was NOT applied: the port still renders the held one.
    expect(port.dataset['evidence']).toBe('ev-1');
    expect(seen.records).toHaveLength(0);
    const approve = screen.getByRole('button', { name: en.approvalGate.verb.approve });
    expect((approve as HTMLButtonElement).disabled).toBe(false);
  });
  // The WITHDRAWN branch (a held approve-to-merge gate superseded for a conflict) is
  // driven through the same probe by `approve-to-merge-overlay-conflict-live.test.tsx`.
});

describe('the reader keeps their place', () => {
  it('scroll, selection, focus and a half-typed refusal reason survive a signal and the notice', async () => {
    const probes = reads(readOf());
    const fake = fakeSource();
    await mount(fake);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.approvalGate.verb.requestChanges }));
    });
    const reason = screen.getByLabelText(en.approvalGate.reason.label) as HTMLTextAreaElement;
    fireEvent.change(reason, { target: { value: 'The empty state needs' } });
    reason.focus();
    reason.setSelectionRange(4, 9);
    const scroller = screen.getByTestId('design-port').parentElement!;
    scroller.scrollTop = 120;

    await fake.fire();
    await probes[0]!.answer(readOf({ movedSince: ['subject'] }));

    expect(screen.getByTestId('approval-subject-moved')).toBeTruthy();
    expect(screen.getByLabelText(en.approvalGate.reason.label)).toBe(reason);
    expect(reason.value).toBe('The empty state needs');
    expect(document.activeElement).toBe(reason);
    expect([reason.selectionStart, reason.selectionEnd]).toEqual([4, 9]);
    expect(scroller.scrollTop).toBe(120);
  });
});

describe('an answer for a view the reader has left is dropped', () => {
  it('a probe answering after the address moved draws nothing', async () => {
    const probes = reads(readOf());
    const fake = fakeSource();
    const view = await mount(fake);

    await fake.fire();
    expect(probes).toHaveLength(1);
    // The reader opens a different approval while the probe is out.
    openAt('GATE-2', 'design_result');
    fetchApprovalGateOverlay.mockImplementation((...args: unknown[]) =>
      args[3] === undefined
        ? Promise.resolve(readOf({ workItem: { ...readOf().workItem, identifier: 'GATE-2' } }))
        : new Promise(() => {}),
    );
    view.rerender(
      <LiveSignalProvider source={fake.source}>
        <ApprovalOverlay />
      </LiveSignalProvider>,
    );
    await act(async () => {});

    await probes[0]!.answer(readOf({ movedSince: ['subject'] }));
    expect(screen.queryByTestId('approval-subject-moved')).toBeNull();
  });

  it('a probe answering after the stamp was replaced draws nothing', async () => {
    const probes = reads(readOf());
    const fake = fakeSource();
    await mount(fake);

    await fake.fire();
    await probes[0]!.answer(readOf({ movedSince: ['subject'] }));
    // A second probe is out when the reader takes *Show the current version*.
    await fake.fire();
    expect(probes).toHaveLength(2);
    fetchApprovalGateOverlay.mockImplementation((...args: unknown[]) =>
      args[3] === undefined
        ? Promise.resolve(readOf({ stamp: 'v1.newer' }))
        : new Promise(() => {}),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.approvalGate.refusal.stale.control }));
    });
    await act(async () => {});
    expect(screen.queryByTestId('approval-subject-moved')).toBeNull();

    await probes[1]!.answer(readOf({ movedSince: ['criteria'] }));
    expect(screen.queryByTestId('approval-subject-moved')).toBeNull();
  });
});
