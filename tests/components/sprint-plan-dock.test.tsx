// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { SprintPlanDock } from '@/app/(authed)/backlog/_components/SprintPlanDock';
import { CreateSprintStrip } from '@/app/(authed)/backlog/_components/CreateSprintStrip';
import { buildStatusByKey } from '@/app/(authed)/backlog/_components/backlogShared';
import type { SprintPlanState } from '@/lib/hooks/useSprintPlanJob';
import type { SprintPlanReviewItemDto } from '@/lib/dto/aiSprintPlan';
import type { ProposedSprint, SprintAssignmentDelta } from '@/lib/ai/types';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';

// The AI sprint-planning SURFACE (Subtask MOTIR-1750) — the entrance strip and
// the review dock, driven under happy-dom (DB-free): both are pure client
// consumers of the MOTIR-918 routes, so the state is handed in and the assertions
// are about what the design draws.
//
// What these lock:
//   (a) the ENTRANCE — the door is present and DISABLED when
//       `aiSprintPlanningEnabled` is false, with the fix hint + the link to the
//       switch, and absent entirely when Motir AI isn't wired;
//   (b) the RUNNING dock narrates only figures a real stream frame carried;
//   (c) the REVIEW renders the packing — sprints, windows, counts, capacity, the
//       server-derived dependency caption, the flag chips, the CTA naming what it
//       creates;
//   (d) DISCARD writes nothing — it dismisses and never calls approve;
//   (e) each shipped failure code renders its own drawn state with its own CTA,
//       and every one of them says nothing was created;
//   (f) the empty packing is a valid outcome, not an error.

afterEach(() => cleanup());

const statusByKey = buildStatusByKey([
  { id: 's1', key: 'todo', label: 'To Do', category: 'todo', color: null, position: 'a0' },
] as never);

function summary(over: Partial<WorkItemSummaryDto> = {}): WorkItemSummaryDto {
  return {
    id: 'wi_1',
    parentId: null,
    kind: 'subtask',
    key: 920,
    identifier: 'MOTIR-920',
    title: 'Cadence trigger fires at threshold',
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    position: 'a0',
    estimateMinutes: 50,
    storyPoints: 5,
    archivedAt: null,
    obsolescence: null,
    obsolescenceNoteMd: null,
    subject: null,
    ...over,
  };
}

function proposedSprint(over: Partial<ProposedSprint> = {}): ProposedSprint {
  return {
    tempId: 'sprint:1',
    name: 'Sprint 2',
    lengthDays: 7,
    itemKeys: ['MOTIR-920', 'MOTIR-1750'],
    totalEstimateMinutes: 1190,
    capacityMinutes: 1680,
    oversizedKeys: [],
    rationale: 'MOTIR-1750 renders the design MOTIR-1749 produces, so it follows it.',
    ...over,
  };
}

function delta(over: Partial<SprintAssignmentDelta> = {}): SprintAssignmentDelta {
  return {
    deltaVersion: 'v1',
    sprintLengthDays: 7,
    capacityMinutes: 1680,
    agentMinutesPerDay: 240,
    sprints: [proposedSprint()],
    itemCount: 2,
    totalEstimateMinutes: 1190,
    unestimatedKeys: [],
    oversizedKeys: [],
    ...over,
  };
}

const ITEMS: Record<string, SprintPlanReviewItemDto> = {
  'MOTIR-920': { item: summary(), blockedByKeys: [] },
  'MOTIR-1750': {
    item: summary({
      id: 'wi_2',
      key: 1750,
      identifier: 'MOTIR-1750',
      title: 'AI sprint-planning UI',
      estimateMinutes: 65,
    }),
    blockedByKeys: ['MOTIR-920'],
  },
};

function state(over: Partial<SprintPlanState> = {}): SprintPlanState {
  return {
    phase: 'review',
    jobId: 'job_1',
    review: { jobStatus: 'succeeded', proposal: delta(), items: ITEMS },
    progress: {
      readCount: null,
      sprintLengthDays: null,
      agentMinutesPerDay: null,
      sprintCount: null,
    },
    failure: null,
    failureDetail: null,
    ...over,
  };
}

function mountDock(over: Partial<SprintPlanState> = {}) {
  const handlers = {
    onCancel: vi.fn(),
    onDismiss: vi.fn(),
    onApprove: vi.fn(),
    onRetry: vi.fn(),
  };
  renderWithIntl(
    <SprintPlanDock
      state={state(over)}
      statusByKey={statusByKey}
      assigneeNameById={new Map()}
      {...handlers}
    />,
  );
  return handlers;
}

