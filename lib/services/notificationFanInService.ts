import { Prisma, type WorkItem } from '@/generated/prisma/client';
import { readWorkItemForService } from '@/lib/workspaces/tenantRead';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { notificationRepository } from '@/lib/repositories/notificationRepository';
import { pageStoreFor } from '@/lib/pages';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { watcherRepository } from '@/lib/repositories/watcherRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workflowsService } from '@/lib/services/workflowsService';
import { notificationPreferencesService } from '@/lib/services/notificationPreferencesService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { mentionExcerpt } from '@/lib/mentions/excerpt';
import type {
  PageCommentCreatedData,
  WorkItemCommentCreatedData,
  WorkItemMentionedData,
  WorkItemTransitionedData,
} from '@/lib/jobs/types';
import type { NotificationData } from '@/lib/dto/notifications';
import type { NotificationCategory } from '@/generated/prisma/client';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// In-app notification fan-in (Story 5.7 · Subtask 5.7.3). The business logic
// behind the notificationFanIn jobs (lib/jobs/definitions/notificationFanIn.ts),
// on the 5.1.6 mention-fan-out pattern — a SECOND consumer of the SAME
// channel-agnostic `work-item/*` events the 5.1.6 email job already consumes.
// It touches NO emit site and adds NO "also notify in-app" call anywhere: the
// emit already happened (5.1.2 / 5.1.6); this service just subscribes and
// writes `Notification` rows for the eligible recipients.
//
// ONE EMIT PATH, MANY CHANNELS (the locked Story-5.7 invariant): comment /
// description writes emit one channel-agnostic event after commit; the 5.1.6
// email job is one consumer, THIS in-app fan-in is a second. Neither reshapes
// the event; neither notifies the other's channel.
//
// EXTENSIBLE — the fan-in SEAM (no forward dep). The handler dispatches on a
// small `eventName → descriptor` registry (NOTIFICATION_FAN_IN_REGISTRY). Each
// descriptor knows ONE event's notification `type` + drawer `category` and how
// to turn its payload into a fan-in plan (the actor, the candidate recipients,
// the dedupe scope, the denormalized render payload). Story 5.4's
// `work-item/transitioned` (the `watching` category) and Story 6.6's
// `work-item/created` + `work-item/field.changed` fan in by ADDING a registry
// entry — with NO change to this pipeline. Subtask 5.7.10 did exactly that for
// Story 5.4's `work-item/transitioned` (the `watching` category): 5.4 shipped
// its emitter + email fan-out BEFORE 5.7.3 existed, so the in-app entry was
// added HERE, not in 5.4 — closing the seam that left the drawer's Watching tab
// empty (notes.html #40). 6.6 adds its events the same way. An unregistered
// event name is a clean no-op, never an error. The `registry` parameter on
// `fanIn` is the injection point the extensibility test drives (a synthetic
// descriptor produces rows through the same core).
//
// The send-time rules (inherited from the 5.1.6 / 5.4 contract, in-app channel):
//   * the ACTOR is ALWAYS excluded (never notify yourself);
//   * candidate ids are DEDUPED (a user mentioned twice in one comment → one
//     row); the `(dedupeKey, recipientUserId)` unique (5.7.2) makes a replayed
//     or retried event idempotent on TOP of that;
//   * VIEW ACCESS is re-validated at fan-in time AS each recipient (the same
//     `canBrowse` policy the read paths enforce) — a recipient who can no
//     longer see the issue gets no row;
//   * the in-app PREFERENCE GATE is consulted per recipient (5.7.6 resolver,
//     permissive default until then) — channel off → no row;
//   * a work item / comment hard-deleted between write and fan-in means there
//     is nothing to notify about — the fan-out resolves to zero rows, it never
//     errors (deletion is a normal race, not a failure to retry).
//
// SCALE (finding #57): a mention descriptor's candidate set is the event's
// bounded mention list (`candidateUserIds`); the `watching`-category
// `transitioned` descriptor's candidate set is the FULL watcher roster, so it
// supplies a PAGED source (`candidatePages`) the way watcherNotificationsService
// walks it — `fanIn` processes one bounded page at a time (exclude · view-check ·
// preference-gate · write per page), never an unbounded roster read nor N
// concurrent capability checks. The page width is `FAN_IN_PAGE_SIZE`.
//
// 4-layer note: this is a SERVICE (the job handlers are its only callers, via
// the injected jobServices bag). It composes repositories + the access policy +
// the preference gate, owns the transaction(s) the fan-out batch writes in (one
// per candidate page via notificationRepository.createMany), and returns a plain
// JSON-serializable summary (step.run memoizes the return value).

