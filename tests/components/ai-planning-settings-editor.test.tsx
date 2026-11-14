// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { withPlanningOverlay } from '@/lib/planning/launcher';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import {
  AiPlanningSettingsEditor,
  isWholeNumberInRange,
  type AutoPlanPauseView,
} from '@/app/(authed)/settings/project/ai-planning/_components/AiPlanningSettingsEditor';
import type { ProjectAiSettingsDto } from '@/lib/dto/projectAiSettings';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';

// AiPlanningSettingsEditor (Story 7.13 · Subtask MOTIR-919) — the AI-planning
// settings panel, per design/ai-settings/. Driven under happy-dom (DB-free): the
// editor is a pure client consumer of the MOTIR-919
// `PATCH /api/projects/[key]/ai-settings` endpoint, so we stub global fetch and
// assert the design's states:
//   (a) the four cards + their controls render with the design's copy, and the
//       explanation toggle (the Story-7.4 column) is SURFACED here;
//   (b) a dependent control is present but DISABLED until its parent switch is
//       on, and its explanatory callout appears only when the setting is live;
//   (c) validation is inline (`role="alert"`), at the field, and BLOCKS Save;
//   (d) Save fires the right PATCH (optimistic) and REVERTS on failure, with a
//       typed 422 slotting its message under the field it names;
//   (e) the non-admin read-only + Motir-AI-not-connected states disable the
//       controls and say why;
//   (f) the MOTIR-1740 auto-plan PAUSED state — both faces (current /
//       out-of-date), the link out to the waiting plan, when it does NOT render,
//       and that pausing is not disabling.

function dto(over: Partial<ProjectAiSettingsDto> = {}): ProjectAiSettingsDto {
  return {
    aiAutoPlanEnabled: false,
    aiAutoPlanThreshold: 5,
    aiSprintPlanningEnabled: false,
    aiSprintLengthDays: 2,
    aiGenerateExplanations: false,
    // MOTIR-3349 — ON by default, resolved from a NULL column by the mapper, so
    // the panel receives a real boolean and never re-derives the default.
    aiRecordPlanningMistakes: true,
    // MOTIR-11264 — ON by default, resolved from a NULL column the same way.
    aiFinalCheck: true,
    ...over,
  };
}

function render(ui: ReactElement) {
  return renderWithIntl(<ToastProvider>{ui}</ToastProvider>);
}

/** The MOTIR-1740 paused view the server hands down (relative time already
 *  formatted). Defaults to a current (not drifted) waiting plan. */
function pauseView(over: Partial<AutoPlanPauseView> = {}): AutoPlanPauseView {
  return {
    planId: 'pln_8f2',
    plannedWhenLabel: '3 days ago',
    itemCount: 12,
    stale: false,
    staleCount: 0,
    ...over,
  };
}

function mount(
  over: Partial<ProjectAiSettingsDto> = {},
  props: {
    isAdmin?: boolean;
    aiConfigured?: boolean;
    canViewLessons?: boolean;
    pause?: AutoPlanPauseView | null;
  } = {},
) {
  return render(
    <AiPlanningSettingsEditor
      projectKey="PROD"
      projectName="motir"
      settings={dto(over)}
      isAdmin={props.isAdmin ?? true}
      aiConfigured={props.aiConfigured ?? true}
      canViewLessons={props.canViewLessons ?? true}
      pause={props.pause ?? null}
    />,
  );
}

const threshold = () => screen.getByTestId('ai-planning-threshold') as HTMLInputElement;
const sprintLength = () => screen.getByTestId('ai-planning-sprint-length') as HTMLInputElement;
const saveButton = () => screen.getByTestId('ai-planning-save') as HTMLButtonElement;
const autoPlanSwitch = () => screen.getByRole('switch', { name: 'Expand the plan automatically' });
const sprintSwitch = () => screen.getByRole('switch', { name: 'Plan sprints with Motir' });
const explanationsSwitch = () => screen.getByRole('switch', { name: 'Draft a why for each item' });
const recordMistakesSwitch = () => screen.getByRole('switch', { name: 'Record planning mistakes' });
const finalCheckSwitch = () => screen.getByRole('switch', { name: 'Run the final check' });
const explanationText = () =>
  screen.getByTestId('ai-planning-record-mistakes-explanation').textContent ?? '';

