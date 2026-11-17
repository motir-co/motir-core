// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import {
  SkipFinalCheckDialog,
  type SkipFinalCheckPhase,
} from '@/components/planning/SkipFinalCheckDialog';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import { indexPlanReview } from '@/lib/planning/planChangeDiff';
import { FINAL_CHECK_SETTING_HREF } from '@/app/(authed)/backlog/_components/aiSprintPlanShared';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import en from '@/messages/en.json';
import { narrationEntry, narrationRead, narrationSession } from '../helpers/planNarration';

// THE SETTINGS LINE IN THE SKIP THE FINAL CHECK CONFIRM (MOTIR-11548), built to
// `design/ai-chat/design-notes.md` § "⭐ The final check, §3 amended" (MOTIR-11547) and
// `planning-workspace--skip-final-check--settings-link.mock.html`: under the consequence (or
// finished) line in every phase, a pointer to the project's Run the final check setting that
// opens in a NEW TAB and leaves this dialog, its phase and the running check alone.

const SK = en.planningWorkspace.skipFinalCheck;
const LINK_WORDS = 'Run the final check in AI planning settings';
const plain = (message: string) => message.replace(/<\/?link>/g, '');

function mount(
  phase: SkipFinalCheckPhase,
  props: { canManageSettings?: boolean } = {},
  handlers = { onKeep: vi.fn(), onConfirm: vi.fn() },
) {
  renderWithIntl(
    <SkipFinalCheckDialog
      open
      phase={phase}
      onKeep={handlers.onKeep}
      onConfirm={handlers.onConfirm}
      {...(props.canManageSettings === undefined
        ? {}
        : { canManageSettings: props.canManageSettings })}
    />,
    { locale: 'en', messages: en },
  );
  return handlers;
}

const line = () => screen.getByTestId('planning-skip-check-dialog-setting');
const link = () => screen.getByTestId('planning-skip-check-setting-link') as HTMLAnchorElement;

afterEach(cleanup);

describe('the copy, by phase and by who may change the setting', () => {
  it.each<[SkipFinalCheckPhase, boolean, string]>([
    ['open', true, SK.settingLine],
    ['skipping', true, SK.settingLine],
    ['failed', true, SK.settingLine],
    ['finished', true, SK.settingLineFinished],
    ['open', false, SK.settingLineReadOnly],
    ['skipping', false, SK.settingLineReadOnly],
    ['failed', false, SK.settingLineReadOnly],
    ['finished', false, SK.settingLineReadOnlyFinished],
  ])('%s, canManageSettings=%s', (phase, canManageSettings, message) => {
    mount(phase, { canManageSettings });
    expect(line().textContent).toBe(
      `${plain(message)}`.replace(LINK_WORDS, `${LINK_WORDS} ${SK.settingNewTab}`),
    );
    expect(link().textContent).toBe(`${LINK_WORDS} ${SK.settingNewTab}`);
  });

  it('the scoping sentence goes once the check had finished, because there was no skip', () => {
    expect(SK.settingLine.startsWith('This skip is for this plan only.')).toBe(true);
    expect(SK.settingLineReadOnly.startsWith('This skip is for this plan only.')).toBe(true);
    expect(SK.settingLineFinished).not.toContain('This skip');
    expect(SK.settingLineReadOnlyFinished).not.toContain('This skip');
    // The admin is told to act; a member is told who can.
    expect(SK.settingLine).toContain('switch off <link>');
    expect(SK.settingLineReadOnly).toContain('A project admin can turn the final check off');
  });

  it('absent canManageSettings, it is the read-only copy', () => {
    mount('open');
    expect(line().textContent).toContain('A project admin can turn the final check off');
  });

  it('the link words repeat the setting’s own label, so the new tab shows the same words', () => {
    expect(LINK_WORDS.startsWith(en.settings.aiPlanning.planner.finalCheckLabel)).toBe(true);
  });
});