/**
 * The denormalized render payload stored on each `Notification.data` (Json) so
 * the 5.7.4 feed read is a single-table scan (no join storm — the 5.7.2 schema
 * decision) lives in `@/lib/dto/notifications` (`NotificationData`) — the SINGLE
 * source-of-truth contract shared by this WRITER and the read mapper, so the two
 * ends cannot drift again (Subtask 5.7.9; the producer once stored
 * `workItemKey` / `workItemTitle` while the DTO read `issueKey` / `title`).
 * `kind` discriminates the row renderer the 5.7.5 drawer picks; 5.7.3 emits the
 * `mentioned` arm and 5.7.10 the `transitioned` (watching) arm.
 */

/** The minimal event envelope the pipeline needs before dispatching to a
 * descriptor; the descriptor re-narrows to its specific payload. Every
 * `work-item/*` event carries these two fields. */
export interface NotificationSourceEvent {
  workspaceId: string;
  workItemId: string;
}

/** A paged candidate source — yields BOUNDED batches of candidate recipient
 * ids so `fanIn` never builds an unbounded in-memory roster nor fires N
 * concurrent view/preference checks (finding #57). `fanIn` hands its own page
 * size in so the page width is one knob (tests shrink it). The mention sources
 * are bounded by construction and use `candidateUserIds` instead; the watcher
 * roster (the `transitioned` / `watching` descriptor) uses this. */
export type CandidatePageSource = (pageSize: number) => AsyncIterable<string[]>;

/** The per-event fan-in plan a descriptor produces from its payload + the
 * (already workspace-verified) work item. `null` = a clean no-op.
 *
 * A plan supplies EITHER `candidateUserIds` (a bounded, in-memory set — the
 * mention sources) OR `candidatePages` (a paged source — the watcher roster).
 * `fanIn` normalizes both to a page walk, so the per-recipient pipeline
 * (actor-exclude · dedupe · view re-check · preference gate · write) is
 * identical for both and a single page reproduces the pre-5.7.10 behaviour
 * byte for byte. */
export interface NotificationFanInPlan {
  /** The actor whose action produced the event — always excluded. */
  actorId: string;
  /** A BOUNDED candidate set (the mention list), processed as a single page.
   * Mutually exclusive with `candidatePages`. */
  candidateUserIds?: string[];
  /** A PAGED candidate source (the watcher roster), walked page by page —
   * never loaded whole (finding #57). Mutually exclusive with
   * `candidateUserIds`. */
  candidatePages?: CandidatePageSource;
  /** The dedupe source id; the row's `dedupeKey` is `${type}:${dedupeSourceId}`,
   * uniquified per recipient by the 5.7.2 `(dedupeKey, recipientUserId)` unique. */
  dedupeSourceId: string;
  /** The denormalized payload written to every row's `data`. */
  data: NotificationData;
}

/** One registry entry: an event's notification `type` + drawer `category`, and
 * how to build its fan-in plan. ADDING one of these is the ONLY change 5.4/6.6
 * need to fan in (the no-forward-dep seam). */
export interface NotificationFanInDescriptor {
  /** The open `Notification.type` discriminator + the `dedupeKey` prefix. */
  notificationType: string;
  /** Which drawer tab the row lands in (`direct` = mentions/assignment/reporter). */
  category: 'direct' | 'watching';
  /** Resolve the event payload (+ the work item) into a fan-in plan, or null
   * for a no-op (no candidates, deleted source). */
  buildPlan(event: NotificationSourceEvent, item: WorkItem): Promise<NotificationFanInPlan | null>;
}

