'use client';

import { useCallback, useId, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  AlertCircle,
  ArrowRight,
  Bot,
  Calendar,
  CloudOff,
  Info,
  Lock,
  Minus,
  NotebookPen,
  PauseCircle,
  Plus,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { PlanOverlayDoor } from '@/components/planning/PlanOverlayDoor';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SwitchRow } from '@/components/settings/SwitchRow';
import { useToast } from '@/components/ui/Toast';
import {
  AI_AUTO_PLAN_THRESHOLD_MAX,
  AI_AUTO_PLAN_THRESHOLD_MIN,
  AI_SPRINT_LENGTH_DAYS_MAX,
  AI_SPRINT_LENGTH_DAYS_MIN,
} from '@/lib/projectAiSettings/limits';
import type { ProjectAiSettingsDto } from '@/lib/dto/projectAiSettings';

// AiPlanningSettingsEditor (Story 7.13 · Subtask MOTIR-919) — the AI-planning
// project settings panel, per design/ai-settings/ai-planning-settings.mock.html
// + design-notes.md (§1 placement, §5 primitives, §6 copy, §8 states, §9 tokens,
// §10 a11y).
//
// A pure client consumer of the MOTIR-919 `PATCH /api/projects/[key]/ai-settings`
// endpoint (the settings-page fetch idiom, mirroring EstimationSettingsEditor —
// NOT a server action): the Save is optimistic-with-reconcile (the committed
// snapshot flips immediately, reverts + toasts on failure). It never touches the
// service layer — the route → projectAiSettingsService → the MOTIR-915
// repository methods is the only path to the columns. The server re-gates the
// write (assertCanManage), so `isAdmin` here only governs whether the edit
// affordances render.
//
// FOUR cards, one shared footer on the LAST EDITABLE card governing the whole
// page's dirty state — four decisions with different blast radius (when to
// expand · how to pack sprints · whether explanations are drafted · whether
// Motir writes down what it got wrong), and a project may want one without the
// others:
//   * Auto-plan          — aiAutoPlanEnabled + aiAutoPlanThreshold
//   * AI sprint planning — aiSprintPlanningEnabled + aiSprintLengthDays
//   * Planner            — aiGenerateExplanations (the Story-7.4 column
//                          SURFACED here, never duplicated) + the
//                          data-practice callout. NO model control: the model
//                          that plans is a platform setting, never a project one
//                          (MOTIR-7228; design-notes AMENDMENT 2026-10, which
//                          also re-argues why the callout stays on this card)
//   * Planning mistakes  — aiRecordPlanningMistakes (Story MOTIR-3331 ·
//                          MOTIR-3352)
//
// ⚠️ THE FOOTER MOVED FROM `Planner` TO `Planning mistakes` (MOTIR-3352). The
// rule is design-notes §4 as REFINED by §L3: the footer sits on the last
// EDITABLE card. §L3 could say "which is the same card today, so nothing moves"
// because the lessons DOOR it added is read-only — a Save button rendered
// beneath a list would appear to govern the list. This card is editable, so it
// is now the last one and the footer follows it. The door card still renders
// BELOW this whole editor, from `page.tsx`, and is unaffected.
//
// A dependent control is present but DISABLED, never hidden (the reader sees
// what the switch unlocks); its group's explanatory callout appears only when
// the setting is live, so the default view stays quiet.
//
// MOTIR-1740 adds ONE state to the Auto-plan card — the PAUSED banner (§8 state
// 7): auto-plan is on, but MOTIR-916's watcher is skipping this project because
// a plan is still waiting for a decision. Pausing is NOT disabling: the switch,
// the stepper and Save stay fully interactive while a plan waits.
//
// Colour strictly `--el-*` (finding #54) with the three callouts on three
// DISTINCT tint slots + `--el-text-strong` text (AA, finding #35); shape via the
// element-semantic tokens. The stepper is a COMPOSITION of a number input and
// two icon buttons — not a new primitive.

/**
 * The auto-plan PAUSED state (Subtask MOTIR-1740 · design §8 state 7, panel 6),
 * as the server hands it to the client: the waiting plan's identity + size, its
 * drift verdict, and its relative time ALREADY formatted (against the request's
 * shared `now`, so nothing here derives a time client-side). `null` — the common
 * case — means nothing is waiting and no paused treatment renders at all.
 */
export interface AutoPlanPauseView {
  planId: string;
  /** `null` while the plan is still `generating` (no `plannedAt` yet). */
  plannedWhenLabel: string | null;
  itemCount: number;
  stale: boolean;
  staleCount: number;
}

