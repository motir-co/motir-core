'use client';

import type { ComponentType, ReactNode } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import {
  ShieldAlert,
  AtSign,
  Bell,
  Bot,
  Check,
  GitPullRequest,
  MessageSquare,
  Moon,
  UserCheck,
} from 'lucide-react';
import { agentVerdictHref } from '@/lib/agentReview/verdictActivity';
import { cn } from '@/lib/utils/cn';
import type { NotificationData, NotificationDTO } from '@/lib/dto/notifications';

// One notification row in the drawer feed (Subtask 5.7.5), per
// design/notifications/drawer.mock.html panels 0–1: the leading accent unread
// dot · the 30px initial-letter avatar carrying a small event-type glyph badge
// in the event's hue (finding #54 — the palette, not grey) · the one-line
// summary (actor + action + issue key, actor & key in --el-text-strong) with
// the relative time pushed right (absolute on hover/title) · the denormalized
// excerpt, single-line truncated. Read rows persist (greyed via --el-text-muted,
// no dot).
//
// ⚠️ No nested interactive elements (the portal-popover / nested-button
// lessons): the whole row is ONE clickable deep-link `<Link>`, and the per-row
// "mark read" toggle is a SIBLING `<button>` overlaid top-right — NOT a child of
// the link. Both call up to the drawer; clicking the row body also marks read.
//
// Mark-UNREAD is intentionally absent: the shipped 5.7.4 API exposes only
// markRead / markAllRead (no un-read mutation), so the toggle shows on unread
// rows only. The design's "mark as unread" affordance is surfaced as a finding
// (design vs shipped-API gap) rather than improvised against a missing endpoint.

// event type → its glyph + the dedicated `--el-notif-*` hue its avatar badge
// takes (MOTIR-1274 · 1266.3). commented/assigned/transitioned previously
// BORROWED the work-item-KIND hues `--el-type-task/story/subtask` for non-type
// meaning (misuse #2); each `--el-notif-*` keeps that exact hue but decoupled, so
// a palette can move notification badges without dragging the type ramp. Zero
// visual change. `mentioned` keeps the accent fill (`--el-notif-mentioned` =
// the same `--color-primary-fill` `--el-accent` resolved to).
const TYPE_META: Record<string, { Icon: ComponentType<{ className?: string }>; badge: string }> = {
  mentioned: { Icon: AtSign, badge: 'bg-(--el-notif-mentioned)' },
  commented: { Icon: MessageSquare, badge: 'bg-(--el-notif-commented)' },
  assigned: { Icon: UserCheck, badge: 'bg-(--el-notif-assigned)' },
  transitioned: { Icon: GitPullRequest, badge: 'bg-(--el-notif-transitioned)' },
  // MOTIR-5016 · Story MOTIR-5010 — the ACCESS-REFUSED row. `shield-alert`: a
  // permission that did not land. `user-x` reads as a PERSON removed from the
  // project and `key-round` as access you HAVE, so neither says this.
  // `--el-notif-access-refused` maps to `--color-warning` — the same hue the plan
  // review rail's `needs_access` outcome uses, so one product story is told in one
  // colour. NOT danger: nothing was lost, the repository exists.
  code_access_refused: { Icon: ShieldAlert, badge: 'bg-(--el-notif-access-refused)' },
  // MOTIR-10368 · Story MOTIR-10363 — an org owner or admin hibernated YOUR agent
  // (design/org-admin/design-notes.md, the Fleet delta's panel 12). `moon`, the
  // glyph the Fleet page's Hibernate control carries. It HAS an actor — the
  // admin — so it keeps the initial avatar and is NOT in ACTORLESS_TYPES.
  agent_hibernated_by_admin: { Icon: Moon, badge: 'bg-(--el-notif-agent-hibernated)' },
  // MOTIR-10340 — a review waits for the recipient's OWN agent. `Bot`, the glyph the review
  // markers and the To approve "review to run" row draw (`design/github/design-notes.md`
  // § 32.1, § 32.5), so the same thing looks the same wherever it is said.
  review_to_run: { Icon: Bot, badge: 'bg-(--el-notif-review-to-run)' },
  // MOTIR-10338 — an agent sent the recipient's card back. The same `Bot` glyph, on the
  // To fix hue, because the row reports the refusal the To fix tag stands for.
  review_sent_back: { Icon: Bot, badge: 'bg-(--el-notif-review-sent-back)' },
};

/** Types whose subject is a PROJECT rather than a work item — no actor, and a
 *  destination resolved from the TYPE. `code_access_refused` is the first
 *  (MOTIR-5016); `Notification.workItemId` is null on these rows. */
const ACTORLESS_TYPES = new Set<string>([
  'code_access_refused',
  'review_to_run',
  'review_sent_back',
]);
const DEFAULT_META = { Icon: Bell, badge: 'bg-(--el-text-muted)' };