export type NotificationFanInRegistry = Record<string, NotificationFanInDescriptor>;

/** The default watcher-roster page width for the `transitioned` fan-in —
 * bounded reads, never a load-all (finding #57). Mirrors
 * `watcherNotificationsService.WATCHER_FAN_OUT_PAGE_SIZE`. */
export const FAN_IN_PAGE_SIZE = 100;

/** Build the `mentioned` render payload shared by both mention sources. */
function buildMentionData(
  source: 'comment' | 'description',
  item: WorkItem,
  excerpt: string | null,
): NotificationData {
  return {
    kind: 'mentioned',
    source,
    issueKey: item.identifier,
    title: item.title,
    excerpt,
  };
}

/** Walk an issue's watcher roster in BOUNDED pages, yielding each page's user
 * ids (finding #57 — a 200-watcher issue never builds an unbounded batch).
 * Cursor-paged oldest-first via `watcherRepository.listByWorkItem`, the same
 * roster walk `watcherNotificationsService.fanOut` uses for the email twin. */
async function* watcherRosterPages(
  workItemId: string,
  workspaceId: string,
  pageSize: number,
): AsyncGenerator<string[]> {
  let cursor: string | undefined;
  do {
    // Bound per page (MOTIR-2815) rather than once around the whole walk: the
    // generator yields to its consumer between pages, and holding a transaction
    // open across an arbitrary consumer is how a pooled connection gets pinned.
    // `watcher` is policy-gated, so unbound the roster was EMPTY and the fan-in
    // notified nobody.
    const page = await withWorkspaceServiceContext(workspaceId, (tx) =>
      watcherRepository.listByWorkItem(workItemId, { take: pageSize, cursor }, tx),
    );
    cursor = page.length === pageSize ? page[page.length - 1]!.id : undefined;
    if (page.length > 0) yield page.map((w) => w.userId);
  } while (cursor);
}

/**
 * The PRODUCTION registry — only the SHIPPED 5.1.6 events. Both mention sources
 * write a `mentioned` / `direct` notification; they differ in copy source
 * (comment body vs description) and dedupe scope (commentId vs revisionId).
 *
 * The `'work-item/transitioned'` → `{ notificationType: 'transitioned',
 * category: 'watching', … }` entry (Subtask 5.7.10) was the documented 5.4 seam
 * — added here, NOT in 5.4: Story 5.4 (the emitter + email fan-out, 5.4.5)
 * shipped BEFORE 5.7.3 existed, so neither story wired the in-app entry and the
 * drawer's Watching tab stayed empty in prod (notes.html #40). 6.6 adds its
 * events the same way — a registry entry, no change to the core.
 */