describe('the entrance — the two-action create-sprint strip (MOTIR-1750)', () => {
  it('offers the AI door beside the manual one when sprint planning is on', () => {
    renderWithIntl(
      <CreateSprintStrip
        onCreated={async () => {}}
        aiEnabled
        aiAvailable
        onPlanSprints={vi.fn()}
        planning={false}
      />,
    );

    expect(screen.getByTestId('create-sprint')).toBeTruthy();
    const door = screen.getByTestId('plan-sprints-with-motir') as HTMLButtonElement;
    expect(door.textContent).toContain('Plan sprints with Motir');
    expect(door.disabled).toBe(false);
    // No hint when the capability is live.
    expect(screen.queryByText(/AI sprint planning is off for this project\./)).toBeNull();
  });

  it('renders the door DISABLED with the fix hint when the project has it off', () => {
    const onPlanSprints = vi.fn();
    renderWithIntl(
      <CreateSprintStrip
        onCreated={async () => {}}
        aiEnabled={false}
        aiAvailable
        onPlanSprints={onPlanSprints}
        planning={false}
      />,
    );

    const door = screen.getByTestId('plan-sprints-with-motir') as HTMLButtonElement;
    // PRESENT and disabled, never hidden — a hidden control cannot teach that
    // the capability exists, and the settings page already promises it.
    expect(door.disabled).toBe(true);
    fireEvent.click(door);
    expect(onPlanSprints).not.toHaveBeenCalled();

    expect(screen.getByText(/AI sprint planning is off for this project\./)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'AI planning settings' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/settings/project/ai-planning');
  });

  it('shows NO AI door and no hint when Motir AI is not wired at all', () => {
    renderWithIntl(
      <CreateSprintStrip
        onCreated={async () => {}}
        aiEnabled={false}
        aiAvailable={false}
        onPlanSprints={vi.fn()}
        planning={false}
      />,
    );

    expect(screen.queryByTestId('plan-sprints-with-motir')).toBeNull();
    expect(screen.queryByText(/AI sprint planning is off for this project\./)).toBeNull();
    expect(screen.getByTestId('create-sprint')).toBeTruthy();
  });
});

describe('the running dock — narrated from real stream frames (MOTIR-1750)', () => {
  it('states only what a frame has actually carried', () => {
    mountDock({
      phase: 'running',
      review: null,
      progress: {
        readCount: 9,
        sprintLengthDays: null,
        agentMinutesPerDay: null,
        sprintCount: null,
      },
    });

    expect(screen.getByText('Planning your sprints…')).toBeTruthy();
    expect(screen.getByText('Read 9 ready work items and what blocks what')).toBeTruthy();
    // The `packed` frame has not arrived, so no sizing figures are claimed.
    expect(screen.queryByText(/agent-minutes a day/)).toBeNull();
    expect(screen.queryByText(/Packing sprint/)).toBeNull();
  });

  it('adds the sizing + packing lines once the packed frame lands', () => {
    mountDock({
      phase: 'running',
      review: null,
      progress: { readCount: 9, sprintLengthDays: 7, agentMinutesPerDay: 240, sprintCount: 3 },
    });

    expect(
      screen.getByText('Sized them against a 7-day sprint at 240 agent-minutes a day'),
    ).toBeTruthy();
    expect(screen.getByText('Packing sprint 3 of 3…')).toBeTruthy();
  });

  it('cancels the run without writing', () => {
    const handlers = mountDock({ phase: 'running', review: null });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    expect(handlers.onApprove).not.toHaveBeenCalled();
  });
});

describe('the review — the proposed packing (MOTIR-1750)', () => {
  it('renders the packing with its real figures', () => {
    mountDock();

    expect(screen.getByText('Proposed sprints')).toBeTruthy();
    expect(
      screen.getByText(
        '1 sprint · 2 work items · 7 days each — nothing is created until you approve.',
      ),
    ).toBeTruthy();

    const panel = screen.getByTestId('proposed-sprint-sprint:1');
    expect(within(panel).getByText('Sprint 2')).toBeTruthy();
    expect(within(panel).getByText('Proposed')).toBeTruthy();
    expect(within(panel).getByText('7 days')).toBeTruthy();
    // 1190 of 1680 minutes → "19h 50m of 28h — 71% …"
    expect(
      within(panel).getByText('19h 50m of 28h — 71% of a 7-day sprint at 240 agent-minutes a day'),
    ).toBeTruthy();
    expect(within(panel).getByText(/Why this order\./)).toBeTruthy();
  });

  it('renders the rows in the packing order, as a static list', () => {
    mountDock();

    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('MOTIR-920'),
      expect.stringContaining('MOTIR-1750'),
    ]);
    // Not the sortable row grid — these rows are not draggable.
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });

  it('captions a row with the SERVER-derived in-packing blocker', () => {
    mountDock();

    expect(
      within(screen.getByTestId('proposed-row-MOTIR-1750')).getByText('after MOTIR-920'),
    ).toBeTruthy();
    expect(within(screen.getByTestId('proposed-row-MOTIR-920')).queryByText(/^after /)).toBeNull();
  });

  it('flags an oversized member and an unestimated one, in words not only colour', () => {
    mountDock({
      review: {
        jobStatus: 'succeeded',
        proposal: delta({
          sprints: [proposedSprint({ oversizedKeys: ['MOTIR-920'] })],
          oversizedKeys: ['MOTIR-920'],
        }),
        items: {
          ...ITEMS,
          'MOTIR-1750': {
            item: summary({
              id: 'wi_2',
              key: 1750,
              identifier: 'MOTIR-1750',
              title: 'AI sprint-planning UI',
              estimateMinutes: null,
              storyPoints: null,
            }),
            blockedByKeys: ['MOTIR-920'],
          },
        },
      },
    });

    expect(
      within(screen.getByTestId('proposed-row-MOTIR-920')).getByText('Bigger than a sprint'),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('proposed-row-MOTIR-1750')).getByText('No estimate'),
    ).toBeTruthy();
    // The head rolls the count up.
    expect(screen.getByText('1 bigger than a sprint')).toBeTruthy();
  });

  it('states the overage — and why the sprint was held together — when over capacity', () => {
    mountDock({
      review: {
        jobStatus: 'succeeded',
        proposal: delta({
          sprints: [
            proposedSprint({
              totalEstimateMinutes: 1720,
              oversizedKeys: ['MOTIR-1750'],
            }),
          ],
        }),
        items: ITEMS,
      },
    });

    expect(
      screen.getByText(
        '28h 40m of 28h — over by 40m, held together because MOTIR-1750 blocks the rest',
      ),
    ).toBeTruthy();
  });

  it('names what approve creates, and promises nothing else changes', () => {
    mountDock();

    expect(screen.getByTestId('sprint-plan-approve').textContent).toContain('Create 1 sprint');
    expect(
      screen.getByText(
        'Approving creates these sprints and moves the work items into them. Nothing else changes — no status moves, no sprint starts.',
      ),
    ).toBeTruthy();
  });

  it('APPROVE is the only write — discard and close dismiss without approving', () => {
    const discardHandlers = mountDock();
    fireEvent.click(screen.getByTestId('sprint-plan-discard'));
    expect(discardHandlers.onDismiss).toHaveBeenCalledTimes(1);
    expect(discardHandlers.onApprove).not.toHaveBeenCalled();

    cleanup();

    const closeHandlers = mountDock();
    fireEvent.click(screen.getByTestId('sprint-plan-close'));
    expect(closeHandlers.onDismiss).toHaveBeenCalledTimes(1);
    expect(closeHandlers.onApprove).not.toHaveBeenCalled();

    cleanup();

    const approveHandlers = mountDock();
    fireEvent.click(screen.getByTestId('sprint-plan-approve'));
    expect(approveHandlers.onApprove).toHaveBeenCalledTimes(1);
  });
});

