'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, Flag, Target } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Segmented } from '@/components/ui/Segmented';
import { DatePicker } from '@motir/design-system';
import { useToast } from '@/components/ui/Toast';
import { formatDate } from '@/lib/utils/datetime';
import type { Locale } from '@/lib/i18n/locales';
import type { SprintDto } from '@/lib/dto/sprints';
import { useSprintPoints } from './useSprintPoints';

// Start-sprint flow (Story 4.4 · Subtask 4.4.5). The modal `design/sprints/
// sprint-lifecycle.mock.html` (panels 1–3) specifies, WIRED to the Start-sprint
// entry-point button Story 4.2.3 mounts in the backlog sprint container (the seam
// pattern: 4.2 mounts the button, 4.4 wires the flow). Self-contained — it takes a
// planned sprint + the project's active sprint (for the friendly one-active error)
// and binds to the shipped backend (4.4.2, goal added in 4.4.8):
//
//   • POST /api/sprints/[id]/start  { name, goal, startDate, endDate } → startSprint
//
// Start is ONE atomic write: `startSprint` (4.4.8 / finding #68) takes the goal
// and stamps it inside the same activation transaction as the window + scope-lock
// baseline, so the dialog no longer issues a separate pre-start `updateSprint`
// PATCH (the Jira start dialog edits the goal inline). An empty goal sends `null`
// to clear it.
//
// "Board opens": on success the flow navigates to /boards — the scrum board
// renders the active sprint once Story 4.5 lands; until then it renders as Kanban
// (graceful). Colour via `--el-*`, shape via element-semantic tokens; the Modal is
// a labelled, focus-trapped dialog (Radix). Error treatments are text + glyph +
// `--el-danger`, never colour alone (finding #35).

type Duration = '1' | '2' | '3' | '4' | 'custom';

const PRESET_WEEKS: Record<Exclude<Duration, 'custom'>, number> = {
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
};

const pad = (n: number) => String(n).padStart(2, '0');

/** Today as a UTC `YYYY-MM-DD` key — matches the DatePicker's UTC date shape. */
function todayKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
}

/** Shift a `YYYY-MM-DD` key by ±days via UTC math (no local-tz off-by-one). */
function addDaysKey(key: string, days: number): string {
  const parts = key.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Inclusive day span of an N-week sprint: a 2-week sprint runs start … start+13. */
function presetSpanDays(weeks: number): number {
  return weeks * 7 - 1;
}

export interface StartSprintDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The planned sprint being started. */
  sprint: SprintDto;
  /** The project name, for the friendly one-active-sprint message. */
  projectName: string;
  /** The project's currently-active sprint, if any (names the one-active error). */
  activeSprint: SprintDto | null;
  /** Refresh the backlog after a successful start (before navigating to /boards). */
  onStarted?: () => void | Promise<void>;
}

