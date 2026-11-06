'use client';

import { useId, useRef, useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, BookOpen, Bug, EyeOff, RotateCcw, Tag } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/Toast';
import {
  PLANNER_FINDING_ATTRIBUTION_VALUES,
  type PlannerFindingDetailDTO,
} from '@/lib/dto/plannerFindings';
import {
  PLATFORM_LESSON_MISTAKE_TYPES,
  type PlatformLessonMistakeType,
} from '@/lib/dto/platformLessons';
import { useLessonTypeLabel } from '../../planning-lessons/_components/LessonBits';
import {
  dismissPlannerFindingAction,
  promotePlannerFindingAction,
  recordPlannerFindingBugKeyAction,
  restorePlannerFindingAction,
  setPlannerFindingAttributionAction,
  type PlannerFindingActionResult,
} from '../actions';
import { findingLabel } from './findingLabels';
import { toPromoteDraft, type PromoteDraft } from './promotePrefill';

/**
 * The TRIAGE CONTROLS of one planner finding — design MOTIR-10362 Panels 12–15,
 * Story MOTIR-10353, card MOTIR-10525.
 *
 * ⚠️ THIS ISLAND OWNS DRAFTS, NEVER THE STORED FINDING. Status, attribution, bug
 * key and lesson link are the server-rendered `detail` prop; every action
 * revalidates the console layout, so the page re-reads after a write and this
 * component shows the new state only from that prop (the lessons curate island's
 * contract). The triage STATE itself is the detail page's to render, not this.
 *
 * ⚠️ A MISSING CONTROL IS PRESENTATION. Below operator nothing renders, because a
 * control that can only be refused is a defect; the action and the service
 * re-gate every write regardless.
 *
 * ⚠️ A PROMOTE THAT CREATED A LESSON BUT COULD NOT LINK IT is never offered
 * again from this screen: a second click would create a second lesson.
 */

type Act = 'attribution' | 'promote' | 'bug' | 'dismiss' | 'restore';
type InlineForm = 'attribution' | 'promote' | 'bug';
type RetryableCode = 'NOT_PERMITTED' | 'INVALID' | 'UNAVAILABLE' | 'FAILED';
type Failure =
  | { act: Act; code: RetryableCode }
  | { act: 'promote'; code: 'DUPLICATE_LESSON'; detail: string };
type Notice = { tone: 'success' | 'warning'; text: string };

/** A project key, a dash and digits — the service's own rule after it upper-cases. */
const BUG_KEY = /^[A-Z][A-Z0-9]*-\d+$/;
const DISMISS_NOTE_MAX = 280;

/** The statuses that may still be promoted; an unknown status never borrows a member's set. */
const PROMOTABLE = new Set(['new', 'filed_as_bug']);

export function looksLikeBugKey(value: string): boolean {
  return BUG_KEY.test(value.trim().toUpperCase());
}

function trimPromote(draft: PromoteDraft): PromoteDraft {
  return {
    title: draft.title.trim(),
    why: draft.why.trim(),
    howToApply: draft.howToApply.trim(),
    mistakeType: draft.mistakeType,
  };
}

export function FindingTriageControls({
  detail,
  canTriage,
}: {
  detail: PlannerFindingDetailDTO;
  canTriage: boolean;
}) {
  if (!canTriage) return null;
  return <Controls detail={detail} />;
}

