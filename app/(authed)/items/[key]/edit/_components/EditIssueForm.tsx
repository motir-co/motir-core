'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/Input';
import { DatePicker } from '@motir/design-system';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import { MarkdownEditor } from '@/components/ui/MarkdownEditor';
import { searchWorkItemMentions } from '@/lib/mentions/workItemMentionSearch';
import { searchPageMentions } from '@/lib/mentions/pageMentionSearch';
import { uploadIssueAttachment } from '@/lib/blob/uploadClient';
import { ParentPicker } from '@/components/issues/ParentPicker';
import { StatusPicker } from '@/components/issues/StatusPicker';
import { StatusHeldNotice } from '@/components/issues/StatusHeldNotice';
import { useStatusHeld } from '@/components/issues/useStatusHeld';
import type { HeldTransitionDTO } from '@/lib/dto/approvalGate';
import type { PlanHoldDTO } from '@/lib/dto/plans';
import { AssigneePicker } from '@/components/issues/AssigneePicker';
import { TypePicker } from '@/components/issues/TypePicker';
import { PriorityPicker } from '@/components/issues/PriorityPicker';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import {
  DraftWithAiButton,
  DraftGateNotice,
  DraftErrorNotice,
} from '@/components/issues/DraftWithAi';
import { useExplanationDraft } from '@/lib/hooks/useExplanationDraft';
import {
  isUntouchedAiDraft,
  explanationLanguageForSave,
  explanationSourceForSave,
} from '@/lib/ai/explanationSource';
import type { IssueType } from '@/lib/issues/parentRules';
import type { WorkItemDto, WorkItemKindDto, WorkItemPriorityDto } from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import { updateIssueAction, changeStatusAction } from '../actions';
import {
  OriginalLanguageAccessory,
  useOriginalLanguageNote,
} from '../../_components/translation/OriginalLanguageNote';

// The full edit form (Subtask 2.3.6). Status and non-status fields submit via
// TWO distinct Server Actions (finding #46): `changeStatusAction` → the gated
// updateStatus, everything else → updateWorkItem. Optimistic concurrency: the
// `updatedAt` read at render is submitted + checked server-side; a 409 surfaces
// a refresh banner. Type (kind) is editable — a change re-validates against the
// current parent + children via assertValidParent (an illegal pair 422s and
// surfaces on the Parent field). Parent + Explanation are editable too; Reporter
// is read-only.

const isoToDateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

export interface EditIssueFormProps {
  issue: WorkItemDto;
  workflow: WorkflowDto;
  members: WorkspaceMemberDTO[];
  /**
   * Whether motir-core is wired to a Motir AI deployment (Subtask 8.8.12),
   * resolved server-side on the edit page. Gates the explanation's "Draft with
   * AI" affordance. Defaults to false (safe disabled state) for test mounts.
   */
  aiConfigured?: boolean;
  /** The status moves an approval HOLDS (MOTIR-5528) — the status field says so
   *  and locks them. Defaults to `[]`. */
  heldTransitions?: HeldTransitionDTO[];
  /** The undecided PLAN holding the card at Planning (MOTIR-6267) — every move
   *  locked, said on the status field with a Review plan door. Defaults to none. */
  planHold?: PlanHoldDTO | null;
  /** Whether the viewer may see the project's pages (`page:view`, MOTIR-7698).
   *  Only then do Description and Explanation offer the `@` picker's Pages
   *  section. Defaults to false. */
  canViewPages?: boolean;
}