/** Pick the summary i18n key for a notification's type (+ whether it deep-links). */
function summaryKey(type: string, hasKey: boolean, kind: NotificationData['kind']): string {
  // ⚠️ A PAGE row is matched on its data KIND, first: it reuses the `mentioned` /
  // `commented` TYPES (so the reader's settings gate it) and carries no issue key BY
  // DESIGN, so the type switch would mis-sentence it and `genericNoKey` would swallow it
  // (design/notifications/design-notes.md, "Page comment rows").
  if (kind === 'page_mentioned') return 'summary.pageMentioned';
  if (kind === 'page_replied') return 'summary.pageReplied';
  // ⚠️ CHECKED BEFORE `hasKey`, because this type has no issue key BY DESIGN and
  // the `genericNoKey` fallback would swallow it (MOTIR-5016). The `hasKey` guard
  // below is for a work-item row whose key is missing — a degraded payload — which
  // is a different thing from a row that is not about a work item at all.
  if (type === 'code_access_refused') return 'summary.accessRefused';
  // Also not about a work item, so also checked before `hasKey` (MOTIR-10368).
  if (type === 'agent_hibernated_by_admin') return 'summary.agentHibernatedByAdmin';
  // Actorless too (MOTIR-10340): its summary names no actor, so it never takes the
  // actor-shaped `generic` fallback below.
  if (type === 'review_to_run' && hasKey) return 'summary.reviewToRun';
  if (type === 'review_sent_back' && hasKey) return 'summary.reviewSentBack';
  if (!hasKey) return 'summary.genericNoKey';
  switch (type) {
    case 'mentioned':
      return 'summary.mentioned';
    case 'commented':
      return 'summary.commented';
    case 'assigned':
      return 'summary.assigned';
    case 'transitioned':
      return 'summary.transitioned';
    default:
      return 'summary.generic';
  }
}