export function StartSprintDialog({
  open,
  onOpenChange,
  sprint,
  projectName,
  activeSprint,
  onStarted,
}: StartSprintDialogProps) {
  const t = useTranslations('backlog');
  const tc = useTranslations('common');
  const locale = useLocale() as Locale;
  const router = useRouter();
  const { toast } = useToast();
  // Live committed-points preview (Subtask 4.4.9 — finding #69): the bounded
  // `rollupForSprint` roll-up, fetched only while the dialog is open. Points are
  // issue-set-derived (NOT window-derived), so the figure is independent of the
  // duration/date controls. `null`/wholly-unestimated → the "—" the catalog owns.
  const points = useSprintPoints(sprint.id, open);

  const [name, setName] = useState(sprint.name);
  const [duration, setDuration] = useState<Duration>('2');
  const [customStart, setCustomStart] = useState<string | null>(todayKey());
  const [customEnd, setCustomEnd] = useState<string | null>(
    addDaysKey(todayKey(), presetSpanDays(2)),
  );
  const [goal, setGoal] = useState(sprint.goal ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [alreadyActive, setAlreadyActive] = useState(false);
  const [serverWindowError, setServerWindowError] = useState(false);

  // Reset transient state on close (React 19 forbids set-state-in-effect; the
  // create-project modal resets in the onOpenChange wrapper for the same reason).
  function handleOpenChange(next: boolean) {
    if (!next) {
      setName(sprint.name);
      setDuration('2');
      setCustomStart(todayKey());
      setCustomEnd(addDaysKey(todayKey(), presetSpanDays(2)));
      setGoal(sprint.goal ?? '');
      setSubmitting(false);
      setAlreadyActive(false);
      setServerWindowError(false);
    }
    onOpenChange(next);
  }

  const isCustom = duration === 'custom';
  const startDate = isCustom ? customStart : todayKey();
  const endDate = isCustom
    ? customEnd
    : addDaysKey(todayKey(), presetSpanDays(PRESET_WEEKS[duration as Exclude<Duration, 'custom'>]));

  const windowInvalid = Boolean(startDate && endDate && endDate < startDate);
  const datesPresent = Boolean(startDate && endDate);
  // The project already runs another sprint → starting this one will 409. Surface
  // the blocked state up front (mock panel 3) AND keep the post-submit 409 path as
  // a race backstop (another sprint could activate between load and submit).
  const blockedByActive = Boolean(activeSprint && activeSprint.id !== sprint.id);
  const showActiveAlert = alreadyActive || blockedByActive;
  const canStart =
    name.trim().length > 0 && datesPresent && !windowInvalid && !blockedByActive && !submitting;

  const durationOptions: { value: Duration; label: string }[] = [
    { value: '1', label: t('startSprintFlow.duration1w') },
    { value: '2', label: t('startSprintFlow.duration2w') },
    { value: '3', label: t('startSprintFlow.duration3w') },
    { value: '4', label: t('startSprintFlow.duration4w') },
    { value: 'custom', label: t('startSprintFlow.durationCustom') },
  ];

  async function handleStart() {
    if (!canStart || !startDate || !endDate) return;
    setAlreadyActive(false);
    setServerWindowError(false);
    setSubmitting(true);
    try {
      // Start is ONE atomic write (4.4.8 / finding #68): the goal rides along in
      // the /start body and `startSprint` stamps it inside the activation
      // transaction — no separate pre-start PATCH. An empty goal sends `null` to
      // clear it.
      const trimmedGoal = goal.trim();
      const res = await fetch(`/api/sprints/${sprint.id}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          goal: trimmedGoal.length > 0 ? trimmedGoal : null,
          startDate,
          endDate,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { code?: string };
        if (data.code === 'SPRINT_ALREADY_ACTIVE') {
          setAlreadyActive(true);
          return;
        }
        if (data.code === 'SPRINT_WINDOW_INVALID') {
          setServerWindowError(true);
          return;
        }
        throw new Error(data.code ?? `start ${res.status}`);
      }

      toast({
        variant: 'success',
        title: t('startSprintFlow.startedToast', { name: name.trim() }),
      });
      handleOpenChange(false);
      await onStarted?.();
      // "Board opens" — navigate to the boards surface (Story 4.5 renders the
      // active sprint there; until then it renders as Kanban — graceful).
      router.push('/boards');
    } catch {
      toast({
        variant: 'error',
        title: t('startSprintFlow.errorTitle'),
        description: t('startSprintFlow.errorDescription'),
      });
    } finally {
      setSubmitting(false);
    }
  }

  const startFieldError =
    serverWindowError || windowInvalid ? t('startSprintFlow.windowInvalid') : undefined;

  return (
    <Modal
      open={open}
      onOpenChange={handleOpenChange}
      title={t('startSprintFlow.title')}
      description={t('startSprintFlow.subtitle', { sprint: sprint.name, project: projectName })}
      size="md"
    >
      <form
        className="mt-1 flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          void handleStart();
        }}
      >
        {/* The fields scroll and the footer stays pinned. In the TALLEST state —
            the already-active alert on top of a custom-duration window — this
            body is ~680px at a 700px-tall viewport, more than the panel's 90vh
            cap; as a bare `<div>` it was clipped by the panel with no
            scrollbar and BOTH footer buttons cut off (MOTIR-2491, measured at
            1280×700). `Modal.Body` owns the scroll recipe. */}
        <Modal.Body className="gap-(--spacing-md)">
          {showActiveAlert ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-peach) px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-strong)"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-(--el-warning)" aria-hidden />
              <span>
                {activeSprint
                  ? t('startSprintFlow.alreadyActive', {
                      project: projectName,
                      sprint: activeSprint.name,
                    })
                  : t('startSprintFlow.alreadyActiveGeneric', { project: projectName })}
              </span>
            </div>
          ) : null}

          <Input
            label={t('startSprintFlow.nameLabel')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            disabled={submitting}
          />

          <div className="flex flex-col gap-1.5">
            <span className="font-sans text-sm font-medium text-(--el-text)">
              {t('startSprintFlow.durationLabel')}
            </span>
            <Segmented
              options={durationOptions}
              value={duration}
              onChange={setDuration}
              label={t('startSprintFlow.durationLabel')}
              disabled={submitting}
            />
            {!isCustom ? (
              <span className="text-xs text-(--el-text-secondary)">
                {startDate && endDate
                  ? t('startSprintFlow.derivedWindow', {
                      start: formatDate(startDate, locale),
                      end: formatDate(endDate, locale),
                      days: presetSpanDays(PRESET_WEEKS[duration as Exclude<Duration, 'custom'>]),
                    })
                  : null}
              </span>
            ) : null}
          </div>

          {isCustom ? (
            <div className="grid grid-cols-2 gap-(--spacing-md)">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor={`start-date-${sprint.id}`}
                  className="font-sans text-sm font-medium text-(--el-text)"
                >
                  {t('startSprintFlow.startDateLabel')}
                </label>
                <DatePicker
                  id={`start-date-${sprint.id}`}
                  value={customStart}
                  onChange={setCustomStart}
                  aria-label={t('startSprintFlow.startDateLabel')}
                  disabled={submitting}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor={`end-date-${sprint.id}`}
                  className="font-sans text-sm font-medium text-(--el-text)"
                >
                  {t('startSprintFlow.endDateLabel')}
                </label>
                <DatePicker
                  id={`end-date-${sprint.id}`}
                  value={customEnd}
                  onChange={setCustomEnd}
                  aria-label={t('startSprintFlow.endDateLabel')}
                  disabled={submitting}
                />
                {startFieldError ? (
                  <span
                    role="alert"
                    className="flex items-center gap-1 font-sans text-xs text-(--el-danger)"
                  >
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    {startFieldError}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}

          <Textarea
            label={t('startSprintFlow.goalLabel')}
            helperText={t('startSprintFlow.goalOptional')}
            placeholder={t('startSprintFlow.goalPlaceholder')}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            disabled={submitting}
            rows={2}
          />

          <div className="flex items-center gap-2 text-sm text-(--el-text-secondary)">
            <Target className="h-4 w-4 shrink-0 text-(--el-accent-on-surface)" aria-hidden />
            <span>
              {t('startSprintFlow.committedSummary', {
                count: sprint.issueCount,
                points: points?.committed ?? 0,
              })}
            </span>
          </div>
        </Modal.Body>

        <Modal.Footer>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={submitting}>
            {tc('cancel')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            leftIcon={<Flag className="h-4 w-4" />}
            loading={submitting}
            disabled={!canStart}
          >
            {t('startSprintFlow.confirm')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