export function EditIssueForm({
  issue,
  workflow,
  members,
  aiConfigured = false,
  heldTransitions,
  planHold,
  canViewPages = false,
}: EditIssueFormProps) {
  // The page search behind both editors' Pages section, bound to the item's own
  // project (MOTIR-7698) — absent for a viewer without `page:view`, so their
  // picker has no Pages section and sends no request. Created once: the editor
  // reads it at mount.
  const [pageSearch] = useState(() =>
    canViewPages ? (query: string) => searchPageMentions(issue.projectId, query) : undefined,
  );
  const statusHeld = useStatusHeld(
    heldTransitions,
    workflow.statuses,
    issue.status,
    planHold,
    // A marked card holds every non-done status (MOTIR-6676). This page draws no
    // Obsolescence field, so the mark is the served one; the door goes to the item
    // page's field.
    issue.obsolescence,
  );
  const router = useRouter();
  const t = useTranslations('issueViews');
  // The language the STORED title is recorded in (MOTIR-8832, design MOTIR-8837).
  // `FormField` shows an error in place of the helper, so the note returns the
  // moment a title error clears.
  const titleNote = useOriginalLanguageNote(issue.languages.title, issue.title.trim() !== '');
  const tc = useTranslations('common');
  const tErr = useTranslations('errors');
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();

  // Concurrency token — bumped after each successful save so a follow-up edit
  // in the same session doesn't conflict with the row this form just wrote.
  const [updatedAt, setUpdatedAt] = useState(issue.updatedAt);
  const [stale, setStale] = useState(false);

  const [kind, setKind] = useState<WorkItemKindDto>(issue.kind);
  const [title, setTitle] = useState(issue.title);
  const [description, setDescription] = useState(issue.descriptionMd ?? '');
  const [explanation, setExplanation] = useState(issue.explanationMd ?? '');
  const [parentId, setParentId] = useState<string | null>(issue.parentId);
  const [status, setStatus] = useState(issue.status);
  const [priority, setPriority] = useState<WorkItemPriorityDto>(issue.priority);
  const [assigneeId, setAssigneeId] = useState<string | null>(issue.assigneeId);
  const [dueDate, setDueDate] = useState(isoToDateInput(issue.dueDate));
  const [estimate, setEstimate] = useState(
    issue.estimateMinutes != null ? String(issue.estimateMinutes) : '',
  );

  // "Draft with AI" (Subtask 8.8.12) — streams a generated explanation into the
  // editor from the item's title / description / type.
  const draft = useExplanationDraft({
    onText: setExplanation,
    getContext: () => ({ title: title.trim(), description, type: issue.type ?? null }),
  });
  // The AI-drafted badge shows for an untouched fresh draft this session OR a
  // persisted ai_draft the user hasn't edited yet (it drops the moment the text
  // diverges from either baseline — mirroring the service's source state machine).
  const showAiDraftedPill =
    draft.draftBaseline !== null
      ? isUntouchedAiDraft(explanation, draft.draftBaseline)
      : issue.explanationSource === 'ai_draft' && explanation === (issue.explanationMd ?? '');

  const [titleError, setTitleError] = useState<string | null>(null);
  const [parentError, setParentError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  // A frozen snapshot of what's on the server, so we only submit real changes.
  const initial = issue;
  const reporter = members.find((m) => m.userId === issue.reporterId);

  const nonStatusDirty =
    kind !== initial.kind ||
    title !== initial.title ||
    (description || null) !== (initial.descriptionMd ?? null) ||
    (explanation || null) !== (initial.explanationMd ?? null) ||
    parentId !== initial.parentId ||
    priority !== initial.priority ||
    assigneeId !== initial.assigneeId ||
    isoToDateInput(initial.dueDate) !== dueDate ||
    (estimate === '' ? null : Number(estimate)) !== initial.estimateMinutes;
  const statusDirty = status !== initial.status;
  const canSubmit = title.trim().length > 0 && (nonStatusDirty || statusDirty);

  function clearErrors() {
    setTitleError(null);
    setParentError(null);
    setStatusError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    clearErrors();
    if (title.trim().length === 0) {
      setTitleError(t('titleRequired'));
      return;
    }

    startTransition(async () => {
      // 1) Non-status fields → updateWorkItem (carries the concurrency token).
      let token = updatedAt;
      if (nonStatusDirty) {
        // Explanation provenance (8.8.12): an untouched AI draft → `ai_draft`,
        // an edited draft → `user_edited`; omitted otherwise so the service's
        // auto-flip rule (editing an existing ai_draft → user_edited) applies.
        const explanationSource = explanationSourceForSave(explanation, draft.draftBaseline);
        // …and the language it was drafted in (MOTIR-8744); omitted otherwise, so
        // the write door records the organisation's content language.
        const explanationLanguage = explanationLanguageForSave(
          explanation,
          draft.draftBaseline,
          draft.draftLanguage,
        );
        const res = await updateIssueAction({
          id: issue.id,
          expectedUpdatedAt: token,
          kind,
          title: title.trim(),
          descriptionMd: description.trim() ? description : null,
          explanationMd: explanation.trim() ? explanation : null,
          ...(explanationSource ? { explanationSource } : {}),
          ...(explanationLanguage ? { languages: { explanation: explanationLanguage } } : {}),
          parentId,
          assigneeId,
          priority,
          dueDate: dueDate ? new Date(`${dueDate}T00:00:00.000Z`).toISOString() : null,
          estimateMinutes: estimate === '' ? null : Number(estimate),
        });
        if (!res.ok) {
          if (res.stale) setStale(true);
          else if (res.field === 'parent') setParentError(res.error);
          else toast({ variant: 'error', title: res.error });
          return;
        }
        token = res.updatedAt;
        setUpdatedAt(res.updatedAt);
      }

      // 2) Status → the gated changeStatusAction.
      if (statusDirty) {
        const res = await changeStatusAction({ id: issue.id, toStatusKey: status });
        if (!res.ok) {
          // A hold that arrived after render (MOTIR-5528): put the status back and
          // say so on the status field with its door, not as a field error.
          if (res.code === 'APPROVAL_GATE_PENDING' && res.gate) {
            statusHeld.onRefused(status, res.gate);
            setStatus(issue.status);
          } else if (res.code === 'PLAN_TARGET_HELD' && res.plan) {
            // A plan took the card after render (MOTIR-6267): the same, with the
            // plan's line and its Review plan door.
            statusHeld.onPlanHeldRefused(res.plan);
            setStatus(issue.status);
          } else if (res.code === 'MARKED_CARD_CANNOT_REOPEN' && res.mark) {
            // Marked after render (MOTIR-6676): the same, with the mark's line.
            statusHeld.onMarkRefused(res.mark);
            setStatus(issue.status);
          } else if (res.field === 'status') setStatusError(res.error);
          else toast({ variant: 'error', title: res.error });
          return;
        }
        setUpdatedAt(res.updatedAt);
      }

      toast({ variant: 'success', title: t('issueSaved', { identifier: issue.identifier }) });
      router.refresh();
    });
  }

  return (
    <form className="flex w-full flex-col gap-4" onSubmit={handleSubmit}>
      <div className="flex items-center gap-2">
        <IssueTypeIcon type={kind as IssueType} className="h-4 w-4" />
        <span className="text-(--el-text-muted) font-mono text-sm">{issue.identifier}</span>
      </div>

      {stale ? (
        <div
          role="alert"
          className="border-(--el-danger) bg-(--el-card) text-(--el-text) flex items-center justify-between gap-3 rounded-(--radius-card) border px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) text-sm"
        >
          <span>{t('staleBanner')}</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => router.refresh()}>
            {t('refresh')}
          </Button>
        </div>
      ) : null}

      <Input
        label={t('title')}
        helperText={titleNote ?? undefined}
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          if (titleError) setTitleError(null);
        }}
        error={titleError ?? undefined}
        maxLength={200}
        disabled={isPending}
        required
      />

      {/* The MarkdownEditor renders its own label (also its aria-label) — no
          wrapping <label>/span, else "Description" shows twice. */}
      <MarkdownEditor
        label={t('description')}
        labelAccessory={
          <OriginalLanguageAccessory
            language={issue.languages.description}
            hasText={issue.descriptionMd != null && issue.descriptionMd.trim() !== ''}
          />
        }
        value={description}
        onChange={setDescription}
        size="full"
        onFileUpload={(f) => uploadIssueAttachment(f, tErr)}
        workItemSearch={searchWorkItemMentions}
        pageSearch={pageSearch}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="flex flex-col gap-1 font-sans text-sm">
          <span className="text-(--el-text) font-medium">{t('type')}</span>
          <TypePicker
            value={kind as IssueType}
            onChange={(t) => {
              setKind(t);
              // A kind change re-validates against the current parent + children;
              // a conflict surfaces on the Parent field (IllegalParentTypeError).
              if (parentError) setParentError(null);
            }}
            disabled={isPending}
          />
        </div>

        <div className="flex flex-col gap-1 font-sans text-sm">
          <span className="text-(--el-text) font-medium">{t('status')}</span>
          <StatusPicker
            statuses={workflow.statuses}
            transitions={workflow.transitions}
            policyMode={workflow.policyMode}
            value={status}
            onChange={(s) => {
              setStatus(s);
              if (statusError) setStatusError(null);
            }}
            error={statusError}
            disabled={isPending}
            held={statusHeld.held}
          />
          <StatusHeldNotice
            itemKey={issue.identifier}
            lines={statusHeld.lines}
            plan={statusHeld.plan}
            mark={statusHeld.mark}
          />
        </div>

        <div className="flex flex-col gap-1 font-sans text-sm">
          <span className="text-(--el-text) font-medium">{t('parent')}</span>
          <ParentPicker
            childType={issue.kind as IssueType}
            value={parentId}
            onChange={(id) => {
              setParentId(id);
              if (parentError) setParentError(null);
            }}
            error={parentError}
            disabled={isPending}
          />
        </div>

        <div className="flex flex-col gap-1 font-sans text-sm">
          <span className="text-(--el-text) font-medium">{t('assignee')}</span>
          <AssigneePicker
            members={members}
            value={assigneeId}
            onChange={setAssigneeId}
            disabled={isPending}
          />
        </div>

        <div className="flex flex-col gap-1 font-sans text-sm">
          <span className="text-(--el-text) font-medium">{t('priority')}</span>
          <PriorityPicker value={priority} onChange={setPriority} disabled={isPending} />
        </div>

        <div className="flex flex-col gap-1 font-sans text-sm">
          <span className="text-(--el-text) font-medium">{t('dueDate')}</span>
          <DatePicker
            aria-label={t('dueDate')}
            value={dueDate || null}
            onChange={(next) => setDueDate(next ?? '')}
            disabled={isPending}
          />
        </div>

        <div className="flex flex-col gap-1 font-sans text-sm">
          <span className="text-(--el-text) font-medium">{t('estimateMinutes')}</span>
          <Input
            type="number"
            min={0}
            aria-label={t('estimateMinutes')}
            value={estimate}
            onChange={(e) => setEstimate(e.target.value)}
            disabled={isPending}
          />
        </div>
      </div>

      {/* Editable, with "Draft with AI" (Subtask 8.8.12): drafting streams a
          generated explanation into the editor; editing an ai_draft auto-flips
          its source to user_edited in the service. The gloss + AI-drafted badge
          + the Draft button ride the editor's own label via labelAccessory — no
          external "Explanation" span, else it shows twice. */}
      <MarkdownEditor
        label={t('explanation')}
        labelAccessory={
          <>
            <span className="text-(--el-text-secondary) font-normal">
              — {t('explanationGloss')}
            </span>
            <OriginalLanguageAccessory
              language={issue.languages.explanation}
              hasText={issue.explanationMd != null && issue.explanationMd.trim() !== ''}
            />
            {showAiDraftedPill ? <Pill severity="info">{t('aiDrafted')}</Pill> : null}
            <DraftWithAiButton
              phase={draft.phase}
              hasDraft={draft.draftBaseline !== null}
              aiConfigured={aiConfigured}
              disabled={isPending || title.trim().length === 0}
              onStart={draft.start}
              onStop={draft.stop}
            />
          </>
        }
        value={explanation}
        onChange={setExplanation}
        size="full"
        onFileUpload={(f) => uploadIssueAttachment(f, tErr)}
        workItemSearch={searchWorkItemMentions}
        pageSearch={pageSearch}
      />
      {!aiConfigured ? <DraftGateNotice /> : null}
      {draft.phase === 'error' ? (
        <DraftErrorNotice
          onRetry={draft.start}
          onDismiss={draft.dismissError}
          errorCode={draft.error?.code}
        />
      ) : null}

      <div className="text-(--el-text-muted) font-sans text-xs">
        {t('reporterCreated', {
          reporter: reporter ? reporter.name : issue.reporterId,
          created: issue.createdAt.slice(0, 10),
        })}
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.push('/items')}
          disabled={isPending}
        >
          {tc('cancel')}
        </Button>
        <Button type="submit" variant="primary" disabled={!canSubmit} loading={isPending}>
          {tc('save')}
        </Button>
      </div>
    </form>
  );
}