describe('the edge states (MOTIR-1750)', () => {
  it('treats an empty packing as a valid outcome, not an error', () => {
    const handlers = mountDock({
      phase: 'empty',
      review: { jobStatus: 'succeeded', proposal: delta({ sprints: [], itemCount: 0 }), items: {} },
    });

    expect(screen.getByText('Nothing to schedule')).toBeTruthy();
    expect(screen.queryByTestId('sprint-plan-approve')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // The empty state's own Close (the dock head carries one too — both dismiss).
    fireEvent.click(screen.getByTestId('sprint-plan-empty-close'));
    expect(handlers.onDismiss).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['disabled', 'AI sprint planning is off for this project.', 'AI planning settings', true],
    // The credits refusal happens BEFORE a run, so its copy offers the fix
    // instead of the nothing-was-created reassurance (design-notes §7, verbatim).
    ['credits', 'You’re out of planning credits.', 'Top up', false],
    ['unreachable', 'Motir didn’t answer.', 'Try again', true],
    ['notAdmin', 'You need sprint-admin rights on this project to create sprints.', null, true],
    ['failed', 'Sprint planning didn’t finish.', 'Try again', true],
  ] as const)(
    'renders the %s failure with its own CTA',
    (failure, lead, cta, saysNothingCreated) => {
      mountDock({ phase: 'error', review: null, failure });

      const alert = screen.getByRole('alert');
      expect(alert.textContent).toContain(lead);
      // A failure that could have written promises it did not — the approve is ONE
      // transaction, so a partial write cannot happen and the copy may say so.
      if (saysNothingCreated) expect(alert.textContent).toContain('Nothing was created');
      if (cta) expect(within(alert).getByText(cta)).toBeTruthy();
      expect(screen.queryByTestId('sprint-plan-approve')).toBeNull();
    },
  );

  it('quotes the server detail on an invalid packing, and offers Plan again', () => {
    const handlers = mountDock({
      phase: 'error',
      review: null,
      failure: 'packing',
      failureDetail:
        'MOTIR-1750 is blocked by MOTIR-1749, but the packing schedules it no earlier.',
    });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('This packing no longer fits your plan.');
    expect(alert.textContent).toContain('MOTIR-1750 is blocked by MOTIR-1749');
    expect(alert.textContent).toContain('Nothing was created');
    fireEvent.click(within(alert).getByRole('button', { name: 'Plan again' }));
    expect(handlers.onRetry).toHaveBeenCalledTimes(1);
  });
});
