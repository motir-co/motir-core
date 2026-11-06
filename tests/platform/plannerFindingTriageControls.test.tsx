// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createFormatter, createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import type { PlannerFindingActionResult } from '@/app/(admin)/admin/planner-findings/actions';
import type { PlannerFindingDetailDTO } from '@/lib/dto/plannerFindings';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { renderToHtml } from '../helpers/serverPageHarness';

/**
 * The planner finding TRIAGE CONTROLS (Story MOTIR-10353 · MOTIR-10525, design
 * MOTIR-10362 Panels 12–15). The five server actions are stubbed at their
 * module, `next/navigation` is mocked, and next-intl serves the real `en`
 * catalogue. The last block renders the detail page itself to check the
 * placement and the operator gate.
 */

const actions = vi.hoisted(() => ({
  setPlannerFindingAttributionAction: vi.fn(),
  recordPlannerFindingBugKeyAction: vi.fn(),
  dismissPlannerFindingAction: vi.fn(),
  restorePlannerFindingAction: vi.fn(),
  promotePlannerFindingAction: vi.fn(),
}));
const push = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
const gate = vi.hoisted(() => ({ principal: null as PlatformPrincipal | null }));
const get = vi.hoisted(() => vi.fn());

vi.mock('@/app/(admin)/admin/planner-findings/actions', () => actions);
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/admin/planner-findings/pf_1',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/components/ui/Toast', async () => {
  const actual =
    await vi.importActual<typeof import('@/components/ui/Toast')>('@/components/ui/Toast');
  return { ...actual, useToast: () => ({ toast }) };
});
vi.mock('@/lib/platform/pageGate', () => ({
  requirePlatformStaffPage: vi.fn(async () => gate.principal),
}));
vi.mock('@/lib/services/plannerFindingsService', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/plannerFindingsService')>(
    '@/lib/services/plannerFindingsService',
  );
  return { ...actual, plannerFindingsService: { get } };
});
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as 'platformAdmin' }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));

const { FindingTriageControls, looksLikeBugKey } =
  await import('@/app/(admin)/admin/planner-findings/_components/FindingTriageControls');
const { toPromoteDraft } =
  await import('@/app/(admin)/admin/planner-findings/_components/promotePrefill');
const { default: DetailPage } = await import('@/app/(admin)/admin/planner-findings/[id]/page');

const pf = en.platformAdmin.plannerFindings;
const lessonTypes = en.platformAdmin.lessons.type;

function detail(over: Partial<PlannerFindingDetailDTO> = {}): PlannerFindingDetailDTO {
  return {
    id: 'pf_1',
    source: 'in_loop',
    planner: 'hosted',
    attribution: 'unattributed',
    outcome: 'fixed',
    prediction: 'STOPS',
    site: 'leaf:MOTIR-12',
    planId: 'plan_7',
    planTitle: 'A plan',
    status: 'new',
    fingerprint: 'fp_1',
    lessonId: null,
    bugKey: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    whatHappened: 'The leaf named a file that does not exist.',
    evidence: 'read_file lib/x.ts → not found',
    correction: 'Name the real file.',
    rule: 'context-refs-exist',
    why: 'The pack never says to read the path.',
    fixDirection: 'Read every path at the baseline.',
    hostedCell: null,
    planpyCell: null,
    cardRef: null,
    authorModel: null,
    baselineBranch: null,
    baselineCommit: null,
    triageNote: null,
    triagedBy: null,
    triagedAt: null,
    cost: null,
    ...over,
  } as PlannerFindingDetailDTO;
}

const OK: PlannerFindingActionResult = {
  ok: true,
  finding: {} as Extract<PlannerFindingActionResult, { ok: true }>['finding'],
};

function mount(over: Partial<PlannerFindingDetailDTO> = {}, canTriage = true) {
  return renderWithIntl(<FindingTriageControls detail={detail(over)} canTriage={canTriage} />);
}

const button = (name: string | RegExp) => screen.getByRole('button', { name });
const queryButton = (name: string | RegExp) => screen.queryByRole('button', { name });