/** The panel's working state — the DTO in the form the controls edit. */
interface WorkingSettings {
  autoPlanEnabled: boolean;
  autoPlanThreshold: string;
  sprintPlanningEnabled: boolean;
  sprintLengthDays: string;
  generateExplanations: boolean;
  recordPlanningMistakes: boolean;
  finalCheck: boolean;
}

/** The persisted DTO → the panel's working state. */
function toWorking(dto: ProjectAiSettingsDto): WorkingSettings {
  return {
    autoPlanEnabled: dto.aiAutoPlanEnabled,
    autoPlanThreshold: String(dto.aiAutoPlanThreshold),
    sprintPlanningEnabled: dto.aiSprintPlanningEnabled,
    sprintLengthDays: String(dto.aiSprintLengthDays),
    generateExplanations: dto.aiGenerateExplanations,
    // Always a real boolean off the DTO — the mapper has already resolved the
    // nullable column's "never written" state to ON (MOTIR-3349), so the panel
    // never has to know the default.
    recordPlanningMistakes: dto.aiRecordPlanningMistakes,
    finalCheck: dto.aiFinalCheck,
  };
}

/** Whether two working states are equal (the dirty check). Exported for the test. */
export function aiSettingsEqual(a: WorkingSettings, b: WorkingSettings): boolean {
  return (
    a.autoPlanEnabled === b.autoPlanEnabled &&
    a.autoPlanThreshold === b.autoPlanThreshold &&
    a.sprintPlanningEnabled === b.sprintPlanningEnabled &&
    a.sprintLengthDays === b.sprintLengthDays &&
    a.generateExplanations === b.generateExplanations &&
    a.recordPlanningMistakes === b.recordPlanningMistakes &&
    a.finalCheck === b.finalCheck
  );
}

/**
 * A stepper value is valid when it is a whole number at or above `min`, and at
 * or below `max` when one is given.
 *
 * The client MIRRORS — never replaces — the MOTIR-915 server validation, and it
 * mirrors exactly what the design's copy promises per field: the threshold is
 * checked against its FLOOR only ("Enter 1 or more ready items."), the sprint
 * length against its full RANGE ("Choose a sprint length between 1 and 14
 * days."). The threshold's app-level ceiling (`AI_AUTO_PLAN_THRESHOLD_MAX`) is
 * still enforced — by the stepper's `+` button, which stops there, and by the
 * server, whose typed 422 names the field so its message lands in that same
 * slot. Inventing a second client message for a bound the design never wrote
 * would be copy the asset does not specify. Exported for the test.
 */
export function isWholeNumberInRange(raw: string, min: number, max?: number): boolean {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return false;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < min) return false;
  return max === undefined || value <= max;
}

