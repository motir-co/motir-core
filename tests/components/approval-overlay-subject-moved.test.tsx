// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { ApprovalGateOverlayReadDTO } from '@/lib/dto/approvalGate';

// THE OPEN APPROVAL LEARNS ITS SUBJECT MOVED (Story MOTIR-5238 · Subtask
// MOTIR-5243) — the case the requester singled out, and four properties that a
// test rendering once cannot see:
//
//   · IT OPENS NO CONNECTION. The host holds the one stream; this surface reads
//     the context. Asserted against the `fetch` COUNT to the stream URL.
//   · IT DISCRIMINATES. A frame says a TAB moved, which is mostly other people's
//     rows. Only a change to THIS gate may produce the notice — and the answer
//     comes from the server's stamp comparison, never from anything parsed here.
//   · THE PORT IS NOT TOUCHED. The rendered design is byte-identical before and
//     after the notice appears; the probe's read is never applied.
//   · IT IS NOT A GATE. Approve stays live, because the stamp is the guarantee
//     and a notice can be missed.

const { shallowPush, refresh, push } = vi.hoisted(() => ({
  shallowPush: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
}));
let params = new URLSearchParams('approval=MOTIR-5147&approvalKind=design_result');
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push }),
  usePathname: () => '/workbench',
  useSearchParams: () => params,
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));
vi.mock('@/lib/approvals/decidedGates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/approvals/decidedGates')>()),
}));

const { ApprovalOverlay } = await import('@/components/approvals/ApprovalOverlay');
const { WorkbenchLive } = await import('../../app/(authed)/workbench/_components/WorkbenchLive');
const { WORKBENCH_STREAM_PATH } =
  await import('../../app/(authed)/workbench/_components/useWorkbenchLive');

// ⚠️ THE PORT'S ANCHOR IS THE COMMIT, NOT THE NOTE. `DesignResultPanel` renders
// `commitSha.slice(0, 7)` and deliberately does NOT render `noteMd` ("it is not
// rendered, so it is nothing to look at"), so the note would have been a text
// this surface never shows — an assertion that passes for the wrong reason.
const RENDERED_COMMIT = '9840d00';
const NEWER_COMMIT = 'fffffff';

function read(over: Partial<ApprovalGateOverlayReadDTO> = {}): ApprovalGateOverlayReadDTO {
  return {
    workItem: {
      id: 'wi-1',
      identifier: 'MOTIR-5147',
      title: 'Design — the row',
      status: 'in_review',
      parentIdentifier: null,
    },
    statuses: [],
    gate: {
      id: 'gate-1',
      workItemId: 'wi-1',
      kind: 'design_result',
      state: 'awaiting',
      subjectId: 'ev-1',
      subjectVersion: '9840d00ea1b2',
      decidedAt: null,
      decidedByLabel: null,
      noteMd: null,
      createdAt: new Date().toISOString(),
      outcomeRef: null,
    },
    canDecide: true,
    routedToLabel: 'Mara S.',
    stamp: 'v1.aaa.bbb.ccc',
    movedSince: [],
    subject: {
      state: 'resolved',
      kind: 'design_result',
      evidence: {
        id: 'ev-1',
        workItemId: 'wi-1',
        commitSha: '9840d00ea1b2',
        noteMd: null,
        producedByKey: 'MOTIR-5147',
        createdAt: new Date().toISOString(),
        // ⚠️ A REAL MOCK ASSET, because an evidence with none makes the port
        // report `failed` and the frame then WITHHOLDS its verbs (state `X`) —
        // which would make the *Approve is still live* assertion below pass for
        // a reason that has nothing to do with this card.
        assets: [
          {
            id: 'asset-1',
            kind: 'mock',
            url: '/api/attachments/asset-1/content',
            mimeType: 'text/html',
            sizeBytes: 1024,
            sourcePath: 'design/workbench/workbench--live.mock.html',
            position: 0,
          },
        ],
      },
      filesKept: true,
    },
    ...over,
  } as ApprovalGateOverlayReadDTO;
}