function Controls({ detail }: { detail: PlannerFindingDetailDTO }) {
  const t = useTranslations('platformAdmin.plannerFindings');
  const typeLabel = useLessonTypeLabel();
  const router = useRouter();
  const { toast } = useToast();
  const headingId = useId();
  const [form, setForm] = useState<InlineForm | null>(null);
  const [confirm, setConfirm] = useState<'promote' | 'dismiss' | null>(null);
  const [attribution, setAttribution] = useState(detail.attribution);
  const [bugKey, setBugKey] = useState('');
  const [promote, setPromote] = useState<PromoteDraft>(() => toPromoteDraft(detail));
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [notLinkedLesson, setNotLinkedLesson] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<Act | null>(null);
  const [isPending, startTransition] = useTransition();
  // A second click inside the same tick, before `isPending` disables anything.
  const inFlight = useRef(false);

  const attributionLabel = (value: string) =>
    findingLabel(t as unknown as Parameters<typeof findingLabel>[0], 'attribution', value);
  const dismissed = detail.status === 'dismissed';
  const promoteOffered = PROMOTABLE.has(detail.status) && notLinkedLesson === null;
  const busy = isPending || submitting !== null;

  function reset() {
    setForm(null);
    setConfirm(null);
    setFailure(null);
    setNote('');
  }

  function open(next: InlineForm) {
    reset();
    setNotice(null);
    if (next === 'attribution') setAttribution(detail.attribution);
    if (next === 'bug') setBugKey(detail.bugKey ?? '');
    if (next === 'promote') setPromote(toPromoteDraft(detail));
    setForm(next);
  }

  function openDismiss() {
    reset();
    setNotice(null);
    setConfirm('dismiss');
  }

  function call(act: Act): Promise<PlannerFindingActionResult> {
    switch (act) {
      case 'attribution':
        return setPlannerFindingAttributionAction(detail.id, { attribution });
      case 'promote':
        return promotePlannerFindingAction(detail.id, trimPromote(promote));
      case 'bug':
        return recordPlannerFindingBugKeyAction(detail.id, bugKey);
      case 'dismiss':
        return dismissPlannerFindingAction(detail.id, note.trim() || undefined);
      case 'restore':
        return restorePlannerFindingAction(detail.id);
    }
  }

  function succeeded(act: Act): string {
    switch (act) {
      case 'attribution':
        return t('attr.saved', { attribution: attributionLabel(attribution) });
      case 'promote':
        return t('promote.saved');
      case 'bug':
        return t('bug.saved', { key: bugKey.trim().toUpperCase() });
      case 'dismiss':
        return t('dismiss.saved');
      case 'restore':
        return t('dismiss.restored');
    }
  }

  function settle(act: Act, result: PlannerFindingActionResult) {
    if (result.ok) {
      setNotice({ tone: 'success', text: succeeded(act) });
      reset();
      return;
    }
    switch (result.code) {
      case 'LESSON_NOT_LINKED':
        reset();
        setNotLinkedLesson(result.lessonId);
        return;
      case 'GONE':
        reset();
        toast({ variant: 'error', title: t('refused.gone') });
        router.push('/admin/planner-findings');
        return;
      case 'UNCHANGED':
        // The action revalidated: the page now shows where the finding really is.
        reset();
        setNotice({ tone: 'warning', text: t('noop') });
        return;
      case 'DUPLICATE_LESSON':
        setConfirm(null);
        setFailure({ act: 'promote', code: 'DUPLICATE_LESSON', detail: result.detail });
        return;
      default:
        // The form keeps every entry; only the promote confirm steps aside so
        // the error sits under the form it belongs to (design Panel 13).
        if (act === 'promote') setConfirm(null);
        setFailure({ act, code: result.code });
    }
  }

  function run(act: Act) {
    if (inFlight.current) return;
    inFlight.current = true;
    setFailure(null);
    setNotice(null);
    setSubmitting(act);
    startTransition(async () => {
      try {
        settle(act, await call(act));
      } finally {
        inFlight.current = false;
        setSubmitting(null);
      }
    });
  }

  const errorBox = (act: Act) =>
    failure && failure.act === act ? (
      <TriageError
        text={
          failure.code === 'DUPLICATE_LESSON'
            ? t('promote.duplicate')
            : t(
                (
                  {
                    NOT_PERMITTED: 'refused.notPermitted',
                    INVALID: 'refused.invalid',
                    UNAVAILABLE: 'refused.unavailable',
                    FAILED: 'refused.failed',
                  } as const
                )[failure.code],
              )
        }
        detail={failure.code === 'DUPLICATE_LESSON' ? failure.detail : null}
        retry={
          failure.code === 'DUPLICATE_LESSON'
            ? null
            : { label: t('triage.retry'), onRetry: () => run(act), disabled: busy }
        }
      />
    ) : null;

  const saveLabel = (act: Act, idle: string) => (submitting === act ? t('triage.saving') : idle);
  const cancel = (
    <Button variant="ghost" size="sm" onClick={reset} disabled={busy}>
      {t('triage.cancel')}
    </Button>
  );

  const attributionOptions: ComboboxOption<string>[] = PLANNER_FINDING_ATTRIBUTION_VALUES.map(
    (value) => ({ value, label: attributionLabel(value) }),
  );
  if (!attributionOptions.some((o) => o.value === detail.attribution)) {
    attributionOptions.push({ value: detail.attribution, label: detail.attribution });
  }
  const typeOptions: ComboboxOption<PlatformLessonMistakeType>[] =
    PLATFORM_LESSON_MISTAKE_TYPES.map((value) => ({ value, label: typeLabel(value) }));

  const bugTyped = bugKey.trim().length > 0;
  const bugValid = looksLikeBugKey(bugKey);
  const promoteBlank = {
    title: promote.title.trim() === '',
    why: promote.why.trim() === '',
    howToApply: promote.howToApply.trim() === '',
  };
  const promoteReady = !promoteBlank.title && !promoteBlank.why && !promoteBlank.howToApply;

  return (
    <Card
      role="region"
      aria-labelledby={headingId}
      data-testid="planner-finding-triage"
      header={
        <h2
          id={headingId}
          className="font-sans text-xs font-medium uppercase tracking-wide text-(--el-text-secondary)"
        >
          {t('triage.title')}
        </h2>
      }
    >
      <div className="flex flex-col gap-3 font-sans">
        <div className="flex flex-wrap gap-2">
          {dismissed ? (
            <Button
              size="sm"
              variant="secondary"
              data-testid="planner-finding-restore"
              leftIcon={<RotateCcw aria-hidden className="h-3.5 w-3.5" />}
              loading={submitting === 'restore'}
              disabled={busy}
              onClick={() => run('restore')}
            >
              {saveLabel('restore', t('dismiss.restore'))}
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Tag aria-hidden className="h-3.5 w-3.5" />}
                aria-expanded={form === 'attribution'}
                disabled={busy}
                onClick={() => open('attribution')}
              >
                {t('attr.open')}
              </Button>
              {promoteOffered ? (
                <Button
                  size="sm"
                  variant="secondary"
                  leftIcon={<BookOpen aria-hidden className="h-3.5 w-3.5" />}
                  aria-expanded={form === 'promote'}
                  disabled={busy}
                  onClick={() => open('promote')}
                >
                  {t('promote.open')}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Bug aria-hidden className="h-3.5 w-3.5" />}
                aria-expanded={form === 'bug'}
                disabled={busy}
                onClick={() => open('bug')}
              >
                {t('bug.open')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-testid="planner-finding-dismiss"
                leftIcon={<EyeOff aria-hidden className="h-3.5 w-3.5" />}
                disabled={busy}
                onClick={openDismiss}
              >
                {t('dismiss.open')}
              </Button>
            </>
          )}
        </div>

        {form === 'attribution' && !dismissed ? (
          <FormBox testId="planner-finding-attribution">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-(--el-text)">{t('attr.label')}</span>
              <Combobox
                label={t('attr.label')}
                options={attributionOptions}
                value={attribution}
                onChange={setAttribution}
                searchable={false}
                disabled={busy}
              />
              <p className="text-xs text-(--el-text-secondary)">{t('attr.hint')}</p>
              <p className="text-xs text-(--el-text-secondary)">{t('attr.regroupNote')}</p>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                loading={submitting === 'attribution'}
                disabled={busy || attribution === detail.attribution}
                onClick={() => run('attribution')}
              >
                {saveLabel('attribution', t('attr.save'))}
              </Button>
              {cancel}
            </div>
            {errorBox('attribution')}
          </FormBox>
        ) : null}

        {form === 'promote' && promoteOffered && !dismissed ? (
          <FormBox testId="planner-finding-promote-form">
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold text-(--el-text)">{t('promote.title')}</h3>
              <p className="text-xs text-(--el-text-secondary)">{t('promote.intro')}</p>
            </div>
            <Input
              label={t('promote.fieldTitle')}
              value={promote.title}
              disabled={busy}
              onChange={(e) => setPromote({ ...promote, title: e.target.value })}
              error={promoteBlank.title ? t('promote.blank') : undefined}
            />
            <Textarea
              label={t('promote.fieldWhy')}
              value={promote.why}
              rows={3}
              disabled={busy}
              onChange={(e) => setPromote({ ...promote, why: e.target.value })}
              error={promoteBlank.why ? t('promote.blank') : undefined}
            />
            <Textarea
              label={t('promote.fieldHow')}
              value={promote.howToApply}
              rows={3}
              disabled={busy}
              onChange={(e) => setPromote({ ...promote, howToApply: e.target.value })}
              error={promoteBlank.howToApply ? t('promote.blank') : undefined}
            />
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-(--el-text)">{t('promote.fieldType')}</span>
              <Combobox
                label={t('promote.fieldType')}
                options={typeOptions}
                value={promote.mistakeType}
                onChange={(mistakeType) => setPromote({ ...promote, mistakeType })}
                searchable={false}
                disabled={busy}
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={busy || !promoteReady}
                onClick={() => {
                  setFailure(null);
                  setConfirm('promote');
                }}
              >
                {t('promote.review')}
              </Button>
              {cancel}
            </div>
            {errorBox('promote')}
          </FormBox>
        ) : null}

        {form === 'bug' && !dismissed ? (
          <FormBox testId="planner-finding-bug-key">
            <Input
              label={t('bug.label')}
              helperText={t('bug.hint')}
              placeholder={t('bug.placeholder')}
              value={bugKey}
              disabled={busy}
              onChange={(e) => setBugKey(e.target.value)}
              // A courtesy check: the triage service's rule is the authority.
              error={bugTyped && !bugValid ? t('bug.invalid') : undefined}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="primary"
                loading={submitting === 'bug'}
                disabled={busy || !bugValid}
                onClick={() => run('bug')}
              >
                {saveLabel('bug', t('bug.save'))}
              </Button>
              {cancel}
            </div>
            {errorBox('bug')}
          </FormBox>
        ) : null}

        {errorBox('restore')}

        {notLinkedLesson ? (
          <div
            role="alert"
            data-testid="planner-finding-lesson-not-linked"
            className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-danger) bg-(--el-danger-surface) px-(--spacing-control-x) py-(--spacing-control-y) text-sm"
          >
            <AlertTriangle
              aria-hidden
              className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger-on-surface)"
            />
            <span className="flex flex-col gap-1">
              <span className="text-(--el-text)">{t('refused.lessonNotLinked')}</span>
              <Link
                href={`/admin/planning-lessons/${encodeURIComponent(notLinkedLesson)}`}
                className="w-fit text-(--el-link) hover:underline"
              >
                {t('detail.lessonLink')}
              </Link>
            </span>
          </div>
        ) : null}

        {notice ? (
          <p
            role="status"
            data-testid="planner-finding-triage-notice"
            className="flex items-start gap-2 text-sm text-(--el-text-secondary)"
          >
            {notice.tone === 'warning' ? (
              <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-warning)" />
            ) : null}
            <span>{notice.text}</span>
          </p>
        ) : null}
      </div>

      <Modal
        open={confirm !== null}
        onOpenChange={(next) => {
          if (!next && !busy) setConfirm(null);
        }}
        role="alertdialog"
        title={confirm === 'promote' ? t('promote.confirmTitle') : t('dismiss.title')}
        description={confirm === 'promote' ? t('promote.confirmBody') : t('dismiss.body')}
        size="md"
      >
        {confirm === 'dismiss' ? (
          <Modal.Body className="gap-4">
            <Textarea
              label={t('dismiss.reasonLabel')}
              placeholder={t('dismiss.reasonPlaceholder')}
              value={note}
              rows={3}
              maxLength={DISMISS_NOTE_MAX}
              disabled={busy}
              onChange={(e) => setNote(e.target.value)}
            />
            {errorBox('dismiss')}
          </Modal.Body>
        ) : null}
        <Modal.Footer>
          <Button
            variant="ghost"
            onClick={() => (confirm === 'dismiss' ? reset() : setConfirm(null))}
            disabled={busy}
          >
            {t('triage.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={submitting === confirm && confirm !== null}
            disabled={busy}
            onClick={() => (confirm ? run(confirm) : undefined)}
          >
            {confirm === 'promote'
              ? saveLabel('promote', t('promote.confirm'))
              : saveLabel('dismiss', t('dismiss.confirm'))}
          </Button>
        </Modal.Footer>
      </Modal>
    </Card>
  );
}

function FormBox({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col gap-3 rounded-(--radius-card) border border-(--el-border) p-(--spacing-card-padding-12)"
    >
      {children}
    </div>
  );
}

/** The design's inline error: danger border on the danger tint, the sentence on `--el-text`. */
function TriageError({
  text,
  detail,
  retry,
}: {
  text: string;
  detail: string | null;
  retry: { label: string; onRetry: () => void; disabled: boolean } | null;
}) {
  return (
    <div
      role="alert"
      data-testid="planner-finding-triage-error"
      className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-danger) bg-(--el-danger-surface) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-sm"
    >
      <AlertTriangle
        aria-hidden
        className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger-on-surface)"
      />
      <span className="flex flex-col gap-2">
        <span className="text-(--el-text)">{text}</span>
        {detail ? <span className="text-xs text-(--el-text)">{detail}</span> : null}
        {retry ? (
          <Button
            size="sm"
            variant="secondary"
            className="w-fit"
            disabled={retry.disabled}
            onClick={retry.onRetry}
          >
            {retry.label}
          </Button>
        ) : null}
      </span>
    </div>
  );
}