export function NotificationRow({
  notification,
  onActivate,
  onMarkRead,
}: {
  notification: NotificationDTO;
  /** The row was opened (clicked) — deep-link + mark read. */
  onActivate: (n: NotificationDTO) => void;
  /** The hover toggle was pressed — mark read without navigating. */
  onMarkRead: (n: NotificationDTO) => void;
}) {
  const t = useTranslations('notifications');
  const format = useFormatter();

  const read = notification.readAt !== null;
  const meta = TYPE_META[notification.type] ?? DEFAULT_META;
  const { Icon } = meta;
  // `data` is a discriminated union (5.7.9) — narrow on `kind` for the
  // arm-specific nouns; `issueKey` / `title` are shared across arms.
  const data = notification.data;
  const tPages = useTranslations('pages');
  const page = data.kind === 'page_mentioned' || data.kind === 'page_replied' ? data : null;
  const issueKey = 'issueKey' in data ? data.issueKey || null : null;
  // The hibernated-agent row's second line names WHEN, in the reader's own
  // clock (design/org-admin, panel 12) — the relative time sits on the right.
  const excerpt =
    // A page reply draws its excerpt too: its words are what the reader decides on.
    page
      ? page.excerpt
      : data.kind === 'mentioned'
        ? data.excerpt
        : data.kind === 'agent_hibernated_by_admin'
          ? t('excerpt.agentHibernatedByAdmin', {
              time: data.hibernatedAt
                ? format.dateTime(new Date(data.hibernatedAt), { timeStyle: 'short' })
                : '',
            })
          : null;
  const toStatus = data.kind === 'transitioned' ? data.toStatus : '';
  // ⚠️ NO ACTOR, AND NO FALLBACK NAME. Motir tried something on the user's behalf
  // and GitHub said no, so `actorFallback` would put a FICTIONAL actor into the
  // summary grammar — the exact failure the design card decided against
  // (`design/notifications/design-notes.md`, the four decisions).
  const actorless = ACTORLESS_TYPES.has(notification.type);
  const actorName = actorless ? '' : (notification.actor?.name ?? t('actorFallback'));
  // The destination is resolved from the TYPE, never from the presence of an
  // issue key: this is the first row whose subject is a PROJECT. A hibernated
  // agent's row resolves to NONE — no route to an agent's panel or terminal.
  // A page row opens the page with its panel at the thread; what the page does with
  // `thread` (scroll, highlight, the gone-passage fallback) is the page's behaviour.
  const href = page
    ? `/pages/${encodeURIComponent(page.pageId)}?thread=${encodeURIComponent(page.threadRootId)}`
    : data.kind === 'code_access_refused'
      ? `/settings/project/code-access?project=${encodeURIComponent(data.projectKey)}`
      : issueKey
        ? // A send-back lands on its own activity entry, whose findings open there — on the
          // All tab, since the default Comments tab does not draw it (MOTIR-10458).
          data.kind === 'review_sent_back' && data.recordId
          ? agentVerdictHref(`/items/${issueKey}`, data.recordId)
          : `/items/${issueKey}`
        : null;
  const createdAt = new Date(notification.createdAt);

  // Rich summary: actor + key bolded via the <s> tag, greyed one tier on a
  // read row (the design's read treatment).
  const strong = (chunks: ReactNode) => (
    <strong
      className={cn(
        'font-semibold',
        // A page title is free text, so on a page row each strong slot keeps to one
        // line and ends in an ellipsis — the page's name is never pushed out of view.
        page && 'inline-block max-w-full truncate align-bottom',
        read ? 'text-(--el-text-secondary)' : 'text-(--el-text-strong)',
      )}
    >
      {chunks}
    </strong>
  );
  const summary = t.rich(summaryKey(notification.type, issueKey !== null, data.kind), {
    // Untitled falls back HERE, in the reader's language — the stored title is kept.
    page: page ? page.pageTitle || tPages('untitled') : '',
    actor: actorName,
    key: issueKey ?? '',
    status: toStatus,
    project: data.kind === 'code_access_refused' ? data.projectName : '',
    agent: data.kind === 'agent_hibernated_by_admin' ? data.agentName : '',
    s: strong,
  });

  const body = (
    <>
      <span
        aria-hidden
        className={cn(
          'mt-[13px] h-2 w-2 shrink-0 rounded-full',
          read ? 'bg-transparent' : 'bg-(--el-accent)',
        )}
      />
      <span className="relative shrink-0">
        {actorless ? (
          /* ⚠️ THE GLYPH IS PROMOTED INTO THE AVATAR SLOT, and the small badge is
             dropped: nobody did this to you, so there is no initial letter to draw
             and no person for a badge to be attached TO. The shape is what says so
             at a glance, which is the design's decision rather than this file's. */
          <span
            aria-hidden
            className={cn(
              'inline-flex h-[30px] w-[30px] items-center justify-center rounded-full text-(--el-accent-text)',
              meta.badge,
              read && 'opacity-60',
            )}
          >
            <Icon className="h-4 w-4" />
          </span>
        ) : (
          <>
            <span
              aria-hidden
              className={cn(
                'inline-flex h-[30px] w-[30px] items-center justify-center rounded-full text-xs font-semibold text-(--el-text-inverted)',
                read ? 'bg-(--el-text-faint)' : 'bg-(--el-text)',
              )}
            >
              {actorName.charAt(0).toUpperCase()}
            </span>
            <span
              aria-hidden
              className={cn(
                'absolute -right-0.5 -bottom-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full text-(--el-accent-text) ring-2 ring-(--el-page-bg)',
                meta.badge,
                read && 'opacity-60',
              )}
            >
              <Icon className="h-2.5 w-2.5" />
            </span>
          </>
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 text-[13px] leading-[1.4]',
              read ? 'text-(--el-text-muted)' : 'text-(--el-text)',
            )}
          >
            {summary}
          </span>
          <span
            className="shrink-0 text-[11px] whitespace-nowrap text-(--el-text-secondary)"
            title={format.dateTime(createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
          >
            {format.relativeTime(createdAt)}
          </span>
        </span>
        {/* The excerpt takes `--el-text-secondary` on BOTH arms (MOTIR-2475):
            the read arm was `--el-text-faint`, which clears AA on no surface,
            and re-inking it alone would have made a READ excerpt darker than an
            unread one. The read/unread hierarchy still reads on the summary
            line above, which keeps its muted/ink split. */}
        {excerpt ? (
          <span className="truncate text-xs leading-[1.4] text-(--el-text-secondary)">
            {excerpt}
          </span>
        ) : null}
      </span>
    </>
  );

  const rowClass = cn(
    'flex items-start gap-2.5 py-3 pr-10 pl-3 text-left transition-colors',
    read ? 'hover:bg-(--el-surface)' : 'bg-(--el-surface-soft) hover:bg-(--el-surface)',
  );

  return (
    <div className="relative border-b border-(--el-border-soft) last:border-b-0">
      {href ? (
        <Link href={href} onClick={() => onActivate(notification)} className={rowClass}>
          {body}
        </Link>
      ) : (
        <button
          type="button"
          onClick={() => onActivate(notification)}
          className={cn('w-full', rowClass)}
        >
          {body}
        </button>
      )}
      {!read ? (
        <button
          type="button"
          aria-label={t('markRead')}
          onClick={() => onMarkRead(notification)}
          className="absolute top-2.5 right-2 inline-flex h-6 w-6 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-muted) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          <Check className="h-[15px] w-[15px]" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