export const NOTIFICATION_FAN_IN_REGISTRY: NotificationFanInRegistry = {
  'work-item/mentioned': {
    notificationType: 'mentioned',
    category: 'direct',
    async buildPlan(event, item) {
      const payload = event as WorkItemMentionedData;
      if (payload.mentionedUserIds.length === 0) return null;
      return {
        actorId: payload.authorId,
        candidateUserIds: payload.mentionedUserIds,
        dedupeSourceId: payload.revisionId,
        data: buildMentionData('description', item, mentionExcerpt(item.descriptionMd)),
      };
    },
  },
  'work-item/comment.created': {
    notificationType: 'mentioned',
    category: 'direct',
    async buildPlan(event, item) {
      const payload = event as WorkItemCommentCreatedData;
      if (payload.mentionedUserIds.length === 0) return null;
      // The comment must still exist (5.1's delete is HARD — an excerpt of a
      // deleted comment would resurrect content the author removed).
      const comment = await withWorkspaceServiceContext(item.workspaceId, (tx) =>
        commentRepository.findById(payload.commentId, tx),
      );
      if (!comment || comment.workItemId !== item.id) return null;
      return {
        actorId: payload.authorId,
        candidateUserIds: payload.mentionedUserIds,
        dedupeSourceId: payload.commentId,
        data: buildMentionData('comment', item, mentionExcerpt(comment.bodyMd)),
      };
    },
  },
  'work-item/transitioned': {
    notificationType: 'transitioned',
    category: 'watching',
    async buildPlan(event, item) {
      const payload = event as WorkItemTransitionedData;
      // The candidate set is the FULL watcher roster — supplied as a PAGED
      // source so `fanIn` walks it bounded (finding #57), never load-all. The
      // actor is excluded by the core (`fanIn` seeds the seen-set with it), so a
      // non-empty plan here is correct even when the only watcher is the actor.
      // Resolve the from/to status DISPLAY names (the drawer renders them); a
      // status renamed/deleted between commit and fan-in falls back to its key
      // (the move still happened — the row still goes out), mirroring the email
      // twin's `statusName` fallback.
      const [fromStatus, toStatus] = await Promise.all([
        workflowsService.getStatusByKey(item.projectId, payload.fromStatusKey, event.workspaceId),
        workflowsService.getStatusByKey(item.projectId, payload.toStatusKey, event.workspaceId),
      ]);
      return {
        actorId: payload.actorId,
        candidatePages: (pageSize) => watcherRosterPages(item.id, item.workspaceId, pageSize),
        // Idempotency scope = the revision row (revision × recipient), the same
        // key the 5.4.5 watcher email job dedupes on.
        dedupeSourceId: payload.revisionId,
        data: {
          kind: 'transitioned',
          issueKey: item.identifier,
          title: item.title,
          fromStatus: fromStatus?.label ?? payload.fromStatusKey,
          toStatus: toStatus?.label ?? payload.toStatusKey,
        },
      };
    },
  },
};

export interface NotificationFanInResult {
  /** The recipient ids a `Notification` row was written for (post validation +
   * preference gate). Empty on any no-op. */
  writtenUserIds: string[];
}

const NO_OP: NotificationFanInResult = { writtenUserIds: [] };

/**
 * The dedupe prefix BOTH page arms share (MOTIR-10924): every row written for one
 * page comment carries `PAGE_COMMENT_DEDUPE_PREFIX + commentId`, whichever arm —
 * `page_mentioned` or `page_replied` — it came from.
 *
 * ⚠️ ONE PREFIX, NOT THE SHIPPED `type:sourceId` SHAPE. With two prefixes a thread
 * participant would hold a `commented:` row from the reply and then, when a later
 * edit mentions them, a second `mentioned:` row about the SAME comment. One prefix
 * makes the `(dedupe_key, recipient_user_id)` unique enforce "one row per person
 * per comment" in the database, whatever order the recipient sets are computed in.
 */
export const PAGE_COMMENT_DEDUPE_PREFIX = 'page-comment:';

/** One page-comment recipient and the arm their row takes. */
interface PageCommentCandidate {
  userId: string;
  arm: 'page_mentioned' | 'page_replied';
}

/** The row type each page arm carries — the existing preference rows that gate it. */
const PAGE_ARM_TYPE = { page_mentioned: 'mentioned', page_replied: 'commented' } as const;

/** Wrap a bounded candidate set as a one-page source — the mention path. An
 * empty set yields no page (the loop never runs → a clean no-op). */
async function* singlePage(ids: string[]): AsyncGenerator<string[]> {
  if (ids.length > 0) yield ids;
}