async function click(name: string | RegExp) {
  await act(async () => {
    fireEvent.click(button(name));
  });
}

async function pick(combobox: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name: combobox }));
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(actions)) fn.mockResolvedValue(OK);
});
afterEach(cleanup);

describe('placement and the operator gate', () => {
  it('renders nothing when the viewer cannot triage', () => {
    const { container } = mount({}, false);
    expect(container.innerHTML).toBe('');
  });

  it('renders the labelled Triage region when the viewer can', () => {
    mount();
    const region = screen.getByRole('region', { name: pf.triage.title });
    expect(region.getAttribute('data-testid')).toBe('planner-finding-triage');
  });

  it.each([
    ['support', false],
    ['operator', true],
    ['superadmin', true],
  ] as const)(
    'the page computes canTriage for %s and places the controls above the narrative',
    async (role, shown) => {
      gate.principal = { userId: 'u_1', email: 'staff@moooon.net', role };
      get.mockResolvedValue({ detail: detail(), triagedByName: null });
      const html = await renderToHtml(
        await DetailPage({ params: Promise.resolve({ id: 'pf_1' }) }),
      );
      expect(html.includes('data-testid="planner-finding-triage"')).toBe(shown);
      if (shown) {
        expect(html.indexOf('planner-finding-triage')).toBeLessThan(html.indexOf(pf.detail.what));
        expect(html.indexOf('</header>')).toBeLessThan(html.indexOf('planner-finding-triage'));
      }
    },
  );

  it('the component imports only the five actions and renders no triage state', () => {
    const source = readFileSync(
      'app/(admin)/admin/planner-findings/_components/FindingTriageControls.tsx',
      'utf8',
    );
    expect(source).not.toMatch(/lib\/services|lib\/ai\/|lib\/repositories|audit/i);
    expect(source).not.toMatch(/TriageChip|triagedBy|triageNote|status\.\w+'/);
    mount({ status: 'filed_as_bug', bugKey: 'MOTIR-42', triageNote: 'n' });
    expect(screen.queryByText(/Bug MOTIR-42/)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('availability per status', () => {
  const ALL = [pf.attr.open, pf.promote.open, pf.bug.open, pf.dismiss.open];

  it.each([
    ['new', ALL],
    ['filed_as_bug', ALL],
    ['promoted_to_lesson', [pf.attr.open, pf.bug.open, pf.dismiss.open]],
    ['dismissed', [pf.dismiss.restore]],
    ['escalated_by_a_newer_motir_ai', [pf.attr.open, pf.bug.open, pf.dismiss.open]],
  ])('%s offers exactly its acts', (status, offered) => {
    mount({ status });
    const names = [...ALL, pf.dismiss.restore];
    for (const name of names) {
      if (offered.includes(name)) expect(queryButton(name)).not.toBeNull();
      else expect(queryButton(name)).toBeNull();
    }
  });

  it('a filed bug opens its key prefilled, so it can be corrected', () => {
    mount({ status: 'filed_as_bug', bugKey: 'MOTIR-42' });
    fireEvent.click(button(pf.bug.open));
    expect((screen.getByLabelText(pf.bug.label) as HTMLInputElement).value).toBe('MOTIR-42');
  });

  it('the attribution select starts at the finding’s value and lists the four values', async () => {
    mount({ attribution: 'model' });
    fireEvent.click(button(pf.attr.open));
    const select = screen.getByRole('combobox', { name: pf.attr.label });
    expect(select.textContent).toContain(pf.attribution.model);
    fireEvent.click(select);
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual([
      pf.attribution.code,
      pf.attribution.corpus,
      pf.attribution.model,
      pf.attribution.unattributed,
    ]);
  });

  it('an attribution the catalogue lacks shows as the raw value', () => {
    mount({ attribution: 'tooling' });
    fireEvent.click(button(pf.attr.open));
    expect(screen.getByRole('combobox', { name: pf.attr.label }).textContent).toContain('tooling');
  });
});

describe('set attribution', () => {
  it('saves a changed value with one action call and says what it set', async () => {
    mount();
    fireEvent.click(button(pf.attr.open));
    expect(screen.getByText(pf.attr.hint)).toBeTruthy();
    expect(screen.getByText(pf.attr.regroupNote)).toBeTruthy();
    expect(button(pf.attr.save).hasAttribute('disabled')).toBe(true);
    await pick(pf.attr.label, pf.attribution.corpus);
    expect(button(pf.attr.save).hasAttribute('disabled')).toBe(false);
    await click(pf.attr.save);
    expect(actions.setPlannerFindingAttributionAction).toHaveBeenCalledTimes(1);
    expect(actions.setPlannerFindingAttributionAction).toHaveBeenCalledWith('pf_1', {
      attribution: 'corpus',
    });
    expect(screen.getByRole('status').textContent).toBe('Attribution set to Corpus.');
    expect(screen.queryByTestId('planner-finding-attribution')).toBeNull();
  });

  it('choosing the current value again leaves Save disabled', async () => {
    mount({ attribution: 'code' });
    fireEvent.click(button(pf.attr.open));
    await pick(pf.attr.label, pf.attribution.code);
    expect(button(pf.attr.save).hasAttribute('disabled')).toBe(true);
  });
});

describe('promote to lesson', () => {
  it('toPromoteDraft prefills from the finding, falling back field by field', () => {
    expect(toPromoteDraft(detail())).toEqual({
      title: 'leaf:MOTIR-12',
      why: 'The pack never says to read the path.',
      howToApply: 'Read every path at the baseline.',
      mistakeType: 'regular_planning',
    });
    expect(toPromoteDraft(detail({ why: '  ', fixDirection: null }))).toEqual({
      title: 'leaf:MOTIR-12',
      why: 'read_file lib/x.ts → not found',
      howToApply: 'Name the real file.',
      mistakeType: 'regular_planning',
    });
    expect(
      toPromoteDraft(
        detail({ site: ' ', why: null, evidence: '', fixDirection: ' ', correction: null }),
      ),
    ).toEqual({ title: '', why: '', howToApply: '', mistakeType: 'regular_planning' });
  });

  it('opens the prefilled form, refuses a blank field, and sends the edited values on confirm', async () => {
    mount();
    fireEvent.click(button(pf.promote.open));
    const form = screen.getByTestId('planner-finding-promote-form');
    expect(within(form).getByText(pf.promote.title)).toBeTruthy();
    expect(within(form).getByText(pf.promote.intro)).toBeTruthy();
    expect((screen.getByLabelText(pf.promote.fieldTitle) as HTMLInputElement).value).toBe(
      'leaf:MOTIR-12',
    );
    expect(screen.getByRole('combobox', { name: pf.promote.fieldType }).textContent).toContain(
      lessonTypes.regular_planning,
    );

    type(pf.promote.fieldWhy, '   ');
    expect(screen.getByText(pf.promote.blank)).toBeTruthy();
    expect(button(pf.promote.review).hasAttribute('disabled')).toBe(true);

    type(pf.promote.fieldWhy, '  Edited why.  ');
    type(pf.promote.fieldTitle, 'Edited title');
    await pick(pf.promote.fieldType, lessonTypes.planning_craft);
    fireEvent.click(button(pf.promote.review));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(pf.promote.confirmTitle)).toBeTruthy();
    expect(within(dialog).getByText(pf.promote.confirmBody)).toBeTruthy();
    expect(actions.promotePlannerFindingAction).not.toHaveBeenCalled();

    await click(pf.promote.confirm);
    expect(actions.promotePlannerFindingAction).toHaveBeenCalledTimes(1);
    expect(actions.promotePlannerFindingAction).toHaveBeenCalledWith('pf_1', {
      title: 'Edited title',
      why: 'Edited why.',
      howToApply: 'Read every path at the baseline.',
      mistakeType: 'planning_craft',
    });
    expect(screen.queryByTestId('planner-finding-promote-form')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(pf.promote.saved);
  });

  it('a lesson created but not linked is named once, linked, and never offered again', async () => {
    actions.promotePlannerFindingAction.mockResolvedValue({
      ok: false,
      code: 'LESSON_NOT_LINKED',
      lessonId: 'lsn_77',
    });
    mount();
    fireEvent.click(button(pf.promote.open));
    fireEvent.click(button(pf.promote.review));
    await click(pf.promote.confirm);
    const alert = screen.getByTestId('planner-finding-lesson-not-linked');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain(pf.refused.lessonNotLinked);
    expect(
      within(alert).getByRole('link', { name: pf.detail.lessonLink }).getAttribute('href'),
    ).toBe('/admin/planning-lessons/lsn_77');
    expect(queryButton(pf.promote.open)).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByTestId('planner-finding-promote-form')).toBeNull();
    expect(actions.promotePlannerFindingAction).toHaveBeenCalledTimes(1);
  });

  it('a duplicate lesson keeps the form open and shows the refusal’s detail, with no retry', async () => {
    actions.promotePlannerFindingAction.mockResolvedValue({
      ok: false,
      code: 'DUPLICATE_LESSON',
      detail: 'A lesson titled “Read paths” already exists.',
    });
    mount();
    fireEvent.click(button(pf.promote.open));
    fireEvent.click(button(pf.promote.review));
    await click(pf.promote.confirm);
    const error = screen.getByTestId('planner-finding-triage-error');
    expect(error.textContent).toContain(pf.promote.duplicate);
    expect(error.textContent).toContain('A lesson titled “Read paths” already exists.');
    expect(error.textContent).not.toContain(pf.refused.unavailable);
    expect(within(error).queryByRole('button', { name: pf.triage.retry })).toBeNull();
    expect(screen.getByTestId('planner-finding-promote-form')).toBeTruthy();
  });
});

describe('record a bug key', () => {
  it('refuses what does not look like a key and records one that does', async () => {
    expect(looksLikeBugKey('MOTIR-123')).toBe(true);
    expect(looksLikeBugKey(' motir-123 ')).toBe(true);
    expect(looksLikeBugKey('motir')).toBe(false);
    expect(looksLikeBugKey('123')).toBe(false);
    expect(looksLikeBugKey('')).toBe(false);

    mount();
    fireEvent.click(button(pf.bug.open));
    expect(screen.getByText(pf.bug.hint)).toBeTruthy();
    expect(screen.getByPlaceholderText(pf.bug.placeholder)).toBeTruthy();
    expect(button(pf.bug.save).hasAttribute('disabled')).toBe(true);
    type(pf.bug.label, 'motir');
    expect(screen.getByText(pf.bug.invalid)).toBeTruthy();
    expect(button(pf.bug.save).hasAttribute('disabled')).toBe(true);
    type(pf.bug.label, 'motir-123');
    expect(screen.queryByText(pf.bug.invalid)).toBeNull();
    await click(pf.bug.save);
    expect(actions.recordPlannerFindingBugKeyAction).toHaveBeenCalledWith('pf_1', 'motir-123');
    expect(screen.getByRole('status').textContent).toBe('Recorded bug MOTIR-123.');
    expect(document.body.textContent).not.toMatch(/filed from|created a bug|work item/i);
  });
});

describe('dismiss and restore', () => {
  it('dismisses with a trimmed note after the confirmation', async () => {
    mount();
    fireEvent.click(button(pf.dismiss.open));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(pf.dismiss.title)).toBeTruthy();
    expect(within(dialog).getByText(pf.dismiss.body)).toBeTruthy();
    const reason = screen.getByLabelText(pf.dismiss.reasonLabel) as HTMLTextAreaElement;
    expect(reason.maxLength).toBe(280);
    expect(reason.placeholder).toBe(pf.dismiss.reasonPlaceholder);
    type(pf.dismiss.reasonLabel, '  Duplicate of pf_0.  ');
    await click(pf.dismiss.confirm);
    expect(actions.dismissPlannerFindingAction).toHaveBeenCalledWith('pf_1', 'Duplicate of pf_0.');
    expect(screen.getByRole('status').textContent).toBe(pf.dismiss.saved);
  });

  it('a blank note reaches the action as undefined', async () => {
    mount();
    fireEvent.click(button(pf.dismiss.open));
    type(pf.dismiss.reasonLabel, '   ');
    await click(pf.dismiss.confirm);
    expect(actions.dismissPlannerFindingAction).toHaveBeenCalledWith('pf_1', undefined);
  });

  it('restore needs no confirmation', async () => {
    mount({ status: 'dismissed' });
    expect(screen.getByTestId('planner-finding-restore')).toBeTruthy();
    await click(pf.dismiss.restore);
    expect(actions.restorePlannerFindingAction).toHaveBeenCalledWith('pf_1');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe(pf.dismiss.restored);
  });
});

describe('every result code has its own text', () => {
  const RETRYABLE = [
    ['NOT_PERMITTED', pf.refused.notPermitted],
    ['INVALID', pf.refused.invalid],
    ['UNAVAILABLE', pf.refused.unavailable],
    ['FAILED', pf.refused.failed],
  ] as const;

  it.each(RETRYABLE)(
    '%s on attribution keeps the choice and offers Try again',
    async (code, text) => {
      actions.setPlannerFindingAttributionAction.mockResolvedValueOnce({ ok: false, code });
      mount();
      fireEvent.click(button(pf.attr.open));
      await pick(pf.attr.label, pf.attribution.corpus);
      await click(pf.attr.save);
      const error = screen.getByTestId('planner-finding-triage-error');
      expect(error.getAttribute('role')).toBe('alert');
      expect(error.textContent).toContain(text);
      expect(screen.getByRole('combobox', { name: pf.attr.label }).textContent).toContain(
        pf.attribution.corpus,
      );
      await click(pf.triage.retry);
      expect(actions.setPlannerFindingAttributionAction).toHaveBeenCalledTimes(2);
      expect(actions.setPlannerFindingAttributionAction).toHaveBeenLastCalledWith('pf_1', {
        attribution: 'corpus',
      });
      expect(screen.queryByTestId('planner-finding-triage-error')).toBeNull();
    },
  );

  it.each(RETRYABLE)('%s on promote keeps every edited field', async (code, text) => {
    actions.promotePlannerFindingAction.mockResolvedValueOnce({ ok: false, code });
    mount();
    fireEvent.click(button(pf.promote.open));
    type(pf.promote.fieldTitle, 'Kept title');
    fireEvent.click(button(pf.promote.review));
    await click(pf.promote.confirm);
    expect(screen.getByTestId('planner-finding-triage-error').textContent).toContain(text);
    expect((screen.getByLabelText(pf.promote.fieldTitle) as HTMLInputElement).value).toBe(
      'Kept title',
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it.each(RETRYABLE)('%s on a bug key keeps the key', async (code, text) => {
    actions.recordPlannerFindingBugKeyAction.mockResolvedValueOnce({ ok: false, code });
    mount();
    fireEvent.click(button(pf.bug.open));
    type(pf.bug.label, 'MOTIR-9');
    await click(pf.bug.save);
    expect(screen.getByTestId('planner-finding-triage-error').textContent).toContain(text);
    expect((screen.getByLabelText(pf.bug.label) as HTMLInputElement).value).toBe('MOTIR-9');
  });

  it.each(RETRYABLE)('%s on dismiss keeps the dialog and the reason', async (code, text) => {
    actions.dismissPlannerFindingAction.mockResolvedValueOnce({ ok: false, code });
    mount();
    fireEvent.click(button(pf.dismiss.open));
    type(pf.dismiss.reasonLabel, 'Kept reason');
    await click(pf.dismiss.confirm);
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByTestId('planner-finding-triage-error').textContent).toContain(text);
    expect((screen.getByLabelText(pf.dismiss.reasonLabel) as HTMLTextAreaElement).value).toBe(
      'Kept reason',
    );
  });

  it.each(RETRYABLE)('%s on restore says so beside Restore', async (code, text) => {
    actions.restorePlannerFindingAction.mockResolvedValueOnce({ ok: false, code });
    mount({ status: 'dismissed' });
    await click(pf.dismiss.restore);
    expect(screen.getByTestId('planner-finding-triage-error').textContent).toContain(text);
  });

  it('GONE says so and returns to the list', async () => {
    actions.recordPlannerFindingBugKeyAction.mockResolvedValueOnce({ ok: false, code: 'GONE' });
    mount();
    fireEvent.click(button(pf.bug.open));
    type(pf.bug.label, 'MOTIR-9');
    await click(pf.bug.save);
    expect(toast).toHaveBeenCalledWith({ variant: 'error', title: pf.refused.gone });
    expect(push).toHaveBeenCalledWith('/admin/planner-findings');
  });

  it('UNCHANGED is a warning that closes the form', async () => {
    actions.setPlannerFindingAttributionAction.mockResolvedValueOnce({
      ok: false,
      code: 'UNCHANGED',
    });
    mount();
    fireEvent.click(button(pf.attr.open));
    await pick(pf.attr.label, pf.attribution.code);
    await click(pf.attr.save);
    expect(screen.getByRole('status').textContent).toBe(pf.noop);
    expect(screen.queryByTestId('planner-finding-attribution')).toBeNull();
    expect(screen.queryByTestId('planner-finding-triage-error')).toBeNull();
  });
});

describe('in flight and cancel', () => {
  it('disables every control, shows Saving…, and never sends twice', async () => {
    let finish: (value: PlannerFindingActionResult) => void = () => {};
    actions.recordPlannerFindingBugKeyAction.mockReturnValueOnce(
      new Promise<PlannerFindingActionResult>((resolve) => {
        finish = resolve;
      }),
    );
    mount();
    fireEvent.click(button(pf.bug.open));
    type(pf.bug.label, 'MOTIR-9');
    await click(pf.bug.save);
    const saving = button(pf.triage.saving);
    expect(saving.hasAttribute('disabled')).toBe(true);
    for (const name of [pf.attr.open, pf.promote.open, pf.bug.open, pf.dismiss.open]) {
      expect(button(name).hasAttribute('disabled')).toBe(true);
    }
    expect(button(pf.triage.cancel).hasAttribute('disabled')).toBe(true);
    expect((screen.getByLabelText(pf.bug.label) as HTMLInputElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.click(saving);
    });
    expect(actions.recordPlannerFindingBugKeyAction).toHaveBeenCalledTimes(1);
    await act(async () => finish(OK));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Recorded bug MOTIR-9.'),
    );
  });

  it('Cancel closes a form or dialog without a call and discards the draft', async () => {
    mount();
    fireEvent.click(button(pf.bug.open));
    type(pf.bug.label, 'MOTIR-9');
    fireEvent.click(button(pf.triage.cancel));
    expect(screen.queryByTestId('planner-finding-bug-key')).toBeNull();
    fireEvent.click(button(pf.bug.open));
    expect((screen.getByLabelText(pf.bug.label) as HTMLInputElement).value).toBe('');

    fireEvent.click(button(pf.dismiss.open));
    type(pf.dismiss.reasonLabel, 'nope');
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: pf.triage.cancel }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    fireEvent.click(button(pf.dismiss.open));
    expect((screen.getByLabelText(pf.dismiss.reasonLabel) as HTMLTextAreaElement).value).toBe('');

    for (const fn of Object.values(actions)) expect(fn).not.toHaveBeenCalled();
  });

  it('Cancel on the promote confirmation returns to the form with the draft', async () => {
    mount();
    fireEvent.click(button(pf.promote.open));
    type(pf.promote.fieldTitle, 'Draft title');
    fireEvent.click(button(pf.promote.review));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: pf.triage.cancel }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect((screen.getByLabelText(pf.promote.fieldTitle) as HTMLInputElement).value).toBe(
      'Draft title',
    );
    expect(actions.promotePlannerFindingAction).not.toHaveBeenCalled();
  });
});