let fetchMock: ReturnType<typeof vi.fn>;

// The paused banner's link is a plan-overlay door (Story MOTIR-7883 · MOTIR-7890):
// it reads the plan's review to learn where it lands. That read is answered here,
// OFF `fetchMock`, so the settings PATCH counts below stay about the PATCH alone.
const { push, shallowPush } = vi.hoisted(() => ({ push: vi.fn(), shallowPush: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/settings/project/ai-planning',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));
const planReads = vi.fn();
function planReview() {
  return new Response(
    JSON.stringify({ status: 'planned', conversation: { sessionId: 's_8f2', targetKeys: [] } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function okResponse(body: unknown = dto()) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function errorResponse(status: number, body: unknown = {}) {
  return { ok: false, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(okResponse());
  planReads.mockReset();
  push.mockReset();
  shallowPush.mockReset();
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (/^\/api\/plans\/[^/]+$/.test(String(url))) {
      planReads(url);
      return Promise.resolve(planReview());
    }
    return (fetchMock as unknown as typeof fetch)(url, init);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AiPlanningSettingsEditor — the four cards', () => {
  it('renders auto-plan, AI sprint planning, planner and planning mistakes, with the explanation toggle SURFACED here', () => {
    mount();

    expect(screen.getByText('Auto-plan')).toBeTruthy();
    expect(screen.getByText('AI sprint planning')).toBeTruthy();
    expect(screen.getByText('Planner')).toBeTruthy();
    expect(screen.getByText('Planning mistakes')).toBeTruthy();

    // FIVE enable switches — the Story-7.4 `aiGenerateExplanations` column,
    // which had no UI anywhere before this panel, the MOTIR-3331
    // record-planning-mistakes switch and the MOTIR-11264 final check.
    expect(screen.getAllByRole('switch')).toHaveLength(5);
    expect(explanationsSwitch().getAttribute('aria-checked')).toBe('false');

    // NO planner-model control (MOTIR-7228): the model that plans is a platform
    // setting. The Planner card keeps its title, takes the delta's sub-copy, and
    // names no model anywhere — not as a control, not read-only, not in a sentence.
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText('Planner model')).toBeNull();
    expect(screen.getByText('Planner')).toBeTruthy();
    expect(screen.getByText('How the planner writes for this project.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\bmodel\b/i);
  });

  it('seeds every control from the persisted settings', () => {
    mount({
      aiAutoPlanEnabled: true,
      aiAutoPlanThreshold: 8,
      aiSprintPlanningEnabled: true,
      aiSprintLengthDays: 4,
      aiGenerateExplanations: true,
    });

    expect(autoPlanSwitch().getAttribute('aria-checked')).toBe('true');
    expect(threshold().value).toBe('8');
    expect(sprintLength().value).toBe('4');
    expect(explanationsSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('labels each switch BY REFERENCE to its visible text (the name cannot drift)', () => {
    mount();
    const labelledBy = autoPlanSwitch().getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe('Expand the plan automatically');
  });
});

describe('AiPlanningSettingsEditor — dependent controls + callouts', () => {
  it('keeps a dependent control PRESENT but disabled until its parent switch is on', () => {
    mount();
    expect(threshold().disabled).toBe(true);
    expect(sprintLength().disabled).toBe(true);

    fireEvent.click(autoPlanSwitch());

    expect(threshold().disabled).toBe(false);
    expect(sprintLength().disabled).toBe(true); // its own parent is still off
  });

  it('shows each group’s explanatory callout ONLY while that setting is live', () => {
    mount();
    const guardrail = /never creates work without you/;
    const rationale = /Short sprints keep plan/;
    expect(screen.queryByText(guardrail)).toBeNull();
    expect(screen.queryByText(rationale)).toBeNull();

    fireEvent.click(autoPlanSwitch());
    expect(screen.getByText(guardrail)).toBeTruthy();
    expect(screen.queryByText(rationale)).toBeNull();

    fireEvent.click(sprintSwitch());
    expect(screen.getByText(rationale)).toBeTruthy();
  });

  // MOTIR-4603 — the cadence's PAUSE CONDITIONS, in the user's words.
  it('names EVERY reason the cadence can pause for, and never a commercial one', () => {
    mount();
    fireEvent.click(autoPlanSwitch());

    const text = screen.getByText(/Auto-planning pauses while Motir cannot read your code/);
    expect(text).toBeTruthy();

    // ⚠️ A condition list that omits a live case is WORSE than none, because the
    // reader rules that case out. Every reason the cadence can actually skip for
    // is named — the two this card adds, and the four that were already there.
    const copy = text.textContent ?? '';
    for (const reason of [
      /no repository is connected/i, // code_blind — no repo
      /code index is out of date/i, // code_blind — badly stale
      /proposed plan is still undecided/i, // pending_proposal
      /ready work is above your threshold/i, // ready_set_healthy
      /nothing left to expand/i, // no_expandable_stub
      /plan does not include AI planning/i, // the entitlement pause (MOTIR-4596)
    ]) {
      expect(copy).toMatch(reason);
    }

    // ⚠️ AND IT NAMES NO INTERNAL COST REASON. If indexing is paused because an
    // allowance is spent, this says the index is out of date and what to do —
    // never why in commercial terms (MOTIR-4541). The real reason lives in the
    // admin panel.
    expect(copy).not.toMatch(/credit|allowance|quota|balance|billing|cost|spend|exhaust/i);

    // And it says the setting is untouched, because it is.
    expect(copy).toMatch(/setting is unchanged/i);
  });

  it('steps within the range and disables each button at its end', () => {
    mount({ aiSprintPlanningEnabled: true, aiSprintLengthDays: 1 });
    const decrease = screen.getByRole('button', { name: 'Decrease sprint length' });
    const increase = screen.getByRole('button', { name: 'Increase sprint length' });

    expect((decrease as HTMLButtonElement).disabled).toBe(true); // at the floor
    fireEvent.click(increase);
    expect(sprintLength().value).toBe('2');
    expect((decrease as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('AiPlanningSettingsEditor — validation', () => {
  it('surfaces a typed threshold error inline (role=alert) and BLOCKS Save', () => {
    mount({ aiAutoPlanEnabled: true });
    fireEvent.change(threshold(), { target: { value: '0' } });

    const alert = screen.getByTestId('ai-planning-threshold-error');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('Enter 1 or more ready items.');
    expect(threshold().getAttribute('aria-invalid')).toBe('true');
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByTestId('ai-planning-footer-hint').textContent).toBe(
      'Fix the highlighted fields to save',
    );
  });

  it('surfaces an out-of-range sprint length and blocks Save', () => {
    mount({ aiSprintPlanningEnabled: true });
    fireEvent.change(sprintLength(), { target: { value: '30' } });

    expect(screen.getByTestId('ai-planning-sprint-length-error').textContent).toContain(
      'Choose a sprint length between 1 and 14 days.',
    );
    expect(saveButton().disabled).toBe(true);
  });

  it('links the field’s hint AND its error slot via aria-describedby', () => {
    mount({ aiAutoPlanEnabled: true });
    fireEvent.change(threshold(), { target: { value: '0' } });

    const describedBy = threshold().getAttribute('aria-describedby')!.split(' ');
    expect(describedBy).toHaveLength(2);
    expect(document.getElementById(describedBy[0]!)?.textContent).toContain(
      'Motir starts drafting',
    );
    expect(document.getElementById(describedBy[1]!)).toBe(
      screen.getByTestId('ai-planning-threshold-error'),
    );
  });

  it('isWholeNumberInRange rejects blanks, fractions and out-of-range values', () => {
    expect(isWholeNumberInRange('5', 1, 14)).toBe(true);
    expect(isWholeNumberInRange(' 14 ', 1, 14)).toBe(true);
    expect(isWholeNumberInRange('', 1, 14)).toBe(false);
    expect(isWholeNumberInRange('2.5', 1, 14)).toBe(false);
    expect(isWholeNumberInRange('0', 1, 14)).toBe(false);
    expect(isWholeNumberInRange('15', 1, 14)).toBe(false);
    // Floor-only (the threshold's shape): no ceiling is applied client-side.
    expect(isWholeNumberInRange('5000', 1)).toBe(true);
    expect(isWholeNumberInRange('0', 1)).toBe(false);
  });
});

describe('AiPlanningSettingsEditor — save', () => {
  it('is inert until something is dirty, then PATCHes the whole panel', async () => {
    mount();
    expect(saveButton().disabled).toBe(true);

    fireEvent.click(autoPlanSwitch());
    expect(screen.getByTestId('ai-planning-footer-hint').textContent).toBe('Unsaved changes');
    expect(saveButton().disabled).toBe(false);

    fireEvent.click(saveButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/projects/PROD/ai-settings');
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      aiAutoPlanEnabled: true,
      aiAutoPlanThreshold: 5,
      aiSprintPlanningEnabled: false,
      aiSprintLengthDays: 2,
      aiGenerateExplanations: false,
      aiRecordPlanningMistakes: true, // ON, and sent on every save
      aiFinalCheck: true, // ON, and sent on every save (MOTIR-11264)
    });
    // Optimistic + reconciled: the footer settles back to not-dirty.
    await waitFor(() => expect(saveButton().disabled).toBe(true));
  });

  it('never sends a planner model — the key is not in the PATCH at all (MOTIR-7228)', async () => {
    mount({ aiGenerateExplanations: true });
    fireEvent.click(explanationsSwitch());
    fireEvent.click(saveButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toMatchObject({ aiGenerateExplanations: false });
    expect(Object.keys(body).some((k) => /model/i.test(k))).toBe(false);
  });

  it('REVERTS the optimistic snapshot when the save fails', async () => {
    fetchMock.mockResolvedValue(errorResponse(500));
    mount();

    fireEvent.click(autoPlanSwitch());
    fireEvent.click(saveButton());

    // The revert restores the committed snapshot, so the change is still dirty.
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    expect(screen.getByTestId('ai-planning-footer-hint').textContent).toBe('Unsaved changes');
  });

  it('slots a typed 422 under the field the server NAMES', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(422, {
        code: 'INVALID_AI_SETTINGS',
        field: 'aiAutoPlanThreshold',
        error: 'The auto-plan threshold must be between 1 and 1000.',
      }),
    );
    mount({ aiAutoPlanEnabled: true });

    fireEvent.change(threshold(), { target: { value: '5000' } });
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(screen.getByTestId('ai-planning-threshold-error').textContent).toContain(
        'must be between 1 and 1000',
      ),
    );
  });

  it('Cancel restores the last-persisted values', () => {
    mount({ aiAutoPlanEnabled: true, aiAutoPlanThreshold: 5 });
    fireEvent.change(threshold(), { target: { value: '9' } });
    expect(threshold().value).toBe('9');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(threshold().value).toBe('5');
    expect(saveButton().disabled).toBe(true);
  });
});

describe('AiPlanningSettingsEditor — read-only + not-connected states', () => {
  it('a non-admin gets the lock banner, disabled controls, and NO footer', () => {
    mount({}, { isAdmin: false });

    expect(screen.getByTestId('ai-planning-readonly-banner').textContent).toContain(
      'Only a project admin can change AI planning settings.',
    );
    expect((autoPlanSwitch() as HTMLButtonElement).disabled).toBe(true);
    expect(threshold().disabled).toBe(true);
    expect(screen.queryByTestId('ai-planning-save')).toBeNull();
  });

  it('an unconnected deployment states the reason on ALL FOUR cards, with no "Connect" CTA', () => {
    mount({}, { aiConfigured: false });

    const banners = screen.getAllByTestId('ai-planning-not-connected-banner');
    expect(banners).toHaveLength(4);
    expect(banners[0]!.textContent).toContain("Motir AI isn't connected.");
    expect(banners[0]!.textContent).toContain('stay inactive until this deployment is connected');
    // Deliberately no in-app provisioning affordance — that route does not exist.
    expect(screen.queryByRole('button', { name: /connect/i })).toBeNull();
    expect((explanationsSwitch() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('AiPlanningSettingsEditor — the auto-plan PAUSED state (MOTIR-1740)', () => {
  const banner = () => screen.getByTestId('ai-planning-paused-banner');

  it('says cadence is paused, and LINKS to the plan that is waiting', async () => {
    mount({ aiAutoPlanEnabled: true }, { pause: pauseView() });
    await act(async () => {});

    expect(banner().textContent).toContain(
      'Auto-plan is paused — a plan is waiting for your review.',
    );
    expect(banner().textContent).toContain('Motir drafts one plan at a time.');
    // The meta line reuses the Plans list's own strings for the same facts.
    expect(banner().textContent).toContain('planned 3 days ago');
    expect(banner().textContent).toContain('12 items');
    // The way OUT — the planning overlay over this page, where a plan is decided
    // (Story MOTIR-7883 · MOTIR-7890).
    const link = screen.getByTestId('ai-planning-paused-link');
    const overlay = withPlanningOverlay('/settings/project/ai-planning', {
      kind: 'project',
      sessionId: 's_8f2',
    });
    expect(planReads).toHaveBeenCalledExactlyOnceWith('/api/plans/pln_8f2');
    expect(link.getAttribute('href')).toBe(overlay);
    expect(link.textContent).toContain('Review the plan');
    fireEvent.click(link, { button: 0 });
    expect(shallowPush).toHaveBeenCalledExactlyOnceWith(overlay);
    expect(push).not.toHaveBeenCalled();
  });

  it('announces as a status region, and carries its meaning in WORDS, not colour', () => {
    mount({ aiAutoPlanEnabled: true }, { pause: pauseView() });

    expect(banner().getAttribute('role')).toBe('status');
    // The link's accessible name says where it goes; the glyphs are decorative.
    expect(screen.getByRole('link', { name: /Review the plan/ })).toBeTruthy();
    banner()
      .querySelectorAll('svg')
      .forEach((svg) => expect(svg.getAttribute('aria-hidden')).toBe('true'));
  });

  it('renders the OUT-OF-DATE face when the waiting plan has drifted', () => {
    mount({ aiAutoPlanEnabled: true }, { pause: pauseView({ stale: true, staleCount: 4 }) });

    const stale = screen.getByTestId('ai-planning-paused-stale');
    // The SHIPPED badge string, not a re-authored one.
    expect(stale.textContent).toContain('Out of date');
    expect(stale.textContent).toContain(
      'Your project has changed since this plan was drafted — 4 items may be out of date.',
    );
    // The pause message itself is unchanged — the drift is additive.
    expect(banner().textContent).toContain('a plan is waiting for your review');
  });

  it('shows NO drift treatment when the waiting plan is current', () => {
    mount({ aiAutoPlanEnabled: true }, { pause: pauseView() });

    expect(screen.queryByTestId('ai-planning-paused-stale')).toBeNull();
    expect(screen.queryByText('Out of date')).toBeNull();
  });

  it('omits the planned-when clause while the plan is still generating', () => {
    mount({ aiAutoPlanEnabled: true }, { pause: pauseView({ plannedWhenLabel: null }) });

    expect(banner().textContent).not.toContain('planned');
    expect(banner().textContent).toContain('12 items');
    expect(screen.getByTestId('ai-planning-paused-link')).toBeTruthy();
  });

  it('renders NOTHING paused when no plan is waiting — the card is exactly as 919 ships it', () => {
    mount({ aiAutoPlanEnabled: true }, { pause: null });

    expect(screen.queryByTestId('ai-planning-paused-banner')).toBeNull();
    // The guardrail callout is untouched by this state.
    expect(screen.getByText(/never creates work without you/)).toBeTruthy();
  });

  it('renders NOTHING paused while auto-plan is off — there is no cadence to pause', () => {
    mount({ aiAutoPlanEnabled: false }, { pause: pauseView() });

    expect(screen.queryByTestId('ai-planning-paused-banner')).toBeNull();

    // …and it appears the moment the reader turns auto-plan on.
    fireEvent.click(autoPlanSwitch());
    expect(screen.getByTestId('ai-planning-paused-banner')).toBeTruthy();
  });

  it('PAUSING IS NOT DISABLING — the switch and the stepper stay interactive', () => {
    mount({ aiAutoPlanEnabled: true, aiAutoPlanThreshold: 5 }, { pause: pauseView() });

    expect((autoPlanSwitch() as HTMLButtonElement).disabled).toBe(false);
    expect(threshold().disabled).toBe(false);
    expect(threshold().getAttribute('aria-disabled')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Increase threshold' }));
    expect(threshold().value).toBe('6');
  });

  it('saving settings while paused works normally', async () => {
    mount({ aiAutoPlanEnabled: true, aiAutoPlanThreshold: 5 }, { pause: pauseView() });

    fireEvent.change(threshold(), { target: { value: '9' } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toMatchObject({ aiAutoPlanEnabled: true, aiAutoPlanThreshold: 9 });
    // The banner is a server-derived state — a settings save does not clear it.
    expect(screen.getByTestId('ai-planning-paused-banner')).toBeTruthy();
  });
});

// ─── Planning mistakes — the fourth card (Story MOTIR-3331 · MOTIR-3352) ─────
// The copy is the deliverable here, so it is asserted as copy: the explanation
// has to carry five specific things, and the one most likely to be dropped is
// what turning the setting OFF costs, because it is the least flattering.
//
// The group also inherits the page's SAVE, which moved onto this card — it is
// now the last EDITABLE one (design-notes §4 as refined by §L3), and the
// read-only lessons door renders below the whole editor, from `page.tsx`.
describe('AiPlanningSettingsEditor — planning mistakes (MOTIR-3352)', () => {
  it('renders the group with its switch reflecting the stored value', () => {
    mount();
    expect(screen.getByText('Planning mistakes')).toBeTruthy();
    expect(recordMistakesSwitch().getAttribute('aria-checked')).toBe('true');

    cleanup();
    mount({ aiRecordPlanningMistakes: false });
    expect(recordMistakesSwitch().getAttribute('aria-checked')).toBe('false');
  });

  it('the explanation covers all FIVE points, in the product’s voice', () => {
    mount();
    const text = explanationText();

    // 1. WHAT IS CAPTURED — the correction, and explicitly not their work items
    //    or their code.
    expect(text).toContain('the correction itself');
    expect(text).toContain('not your work items and not your code');

    // 2. WHERE IT GOES — this project only.
    expect(text).toContain('stays with this project');
    expect(text).toContain('never shared with any other');

    // 3. WHAT IT DOES — later plans here are given the relevant ones.
    expect(text).toContain('drafts later plans here');
    expect(text).toContain('the same mistake is less likely twice');

    // 4. WHAT TURNING IT OFF COSTS — the point a vague brief drops. Both halves:
    //    no NEW ones are written, and the existing ones KEEP APPLYING.
    expect(text).toContain('Turn this off');
    expect(text).toContain('stops writing new ones down');
    expect(text).toContain('keeps applying until you stop it');

    // 5. WHERE TO LOOK — one step away, and it is a real link to the list.
    const link = screen.getByTestId(
      'ai-planning-record-mistakes-lessons-link',
    ) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/settings/project/ai-planning/lessons');
  });

  it('says the same thing as the lessons surface where the two touch', () => {
    // The design's own instruction (§L9): the setting's explanation and the
    // lessons surface describe ONE mechanism and a reader meets them minutes
    // apart. The shared vocabulary is what makes them read as one thing —
    // "correction", and the verb "apply".
    mount();
    const hint = screen.getByText(/When a plan turns out to be wrong/).textContent ?? '';

    // The lessons empty state opens with the same clause and the same verb.
    expect(hint).toContain('When a plan turns out to be wrong');
    expect(hint).toContain('Motir writes down the correction');
    expect(hint).toContain('applies it to every plan it drafts for this project');
  });

  it('uses NO implementation noun — the vocabulary rule the design states', () => {
    // §L9: not "lesson store", not "retired", not "scope", not "embedding", not
    // "injection". A reader is told what happens, in words they already have.
    mount();
    const copy = `${explanationText()} ${screen.getByText('Planning mistakes').textContent}`;
    for (const jargon of ['lesson store', 'corpus', 'retire', 'embedding', 'injection', 'scope']) {
      expect(copy.toLowerCase()).not.toContain(jargon);
    }
  });

  it('writes through the sparse PATCH when switched off', async () => {
    mount();

    fireEvent.click(recordMistakesSwitch());
    fireEvent.click(saveButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body['aiRecordPlanningMistakes']).toBe(false);
    // The rest of the group rides along untouched — the panel saves the whole
    // page, and the SERVER patch is what is sparse.
    expect(body['aiGenerateExplanations']).toBe(false);
  });

  it('a non-admin cannot change it — the surface follows the server, it does not re-derive the rule', () => {
    mount({}, { isAdmin: false });

    expect((recordMistakesSwitch() as HTMLButtonElement).disabled).toBe(true);
    // Disabled, never hidden: a reader who cannot change the setting is still
    // entitled to know what it does with their project's planning work.
    expect(explanationText()).toContain('the correction itself');
    expect(screen.getByText('Only a project admin can change AI planning settings.')).toBeTruthy();
  });

  it('hides the "where to look" link from a reader who may not read the lessons', () => {
    // The same `lesson:view` gate the door card renders under (design §L3). A
    // link to a page that would 403 is worse than no link; the destination
    // guards itself server-side either way.
    mount({}, { canViewLessons: false });

    expect(screen.queryByTestId('ai-planning-record-mistakes-lessons-link')).toBeNull();
    // The other four points survive — only the pointer is withheld.
    expect(explanationText()).toContain('Turn this off');
  });

  it('carries the page SAVE — it is now the last editable card', () => {
    // §4 as refined by §L3: the footer sits on the LAST EDITABLE card, and this
    // group is it. If it ever renders under `Planner` again, the read-only
    // lessons door would sit between the last control and its Save button.
    mount();

    // One save button on the page, not one per card.
    expect(screen.getAllByTestId('ai-planning-save')).toHaveLength(1);

    // And it lives INSIDE this group's card: walk up from the Save button to the
    // card that contains it and assert that card's heading is this one. A
    // position check on the DOM is what pins the footer's owner — asserting only
    // that a Save exists somewhere would pass with it still on `Planner`.
    const owningCard = saveButton().closest('section, div[class*="rounded"]');
    expect(owningCard?.textContent).toContain('Planning mistakes');
    expect(owningCard?.textContent).not.toContain('Draft a why for each item');
  });
});

describe('the planner model has left the copy, in both locales (MOTIR-7228)', () => {
  // Asserted on the CATALOGS, so a zh string that still names a model is caught
  // without rendering the room in zh. The model is a platform setting now.
  const catalogs = [
    ['en', enMessages],
    ['zh', zhMessages],
  ] as const;

  it('deletes the six picker keys and rewrites the sub-copy', () => {
    for (const [lang, messages] of catalogs) {
      const planner = messages.settings.aiPlanning.planner as Record<string, string>;
      for (const key of [
        'modelLabel',
        'modelHint',
        'modelDefault',
        'modelDefaultSecondary',
        'modelThorough',
        'modelFast',
      ]) {
        expect(planner[key], `${lang}.settings.aiPlanning.planner.${key}`).toBeUndefined();
      }
    }
    expect(enMessages.settings.aiPlanning.planner.subtitle).toBe(
      'How the planner writes for this project.',
    );
    expect(zhMessages.settings.aiPlanning.planner.subtitle).toBe('规划器如何为该项目撰写内容。');
  });

  it('the page description, the permission and the refusal line name no model', () => {
    for (const [lang, messages] of catalogs) {
      const lines = [
        messages.settings.aiPlanning.pageDescription,
        messages.settings.aiPlanning.planner.subtitle,
        messages.permissions.ai_configure.description,
        messages.settings.noAccess.section['ai-planning'],
      ];
      for (const line of lines) {
        expect(line, `${lang}: "${line}"`).not.toMatch(/model|模型/i);
      }
    }
  });
});

// ─── The final check (Story MOTIR-11262 · MOTIR-11264) ───────────────────────
// A second row on the Planner card (design-notes § MOTIR-11263 §1): on by
// default, a yellow callout only while it reads off, saved with the page, and
// disabled at its saved value — callout included — for a member without
// `ai:configure`.
describe('AiPlanningSettingsEditor — the final check (MOTIR-11264)', () => {
  const offCallout = () => screen.queryByTestId('ai-planning-final-check-off');

  it('is on by default, with its hint and no callout', () => {
    mount();
    expect(finalCheckSwitch().getAttribute('aria-checked')).toBe('true');
    expect(finalCheckSwitch().id).toBe('ai-planning-final-check');
    expect(screen.getByText(/reads its work items again in build order/)).toBeTruthy();
    expect(offCallout()).toBeNull();
  });

  it('switched off, it shows the callout, makes the page dirty and saves `aiFinalCheck: false`', async () => {
    mount();

    fireEvent.click(finalCheckSwitch());
    expect(finalCheckSwitch().getAttribute('aria-checked')).toBe('false');
    expect(offCallout()?.textContent).toBe(
      'Plans for this project are proposed without the final check. Each plan’s summary says it was not checked.',
    );
    expect(screen.getByTestId('ai-planning-footer-hint').textContent).toBe('Unsaved changes');

    fireEvent.click(saveButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body['aiFinalCheck']).toBe(false);
    expect(body['aiRecordPlanningMistakes']).toBe(true);
  });

  it('a saved off reads off, with the callout, and turning it back on clears it', () => {
    mount({ aiFinalCheck: false });
    expect(finalCheckSwitch().getAttribute('aria-checked')).toBe('false');
    expect(offCallout()).not.toBeNull();

    fireEvent.click(finalCheckSwitch());
    expect(offCallout()).toBeNull();
  });

  it('a non-admin sees it disabled at the saved value, the callout still shown, and the text marked disabled', () => {
    mount({ aiFinalCheck: false }, { isAdmin: false });

    const sw = finalCheckSwitch() as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    // A member should know why a plan says it was not checked.
    expect(offCallout()).not.toBeNull();
    // The faint ink on a disabled row is the WCAG 1.4.3 disabled exemption, and
    // the element says so (design-notes § MOTIR-11263 §1).
    const label = screen.getByText('Run the final check');
    expect(label.getAttribute('aria-disabled')).toBe('true');
  });
});
