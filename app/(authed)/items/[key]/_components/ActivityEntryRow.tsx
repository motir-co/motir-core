'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { Component } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { Pill } from '@/components/ui/Pill';
import { ValueChip } from '@/components/ui/MultiSelectPicker';
import { labelTint } from '@/lib/labels/labelTint';
import { formatDate } from '@/lib/utils/datetime';
import type { Locale } from '@/lib/i18n/locales';
import type { ActivityEntryDto, ActivityEntryPartDto, ActivityValueDto } from '@/lib/dto/activity';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import { StatusPill } from '@/components/issues/StatusPill';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import { reviewCommitsLabel } from '@/lib/agentReview/verdictActivity';
import { AgentVerdictActivityRow } from './AgentVerdictActivityRow';

// One History feed row (Story 5.5 · Subtask 5.5.4), per
// `design/work-items/activity-history.mock.html` panels 1–2: comment-row-
// aligned (the same 22px first column, so the two row kinds stay left-aligned
// in All) but visually QUIETER — an 18px initial-letter avatar, the sentence
// line in 13px secondary ink with the actor (semibold) and the field name
// (medium) lifted out, relative time (absolute on hover via `title`, the
// comment-row convention), and the value line below: old struck-muted → new
// medium-weight, empty sides as italic faint "None" (the changelog null).
// Append-only: NO action affordance exists on any row, for any role.
//
// A revision may carry several renderable parts (one edit-form save can touch
// many fields); the feed renders ONE row PER PART — each a complete sentence,
// the Jira changelog line grammar — so the caller flatMaps an entry's parts
// through this component.

/** The per-change-type value forms (panel 1): how each side renders. */
function HistoryAvatar({ name }: { name: string | null }) {
  return (
    <span
      className={cn(
        'mt-px inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center justify-self-center rounded-full text-[9px] font-semibold',
        name
          ? 'bg-(--el-text) text-(--el-text-inverted)'
          : 'bg-(--el-muted) text-(--el-text-muted)',
      )}
      aria-hidden
    >
      {name ? name.charAt(0).toUpperCase() : '?'}
    </span>
  );
}

/** Sentence-line emphasis spans (the mock's .h-actor / .h-field grammar). */
function actorChunk(name: string | null, formerLabel: string): ReactNode {
  return name ? (
    <span className="text-(--el-text) font-semibold">{name}</span>
  ) : (
    <span className="text-(--el-text-muted) font-medium italic">{formerLabel}</span>
  );
}

function fieldChunk(chunks: ReactNode): ReactNode {
  return <span className="text-(--el-text) font-medium">{chunks}</span>;
}

/** Diff keys → the localized field-name message id (a closed set — `field`
 * parts only arise from registry-registered keys; `customFields.<key>` shows
 * its stored key suffix until the 5.3 definition-label resolution lands). */
const FIELD_NAME_KEYS: Record<string, string> = {
  title: 'title',
  kind: 'kind',
  priority: 'priority',
  status: 'status',
  assigneeId: 'assigneeId',
  reporterId: 'reporterId',
  parentId: 'parentId',
  projectId: 'projectId',
  dueDate: 'dueDate',
  estimateMinutes: 'estimateMinutes',
  storyPoints: 'storyPoints',
  difficulty: 'difficulty',
  obsolescence: 'obsolescence',
  obsolescenceNoteMd: 'obsolescenceNoteMd',
  type: 'type',
  executor: 'executor',
  targetRepo: 'targetRepo',
  targetRepos: 'targetRepos',
  folderId: 'folderId',
  descriptionMd: 'descriptionMd',
  explanationMd: 'explanationMd',
  explanationSource: 'explanationSource',
  archivedAt: 'archivedAt',
  pageLinks: 'pageLinks',
};

/** The stored `WorkItemLinkKindDto` values + the renderer's `blocks` default
 * — lowercase inline forms (the mock's "linked PROD-12 as _blocks_"). */
const LINK_KIND_KEYS: Record<string, string> = {
  blocks: 'blocks',
  is_blocked_by: 'is_blocked_by',
  relates_to: 'relates_to',
  duplicates: 'duplicates',
  clones: 'clones',
  supersedes: 'supersedes',
};

