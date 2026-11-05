// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import type {
  DevelopmentGateActions,
  DevelopmentGateRead,
} from '@/components/github/DevelopmentGateFrame';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';
import type { GateReviewPathDTO, ReviewLineDTO } from '@/lib/dto/reviewState';
import { AWAITING_MERGE_GATE, CORE_PR, GATEWAY_PR, recordDto } from '../helpers/howToTestFixtures';

// THE REVIEW PATH IN THE DEVELOPMENT FRAME (Story MOTIR-10327 · MOTIR-10342;
// `design/github/design-notes.md` § 32.4, § 32.6, § 32.8, mock G1–G7) — the real block,
// with the read model's `reviewPath` handed in as the item page hands it: the review line on
// the awaiting approve-and-merge frame at the current version, the author note for the
// routed author of every pull request, and the gate-off send-back's Sent back band with
// Dismiss the review for the routed person only.

const { refreshSpy } = vi.hoisted(() => ({ refreshSpy: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const CORE_V = `moooon/motir-core#131@${'3f2a91c0'.padEnd(40, '0')}`;
const GATEWAY_V = `moooon/motir-gateway#57@${'aa11bb20'.padEnd(40, '0')}`;
const VERSION = [CORE_V, GATEWAY_V].sort().join(',');
const AWAITING: ApprovalGateDTO = { ...AWAITING_MERGE_GATE, subjectVersion: VERSION };

const NOT_REVIEWED: ReviewLineDTO = {
  value: 'not_reviewed',
  actor: null,
  reason: null,
  reviewer: null,
  at: null,
  githubApprovals: [],
  lastReviewedVersion: null,
  lastReviewedRef: null,
  command: 'motir review ACME-12',
};

function path(over: Partial<GateReviewPathDTO> = {}): GateReviewPathDTO {
  return {
    identifier: 'ACME-12',
    currentVersion: VERSION,
    line: NOT_REVIEWED,
    recordRef: null,
    viewerIsRouted: false,
    authorOfEveryPr: false,
    sentBackRecord: null,
    ...over,
  };
}

function renderFrame(read: Partial<DevelopmentGateRead> & { gate: ApprovalGateDTO }) {
  return render(
    <DevelopmentSectionBody
      pullRequests={[CORE_PR, GATEWAY_PR]}
      itemIdentifier="ACME-12"
      manualLinkable
      howToTest={recordDto()}
      mergeGate={{
        canDecide: true,
        routedToLabel: 'Mara S.',
        members: [],
        stamp: 'v1.stamp-on-screen',
        ...read,
      }}
      gateActions={
        {
          decide: vi.fn(),
          approveAndMerge: vi.fn(),
          retryMember: vi.fn(),
        } as never as DevelopmentGateActions
      }
    />,
  );
}

const line = () => document.querySelector('[data-review-line]');
const authorNote = en.approvalGate.reviewPath.authorNote;
const dismiss = en.approvalGate.reviewPath.dismiss;

describe('the review line and the author note', () => {
  it('draws the line on the awaiting frame at the current version, and the note for the routed author', () => {
    renderFrame({
      gate: AWAITING,
      reviewPath: path({ viewerIsRouted: true, authorOfEveryPr: true }),
    });
    expect(line()?.getAttribute('data-review-line')).toBe('not_reviewed');
    expect(screen.getByRole('note').textContent).toContain(authorNote.title);
  });

  it('no note when the reader is not the routed person, or not the author of every pull request', () => {
    renderFrame({ gate: AWAITING, reviewPath: path({ authorOfEveryPr: true }) });
    expect(line()).not.toBeNull();
    expect(screen.queryByText(authorNote.title)).toBeNull();
    cleanup();
    renderFrame({ gate: AWAITING, reviewPath: path({ viewerIsRouted: true }) });
    expect(screen.queryByText(authorNote.title)).toBeNull();
  });

  it('no line when the gate is about another version, or there is no review path', () => {
    renderFrame({ gate: AWAITING, reviewPath: path({ currentVersion: 'moooon/x#1@b' }) });
    expect(line()).toBeNull();
    cleanup();
    renderFrame({ gate: AWAITING });
    expect(line()).toBeNull();
  });
});

describe('the gate-off send-back and Dismiss the review', () => {
  const SENT_BACK = path({
    viewerIsRouted: true,
    sentBackRecord: {
      recordId: 'rec-1',
      findingsMd: '- `lib/export.ts:12` drops the header row.',
      at: '2026-11-05T10:00:00.000Z',
    },
  });
  const WITHDRAWN: ApprovalGateDTO = { ...AWAITING, state: 'superseded' };

  it('draws the Sent back band from the record, and Dismiss for the routed person', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    renderFrame({ gate: WITHDRAWN, reviewPath: SENT_BACK });
    expect(screen.getByText('drops the header row.', { exact: false })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: dismiss.button }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Out of scope.' } });
    await act(async () => {
      fireEvent.submit(screen.getByRole('textbox').closest('form')!);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/work-items/ACME-12/review-dismissal',
      expect.objectContaining({
        body: JSON.stringify({ subjectVersion: VERSION, reason: 'Out of scope.' }),
      }),
    );
    // The page re-reads; the control is gone until the read lands.
    await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('dismiss-review')).toBeNull();
  });

  it('a reader who is not the routed person sees the band and no Dismiss', () => {
    renderFrame({ gate: WITHDRAWN, reviewPath: { ...SENT_BACK, viewerIsRouted: false } });
    expect(screen.getByText('drops the header row.', { exact: false })).toBeTruthy();
    expect(screen.queryByTestId('dismiss-review')).toBeNull();
  });
});