describe('the placement', () => {
  it('sits directly under the consequence line', () => {
    mount('open', { canManageSettings: true });
    const consequence = screen.getByTestId('planning-skip-check-dialog-consequence');
    expect(consequence.nextElementSibling).toBe(line());
  });

  it('sits directly under the finished line', () => {
    mount('finished', { canManageSettings: true });
    const finished = screen.getByTestId('planning-skip-check-dialog-finished');
    expect(finished.nextElementSibling).toBe(line());
  });

  it('keeps the error line last, next to the Try again it answers', () => {
    mount('failed', { canManageSettings: true });
    expect(line().nextElementSibling).toBe(screen.getByTestId('planning-skip-check-dialog-error'));
  });

  it('is not part of the dialog’s description', () => {
    mount('open', { canManageSettings: true });
    const described = screen.getByRole('alertdialog').getAttribute('aria-describedby') ?? '';
    expect(line().id).toBe('');
    expect(described).not.toContain('setting');
  });

  it('is a quiet secondary line with an aria-hidden glyph', () => {
    mount('open', { canManageSettings: true });
    expect(line().className).toContain('text-(--el-text-secondary)');
    expect(line().className).toContain('px-(--spacing-control-x-12)');
    expect(line().querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('the link', () => {
  it('opens the Run the final check row in a new tab, named so', () => {
    mount('open', { canManageSettings: true });
    expect(link().getAttribute('href')).toBe(FINAL_CHECK_SETTING_HREF);
    expect(link().getAttribute('href')).toBe('/settings/project/ai-planning#final-check');
    expect(link().getAttribute('target')).toBe('_blank');
    expect(link().getAttribute('rel')).toBe('noopener noreferrer');
    expect(within(link()).getByText(SK.settingNewTab).className).toContain('sr-only');
    expect(link().querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(
      screen.getByRole('link', {
        name: 'Run the final check in AI planning settings (opens in a new tab)',
      }),
    ).toBe(link());
  });

  it('the read-only member gets the same link to the same row', () => {
    mount('open', { canManageSettings: false });
    expect(link().getAttribute('href')).toBe(FINAL_CHECK_SETTING_HREF);
    expect(link().getAttribute('target')).toBe('_blank');
  });

  it.each<SkipFinalCheckPhase>(['open', 'skipping', 'failed', 'finished'])(
    'pressing it in the %s phase calls neither onKeep nor onConfirm, and the dialog stays',
    (phase) => {
      const { onKeep, onConfirm } = mount(phase, { canManageSettings: true });
      // The test window has no second tab to open: stop the browser's own navigation
      // after React has seen the press, so only the dialog's handlers are measured.
      const noNavigate = (event: Event) => event.preventDefault();
      document.addEventListener('click', noNavigate);
      fireEvent.click(link());
      document.removeEventListener('click', noNavigate);
      fireEvent.keyDown(link(), { key: 'Enter' });
      expect(onKeep).not.toHaveBeenCalled();
      expect(onConfirm).not.toHaveBeenCalled();
      expect(screen.getByTestId('planning-skip-check-dialog').getAttribute('data-phase')).toBe(
        phase,
      );
      expect(screen.getByRole('alertdialog')).toBeTruthy();
    },
  );

  it('stays live while the skip is out', () => {
    mount('skipping', { canManageSettings: true });
    expect((screen.getByTestId('planning-skip-check-keep') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(link().hasAttribute('disabled')).toBe(false);
    expect(link().getAttribute('aria-disabled')).toBeNull();
  });
});

describe('focus', () => {
  it('still opens on Keep checking, with the link before the footer in the tab order', async () => {
    mount('open', { canManageSettings: true });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('planning-skip-check-keep')),
    );
    const keep = screen.getByTestId('planning-skip-check-keep');
    expect(link().compareDocumentPosition(keep) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('the planning rail words the line by the viewer’s ai:configure', () => {
  const LAUNCH = parsePlanningLaunch({ mode: 'replan', from: 'project' });
  const state = {
    phase: 'streaming',
    session: {
      id: 's1',
      projectId: 'p1',
      targetKeys: [],
      turnCount: 0,
      lastJobId: null,
      lastSubmittedAt: null,
      lastActivityAt: '2026-01-01T00:00:00.000Z',
      origin: 'conversation',
      createdAt: '2026-07-27T09:00:00.000Z',
      updatedAt: '2026-07-27T10:00:00.000Z',
      turns: [],
      workItemRefs: {},
    },
    progress: null,
    review: null,
    liveReview: null,
    liveVersion: 0,
    liveFailing: false,
    discardedReview: null,
    decided: null,
    jobId: 'job-1',
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
    narration: narrationRead(
      [narrationSession('s-check', 'check', null)],
      [narrationEntry(1, 's-check', 'Reading the plan in build order.')],
    ),
    narrationKept: { planId: 'plan_1', live: ['s-check'], earlier: [], loadingEarlier: false },
  } as unknown as PlanChangeConversationState;

  function openFromRail(canManageSettings?: boolean) {
    renderWithIntl(
      <PlanChangeRail
        launch={LAUNCH}
        projectName="PayFlow"
        state={state}
        index={indexPlanReview(state.review)}
        targets={[]}
        onSend={vi.fn()}
        onRetry={vi.fn()}
        onCorrectTurn={vi.fn()}
        onApprove={vi.fn()}
        onDiscard={vi.fn()}
        onAddTarget={vi.fn()}
        onRemoveTarget={vi.fn()}
        onStop={vi.fn()}
        onSkipFinalCheck={vi.fn(async () => 'skipped' as const)}
        {...(canManageSettings === undefined ? {} : { canManageSettings })}
      />,
      { locale: 'en', messages: en },
    );
    fireEvent.click(screen.getByTestId('plan-narration-skip-check-control'));
  }

  it('an admin is told to switch it off', async () => {
    openFromRail(true);
    await screen.findByRole('alertdialog');
    expect(line().textContent).toContain('switch off');
  });

  it('a member who only plans is told who can', async () => {
    openFromRail(false);
    await screen.findByRole('alertdialog');
    expect(line().textContent).toContain('A project admin can turn the final check off');
  });

  it('absent the prop, the rail draws the read-only copy', async () => {
    openFromRail();
    await screen.findByRole('alertdialog');
    expect(line().textContent).toContain('A project admin can turn the final check off');
  });
});
