// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type {
  ReadinessVerdictDto,
  RelationshipLinkDto,
  WorkItemSummaryDto,
} from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';

// MOTIR-4496 — THE OPTIMISTIC LINK PANEL.
//
// The panel used to write and then call `router.refresh()` with nothing in
// between, so a row appeared or disappeared only once the server had
// re-rendered the WHOLE detail page. Every assertion in this file is written
// with the network DEFERRED — the Server Action's promise is held open — so it
// measures the one thing the old code could not do: move the row before the
// server has answered at all, let alone before the refresh lands. Each of these
// fails on the pre-4496 component, which is what makes them a regression
// surface rather than a description.
//
// The E2E specs this card exists to stop flaking
// (`tests/e2e/issue-detail-flow.spec.ts:461` / `:595` / `:622`) are deliberately
// NOT touched — they are the detector, and amending them is what this card
// exists to avoid.

const createLinkAction = vi.fn();
const removeLinkAction = vi.fn();
const listLinkCandidatesAction = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(authed)/items/[key]/actions', () => ({
  createLinkAction: (...args: unknown[]) => createLinkAction(...args),
  removeLinkAction: (...args: unknown[]) => removeLinkAction(...args),
  listLinkCandidatesAction: (...args: unknown[]) => listLinkCandidatesAction(...args),
}));

let searchParamsString = '';
vi.mock('next/navigation', () => ({
  usePathname: () => '/items/PROD-1',
  useSearchParams: () => new URLSearchParams(searchParamsString),
  useRouter: () => ({ refresh }),
}));

import { RelationshipsPanel } from '@/app/(authed)/items/[key]/_components/RelationshipsPanel';

vi.spyOn(window.history, 'pushState').mockImplementation(() => {});

/** A promise whose settlement this test controls — "the network, deferred". */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function summary(overrides: Partial<WorkItemSummaryDto> = {}): WorkItemSummaryDto {
  return {
    id: 'wi',
    parentId: null,
    kind: 'task',
    key: 1,
    identifier: 'PROD-1',
    title: 'An item',
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    position: 'a0',
    estimateMinutes: null,
    storyPoints: null,
    archivedAt: null,
    obsolescence: null,
    obsolescenceNoteMd: null,
    subject: null,
    ...overrides,
  };
}

const workflow: WorkflowDto = {
  statuses: [
    {
      id: 's1',
      projectId: 'p1',
      key: 'todo',
      label: 'To Do',
      category: 'todo',
      color: null,
      position: 'a0',
      isInitial: true,
    },
  ],
  transitions: [],
  policyMode: 'open',
};

const READY: ReadinessVerdictDto = { ready: true, openBlockers: [], blockedByAncestor: null };
const blocker = summary({ id: 'b', key: 3, identifier: 'PROD-3', title: 'Upstream' });
const BLOCKED: ReadinessVerdictDto = {
  ready: false,
  openBlockers: [blocker],
  blockedByAncestor: null,
};
const BLOCKER_LINK: RelationshipLinkDto = { linkId: 'link-b', item: blocker };

const EMPTY = {
  blockedBy: [] as RelationshipLinkDto[],
  blocks: [] as RelationshipLinkDto[],
  relatesTo: [] as RelationshipLinkDto[],
  duplicates: [] as RelationshipLinkDto[],
  clones: [] as RelationshipLinkDto[],
  supersedes: [] as RelationshipLinkDto[],
  supersededBy: [] as RelationshipLinkDto[],
  currentStatus: 'todo',
  workflow,
  editable: true,
  currentItemId: 'wi-1',
  identifier: 'PROD-1',
};

beforeEach(() => {
  createLinkAction.mockReset();
  removeLinkAction.mockReset();
  listLinkCandidatesAction.mockReset();
  refresh.mockReset();
  searchParamsString = '';
  listLinkCandidatesAction.mockResolvedValue({ ok: true, candidates: [blocker] });
});
afterEach(cleanup);