/** The overlay's own read, plus a controllable stream for the host above it. */
function harness(reads: ApprovalGateOverlayReadDTO[]) {
  const calls: string[] = [];
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  let next = 0;
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes(WORKBENCH_STREAM_PATH)) {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          streamController = c;
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }
    const body = reads[Math.min(next, reads.length - 1)]!;
    next += 1;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    async nudge(moved: string[]) {
      await act(async () => {
        streamController?.enqueue(
          encoder.encode(
            `event: watermark\ndata: ${JSON.stringify({ moved, cursor: `w1.${moved.join('')}` })}\n\n`,
          ),
        );
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    gateReadCount: () => calls.filter((u) => u.includes('/api/work-items/approval-gate')).length,
    lastGateRead: () => calls.filter((u) => u.includes('/api/work-items/approval-gate')).at(-1)!,
  };
}

async function mount() {
  await act(async () => {
    renderWithIntl(
      <WorkbenchLive>
        <ApprovalOverlay />
      </WorkbenchLive>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  params = new URLSearchParams('approval=MOTIR-5147&approvalKind=design_result');
  refresh.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('it opens NO connection of its own', () => {
  it('reads the host signal — the stream is fetched exactly once with the overlay open', async () => {
    const h = harness([read()]);
    await mount();

    expect(h.calls.filter((u) => u.includes(WORKBENCH_STREAM_PATH))).toHaveLength(1);
    expect(screen.getByText(RENDERED_COMMIT)).toBeTruthy();
  });
});

describe('the DISCRIMINATION — a tab moving is not this gate moving', () => {
  it('says NOTHING when the probe reports nothing moved', async () => {
    const h = harness([read(), read({ movedSince: [] })]);
    await mount();

    await h.nudge(['approvals']);

    expect(screen.queryByTestId('approval-subject-moved')).toBeNull();
    // It DID ask — the discrimination is the server's answer, not a guess here.
    expect(h.gateReadCount()).toBe(2);
    expect(h.lastGateRead()).toContain('since=v1.aaa.bbb.ccc');
  });

  it('draws the notice, naming what moved, when the probe reports a change', async () => {
    const h = harness([read(), read({ movedSince: ['subject'] })]);
    await mount();

    await h.nudge(['approvals']);

    const notice = screen.getByTestId('approval-subject-moved');
    expect(notice.textContent).toContain('the published version');
    expect(notice.textContent).toContain('changed since you opened this');
    expect(notice.textContent).toContain('Approving now would be refused');
  });

  it('an ACCEPTANCE question draws the same notice — the mechanism is the frame\u2019s, not the design\u2019s (MOTIR-5792)', async () => {
    // The acceptance arm mounts its own `ApprovalGateControl` with its own alert slot, so
    // the notice is a separate line of code from the design arm's and is asserted here
    // rather than assumed to follow. A receipt is FROZEN on approval rather than pinned,
    // which is why its frame passes `filesKept={null}` — but nothing about the moved
    // notice differs.
    const RECEIPT = {
      id: 'ae-1',
      workItemId: 'wi-1',
      status: 'pending',
      videoUrl: 'https://blob.example/run.webm',
      mimeType: 'video/webm',
      sizeBytes: 1024,
      traceUrl: null,
      chapters: [{ label: 'Open the story', tSeconds: 0 }],
      commitSha: '9840d00ea1b2',
      ciRunUrl: null,
      producedByKey: 'MOTIR-5792',
      approvedById: null,
      approvedAt: null,
      createdAt: new Date().toISOString(),
    };
    const acceptance = (over: Partial<ApprovalGateOverlayReadDTO> = {}) => {
      const base = read(over);
      return {
        ...base,
        gate: { ...base.gate, kind: 'acceptance_result', subjectId: 'ae-1' },
        subject: { state: 'resolved', kind: 'acceptance_result', evidence: RECEIPT },
      } as ApprovalGateOverlayReadDTO;
    };
    const h = harness([acceptance(), acceptance({ movedSince: ['subject'] })]);
    await mount();

    await h.nudge(['approvals']);

    const notice = screen.getByTestId('approval-subject-moved');
    expect(notice.textContent).toContain('changed since you opened this');
    // The recording is still the port beneath it.
    expect(screen.getByRole('button', { name: /Open the story/ })).toBeTruthy();

    // …and *Show the current version* is the reader's OWN act, which re-reads rather
    // than deciding anything — the acceptance arm's own handler, not the design arm's.
    const before = h.gateReadCount();
    await act(async () => {
      fireEvent.click(within(notice).getByRole('button', { name: 'Show the current version' }));
    });
    expect(h.gateReadCount()).toBeGreaterThan(before);
  });

  it('a CHOICE draws the same notice, and its own Show the current version re-reads (MOTIR-5896)', async () => {
    // The choice arm mounts its own frame with its own alert slot, like the acceptance
    // arm above — so its notice and its re-read are asserted, not assumed to follow.
    params = new URLSearchParams('approval=MOTIR-5147&approvalKind=decision_choice');
    const choice = (over: Partial<ApprovalGateOverlayReadDTO> = {}) => {
      const base = read(over);
      return {
        ...base,
        gate: { ...base.gate, kind: 'decision_choice', subjectId: 'wi-1', chosenOption: null },
        subject: {
          state: 'resolved',
          kind: 'decision_choice',
          choice: {
            question: 'Where do exports live?',
            why: { situation: 'two_workflows', youSaid: null, evidenceMd: '' },
            options: [
              { id: 'a', label: 'Option A', bestFor: 'less to operate', whyMd: '' },
              { id: 'b', label: 'Option B', bestFor: 'more cost-effective', whyMd: '' },
            ],
            followUpMd: 'Next.',
            subjectVersion: 'a'.repeat(64),
          },
        },
      } as ApprovalGateOverlayReadDTO;
    };
    const h = harness([choice(), choice({ movedSince: ['subject'] })]);
    await mount();

    await h.nudge(['approvals']);

    const notice = screen.getByTestId('approval-subject-moved');
    expect(notice.textContent).toContain('changed since you opened this');
    expect(screen.getByText('Option A')).toBeTruthy();

    const before = h.gateReadCount();
    await act(async () => {
      fireEvent.click(within(notice).getByRole('button', { name: 'Show the current version' }));
    });
    expect(h.gateReadCount()).toBeGreaterThan(before);
  });

  it('a DECISION to confirm draws the same notice, and its own Show the current version re-reads (MOTIR-5960)', async () => {
    // The confirm arm mounts its own frame with its own alert slot, as the choice arm
    // does — so its notice and its re-read are asserted, not assumed to follow.
    params = new URLSearchParams('approval=MOTIR-5147&approvalKind=decision_confirmation');
    const confirm = (over: Partial<ApprovalGateOverlayReadDTO> = {}) => {
      const base = read(over);
      return {
        ...base,
        gate: { ...base.gate, kind: 'decision_confirmation', subjectId: 'wi-1' },
        subject: {
          state: 'resolved',
          kind: 'decision_confirmation',
          confirm: {
            decisionMd: 'Exports move to a bucket.',
            changes: ['workflow'],
            whatChangedMd: 'Before and after.',
            supersedes: ['MOTIR-6'],
            supersedesMd: 'MOTIR-6',
            resultingDirectionMd: 'Bucket.',
            subjectVersion: 'a'.repeat(64),
            workItemRefs: {},
            record: { kind: 'none' },
            recordCount: 0,
            presentRecordIds: [],
            supersedesItems: [{ key: 'MOTIR-6', title: null }],
            epic: null,
          },
        },
      } as ApprovalGateOverlayReadDTO;
    };
    const h = harness([confirm(), confirm({ movedSince: ['subject'] })]);
    await mount();

    await h.nudge(['approvals']);

    const notice = screen.getByTestId('approval-subject-moved');
    expect(notice.textContent).toContain('changed since you opened this');
    expect(screen.getByText('Exports move to a bucket.')).toBeTruthy();

    const before = h.gateReadCount();
    await act(async () => {
      fireEvent.click(within(notice).getByRole('button', { name: 'Show the current version' }));
    });
    expect(h.gateReadCount()).toBeGreaterThan(before);
  });

  it('a MANUAL-WORK question draws the same notice, and its own Show the current version re-reads (MOTIR-7478)', async () => {
    params = new URLSearchParams('approval=MOTIR-5147&approvalKind=manual_work');
    const manual = (over: Partial<ApprovalGateOverlayReadDTO> = {}) => {
      const base = read(over);
      return {
        ...base,
        gate: { ...base.gate, kind: 'manual_work', subjectId: 'wi-1', subjectVersion: null },
        subject: {
          state: 'resolved',
          kind: 'manual_work',
          manualWork: {
            todos: [],
            progress: { done: 0, total: 0 },
            mergeWritesDone: false,
            workItemRefs: {},
          },
        },
      } as ApprovalGateOverlayReadDTO;
    };
    const h = harness([manual(), manual({ movedSince: ['subject'] })]);
    await mount();

    await h.nudge(['approvals']);

    const notice = screen.getByTestId('approval-subject-moved');
    expect(notice.textContent).toContain('changed since you opened this');

    const before = h.gateReadCount();
    await act(async () => {
      fireEvent.click(within(notice).getByRole('button', { name: 'Show the current version' }));
    });
    expect(h.gateReadCount()).toBeGreaterThan(before);
  });

  it('names SEVERAL things when several moved', async () => {
    const h = harness([read(), read({ movedSince: ['subject', 'criteria'] })]);
    await mount();
    await h.nudge(['approvals']);

    const notice = screen.getByTestId('approval-subject-moved');
    expect(notice.textContent).toContain('the published version');
    expect(notice.textContent).toContain('the acceptance criteria');
  });

  it('does not probe at all until a nudge arrives', async () => {
    const h = harness([read()]);
    await mount();
    expect(h.gateReadCount()).toBe(1);
  });
});

describe('the PORT is not touched, and the verbs are not withheld', () => {
  it('leaves the rendered design exactly as it was, and keeps Approve live', async () => {
    const h = harness([
      read(),
      // The probe's read carries DIFFERENT bytes. They must never reach the screen.
      read({
        movedSince: ['subject'],
        subject: {
          state: 'resolved',
          kind: 'design_result',
          evidence: {
            id: 'ev-2',
            workItemId: 'wi-1',
            commitSha: 'fffffffffffff',
            noteMd: null,
            producedByKey: 'MOTIR-5147',
            createdAt: new Date().toISOString(),
            assets: [
              {
                id: 'asset-2',
                kind: 'mock',
                url: '/api/attachments/asset-2/content',
                mimeType: 'text/html',
                sizeBytes: 1024,
                sourcePath: 'design/workbench/workbench--live.mock.html',
                position: 0,
              },
            ],
          },
          filesKept: true,
        },
      } as Partial<ApprovalGateOverlayReadDTO>),
    ]);
    await mount();
    await h.nudge(['approvals']);

    expect(screen.getByTestId('approval-subject-moved')).toBeTruthy();
    // ⚠️ THE ONE OUTCOME THE DESIGN FORBIDS OUTRIGHT: the reader's screen
    // changing under them. *Show the current version* is their own act.
    expect(screen.getByText(RENDERED_COMMIT)).toBeTruthy();
    expect(screen.queryByText(NEWER_COMMIT)).toBeNull();

    // ⚠️ AND APPROVE IS STILL LIVE. The stamp refuses a stale press; this notice
    // only moves the knowledge earlier. Disabling the verb would make a notice
    // that can be missed look like the precondition.
    const approve = screen.getByRole('button', { name: /approve/i });
    expect(approve.hasAttribute('disabled')).toBe(false);
  });
});

describe('it does not stack', () => {
  it('a second, different move REPLACES the notice rather than adding one', async () => {
    const h = harness([
      read(),
      read({ movedSince: ['subject'] }),
      read({ movedSince: ['criteria'] }),
    ]);
    await mount();

    await h.nudge(['approvals']);
    expect(screen.getAllByTestId('approval-subject-moved')).toHaveLength(1);

    await h.nudge(['approvals']);
    const notices = screen.getAllByTestId('approval-subject-moved');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.textContent).toContain('the acceptance criteria');
  });
});