export function AiPlanningSettingsEditor({
  projectKey,
  projectName,
  settings,
  isAdmin,
  aiConfigured,
  canViewLessons = false,
  pause = null,
  providerTableUrl = null,
}: {
  projectKey: string;
  projectName: string;
  settings: ProjectAiSettingsDto;
  isAdmin: boolean;
  aiConfigured: boolean;
  /** Whether the actor may read this project's lessons (`lesson:view`,
   *  MOTIR-3336) — the SAME gate the door card below the editor renders under
   *  (design §L3). Governs only the explanation's "where to look" link;
   *  defaults to `false` so a caller that has not resolved the permission shows
   *  no link rather than a link that 403s. */
  canViewLessons?: boolean;
  pause?: AutoPlanPauseView | null;
  /**
   * The absolute url of the published provider table, or `null` on a build that
   * has not configured the legal manifest.
   *
   * Resolved SERVER-side (`lib/legal/links.ts` is `server-only`) and passed down,
   * which is the idiom MOTIR-4010 established for all three legal-linking
   * surfaces — it also keeps the operator's document list out of the client
   * bundle. `null` is the unconfigured build and is the common case for the open
   * product, so it is a real arm rather than a defensive default.
   */
  providerTableUrl?: string | null;
}) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const { toast } = useToast();

  // `committed` is the last-persisted state (the optimistic snapshot target);
  // `working` holds the in-flight edits. dirty = working ≠ committed.
  const [committed, setCommitted] = useState<WorkingSettings>(() => toWorking(settings));
  const [working, setWorking] = useState<WorkingSettings>(() => toWorking(settings));
  const [saving, setSaving] = useState(false);
  // A typed server rejection (422), slotted under the field it names.
  const [serverError, setServerError] = useState<{ field: string; message: string } | null>(null);

  // Every control is inert when the actor can't write, or when this deployment
  // has no Motir AI connection to run the cadence (§8.6 — stated reason, no
  // invented "Connect" CTA).
  const locked = !isAdmin || !aiConfigured;

  const patch = useCallback((next: Partial<WorkingSettings>) => {
    setWorking((prev) => ({ ...prev, ...next }));
    setServerError(null);
  }, []);

  // Floor-only, per the design's copy (§8.3 + §6): the ceiling is enforced by
  // the stepper's `+` button and by the server's typed 422.
  const thresholdValid = isWholeNumberInRange(
    working.autoPlanThreshold,
    AI_AUTO_PLAN_THRESHOLD_MIN,
  );
  const sprintLengthValid = isWholeNumberInRange(
    working.sprintLengthDays,
    AI_SPRINT_LENGTH_DAYS_MIN,
    AI_SPRINT_LENGTH_DAYS_MAX,
  );
  const valid = thresholdValid && sprintLengthValid;
  const dirty = !aiSettingsEqual(working, committed);
  const canSave = isAdmin && !locked && dirty && valid && !saving;

  const reset = useCallback(() => {
    setWorking(committed);
    setServerError(null);
  }, [committed]);

  const save = useCallback(() => {
    if (!isAdmin || locked || !valid) return;
    const prev = committed;
    const next = working;
    // Optimistic: the committed snapshot flips now; reconcile / revert on the
    // response. The success response IS the confirmation — no router.refresh()
    // (CLAUDE.md § page state: refreshing the cell's own value causes a revert).
    setCommitted(next);
    setSaving(true);
    setServerError(null);
    void fetch(`/api/projects/${encodeURIComponent(projectKey)}/ai-settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        aiAutoPlanEnabled: next.autoPlanEnabled,
        aiAutoPlanThreshold: Number(next.autoPlanThreshold),
        aiSprintPlanningEnabled: next.sprintPlanningEnabled,
        aiSprintLengthDays: Number(next.sprintLengthDays),
        aiGenerateExplanations: next.generateExplanations,
        aiRecordPlanningMistakes: next.recordPlanningMistakes,
        aiFinalCheck: next.finalCheck,
      }),
    })
      .then(async (res) => {
        if (res.ok) {
          setSaving(false);
          toast({
            variant: 'success',
            title: t('aiPlanning.savedTitle'),
            description: t('aiPlanning.savedDesc', { project: projectName }),
          });
          return;
        }
        // Revert the optimistic snapshot, then route the failure: a typed 422
        // names the offending field, so its message lands in that field's own
        // slot (§8.3) instead of a generic toast.
        setCommitted(prev);
        setSaving(false);
        const body = (await res.json().catch(() => null)) as {
          field?: string;
          error?: string;
        } | null;
        if (res.status === 422 && body?.field && body.error) {
          setServerError({ field: body.field, message: body.error });
          return;
        }
        toast({
          variant: 'error',
          title: t('aiPlanning.errorTitle'),
          description: t('aiPlanning.saveError'),
        });
      })
      .catch(() => {
        setCommitted(prev);
        setSaving(false);
        toast({
          variant: 'error',
          title: t('aiPlanning.errorTitle'),
          description: t('aiPlanning.saveError'),
        });
      });
  }, [isAdmin, locked, valid, committed, working, projectKey, projectName, t, toast]);

  const notConnected = !aiConfigured ? <NotConnectedBanner /> : null;

  return (
    <div className="flex flex-col gap-5" data-testid="ai-planning-settings">
      {/* ── Card 1 · Auto-plan ─────────────────────────────────────────────── */}
      <SettingsCard
        icon={<Sparkles className="size-[17px]" aria-hidden />}
        title={t('aiPlanning.autoPlan.title')}
        subtitle={t('aiPlanning.autoPlan.subtitle')}
      >
        {notConnected}
        {!isAdmin ? <ReadOnlyBanner /> : null}
        {/* The PAUSE (MOTIR-1740 · §8 state 7). It follows the SWITCH the reader
            is currently looking at, exactly like the guardrail callout below:
            with auto-plan turned off there is no cadence to be paused, so
            claiming otherwise beside an off switch would contradict itself.
            Pausing is NOT disabling — nothing below is disabled by it. */}
        {working.autoPlanEnabled && pause ? <PausedBanner pause={pause} /> : null}

        <SwitchRow
          checked={working.autoPlanEnabled}
          onCheckedChange={(v) => patch({ autoPlanEnabled: v })}
          disabled={locked}
          label={t('aiPlanning.autoPlan.enableLabel')}
          hint={t('aiPlanning.autoPlan.enableHint')}
        />

        <DependentField
          label={t('aiPlanning.autoPlan.thresholdLabel')}
          hint={t('aiPlanning.autoPlan.thresholdHint')}
          disabled={locked || !working.autoPlanEnabled}
        >
          {(ids) => (
            <>
              <Stepper
                value={working.autoPlanThreshold}
                onChange={(v) => patch({ autoPlanThreshold: v })}
                min={AI_AUTO_PLAN_THRESHOLD_MIN}
                max={AI_AUTO_PLAN_THRESHOLD_MAX}
                disabled={locked || !working.autoPlanEnabled}
                unit={t('aiPlanning.autoPlan.thresholdUnit')}
                ariaLabel={t('aiPlanning.autoPlan.thresholdLabel')}
                decreaseLabel={t('aiPlanning.autoPlan.decreaseAria')}
                increaseLabel={t('aiPlanning.autoPlan.increaseAria')}
                describedBy={ids.describedBy}
                invalid={!thresholdValid || serverError?.field === 'aiAutoPlanThreshold'}
                testId="ai-planning-threshold"
              />
              {!thresholdValid ? (
                <FieldError id={ids.errorId} testId="ai-planning-threshold-error">
                  {t('aiPlanning.autoPlan.thresholdInvalid')}
                </FieldError>
              ) : serverError?.field === 'aiAutoPlanThreshold' ? (
                <FieldError id={ids.errorId} testId="ai-planning-threshold-error">
                  {serverError.message}
                </FieldError>
              ) : null}
              {working.autoPlanEnabled ? (
                <Callout tint="sky" icon={<Info className="size-[15px]" aria-hidden />}>
                  {t.rich('aiPlanning.autoPlan.guardrail', {
                    strong: (chunks) => <strong className="font-semibold">{chunks}</strong>,
                  })}
                </Callout>
              ) : null}
              {/* MOTIR-4603 — WHEN the cadence holds off, in the user's words.
                  ⚠️ THE CHECKBOX ABOVE IS NEVER MUTATED BY A PAUSE. It records
                  what the user WANTS; silently unchecking it to reflect a system
                  state would be Motir editing their intent, and they would later
                  find a setting they never changed. So the condition is EXPLAINED
                  here and the switch stays exactly where they left it.
                  ⚠️ AND IT NAMES NO COMMERCIAL CAUSE. If indexing is paused
                  because an allowance is spent, this says the index is out of
                  date and what to do about it — never why in cost terms
                  (MOTIR-4541). The real reason lives in the admin panel. */}
              {working.autoPlanEnabled ? (
                <Callout tint="peach" icon={<Info className="size-[15px]" aria-hidden />}>
                  {t('aiPlanning.autoPlan.pauseConditions')}
                </Callout>
              ) : null}
            </>
          )}
        </DependentField>
      </SettingsCard>

      {/* ── Card 2 · AI sprint planning ────────────────────────────────────── */}
      <SettingsCard
        icon={<Calendar className="size-[17px]" aria-hidden />}
        title={t('aiPlanning.sprint.title')}
        subtitle={t('aiPlanning.sprint.subtitle')}
      >
        {notConnected}

        <SwitchRow
          checked={working.sprintPlanningEnabled}
          onCheckedChange={(v) => patch({ sprintPlanningEnabled: v })}
          disabled={locked}
          label={t('aiPlanning.sprint.enableLabel')}
          hint={t('aiPlanning.sprint.enableHint')}
        />

        <DependentField
          label={t('aiPlanning.sprint.lengthLabel')}
          hint={t('aiPlanning.sprint.lengthHint')}
          disabled={locked || !working.sprintPlanningEnabled}
        >
          {(ids) => (
            <>
              <Stepper
                value={working.sprintLengthDays}
                onChange={(v) => patch({ sprintLengthDays: v })}
                min={AI_SPRINT_LENGTH_DAYS_MIN}
                max={AI_SPRINT_LENGTH_DAYS_MAX}
                disabled={locked || !working.sprintPlanningEnabled}
                unit={t('aiPlanning.sprint.lengthUnit')}
                ariaLabel={t('aiPlanning.sprint.lengthLabel')}
                decreaseLabel={t('aiPlanning.sprint.decreaseAria')}
                increaseLabel={t('aiPlanning.sprint.increaseAria')}
                describedBy={ids.describedBy}
                invalid={!sprintLengthValid || serverError?.field === 'aiSprintLengthDays'}
                testId="ai-planning-sprint-length"
              />
              {!sprintLengthValid ? (
                <FieldError id={ids.errorId} testId="ai-planning-sprint-length-error">
                  {t('aiPlanning.sprint.lengthInvalid')}
                </FieldError>
              ) : serverError?.field === 'aiSprintLengthDays' ? (
                <FieldError id={ids.errorId} testId="ai-planning-sprint-length-error">
                  {serverError.message}
                </FieldError>
              ) : null}
              {working.sprintPlanningEnabled ? (
                <Callout tint="lavender" icon={<Info className="size-[15px]" aria-hidden />}>
                  {t('aiPlanning.sprint.rationale')}
                </Callout>
              ) : null}
            </>
          )}
        </DependentField>
      </SettingsCard>

      {/* ── Card 3 · Planner ───────────────────────────────────────────────── */}
      <SettingsCard
        icon={<Bot className="size-[17px]" aria-hidden />}
        title={t('aiPlanning.planner.title')}
        subtitle={t('aiPlanning.planner.subtitle')}
      >
        {notConnected}

        <SwitchRow
          checked={working.generateExplanations}
          onCheckedChange={(v) => patch({ generateExplanations: v })}
          disabled={locked}
          label={t('aiPlanning.planner.explanationsLabel')}
          hint={t('aiPlanning.planner.explanationsHint')}
        />

        <SwitchRow
          checked={working.finalCheck}
          onCheckedChange={(v) => patch({ finalCheck: v })}
          disabled={locked}
          label={t('aiPlanning.planner.finalCheckLabel')}
          hint={t('aiPlanning.planner.finalCheckHint')}
          testId="ai-planning-final-check"
        >
          {working.finalCheck ? null : (
            <Callout
              tint="yellow"
              icon={<TriangleAlert className="size-[15px]" aria-hidden />}
              testId="ai-planning-final-check-off"
            >
              {t('aiPlanning.planner.finalCheckOff')}
            </Callout>
          )}
        </SwitchRow>

        {/* THE DATA-PRACTICE PROMISE (Story MOTIR-3665 · MOTIR-3670; design
            §D2-D4, panel 7). At the FOOT of this card and nowhere else: the
            promise qualifies the act of CHOOSING A MODEL, so it belongs where
            that choice is made, and it reads in the right order — pick the
            model, then learn what happens to what you send it. Under the page
            title it would read as a claim about auto-plan and sprint packing
            too, which are cadence settings and not egress.

            ⚠️ TWO SENTENCES, TWO KINDS OF STATEMENT, and the design depends on
            the difference (§D3). The first is a COMMITMENT — a fact about our
            own systems, ours to make, stated in the same words on the public
            provider page. The second is a REPORT — a provider's published
            position, which cannot be undertaken on its behalf, so it must not be
            written in a voice that makes it sound like a second promise. They
            are separate i18n keys for exactly that reason: a translator needs to
            know which is which, and a revision to one must not silently re-open
            the other.

            ⚠️ NO PROVIDER FACT APPEARS HERE. No retention window, no training
            answer, no provider names — those live in the gateway
            (`motir/datapolicy`) and on the published page, and a third copy in a
            React component is how that data has already gone stale four times.
            `tests/settings/aiPlanningDataPractice.test.tsx` asserts the absence
            rather than trusting this comment. */}
        <Callout
          tint="plain"
          icon={<Info className="size-[15px]" aria-hidden />}
          testId="ai-planning-data-practice"
        >
          <span className="block">
            {t('aiPlanning.planner.dataPracticeCommitment')}{' '}
            {t('aiPlanning.planner.dataPracticeReport')}
          </span>
          {/* The link is the WHOLE mechanism by which a reader reaches the
              per-provider answers, since nothing above restates one — and it is
              an ABSOLUTE url on the operator's own host, because MOTIR-4103 moved
              `content/legal/` and `app/(public)/legal/` out of this repository. A
              bare `/legal/model-providers` would resolve against this app and
              survive only on MOTIR-3884's 301.

              `null` (an unconfigured manifest) renders NO link, and the
              commitment sentence stands alone — it is true on a self-hosted build
              whether or not anyone published a provider page. That follows the
              precedent one card down, whose own comment is the rule: "a link to a
              page the reader cannot open is worse than no link". It is NOT
              `signUpLegalLinks`' both-or-neither case, where the paragraph would
              otherwise assert agreement to a document nobody published; here only
              the pointer is missing, not the claim. */}
          {providerTableUrl ? (
            <a
              href={providerTableUrl}
              className="text-(--el-link) mt-2 inline-flex items-center gap-1 text-xs font-medium hover:underline"
              data-testid="ai-planning-provider-table-link"
            >
              {t('aiPlanning.planner.dataPracticeLink')}
              <ArrowRight className="size-3.5" aria-hidden />
            </a>
          ) : null}
        </Callout>
      </SettingsCard>

      {/* ── Card 4 · Planning mistakes (+ the shared footer) ────────────────── */}
      <SettingsCard
        icon={<NotebookPen className="size-[17px]" aria-hidden />}
        title={t('aiPlanning.lessonCapture.title')}
        subtitle={t('aiPlanning.lessonCapture.subtitle')}
        footer={
          isAdmin ? (
            <div className="bg-(--el-surface-soft) border-(--el-border-soft) flex items-center justify-end gap-2.5 border-t px-(--spacing-card-padding) py-3.5">
              <span
                className="text-(--el-text-secondary) mr-auto text-xs"
                data-testid="ai-planning-footer-hint"
              >
                {!valid
                  ? t('aiPlanning.footer.invalidHint')
                  : dirty
                    ? t('aiPlanning.footer.dirtyHint')
                    : null}
              </span>
              <Button variant="secondary" onClick={reset} disabled={!dirty || saving}>
                {tc('cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={save}
                loading={saving}
                disabled={!canSave}
                data-testid="ai-planning-save"
              >
                {t('aiPlanning.footer.save')}
              </Button>
            </div>
          ) : null
        }
      >
        {notConnected}

        <SwitchRow
          checked={working.recordPlanningMistakes}
          onCheckedChange={(v) => patch({ recordPlanningMistakes: v })}
          disabled={locked}
          label={t('aiPlanning.lessonCapture.enableLabel')}
          hint={t('aiPlanning.lessonCapture.enableHint')}
          testId="ai-planning-record-mistakes"
        >
          {/* ⚠️ ALWAYS RENDERED, unlike the guardrail / rationale callouts, which
              appear only while their feature is live. Those explain a feature the
              reader has switched ON; this one is how the reader decides in the
              first place — and it is the only setting on this page whose subject
              (Motir observing their planning work and keeping conclusions about
              it) is not guessable from the label. Hiding it once the switch is
              off would also hide the sentence about what turning it off costs
              from the one reader who most needs it.

              `tint="plain"` deliberately: the three tinted slots are taken by the
              guardrail, the rationale and the pause, and this is explanation, not
              an alert. */}
          <Callout
            tint="plain"
            icon={<Info className="size-[15px]" aria-hidden />}
            testId="ai-planning-record-mistakes-explanation"
          >
            <span className="block">{t('aiPlanning.lessonCapture.explanation')}</span>
            {/* Point five — WHERE TO LOOK, so the setting and the thing it
                produces are one step apart. Gated on `lesson:view` exactly as the
                door card below the editor is (design §L3): a link to a page the
                reader cannot open is worse than no link. Hiding is presentation —
                the destination guards itself server-side. */}
            {canViewLessons ? (
              <Link
                href="/settings/project/ai-planning/lessons"
                className="text-(--el-link) mt-2 inline-flex items-center gap-1 text-xs font-medium hover:underline"
                data-testid="ai-planning-record-mistakes-lessons-link"
              >
                {t('aiPlanning.lessonCapture.viewLessons')}
                <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            ) : null}
          </Callout>
        </SwitchRow>
      </SettingsCard>
    </div>
  );
}

// ── Dependent field — indented under its parent switch, present-but-disabled ──
// A disabled dependent keeps its layout and stays legible (only its text tokens
// drop to `--el-text-faint`); it is `disabled`, never `aria-hidden`, so a screen
// reader sees the same unavailable option a sighted user does (§8.1, §10).

function DependentField({
  label,
  hint,
  disabled,
  children,
}: {
  label: string;
  hint: string;
  disabled: boolean;
  children: (ids: { describedBy: string; errorId: string }) => ReactNode;
}) {
  const hintId = useId();
  const errorId = useId();
  return (
    <div className="border-(--el-border-soft) ml-[50px] flex flex-col gap-1.5 border-l pl-3.5">
      <span
        {...(disabled ? { 'aria-disabled': true } : {})}
        className={`text-sm font-medium ${disabled ? 'text-(--el-text-faint)' : 'text-(--el-text)'}`}
      >
        {label}
      </span>
      <p
        id={hintId}
        {...(disabled ? { 'aria-disabled': true } : {})}
        className={`max-w-[52ch] text-xs leading-relaxed ${disabled ? 'text-(--el-text-faint)' : 'text-(--el-text-helper)'}`}
      >
        {hint}
      </p>
      {children({ describedBy: `${hintId} ${errorId}`, errorId })}
    </div>
  );
}

// ── Stepper — a COMPOSITION of a number input and two icon buttons ────────────
// Not a new primitive (§5). Each button disables at its end of the range, so the
// ordinary path cannot produce an invalid value; the error state exists for
// typed input.

function Stepper({
  value,
  onChange,
  min,
  max,
  disabled,
  unit,
  ariaLabel,
  decreaseLabel,
  increaseLabel,
  describedBy,
  invalid,
  testId,
}: {
  value: string;
  onChange: (next: string) => void;
  min: number;
  max: number;
  disabled: boolean;
  unit: string;
  ariaLabel: string;
  decreaseLabel: string;
  increaseLabel: string;
  describedBy: string;
  invalid: boolean;
  testId: string;
}) {
  const numeric = Number(value.trim());
  const steppable = /^-?\d+$/.test(value.trim());
  const step = useCallback(
    (delta: number) => {
      const base = steppable ? numeric : min;
      const next = Math.min(max, Math.max(min, base + delta));
      onChange(String(next));
    },
    [steppable, numeric, min, max, onChange],
  );

  const iconButton =
    'inline-flex size-(--height-control) items-center justify-center rounded-(--radius-control) border border-(--el-button-border) bg-(--el-page-bg) text-(--el-text-secondary) hover:bg-(--el-muted) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <div className="mt-0.5 inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={disabled || (steppable && numeric <= min)}
        aria-label={decreaseLabel}
        className={iconButton}
      >
        <Minus className="size-[15px]" aria-hidden />
      </button>
      <input
        type="number"
        inputMode="numeric"
        value={value}
        min={min}
        max={max}
        step={1}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value)}
        className={`h-(--height-control) w-[74px] rounded-(--radius-input) border bg-(--el-page-bg) text-center font-mono text-sm font-semibold text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) disabled:cursor-not-allowed disabled:opacity-50 ${
          invalid ? 'border-(--el-danger)' : 'border-(--el-input-border)'
        }`}
      />
      <button
        type="button"
        onClick={() => step(1)}
        disabled={disabled || (steppable && numeric >= max)}
        aria-label={increaseLabel}
        className={iconButton}
      >
        <Plus className="size-[15px]" aria-hidden />
      </button>
      <span
        {...(disabled ? { 'aria-disabled': true } : {})}
        className={`text-xs ${disabled ? 'text-(--el-text-faint)' : 'text-(--el-text-muted)'}`}
      >
        {unit}
      </span>
    </div>
  );
}

// ── Inline validation message — announced on appearance (§10) ─────────────────

function FieldError({ id, testId, children }: { id: string; testId: string; children: ReactNode }) {
  return (
    <p
      id={id}
      role="alert"
      data-testid={testId}
      className="mt-0.5 flex items-center gap-1.5 text-xs text-(--el-danger)"
    >
      <AlertCircle className="size-[13px] shrink-0" aria-hidden />
      {children}
    </p>
  );
}

// ── Banners + callouts — three DISTINCT tint slots so they never read alike ───

function Callout({
  tint,
  icon,
  children,
  testId,
  role,
}: {
  tint: 'sky' | 'lavender' | 'peach' | 'yellow' | 'plain';
  icon: ReactNode;
  children: ReactNode;
  testId?: string;
  /** `status` for the paused banner (§10) — it appears after a save or a
   *  refresh, so it announces without stealing focus. */
  role?: 'status';
}) {
  const surface =
    tint === 'sky'
      ? 'bg-(--el-tint-sky) border-(--el-border-soft) text-(--el-text-strong)'
      : tint === 'lavender'
        ? 'bg-(--el-tint-lavender) border-(--el-border-soft) text-(--el-text-strong)'
        : tint === 'peach'
          ? 'bg-(--el-tint-peach) border-(--el-border-soft) text-(--el-text-strong)'
          : tint === 'yellow'
            ? 'bg-(--el-tint-yellow) border-(--el-border-soft) text-(--el-text-strong)'
            : 'bg-(--el-surface) border-(--el-border) text-(--el-text-secondary)';
  const iconTone =
    tint === 'sky'
      ? 'text-(--el-info)'
      : tint === 'lavender'
        ? 'text-(--el-accent-on-surface)'
        : tint === 'peach' || tint === 'yellow'
          ? 'text-(--el-warning)'
          : 'text-(--el-icon-muted)';
  return (
    <div
      data-testid={testId}
      {...(role ? { role } : {})}
      className={`flex gap-2.5 rounded-(--radius-card) border px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) text-xs leading-relaxed ${surface}`}
    >
      <span className={`mt-px shrink-0 ${iconTone}`}>{icon}</span>
      <span>{children}</span>
    </div>
  );
}

function ReadOnlyBanner() {
  const t = useTranslations('settings');
  return (
    <Callout
      tint="plain"
      icon={<Lock className="size-[15px]" aria-hidden />}
      testId="ai-planning-readonly-banner"
    >
      {t('aiPlanning.readOnlyBanner')}
    </Callout>
  );
}

// ── The auto-plan PAUSED banner (MOTIR-1740 · design §8 state 7, panel 6) ─────
// MOTIR-916's watcher SKIPS a project whose plan is still undecided, and nothing
// expires a plan — so without this the silence is indistinguishable from a
// broken feature. It is the SAME `Callout` box the guardrail uses, in the GATE
// (peach + `--el-warning`) role this surface already defines for "the setting is
// on, but the feature is not running — here is why"; paused and not-connected
// are the same message family and cannot co-occur (a deployment with no Motir AI
// connection has no undecided plan), so the role is REUSED, not a fourth tint
// invented. Told apart by their glyph and their first sentence, never by hue.
//
// The LINK is the point: it makes the silence actionable, pointing at the
// shipped plan detail (MOTIR-847), which is otherwise reachable only from the
// Plans list. On a tint it takes `--el-text-strong` + an underline, NEVER
// `--el-link` (4.13:1 on peach — under AA, finding #35).
//
// The meta line REUSES the Plans list's own strings (`aiPlanning.plannedAt` /
// `aiPlanning.itemCount` / `planReview.staleBadge`) rather than re-authoring
// them (§11), so the two surfaces can never drift in how they describe the same
// plan; only the paused-specific sentences are new.

function PausedBanner({ pause }: { pause: AutoPlanPauseView }) {
  const t = useTranslations('settings');
  const tp = useTranslations('aiPlanning');
  const tr = useTranslations('planReview');

  return (
    <Callout
      tint="peach"
      role="status"
      icon={<PauseCircle className="size-[15px]" aria-hidden />}
      testId="ai-planning-paused-banner"
    >
      <span className="flex min-w-0 flex-col gap-[7px]">
        <span>
          <strong className="font-semibold">{t('aiPlanning.paused.lead')}</strong>{' '}
          {t('aiPlanning.paused.body')}
        </span>

        {/* The OUT-OF-DATE face — the shipped stale badge (markup + tokens from
            components/planning/PlanItemNode.tsx) plus the drift sentence. The
            WORD carries the meaning; the glyph is decorative (§10). */}
        {pause.stale ? (
          <span
            className="flex flex-wrap items-center gap-2"
            data-testid="ai-planning-paused-stale"
          >
            <span className="inline-flex items-center gap-1 rounded-(--radius-badge) border border-(--el-border-soft) bg-(--el-tint-yellow) px-(--spacing-chip-x) py-(--spacing-chip-y) text-[11px] font-semibold text-(--el-text-strong)">
              <TriangleAlert className="size-[12px] shrink-0 text-(--el-warning)" aria-hidden />
              {tr('staleBadge')}
            </span>
            <span>{t('aiPlanning.paused.staleBody', { count: pause.staleCount })}</span>
          </span>
        ) : null}

        <span className="flex flex-wrap items-center gap-2">
          {pause.plannedWhenLabel ? (
            <>
              {/* The shipped string is sentence-cased for the Plans list's own
                  slot ("planned 3 days ago"); leading this line it takes a
                  capital — done in CSS so the STRING stays shared. */}
              <span className="first-letter:uppercase">
                {tp('plannedAt', { when: pause.plannedWhenLabel })}
              </span>
              <span className="text-(--el-text-tertiary)" aria-hidden>
                ·
              </span>
            </>
          ) : null}
          <span>{tp('itemCount', { count: pause.itemCount })}</span>
          {/* The pause view carries no status or session, so the door resolves
              them; an undecided plan opens in the overlay over this page (Story
              MOTIR-7883 · MOTIR-7890). */}
          <PlanOverlayDoor
            planId={pause.planId}
            data-testid="ai-planning-paused-link"
            className="inline-flex items-center gap-1.5 font-semibold text-(--el-text-strong) underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
          >
            {t('aiPlanning.paused.reviewCta')}
            <ArrowRight className="size-[13px] shrink-0" aria-hidden />
          </PlanOverlayDoor>
        </span>
      </span>
    </Callout>
  );
}

function NotConnectedBanner() {
  const t = useTranslations('settings');
  return (
    <Callout
      tint="peach"
      icon={<CloudOff className="size-[15px]" aria-hidden />}
      testId="ai-planning-not-connected-banner"
    >
      <strong className="font-semibold">{t('aiPlanning.notConnectedTitle')}</strong>{' '}
      {t('aiPlanning.notConnectedBody')}
    </Callout>
  );
}