/** Open the row's confirm popover and press Remove. */
function clickRemove() {
  fireEvent.click(screen.getByRole('button', { name: /Remove Blocked by link to PROD-3/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove link' }));
}

/** Open the add form, search, pick PROD-3, press Add. */
async function addBlocker() {
  fireEvent.click(screen.getByRole('button', { name: /Link work item/ }));
  fireEvent.click(await screen.findByRole('combobox', { name: 'Work item to link' }));
  fireEvent.change(await screen.findByRole('combobox', { name: /Search by identifier or title/ }), {
    target: { value: 'Upstream' },
  });
  fireEvent.click(await screen.findByRole('option', { name: /Upstream/ }));
  const add = screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement;
  await waitFor(() => expect(add.disabled).toBe(false));
  fireEvent.click(add);
}

describe('MOTIR-4496 · the row moves before the server answers (criteria 1, 2, 4)', () => {
  it('REMOVE: the row is gone while the action is still in flight', async () => {
    const write = deferred<{ ok: true; readiness: ReadinessVerdictDto }>();
    removeLinkAction.mockReturnValue(write.promise);
    render(<RelationshipsPanel {...EMPTY} blockedBy={[BLOCKER_LINK]} readiness={BLOCKED} />);
    expect(screen.getByRole('link', { name: /Upstream/ })).toBeTruthy();

    clickRemove();

    // ⚠️ THE ASSERTION THAT FAILS ON THE PRE-4496 COMPONENT. Nothing has been
    // awaited: `removeLinkAction`'s promise is still open, so no response has
    // arrived and no refresh has run.
    expect(screen.queryByRole('link', { name: /Upstream/ })).toBeNull();
    expect(refresh).not.toHaveBeenCalled();

    await act(async () => {
      write.resolve({ ok: true, readiness: READY });
    });
    // Criterion 5's first half: the refresh still runs.
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('ADD: the row is present while the action is still in flight, built from the picked candidate', async () => {
    const write = deferred<{ ok: true; linkId: string; readiness: ReadinessVerdictDto }>();
    createLinkAction.mockReturnValue(write.promise);
    render(<RelationshipsPanel {...EMPTY} readiness={READY} />);

    await addBlocker();

    expect(screen.getByRole('link', { name: /Upstream/ })).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();

    await act(async () => {
      write.resolve({ ok: true, linkId: 'link-b', readiness: BLOCKED });
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('the write carries the CURRENT item, so the response can re-judge its readiness', async () => {
    removeLinkAction.mockResolvedValue({ ok: true, readiness: READY });
    render(<RelationshipsPanel {...EMPTY} blockedBy={[BLOCKER_LINK]} readiness={BLOCKED} />);
    clickRemove();
    await waitFor(() =>
      expect(removeLinkAction).toHaveBeenCalledWith({
        linkId: 'link-b',
        currentItemId: 'wi-1',
        identifier: 'PROD-1',
      }),
    );
  });
});

describe('MOTIR-4496 · a rejected write ROLLS BACK to the inline error (criteria 1, 2)', () => {
  it('REMOVE: the row comes back and the confirm popover shows the message', async () => {
    removeLinkAction.mockResolvedValue({ ok: false, error: 'That link is gone.' });
    render(<RelationshipsPanel {...EMPTY} blockedBy={[BLOCKER_LINK]} readiness={BLOCKED} />);
    clickRemove();

    await screen.findByText('That link is gone.');
    expect(screen.getByRole('link', { name: /Upstream/ })).toBeTruthy();
    // A failed write never refreshes — there is nothing on the server to re-read.
    expect(refresh).not.toHaveBeenCalled();
  });

  it('ADD: the optimistic row is withdrawn and the form shows the message', async () => {
    createLinkAction.mockResolvedValue({ ok: false, error: 'That link already exists.' });
    render(<RelationshipsPanel {...EMPTY} readiness={READY} />);

    await addBlocker();

    await screen.findByText('That link already exists.');
    expect(screen.queryByRole('link', { name: /Upstream/ })).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('MOTIR-4496 · the readiness banner rides the RESPONSE, not the refresh (criteria 3, 7a)', () => {
  // These hold the REFRESH open as well as the write, which is the only way to
  // see the window the card is about: the moment after the action has answered
  // and before the whole-page refresh has landed. That window is where the
  // banner used to be blank-slow, and where §4 warned the row fix would leave
  // it if criterion 7 were discharged by restating criterion 3.
  it('removing the last blocker flips the banner to "Ready to start" on the action response', async () => {
    const write = deferred<{ ok: true; readiness: ReadinessVerdictDto }>();
    const refreshLanded = deferred<void>();
    removeLinkAction.mockReturnValue(write.promise);
    refresh.mockReturnValue(refreshLanded.promise);
    render(<RelationshipsPanel {...EMPTY} blockedBy={[BLOCKER_LINK]} readiness={BLOCKED} />);
    screen.getByText('Blocked');

    clickRemove();
    // The ROW is optimistic; the BANNER is not re-derived in the browser, so it
    // still reads the server's last word while the write is in flight.
    expect(screen.getByText('Blocked')).toBeTruthy();

    await act(async () => {
      write.resolve({ ok: true, readiness: READY });
    });

    // ⚠️ THE POINT OF CRITERION 7(a). The refresh has been STARTED and has NOT
    // landed — and the banner has already flipped, off the action's re-judged
    // verdict. Before this card it would have waited for the whole-page
    // refresh: the wait the row assertion above it had been absorbing, and
    // which making the row optimistic would otherwise have handed to it.
    expect(refresh).toHaveBeenCalledTimes(1);
    await screen.findByText('Ready to start');

    await act(async () => {
      refreshLanded.resolve();
    });
  });

  it('adding a blocker flips the banner to "Blocked" and names it, on the same terms', async () => {
    const write = deferred<{ ok: true; linkId: string; readiness: ReadinessVerdictDto }>();
    const refreshLanded = deferred<void>();
    createLinkAction.mockReturnValue(write.promise);
    refresh.mockReturnValue(refreshLanded.promise);
    render(<RelationshipsPanel {...EMPTY} readiness={READY} />);
    screen.getByText('Ready to start');

    await addBlocker();

    await act(async () => {
      write.resolve({ ok: true, linkId: 'link-b', readiness: BLOCKED });
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    await screen.findByText('Blocked');
    expect(screen.getAllByRole('link', { name: /PROD-3/ }).length).toBeGreaterThan(0);

    await act(async () => {
      refreshLanded.resolve();
    });
  });
});

describe('MOTIR-4496 · the refresh RECONCILES and WINS (criterion 5)', () => {
  it('a refresh whose set DISAGREES with the optimistic removal puts the row back', async () => {
    removeLinkAction.mockResolvedValue({ ok: true, readiness: READY });
    const { rerender } = render(
      <RelationshipsPanel {...EMPTY} blockedBy={[BLOCKER_LINK]} readiness={BLOCKED} />,
    );

    clickRemove();
    expect(screen.queryByRole('link', { name: /Upstream/ })).toBeNull();

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    // The server re-rendered and STILL carries the link (a concurrent re-link,
    // a revalidation that read a replica). The refresh is the authority, so the
    // optimistic removal is retired and the row returns — the panel does not
    // keep hiding a row the server says exists.
    rerender(<RelationshipsPanel {...EMPTY} blockedBy={[BLOCKER_LINK]} readiness={BLOCKED} />);
    await screen.findByRole('link', { name: /Upstream/ });
    // …and the banner goes back with it, rather than keeping the verdict the
    // action returned for a set the server has since contradicted.
    await screen.findByText('Blocked');
  });

  it('a refresh that AGREES leaves the row gone — no flicker back', async () => {
    removeLinkAction.mockResolvedValue({ ok: true, readiness: READY });
    const { rerender } = render(
      <RelationshipsPanel {...EMPTY} blockedBy={[BLOCKER_LINK]} readiness={BLOCKED} />,
    );

    clickRemove();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    rerender(<RelationshipsPanel {...EMPTY} blockedBy={[]} readiness={READY} />);
    expect(screen.queryByRole('link', { name: /Upstream/ })).toBeNull();
    await screen.findByText('Ready to start');
  });

  it('the reconciled ADD is not rendered twice when the refresh lands the real row', async () => {
    createLinkAction.mockResolvedValue({ ok: true, linkId: 'link-b', readiness: BLOCKED });
    const { rerender } = render(<RelationshipsPanel {...EMPTY} readiness={READY} />);

    await addBlocker();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    rerender(<RelationshipsPanel {...EMPTY} blockedBy={[BLOCKER_LINK]} readiness={BLOCKED} />);
    expect(screen.getAllByRole('link', { name: /Upstream/ })).toHaveLength(1);
  });
});

describe('MOTIR-4496 · two writes in flight resolve OUT OF ORDER (the seq guard)', () => {
  it('an older response does not clobber the newer verdict', async () => {
    const first = deferred<{ ok: true; readiness: ReadinessVerdictDto }>();
    const second = deferred<{ ok: true; linkId: string; readiness: ReadinessVerdictDto }>();
    const refreshLanded = deferred<void>();
    removeLinkAction.mockReturnValue(first.promise);
    createLinkAction.mockReturnValue(second.promise);
    refresh.mockReturnValue(refreshLanded.promise);

    render(<RelationshipsPanel {...EMPTY} blockedBy={[BLOCKER_LINK]} readiness={BLOCKED} />);

    clickRemove(); // seq 1 — would leave the item READY
    await addBlocker(); // seq 2 — puts a blocker back, so BLOCKED

    // The NEWER write answers first…
    await act(async () => {
      second.resolve({ ok: true, linkId: 'link-b2', readiness: BLOCKED });
    });
    await screen.findByText('Blocked');

    // …and the OLDER one answers second. Its verdict is stale by construction:
    // it was computed before the add committed. `CLAUDE.md`'s optimistic-
    // reconcile rule is that it must not win, and the seq guard is what says so.
    await act(async () => {
      first.resolve({ ok: true, readiness: READY });
    });
    expect(screen.queryByText('Ready to start')).toBeNull();
    screen.getByText('Blocked');

    await act(async () => {
      refreshLanded.resolve();
    });
  });
});

describe('MOTIR-6675 · the supersedes pair through the add-link control', () => {
  it('offers all seven relationships, and a Superseded-by add lands under Superseded by', async () => {
    const write = deferred<{ ok: true; linkId: string; readiness: ReadinessVerdictDto }>();
    createLinkAction.mockReturnValue(write.promise);
    render(<RelationshipsPanel {...EMPTY} readiness={READY} />);

    fireEvent.click(screen.getByRole('button', { name: /Link work item/ }));
    fireEvent.click(await screen.findByRole('combobox', { name: 'Relationship' }));
    const offered = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(offered).toEqual([
      'Blocked by',
      'Blocks',
      'Relates to',
      'Duplicates',
      'Clones',
      'Supersedes',
      'Superseded by',
    ]);
    fireEvent.click(screen.getByRole('option', { name: 'Superseded by' }));

    fireEvent.click(await screen.findByRole('combobox', { name: 'Work item to link' }));
    fireEvent.change(
      await screen.findByRole('combobox', { name: /Search by identifier or title/ }),
      {
        target: { value: 'Upstream' },
      },
    );
    fireEvent.click(await screen.findByRole('option', { name: /Upstream/ }));
    const add = screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement;
    await waitFor(() => expect(add.disabled).toBe(false));
    fireEvent.click(add);

    await waitFor(() =>
      expect(createLinkAction).toHaveBeenCalledWith(
        expect.objectContaining({ relationship: 'superseded_by', targetId: 'b' }),
      ),
    );
    // The optimistic row sits in the Superseded-by group, before the server answers.
    const group = document.querySelector<HTMLElement>('[data-relationship-group="superseded_by"]')!;
    expect(within(group).getByRole('link', { name: /Upstream/ })).toBeTruthy();
    expect(document.querySelector('[data-relationship-group="supersedes"]')).toBeNull();

    await act(async () => {
      write.resolve({ ok: true, linkId: 'link-s', readiness: READY });
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });
});