export const notificationFanInService = {
  /**
   * Fan one channel-agnostic `work-item/*` event into `Notification` rows for
   * every eligible recipient, walking the candidate source one BOUNDED page at a
   * time (each page written in its own transaction). Resolves (never throws) on
   * a vanished issue/comment, an unregistered event, or zero survivors.
   *
   * A `candidateUserIds` plan (the mention sources) is a single page, so this
   * reproduces the pre-5.7.10 behaviour exactly; a `candidatePages` plan (the
   * watcher roster) streams pages so a 200-watcher transition never builds an
   * unbounded batch nor fires N concurrent view/preference checks (finding #57).
   *
   * @param eventName the triggering event name — the registry key.
   * @param event the event payload (re-narrowed by the matched descriptor).
   * @param registry injection point for the extensibility test; defaults to the
   *   production registry. A synthetic entry proves 5.4/6.6 fan in with no core
   *   change.
   * @param opts.pageSize the candidate-source page width (tests shrink it to
   *   force a multi-page walk); production omits it (defaults to
   *   `FAN_IN_PAGE_SIZE`).
   */
  async fanIn<E extends NotificationSourceEvent>(
    eventName: string,
    event: E,
    registry: NotificationFanInRegistry = NOTIFICATION_FAN_IN_REGISTRY,
    opts: { pageSize?: number } = {},
  ): Promise<NotificationFanInResult> {
    const descriptor = registry[eventName];
    if (!descriptor) return NO_OP; // unregistered event → clean no-op, never an error.

    // The issue must still exist in this workspace (hard-deleted → nothing to
    // link to). Mirrors the 5.1.6 fan-out's scoping gate.
    //
    // USERLESS (MOTIR-2685): fan-in runs from a job with no session, so the read binds
    // the WORKSPACE tier. `event.workspaceId` is part of the notification source event
    // the writer emitted — a trusted resolution, never wire input. Unbound, every
    // in-app notification for every registered event type resolved to NO_OP under
    // `motir_app`, which reads as "nothing to notify about" rather than as a failure.
    const item = await readWorkItemForService(event.workItemId, event.workspaceId);
    if (!item || item.workspaceId !== event.workspaceId) return NO_OP;

    const plan = await descriptor.buildPlan(event, item);
    if (!plan) return NO_OP;

    const pageSize = opts.pageSize ?? FAN_IN_PAGE_SIZE;
    const pages = plan.candidatePages
      ? plan.candidatePages(pageSize)
      : singlePage(plan.candidateUserIds ?? []);

    // `seen` carries the actor (never self-notify) plus every id already
    // processed, so candidates are deduped WITHIN and ACROSS pages — a user
    // mentioned twice, or appearing on two roster pages, gets one row (on top of
    // the 5.7.2 `(dedupeKey, recipientUserId)` unique that absorbs replays).
    const dedupeKey = `${descriptor.notificationType}:${plan.dedupeSourceId}`;
    const seen = new Set<string>([plan.actorId]);
    const writtenUserIds: string[] = [];

    for await (const rawPage of pages) {
      const candidateIds: string[] = [];
      for (const id of rawPage) {
        if (!seen.has(id)) {
          seen.add(id);
          candidateIds.push(id);
        }
      }
      if (candidateIds.length === 0) continue;

      // Re-validate view access AS each candidate (access may have changed since
      // the write), bounded by the page. A project deleted out from under the
      // issue → stop the walk (no one can view) — the same vanish-tolerant
      // behaviour the 5.1.6 fan-out has.
      let viewableIds: string[];
      try {
        const checks = await Promise.all(
          candidateIds.map(async (userId) => {
            const caps = await projectAccessService.getCapabilities(item.projectId, {
              workspaceId: event.workspaceId,
              userId,
            });
            return caps.canBrowse ? userId : null;
          }),
        );
        viewableIds = checks.filter((id): id is string => id !== null);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) break;
        throw err;
      }
      if (viewableIds.length === 0) continue;

      // The in-app preference gate, per recipient (5.7.6 resolver). Channel off
      // → no row. This is what makes the `transitioned · in_app` toggle real for
      // free — no extra wiring in the descriptor.
      const gateChecks = await Promise.all(
        viewableIds.map(async (userId) => {
          const enabled = await notificationPreferencesService.isChannelEnabled(
            userId,
            descriptor.notificationType,
            'in_app',
          );
          return enabled ? userId : null;
        }),
      );
      const recipientIds = gateChecks.filter((id): id is string => id !== null);
      if (recipientIds.length === 0) continue;

      // One row per recipient for THIS page, in one transaction. `createMany`'s
      // skipDuplicates + the `(dedupeKey, recipientUserId)` unique make a replay
      // / retry idempotent.
      //
      // ⚠️ BOUND (MOTIR-2866/2867), on the SAME workspace the reads above bind.
      // `notification`'s policy is `workspace_id = current_setting('app.workspace_id',
      // true)` in `USING` **and** `WITH CHECK`, so a bare `db.$transaction` here
      // could not satisfy it: every row this loop builds was refused, and because
      // the fan-in is a background job nothing surfaced it — the mutation that
      // triggered it succeeded and the recipient simply never heard. MOTIR-2796
      // bound the roster READ (":181") and the comment read (":224") and left this
      // write on the singleton, which is the shape of the whole write surface.
      // `event.workspaceId` is the trusted value the source event carries, and
      // ":324" has already asserted `item.workspaceId === event.workspaceId`, so
      // the bind and the rows' own `workspaceId` column cannot disagree.
      const rows: Prisma.NotificationCreateManyInput[] = recipientIds.map((recipientUserId) => ({
        workspaceId: event.workspaceId,
        recipientUserId,
        type: descriptor.notificationType,
        category: descriptor.category,
        workItemId: item.id,
        actorId: plan.actorId,
        data: plan.data as unknown as Prisma.InputJsonValue,
        dedupeKey,
      }));
      await withWorkspaceServiceContext(event.workspaceId, (tx) =>
        notificationRepository.createMany(rows, tx),
      );
      writtenUserIds.push(...recipientIds);
    }

    return { writtenUserIds };
  },

  /**
   * Fan one `page/comment.created` event into `Notification` rows (Story
   * MOTIR-10868 · MOTIR-10924) — the in-app consumer of a page comment. A SIBLING
   * of `fanIn` rather than a registry entry, because `fanIn` opens by resolving a
   * WORK ITEM and every part of its plan assumes one; a page row has none.
   *
   * THE RECIPIENTS, and the order the exclusions run in:
   *   1. the MENTION set — the event's (already validated) mention ids, minus the
   *      author → `page_mentioned`, type `mentioned`;
   *   2. on a reply only, the REPLY set — the thread root's author plus the author
   *      of every reply ordered before this comment, minus the author, minus
   *      everyone in the mention set → `page_replied`, type `commented`.
   * So a participant the reply also mentions gets the mention row and no reply row.
   *
   * PER CANDIDATE, one bounded page at a time (`FAN_IN_PAGE_SIZE`): page access is
   * re-checked as them at send time (`canViewPages`; a vanished project ends the
   * walk), then the `in_app` channel of their row's own type, then the rows that
   * already exist under the comment's key are read and those people dropped, and
   * the rest are written in one `createMany`. Reading before writing is what makes
   * `writtenUserIds` the people actually written: a replay, or an edit's re-fire
   * under the same comment id, writes nobody it already wrote and reports nobody.
   *
   * WHY A BATCHED `createMany` and not `notifyProjectEvent` per recipient: that
   * method writes one recipient per transaction and swallows its own failure, so
   * a fan-out built on it could finish green with someone never notified. Here a
   * failure throws, and the job's transient retry does its work.
   *
   * THE PAYLOAD is built once per comment: the page's stored title VERBATIM (`''`
   * on an untitled page; the fallback is the reader's, applied when a surface
   * renders), the project key, the thread root and `mentionExcerpt` over the
   * comment's own body. Every row is category `direct`, actor the event's author,
   * `pageId` set and `workItemId` null.
   *
   * Resolves (never throws) on a comment deleted before the fan-out, a comment or
   * page outside the event's workspace, or zero survivors. An ARCHIVED page still
   * notifies: the page read returns it, and its thread stays readable.
   *
   * @param opts.pageSize the recipient page width (tests shrink it to force two
   *   writes); production omits it (`FAN_IN_PAGE_SIZE`).
   */
  async fanInPageComment(
    event: PageCommentCreatedData,
    opts: { pageSize?: number } = {},
  ): Promise<NotificationFanInResult> {
    // USERLESS: a job has no session, so every read binds the WORKSPACE tier from
    // the trusted id the emitting service put on the event. A row in another
    // workspace is invisible under that binding and resolves to nothing.
    const subject = await withWorkspaceServiceContext(event.workspaceId, async (tx) => {
      // Not `lockById`: a job that reads in order to notify must hold no row lock.
      const comment = await pageStoreFor(tx).findPageComment(event.commentId);
      if (!comment || comment.workspaceId !== event.workspaceId) return null;
      // Archived pages come back too — an archived thread still notifies.
      const page = await pageRepository.findById(comment.pageId, tx);
      if (!page) return null;
      const project = await projectRepository.findById(page.projectId, tx);
      if (!project) return null;

      const participants: string[] = [];
      if (event.isReply) {
        const root = await pageStoreFor(tx).findPageComment(event.threadRootCommentId);
        if (root) participants.push(root.authorId);
        // Oldest first; only the replies BEFORE this one are its thread's people,
        // so an edit's re-fire recomputes a subset and never adds a participant.
        const replies = await pageStoreFor(tx).findPageCommentReplies([event.threadRootCommentId]);
        for (const reply of replies) {
          if (reply.id === comment.id) break;
          participants.push(reply.authorId);
        }
      }
      return { comment, page, projectKey: project.identifier, participants };
    });
    if (!subject) return NO_OP;
    const { comment, page, projectKey, participants } = subject;

    const seen = new Set<string>([event.authorId]);
    const candidates: PageCommentCandidate[] = [];
    for (const userId of event.mentionedUserIds) {
      if (seen.has(userId)) continue;
      seen.add(userId);
      candidates.push({ userId, arm: 'page_mentioned' });
    }
    for (const userId of participants) {
      if (seen.has(userId)) continue;
      seen.add(userId);
      candidates.push({ userId, arm: 'page_replied' });
    }
    if (candidates.length === 0) return NO_OP;

    const excerpt = mentionExcerpt(comment.bodyMd);
    const dataFor = (arm: PageCommentCandidate['arm']): NotificationData => ({
      kind: arm,
      pageId: page.id,
      pageTitle: page.title,
      projectKey,
      threadRootId: event.threadRootCommentId,
      excerpt,
    });
    const dedupeKey = `${PAGE_COMMENT_DEDUPE_PREFIX}${comment.id}`;
    const pageSize = opts.pageSize ?? FAN_IN_PAGE_SIZE;
    const writtenUserIds: string[] = [];

    for (let start = 0; start < candidates.length; start += pageSize) {
      const batch = candidates.slice(start, start + pageSize);

      let viewable: PageCommentCandidate[];
      try {
        const checks = await Promise.all(
          batch.map(async (candidate) => {
            const caps = await projectAccessService.getPageCapabilities(page.projectId, {
              workspaceId: event.workspaceId,
              userId: candidate.userId,
            });
            return caps.canViewPages ? candidate : null;
          }),
        );
        viewable = checks.filter((c): c is PageCommentCandidate => c !== null);
      } catch (err) {
        if (err instanceof ProjectNotFoundError) break;
        throw err;
      }
      if (viewable.length === 0) continue;

      const gated = await Promise.all(
        viewable.map(async (candidate) =>
          (await notificationPreferencesService.isChannelEnabled(
            candidate.userId,
            PAGE_ARM_TYPE[candidate.arm],
            'in_app',
          ))
            ? candidate
            : null,
        ),
      );
      const recipients = gated.filter((c): c is PageCommentCandidate => c !== null);
      if (recipients.length === 0) continue;

      const written = await withWorkspaceServiceContext(event.workspaceId, async (tx) => {
        const present = new Set(
          await notificationRepository.findRecipientIdsByDedupeKey(
            dedupeKey,
            recipients.map((r) => r.userId),
            tx,
          ),
        );
        const fresh = recipients.filter((r) => !present.has(r.userId));
        // `skipDuplicates` still absorbs a CONCURRENT duplicate between the read
        // and the insert; the read above is what decides who is reported.
        await notificationRepository.createMany(
          fresh.map((r) => ({
            workspaceId: event.workspaceId,
            recipientUserId: r.userId,
            type: PAGE_ARM_TYPE[r.arm],
            category: 'direct',
            workItemId: null,
            pageId: page.id,
            actorId: event.authorId,
            data: dataFor(r.arm) as unknown as Prisma.InputJsonValue,
            dedupeKey,
          })),
          tx,
        );
        return fresh.map((r) => r.userId);
      });
      writtenUserIds.push(...written);
    }

    return { writtenUserIds };
  },

  /**
   * Notify ONE recipient about something whose subject is a PROJECT rather than a
   * work item (MOTIR-5016 · Story MOTIR-5010) — a REFUSED collaborator invitation —
   * or about a card with NO ACTOR (MOTIR-10340): a review waiting for the routed
   * person's own agent. Neither has a person who did it, which is what `fanIn`'s
   * actor-shaped plan assumes.
   *
   * ⚠️ WHY THIS IS A SIBLING OF `fanIn` AND NOT A CALL INTO IT. `fanIn` opens by
   * resolving `event.workItemId` and returns `NO_OP` when the item does not
   * exist — the registry, the plan, the dedupe key and the row all assume a work
   * item. This event has none (`Notification.workItemId` is nullable and null
   * here), so routing it through `fanIn` would mean widening a mechanism four
   * shipped types depend on, which MOTIR-5016's own boundary forbids.
   *
   * ⚠️ WHAT IT DOES **NOT** DIVERGE ON is the thing that matters: the CHANNEL
   * GATE. `notificationPreferencesService.isChannelEnabled` is consulted exactly
   * as `fanIn` consults it, so toggling the row off in the settings matrix
   * suppresses this type without any change at the emit site — which is the whole
   * reason the card asked for the shared path. The row is written through the same
   * repository, on the same workspace bind, with the same
   * `createMany(skipDuplicates)` idempotency.
   *
   * ⚠️ THE DEDUPE KEY IS KEYED ON WHAT IS TRUE ONCE — the repository row and the
   * invited login — never on a timestamp or an attempt counter. Establishing is
   * retryable (**Try again** sits on the failed panel), so an attempt-varying key
   * would give a user one row per retry for one refusal.
   *
   * Best-effort and never thrown: a notification that could not be written must
   * not cost the caller the repositories it just created.
   */
  async notifyProjectEvent(args: {
    workspaceId: string;
    recipientUserId: string;
    type: string;
    category: NotificationCategory;
    dedupeKey: string;
    data: NotificationData;
    /** The card the row is about, for a SYSTEM event that has one (the review to run,
     *  MOTIR-10340) — the row then dies with the card. Null or absent for a project. */
    workItemId?: string | null;
    /** The page the row is about (MOTIR-10922): a page mention or a page reply. The
     *  row then dies with the page, and `workItemId` stays null. */
    pageId?: string | null;
    /** Who acted, when someone did (MOTIR-10368); null for a system event. */
    actorId?: string | null;
  }): Promise<boolean> {
    try {
      const enabled = await notificationPreferencesService.isChannelEnabled(
        args.recipientUserId,
        args.type,
        'in_app',
      );
      if (!enabled) return false;

      await withWorkspaceServiceContext(args.workspaceId, (tx) =>
        notificationRepository.createMany(
          [
            {
              workspaceId: args.workspaceId,
              recipientUserId: args.recipientUserId,
              type: args.type,
              category: args.category,
              // NULL when the subject is a project: the drawer resolves that row's
              // destination from the TYPE, not from an issue key. A system event about a
              // card (the review to run) names it.
              workItemId: args.workItemId ?? null,
              // A page-subject row names its page, so a permanent page delete takes it.
              pageId: args.pageId ?? null,
              actorId: args.actorId ?? null,
              data: args.data as unknown as Prisma.InputJsonValue,
              dedupeKey: args.dedupeKey,
            },
          ],
          tx,
        ),
      );
      return true;
    } catch (err) {
      console.error(
        `[notificationFanInService] could not write a ${args.type} notification for ${args.recipientUserId}:`,
        err,
      );
      return false;
    }
  },
};