export function ActivityEntryRow({
  entry,
  part,
  statusCategories,
}: {
  entry: ActivityEntryDto;
  part: ActivityEntryPartDto;
  /** Status key → lifecycle category (the project workflow) — the Pill tint. */
  statusCategories: Readonly<Record<string, StatusCategoryDto>>;
}) {
  // An agent's review verdict (MOTIR-10338) has its own row grammar — a Bot disc, not an
  // initial avatar — so it is its own component rather than one more sentence here.
  if (part.kind === 'agentVerdict') return <AgentVerdictActivityRow entry={entry} part={part} />;
  return <RevisionEntryRow entry={entry} part={part} statusCategories={statusCategories} />;
}

function RevisionEntryRow({
  entry,
  part,
  statusCategories,
}: {
  entry: ActivityEntryDto;
  part: Exclude<ActivityEntryPartDto, { kind: 'agentVerdict' }>;
  statusCategories: Readonly<Record<string, StatusCategoryDto>>;
}) {
  const routes = useReaderRoutes();
  const t = useTranslations('activity');
  const tReview = useTranslations('approvalGate.reviewPath.activity');
  const format = useFormatter();
  const locale = useLocale() as Locale;
  const changedAt = new Date(entry.changedAt);

  function fieldName(key: string): string {
    if (key.startsWith('customFields.')) return key.slice('customFields.'.length);
    const messageId = FIELD_NAME_KEYS[key];
    return messageId ? t(`fields.${messageId}`) : key;
  }

  /** "None" — the changelog null (italic faint, never struck). */
  function noneSpan(): ReactNode {
    return <span className="text-(--el-text-secondary) font-sans italic">{t('none')}</span>;
  }

  /** Status side — the workflow LABEL as a Pill (tint by category; the
   * `blocked` key takes the mock's peach; an unknown/deleted status falls
   * back to a neutral Pill on its stored key). */
  function statusSide(value: Extract<ActivityValueDto, { type: 'status' }>): ReactNode {
    const label = value.label ?? value.key;
    if (value.key === 'blocked') return <Pill severity="warning">{label}</Pill>;
    const category = statusCategories[value.key];
    return category ? (
      <StatusPill statusKey={value.key} category={category} label={label} />
    ) : (
      <Pill tone="neutral">{label}</Pill>
    );
  }

  /** User side — 18px avatar + name; a deleted referent renders the
   * "Former member" form (muted "?" avatar, italic name), never a broken
   * entry. */
  function userSide(
    value: Extract<ActivityValueDto, { type: 'user' }>,
    side: 'from' | 'to',
  ): ReactNode {
    return (
      <span className="inline-flex items-center gap-1.5">
        <HistoryAvatar name={value.name} />
        {value.name ? (
          <span className={sideText(side)}>{value.name}</span>
        ) : (
          <span className="text-(--el-text-muted) italic">{t('formerMember')}</span>
        )}
      </span>
    );
  }

  /** Issue side — the identifier mono in `--el-link` (the links.mock
   * vocabulary); a deleted referent shows its stored id, unlinked. */
  function issueSide(value: Extract<ActivityValueDto, { type: 'issue' }>): ReactNode {
    return value.identifier ? (
      <Link
        href={routes.item(value.identifier)}
        className="text-(--el-link) rounded-(--radius-control) font-mono text-xs hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        {value.identifier}
      </Link>
    ) : (
      <span className="text-(--el-text-muted) font-mono text-xs">{value.workItemId}</span>
    );
  }

  /** Old struck-through muted / new medium-weight (the mock's .v-old/.v-new). */
  function sideText(side: 'from' | 'to'): string {
    return side === 'from'
      ? 'text-(--el-text-muted) line-through decoration-(--el-border-strong)'
      : 'text-(--el-text) font-medium';
  }

  function valueSide(value: ActivityValueDto, side: 'from' | 'to'): ReactNode {
    switch (value.type) {
      case 'none':
        return noneSpan();
      case 'text':
        return <span className={sideText(side)}>{value.text}</span>;
      case 'status':
        return statusSide(value);
      case 'user':
        return userSide(value, side);
      case 'date':
        return <span className={sideText(side)}>{formatDate(value.date, locale)}</span>;
      case 'sprint':
        return <span className={sideText(side)}>{value.name ?? value.sprintId}</span>;
      case 'issue':
        return issueSide(value);
    }
  }

  /** The value line — old → new (the arrow in `--el-text-faint`). */
  function valueLine(from: ReactNode, to: ReactNode): ReactNode {
    return (
      <div className="text-(--el-text) flex flex-wrap items-center gap-1.5 font-sans text-[13px]">
        {from}
        <span className="text-(--el-text-faint)" aria-hidden>
          →
        </span>
        {to}
      </div>
    );
  }

  const actor = (): ReactNode => actorChunk(entry.actor.name, t('formerMember'));

  /** Sentence + optional value line per part kind (panels 1–2). */
  function partContent(): { sentence: ReactNode; values?: ReactNode; anchor?: boolean } {
    switch (part.kind) {
      case 'created':
        return { sentence: t.rich('created', { actor }), anchor: true };
      case 'archived':
        return { sentence: t.rich('archived', { actor }), anchor: true };
      case 'unarchived':
        return { sentence: t.rich('unarchived', { actor }), anchor: true };
      case 'fieldEdited':
        return {
          sentence: t.rich('updatedField', {
            actor,
            field: fieldChunk,
            fieldName: fieldName(part.field),
          }),
        };
      case 'field': {
        if (part.field === 'sprintId') {
          // "moved this issue to Sprint 4 / the Backlog" — names resolved,
          // never ids; an empty side reads "Backlog" (the design's form).
          const backlog = t('backlog');
          const sprintSide = (value: ActivityValueDto, side: 'from' | 'to'): ReactNode =>
            value.type === 'none' ? (
              <span className={side === 'from' ? sideText('from') : sideText('to')}>{backlog}</span>
            ) : (
              valueSide(value, side)
            );
          const movedToBacklog = part.to.type === 'none';
          const targetName =
            part.to.type === 'sprint' ? (part.to.name ?? part.to.sprintId) : backlog;
          return {
            sentence: t.rich(movedToBacklog ? 'movedToBacklog' : 'movedToSprint', {
              actor,
              target: fieldChunk,
              targetName,
            }),
            values: valueLine(sprintSide(part.from, 'from'), sprintSide(part.to, 'to')),
          };
        }
        return {
          sentence: t.rich('changedField', {
            actor,
            field: fieldChunk,
            fieldName: fieldName(part.field),
          }),
          values: valueLine(valueSide(part.from, 'from'), valueSide(part.to, 'to')),
        };
      }
      case 'link': {
        const kindKey = LINK_KIND_KEYS[part.linkKind];
        const kindLabel = kindKey ? t(`linkKinds.${kindKey}`) : part.linkKind.replace(/_/g, ' ');
        return {
          sentence: t.rich(part.op === 'added' ? 'linkAdded' : 'linkRemoved', {
            actor,
            kind: () => <span className="italic">{kindLabel}</span>,
            target: () =>
              part.target.type === 'issue' ? (
                issueSide(part.target)
              ) : (
                <span className="font-mono text-xs">{t('none')}</span>
              ),
          }),
        };
      }
      case 'collection': {
        if (part.field === 'attachments') {
          return {
            sentence: t.rich(part.op === 'added' ? 'attached' : 'attachmentRemoved', {
              actor,
              files: () => (
                <span className="text-(--el-text) font-mono text-xs">{part.items.join(', ')}</span>
              ),
            }),
          };
        }
        // Labels / components — the 5.4 chip vocabulary verbatim (labels keep
        // their name-hash tint; components stay neutral + glyph). A card's steps
        // (`todos`) read the same way: "added the Steps", counted.
        const isLabels = part.field === 'labels';
        const isComponents = part.field === 'components';
        const collectionName =
          isLabels || isComponents || part.field === 'todos'
            ? t(`fields.${part.field}`, { count: part.items.length })
            : fieldName(part.field);
        return {
          sentence: t.rich(part.op === 'added' ? 'collectionAdded' : 'collectionRemoved', {
            actor,
            field: fieldChunk,
            fieldName: collectionName,
          }),
          values: (
            <div className="flex flex-wrap items-center gap-1.5">
              {part.items.map((item, index) => (
                <ValueChip
                  key={`${item}:${index}`}
                  option={{
                    id: `${item}:${index}`,
                    label: item,
                    tint: isLabels ? labelTint(item) : undefined,
                    glyph: isComponents ? Component : undefined,
                  }}
                />
              ))}
            </div>
          ),
        };
      }
      case 'commentDeleted':
        return {
          sentence: t.rich('commentDeleted', { actor }),
          values: (
            <div className="text-(--el-text-muted) font-sans text-xs">
              {part.replyCount > 0
                ? t('commentDeletedReplies', { count: part.replyCount })
                : t('commentDeletedGloss')}
            </div>
          ),
        };
      // A person dismissed the agent's send-back (MOTIR-10434) — the shipped row grammar, the
      // person as the actor, the commits in the sentence and their reason on the value line
      // (`--el-text-secondary`, which holds AA on every surface the feed sits on).
      case 'reviewDismissed':
        return {
          sentence: tReview.rich('dismissed', {
            actor,
            commits: reviewCommitsLabel(part.subjectVersion),
          }),
          values: (
            <div className="text-(--el-text-secondary) font-sans text-xs whitespace-pre-wrap break-words">
              {tReview('dismissedReason', { reason: part.reasonMd })}
            </div>
          ),
        };
      case 'generic': {
        const sentence = t.rich('changedGeneric', {
          actor,
          key: () => (
            <span className="bg-(--el-muted) text-(--el-text) rounded-(--radius-control) px-(--spacing-kbd-x) py-(--spacing-kbd-y) font-mono text-xs">
              {part.key}
            </span>
          ),
        });
        const side = (raw: string | null, which: 'from' | 'to'): ReactNode =>
          raw === null ? noneSpan() : <span className={sideText(which)}>{raw}</span>;
        return { sentence, values: valueLine(side(part.from, 'from'), side(part.to, 'to')) };
      }
    }
  }

  const { sentence, values, anchor } = partContent();

  return (
    <div className="grid grid-cols-[22px_minmax(0,1fr)] gap-x-2.5">
      <HistoryAvatar name={entry.actor.name} />
      <div className="flex min-w-0 flex-col gap-1">
        <p
          className={cn(
            'font-sans text-[13px] leading-relaxed',
            anchor ? 'text-(--el-text-muted)' : 'text-(--el-text-secondary)',
          )}
        >
          {sentence}{' '}
          <span
            className="text-(--el-text-muted) ml-1 text-xs whitespace-nowrap"
            title={format.dateTime(changedAt, { dateStyle: 'medium', timeStyle: 'short' })}
          >
            {format.relativeTime(changedAt)}
          </span>
        </p>
        {values}
      </div>
    </div>
  );
}

/** History-row pulse skeleton (panel 5 — the BacklogSkeleton grammar shaped
 * like history rows: 18px circle + sentence/value bars). */
export function ActivitySkeleton({ rows }: { rows: number }) {
  return (
    <div aria-busy className="flex animate-pulse flex-col gap-3.5">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="grid grid-cols-[22px_minmax(0,1fr)] gap-x-2.5">
          <span className="bg-(--el-muted) mt-px h-[18px] w-[18px] justify-self-center rounded-full" />
          <div className="flex min-w-0 flex-col gap-1.5 pt-0.5">
            <span
              className="bg-(--el-muted) h-2.5 rounded-(--radius-control)"
              style={{ width: `${64 - (index % 3) * 12}%` }}
            />
            {index % 3 !== 2 ? (
              <span
                className="bg-(--el-muted) h-2.5 rounded-(--radius-control)"
                style={{ width: `${34 - (index % 3) * 6}%` }}
              />
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
