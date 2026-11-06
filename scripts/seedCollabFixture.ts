/**
 * The COLLABORATION-shaped at-scale fixture (Subtask 5.6.1 — the 4.7.1
 * precedent, applied to Epic 5). `pnpm db:seed:collab` builds the
 * **collaboration-loaded issue** — hundreds of threaded comments with real
 * @mentions, dozens of mixed panel/editor attachments, every custom-field
 * type valued (including an archived select option), labels, components (one
 * with a default assignee), many watchers, and hundreds of revisions
 * accumulated from real edits — plus a small spread of normally-loaded
 * issues. It is the fixture the Story 5.6 at-scale specs (5.6.3 bounded-read
 * census + the combined-page a11y sweep) run against; the existing large
 * seeds are tree-shaped (2.5.16), board-shaped (3.5.1) and sprint-shaped
 * (4.7.1) — none builds collaboration data.
 *
 * EVERYTHING goes through the shipped services (the no-raw-inserts seed
 * rule), which makes the script double as a bulk smoke test of every Epic-5
 * write path: commentsService (5.1.2, threading + server-side mention
 * parsing), attachmentsService (5.2.2 panel attach · 2.3.7 editor upload) and
 * the 5.2.3 link-on-write (editor attachments are linked by genuinely
 * referencing their blob URLs from comment bodies — never inserted),
 * customFields/Values (5.3.2/5.3.3), labels/components/watchers (5.4.2-4),
 * and workItemsService update/status for the revision churn. The TWO
 * sanctioned exceptions, mirroring `seedLargeBoard`'s documented raw-UPDATE
 * precedent:
 *
 *   1. **Timestamp spreading.** Services stamp `now()` on every row, so after
 *      seeding, three raw UPDATEs spread comment / attachment / revision
 *      timestamps across a multi-week window (insertion ORDER preserved —
 *      replies stay after their parents). Without this every paging/interleave
 *      boundary the 5.6 specs assert against would collapse onto one instant.
 *      This is the same reason seedLargeBoard backdates `updatedAt` raw: the
 *      ORM would re-stamp what the fixture must control.
 *   2. **External seams are stubbed by the RUNNER, not here.** The runner
 *      (`scripts/seed-collab.ts`) points the Vercel-Blob SDK and the Inngest
 *      SDK at an embedded local stub — exactly the two seams the test suite
 *      mocks — so the full service path runs (gates, transactions, audit
 *      rows, link-on-write) without a cloud token and without enqueueing
 *      hundreds of notification jobs at seed time.
 *
 * DETERMINISTIC: all content/author/target choices come from an FNV-1a hash
 * of stable keys (the plan-seed convention) — no Math.random, no Date.now in
 * any decision. Timestamps are relative to now() (the Done-age precedent),
 * with deterministic order and spacing across reseeds.
 *
 * IDEMPOTENT: re-running clears ONLY this fixture's own workspace (matched by
 * the fixed owner email + workspace name) and reseeds — it never touches any
 * other workspace's data. Refuses to run under NODE_ENV=production.
 *
 * CAP-PARAMETERISED: every dimension is an env knob (SEED_COLLAB_*) so the CI
 * lane can run reduced while local runs go full-size. `resolveCollabSeedSizes()` is the
 * ONE resolver — the seed, its self-check, and the E2E helpers
 * (tests/e2e/_helpers/collab.ts) all read the same numbers.
 */
/* eslint-disable no-console -- a CLI dev script: console IS its output surface */
import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { commentsService } from '@/lib/services/commentsService';
import { attachmentsService } from '@/lib/services/attachmentsService';
import { customFieldsService } from '@/lib/services/customFieldsService';
import { customFieldValuesService } from '@/lib/services/customFieldValuesService';
import { labelsService } from '@/lib/services/labelsService';
import { componentsService } from '@/lib/services/componentsService';
import { watchersService } from '@/lib/services/watchersService';
import type { WorkItemPriorityDto } from '@/lib/dto/workItems';

// ── The fixture tenant (fixed identifiers the helpers + specs key off) ──────
export const SEED_COLLAB_OWNER_EMAIL = 'seed-collab@motir.dev';
export const SEED_COLLAB_PASSWORD = 'seed-collab-pass-1!';
export const SEED_COLLAB_WORKSPACE_NAME = 'Seed — Collab (Epic 5)';
export const SEED_COLLAB_PROJECT_NAME = 'Collab heavy';
export const SEED_COLLAB_PROJECT_IDENTIFIER = 'CLB';
/** The loaded issue's canonical (final) title — the helpers find it by this. */
export const SEED_COLLAB_LOADED_TITLE = 'Checkout intermittently double-charges on payment retry';
/** Days the comment/attachment/revision timestamps spread back from now(). */
export const SEED_COLLAB_SPREAD_DAYS = 120;

const MEMBER_NAMES = [
  'Ada Okafor',
  'Bram Visser',
  'Carmen Ruiz',
  'Daan Mulder',
  'Elif Yilmaz',
  'Femke de Boer',
  'Gabriel Costa',
  'Hana Sato',
  'Imran Patel',
  'Jonas Berg',
  'Katya Petrova',
  'Liam Walsh',
  'Mei Lin',
  'Noor Haddad',
  'Otis Brown',
  'Priya Nair',
  'Quinn Murphy',
] as const;

// ── Size knobs (the board-at-scale env-cap pattern) ─────────────────────────
const n = (env: string, dflt: number) => {
  const v = Number(process.env[env]);
  return Number.isFinite(v) && v > 0 ? Math.trunc(v) : dflt;
};

export interface CollabSeedSizes {
  /** Total comments on the loaded issue (threads + replies). */
  comments: number;
  /** Panel-sourced attachments (attachmentsService.attachToWorkItem). */
  panelAttachments: number;
  /** Editor-sourced attachments (uploaded, then genuinely referenced from comment bodies). */
  editorAttachments: number;
  /** Field-churn edits on the loaded issue (each → one revision). */
  churnEdits: number;
  /** Workspace members beside the owner (the watcher/author/mention pool). */
  members: number;
  /** Labels on the loaded issue. */
  labels: number;
  /** Components in the project (one gets a default assignee). */
  components: number;
  /** Normally-loaded issues beside the loaded one. */
  spreadIssues: number;
}

/**
 * The ONE size resolver — the seed, its end-of-run self-check, and the E2E
 * helpers all call this, so a CI lane that lowers a knob keeps every assert
 * consistent. Defaults are the full-size spec-sheet shape (300+/60+/15+/500+).
 */
export function resolveCollabSeedSizes(): CollabSeedSizes {
  return {
    comments: n('SEED_COLLAB_COMMENTS', 320),
    panelAttachments: n('SEED_COLLAB_PANEL_ATTACHMENTS', 44),
    editorAttachments: n('SEED_COLLAB_EDITOR_ATTACHMENTS', 20),
    churnEdits: n('SEED_COLLAB_CHURN_EDITS', 440),
    members: n('SEED_COLLAB_MEMBERS', MEMBER_NAMES.length),
    labels: n('SEED_COLLAB_LABELS', 12),
    components: n('SEED_COLLAB_COMPONENTS', 4),
    spreadIssues: n('SEED_COLLAB_SPREAD_ISSUES', 6),
  };
}

// ── Determinism: FNV-1a over stable keys (the plan-seed convention) ─────────
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function pick<T>(arr: readonly T[], key: string): T {
  return arr[hash(key) % arr.length]!;
}

// ── Small REAL fixture files (the 5.2.8 convention) ─────────────────────────
// A genuine 1×1 transparent PNG (real format bytes, not zero-fill).
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PDF_MIN = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
    'trailer<</Size 4/Root 1 0 R>>\n%%EOF\n',
);
const FILE_KINDS = [
  { ext: 'txt', mime: 'text/plain', bytes: (k: string) => Buffer.from(`repro notes ${k}\n`) },
  { ext: 'png', mime: 'image/png', bytes: () => PNG_1PX },
  { ext: 'pdf', mime: 'application/pdf', bytes: () => PDF_MIN },
] as const;
const FILE_STEMS = [
  'stacktrace',
  'har-capture',
  'payment-log',
  'screenshot',
  'gateway-config',
  'retry-trace',
  'session-dump',
  'invoice-sample',
] as const;

function fixtureFile(key: string): File {
  const kind = pick(FILE_KINDS, `kind:${key}`);
  const stem = pick(FILE_STEMS, `stem:${key}`);
  const bytes = kind.bytes(key);
  return new File([new Uint8Array(bytes)], `${stem}-${hash(key) % 97}.${kind.ext}`, {
    type: kind.mime,
  });
}

// ── Deterministic comment copy ──────────────────────────────────────────────
const COMMENT_PHRASES = [
  'Reproduced this on staging — the second PATCH lands after the retry window closes.',
  'I traced it to the idempotency key rotating between attempts. Logs attached upthread.',
  'Customer support has three more reports of this since Monday.',
  'Could this be the same root cause as the webhook double-fire we saw in March?',
  'Confirmed: the gateway acks both captures. We need to dedupe on our side.',
  'The retry queue metrics spike exactly when this happens.',
  'I can take this one if nobody else has started.',
  'Adding the finance team so they see the refund volume.',
  'The fix needs a migration — the charge table has no unique constraint on intent id.',
  'Verified the patch on the canary tenant; no duplicates in 48h.',
  'This blocks the quarterly reconciliation export.',
  'Rolled the feature flag back to 10% while we investigate.',
  'The repro rate is much higher on slow connections — timeout-driven retries.',
  'Updated the runbook with the manual refund procedure in the meantime.',
  'We should backfill the affected invoices once the dedupe lands.',
  'The duplicate pairs all share one idempotency key prefix — narrowing it down.',
] as const;
const REPLY_PHRASES = [
  'Agreed — same conclusion from my side.',
  'Can you attach the exact request ids?',
  'This matches what I see in the gateway dashboard.',
  'Filed the follow-up with the provider, reference in the parent thread.',
  'Nice catch. That explains the pattern.',
  'Re-ran it with the flag off and it still reproduces.',
] as const;

const SPREAD_TITLES = [
  'Refund webhook occasionally arrives before the charge row commits',
  'Add idempotency-key audit view to the billing console',
  'Currency rounding mismatch on partial refunds',
  'Reconciliation export times out for January',
  'Upgrade payment SDK to the 2026-05 release',
  'Document the manual refund runbook',
  'Chargeback notifications land in the wrong queue',
  'Spike: provider-side dedupe guarantees',
] as const;

const CHURN_TITLES = [
  'Checkout double-charges on payment retry',
  'Double capture on checkout retry path',
  'Payment retry produces duplicate charges',
  'Checkout retry intermittently double-charges cards',
] as const;

const PRIORITIES: readonly WorkItemPriorityDto[] = ['lowest', 'low', 'medium', 'high', 'highest'];
const ESTIMATES = [30, 60, 120, 240, 480] as const;

// ── The manifest (what got built — the self-check asserts against it) ───────
export interface CollabSeedManifest {
  workspaceId: string;
  projectId: string;
  projectIdentifier: string;
  loadedIssueId: string;
  loadedIssueIdentifier: string;
  comments: number;
  replies: number;
  mentionRows: number;
  panelAttachments: number;
  editorAttachments: number;
  labels: number;
  components: number;
  watchers: number;
  revisions: number;
  customFieldsValued: number;
  spreadIssues: number;
}

type Ctx = { userId: string; workspaceId: string };

export async function seedCollabFixture(): Promise<CollabSeedManifest> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('db:seed:collab is a DEV tool — refusing to run under NODE_ENV=production.');
  }
  const sizes = resolveCollabSeedSizes();

  // ── Idempotent clear: drop this fixture's prior workspace(s) only ─────────
  const existingOwner = await db.user.findUnique({ where: { email: SEED_COLLAB_OWNER_EMAIL } });
  if (existingOwner) {
    const memberships = await db.workspaceMembership.findMany({
      where: { userId: existingOwner.id },
      include: { workspace: true },
    });
    for (const m of memberships) {
      if (m.workspace.name === SEED_COLLAB_WORKSPACE_NAME) {
        // work_item.parent is onDelete:NoAction — clear the set in one
        // statement first; the workspace then cascades everything else
        // (comments, attachments, labels, components, memberships).
        await db.workItem.deleteMany({ where: { workspaceId: m.workspaceId } });
        await db.workspace.delete({ where: { id: m.workspaceId } });
      }
    }
  }

  // ── Tenant: owner + member pool, workspace, project, project enrolment ────
  const owner =
    existingOwner ??
    (await usersService.createUser({
      email: SEED_COLLAB_OWNER_EMAIL,
      password: SEED_COLLAB_PASSWORD,
      name: 'Sam Collab',
    }));

  const { workspace } = await workspacesService.createWorkspace({
    name: SEED_COLLAB_WORKSPACE_NAME,
    ownerUserId: owner.id,
  });

  const memberIds: string[] = [owner.id];
  const nameById = new Map<string, string>([[owner.id, 'Sam Collab']]);
  for (let i = 0; i < sizes.members; i++) {
    const email = `seed-collab-m${i + 1}@motir.dev`;
    const name = MEMBER_NAMES[i % MEMBER_NAMES.length]!;
    const existing = await db.user.findUnique({ where: { email } });
    const user =
      existing ?? (await usersService.createUser({ email, password: SEED_COLLAB_PASSWORD, name }));
    await workspacesService.addMember({
      userId: user.id,
      workspaceId: workspace.id,
      workspaceRole: 'member',
    });
    memberIds.push(user.id);
    nameById.set(user.id, name);
  }

  const project = await projectsService.createProject({
    name: SEED_COLLAB_PROJECT_NAME,
    identifier: SEED_COLLAB_PROJECT_IDENTIFIER,
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });

  // Enroll the pool in the project (open access) — the plan-seed 6.4.7
  // pattern, so members can comment / be mentioned / watch.
  // Bound (MOTIR-2868) — same shape as seedReportingFixture: `project_membership`
  // and the `project` access-level write below are both workspace-gated, and the
  // workspace already exists.
  await withWorkspaceServiceContext(workspace.id, async (tx: Prisma.TransactionClient) => {
    for (const userId of memberIds) {
      await projectMembershipRepository.create(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          userId,
        },
        tx,
      );
    }
    await projectRepository.setAccessMode(project.id, 'workspace', tx);
  });
  // Land every member on this project at sign-in (the seed-large convenience).
  await db.workspaceMembership.updateMany({
    where: { workspaceId: workspace.id },
    data: { activeProjectId: project.id },
  });

  const ownerCtx: Ctx = { userId: owner.id, workspaceId: workspace.id };
  const ctxOf = (userId: string): Ctx => ({ userId, workspaceId: workspace.id });
  const mentionToken = (userId: string) => `[@${nameById.get(userId)}](mention:${userId})`;

  // ── Custom fields: one of each of the five types (5.3.2) ──────────────────
  const fieldInput = { key: project.identifier, actorUserId: owner.id, ctx: ownerCtx };
  const textField = await customFieldsService.createField({
    ...fieldInput,
    label: 'Gateway reference',
    fieldType: 'text',
  });
  const numberField = await customFieldsService.createField({
    ...fieldInput,
    label: 'Affected customers',
    fieldType: 'number',
  });
  const dateField = await customFieldsService.createField({
    ...fieldInput,
    label: 'First reported',
    fieldType: 'date',
  });
  const selectField = await customFieldsService.createField({
    ...fieldInput,
    label: 'Payment provider',
    fieldType: 'select',
    options: ['Stripe', 'Adyen', 'Legacy gateway'],
  });
  const userField = await customFieldsService.createField({
    ...fieldInput,
    label: 'Escalation owner',
    fieldType: 'user',
  });

  // ── Components (5.4.3): one carries a default assignee ────────────────────
  const componentNames = ['Payments', 'Checkout', 'Billing console', 'Notifications'];
  const componentIds: string[] = [];
  for (let i = 0; i < sizes.components; i++) {
    const name = componentNames[i % componentNames.length] ?? `Component ${i + 1}`;
    const component = await componentsService.createComponent(
      {
        key: project.identifier,
        name,
        description: i === 0 ? 'Everything that talks to the payment gateway' : null,
        defaultAssigneeId: i === 0 ? pick(memberIds, 'component-default-assignee') : null,
      },
      ownerCtx,
    );
    componentIds.push(component.id);
  }

  // ── The loaded issue ───────────────────────────────────────────────────────
  let revisionOps = 0; // every op below that writes a work_item_revision row
  const loaded = await workItemsService.createWorkItem(
    {
      projectId: project.id,
      kind: 'bug',
      title: SEED_COLLAB_LOADED_TITLE,
      descriptionMd:
        'Under retry pressure the checkout flow issues a second capture for the same ' +
        'payment intent. Tracked across gateway logs, support tickets and the ' +
        'reconciliation export — see the thread below for repro traces and the ' +
        'mitigation history.',
      priority: 'highest',
      assigneeId: pick(memberIds, 'loaded-assignee'),
    },
    ownerCtx,
  );
  revisionOps++; // the 'created' revision
  await workItemsService.updateStatus(loaded.id, 'in_progress', ownerCtx);
  revisionOps++;

  // Labels (5.4.2, type-to-create): distinct names → distinct revision diffs.
  const labelNames = [
    'payments',
    'double-charge',
    'gateway',
    'retry',
    'finance-impact',
    'customer-reported',
    'reconciliation',
    'idempotency',
    'sev2',
    'quarterly-audit',
    'canary-verified',
    'needs-backfill',
    'flagged-rollback',
    'provider-stripe',
  ];
  for (let i = 0; i < sizes.labels; i++) {
    // No modulo wrap — a repeated name would be an idempotent no-op (no new
    // label, no revision) and break the exact-count self-check.
    const name = labelNames[i] ?? `payments-extra-${i + 1}`;
    await labelsService.addLabel(loaded.id, name, ctxOf(pick(memberIds, `label-actor:${i}`)));
    revisionOps++;
  }

  // Components on the issue — including the default-assignee one.
  const onIssueComponents = componentIds.slice(0, Math.min(3, componentIds.length));
  for (const [i, componentId] of onIssueComponents.entries()) {
    await componentsService.addComponent(
      loaded.id,
      componentId,
      ctxOf(pick(memberIds, `component-actor:${i}`)),
    );
    revisionOps++;
  }

  // Custom-field values — all five types (5.3.3), one per field.
  const selectOption = selectField.options[selectField.options.length - 1]!; // 'Legacy gateway'
  const fieldValues: Array<[string, string | number]> = [
    [textField.id, 'GW-CASE-118203'],
    [numberField.id, 37],
    [dateField.id, '2026-04-02'],
    [selectField.id, selectOption.id],
    [userField.id, pick(memberIds, 'escalation-owner')],
  ];
  for (const [i, [fieldId, value]] of fieldValues.entries()) {
    await customFieldValuesService.setValue(
      loaded.id,
      fieldId,
      value,
      ctxOf(pick(memberIds, `field-actor:${i}`)),
    );
    revisionOps++;
  }
  // Archive the valued select option AFTER the value is set — the loaded rail
  // must render a current-but-archived value (the 5.3 archived-mark contract).
  await customFieldsService.archiveOption({
    optionId: selectOption.id,
    actorUserId: owner.id,
    ctx: ownerCtx,
  });

  // ── Watchers (5.4.4): the whole pool self-watches the loaded issue ────────
  for (const userId of memberIds) {
    await watchersService.watch(loaded.id, ctxOf(userId));
  }

  // ── Comments (5.1.2): threads, replies, mentions, editor-sourced embeds ───
  // Editor attachments ride comment bodies: upload through the 2.3.7 service
  // (the unlinked audit row), then genuinely reference the blob URL from the
  // body so the 5.2.3 link-on-write inside the comment transaction links it.
  console.log(`Seeding ${sizes.comments} comments (+${sizes.editorAttachments} editor embeds)…`);
  const topLevelIds: string[] = [];
  const uploadsByUser = new Map<string, number>();
  let mentionRows = 0;
  let editorEmbedded = 0;
  const embedEvery = Math.max(2, Math.floor(sizes.comments / sizes.editorAttachments));

  // The 2.3.7 upload gate is 10/user/min IN-PROCESS — pick an uploader that
  // still has headroom (authors are hash-picked, so one author could
  // otherwise exceed the window during a fast seed run).
  const pickUploader = (preferred: string): string => {
    if ((uploadsByUser.get(preferred) ?? 0) < 9) return preferred;
    const fallback = memberIds.find((id) => (uploadsByUser.get(id) ?? 0) < 9);
    if (!fallback) throw new Error('Upload pool exhausted — raise SEED_COLLAB_MEMBERS.');
    return fallback;
  };

  for (let i = 0; i < sizes.comments; i++) {
    const authorId = pick(memberIds, `comment-author:${i}`);
    const isReply = i % 4 === 3 && topLevelIds.length > 0;
    let body: string = isReply
      ? pick(REPLY_PHRASES, `reply-body:${i}`)
      : pick(COMMENT_PHRASES, `comment-body:${i}`);

    if (hash(`mention?:${i}`) % 10 < 3) {
      const target = pick(
        memberIds.filter((id) => id !== authorId),
        `mention-target:${i}`,
      );
      body = `${mentionToken(target)} ${body}`;
      mentionRows++;
    }

    if (i % embedEvery === 1 && editorEmbedded < sizes.editorAttachments) {
      const uploaderId = pickUploader(authorId);
      const file = fixtureFile(`editor:${i}`);
      const uploaded = await attachmentsService.uploadAttachment(file, {
        ...ctxOf(uploaderId),
        projectId: project.id,
      });
      uploadsByUser.set(uploaderId, (uploadsByUser.get(uploaderId) ?? 0) + 1);
      body += `\n\n![${file.name}](${uploaded.url})`;
      editorEmbedded++;
    }

    const comment = await commentsService.addComment(
      loaded.id,
      {
        bodyMd: body,
        parentCommentId: isReply ? pick(topLevelIds, `reply-parent:${i}`) : null,
      },
      ctxOf(authorId),
    );
    if (!isReply) topLevelIds.push(comment.id);
    if ((i + 1) % 50 === 0) console.log(`  …${i + 1} comments`);
  }

  // ── Panel attachments (5.2.2): real Files through attachToWorkItem ────────
  console.log(`Seeding ${sizes.panelAttachments} panel attachments…`);
  for (let i = 0; i < sizes.panelAttachments; i++) {
    const uploaderId = pickUploader(memberIds[i % memberIds.length]!);
    await attachmentsService.attachToWorkItem(
      loaded.id,
      fixtureFile(`panel:${i}`),
      ctxOf(uploaderId),
    );
    uploadsByUser.set(uploaderId, (uploadsByUser.get(uploaderId) ?? 0) + 1);
    revisionOps++; // the panel link writes an attachments diff revision
  }

  // ── Revision churn (real edits — title/status/assignee/field churn) ───────
  // Every edit picks a value DIFFERENT from the current one (the services
  // treat a same-value patch as a no-op and write NO revision — a repeated
  // hash pick would silently shrink the revision count below `revisionOps`).
  console.log(`Seeding ${sizes.churnEdits} churn edits…`);
  const differing = <T>(arr: readonly T[], key: string, current: T): T => {
    const candidates = arr.filter((v) => v !== current);
    return pick(candidates, key);
  };
  let curTitle: string = SEED_COLLAB_LOADED_TITLE;
  let curPriority: WorkItemPriorityDto = 'highest';
  let curAssignee = pick(memberIds, 'loaded-assignee');
  let curEstimate: number | null = null;
  let curCustomers = 37;
  for (let j = 0; j < sizes.churnEdits; j++) {
    const actor = ctxOf(pick(memberIds, `churn-actor:${j}`));
    const op = j % 40 === 0 ? 'review' : j % 40 === 20 ? 'progress' : j % 5;
    if (op === 'review') {
      await workItemsService.updateStatus(loaded.id, 'in_review', actor);
    } else if (op === 'progress') {
      await workItemsService.updateStatus(loaded.id, 'in_progress', actor);
    } else if (op === 0) {
      curPriority = differing(PRIORITIES, `churn-priority:${j}`, curPriority);
      await workItemsService.updateWorkItem(loaded.id, { priority: curPriority }, actor);
    } else if (op === 1) {
      curAssignee = differing(memberIds, `churn-assignee:${j}`, curAssignee);
      await workItemsService.updateWorkItem(loaded.id, { assigneeId: curAssignee }, actor);
    } else if (op === 2) {
      curEstimate = differing(ESTIMATES, `churn-estimate:${j}`, curEstimate as number);
      await workItemsService.updateWorkItem(loaded.id, { estimateMinutes: curEstimate }, actor);
    } else if (op === 3) {
      const next = 30 + (hash(`churn-customers:${j}`) % 60);
      curCustomers = next === curCustomers ? next + 1 : next;
      await customFieldValuesService.setValue(loaded.id, numberField.id, curCustomers, actor);
    } else {
      curTitle = differing(CHURN_TITLES, `churn-title:${j}`, curTitle);
      await workItemsService.updateWorkItem(loaded.id, { title: curTitle }, actor);
    }
    revisionOps++;
    if ((j + 1) % 100 === 0) console.log(`  …${j + 1} edits`);
  }
  // Settle on the canonical title (the helpers find the issue by it). The
  // status settle may be a no-op (no revision) — deliberately not counted.
  if (curTitle !== SEED_COLLAB_LOADED_TITLE) {
    await workItemsService.updateWorkItem(loaded.id, { title: SEED_COLLAB_LOADED_TITLE }, ownerCtx);
    revisionOps++;
  }
  await workItemsService.updateStatus(loaded.id, 'in_progress', ownerCtx);

  // ── The spread: a handful of normally-loaded siblings ─────────────────────
  for (let s = 0; s < sizes.spreadIssues; s++) {
    const sCtx = ctxOf(pick(memberIds, `spread-reporter:${s}`));
    const item = await workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: pick(['task', 'story', 'bug'] as const, `spread-kind:${s}`),
        title: SPREAD_TITLES[s % SPREAD_TITLES.length]!,
        descriptionMd: 'Part of the payments collaboration spread (seeded).',
        priority: pick(PRIORITIES, `spread-priority:${s}`),
        assigneeId: pick(memberIds, `spread-assignee:${s}`),
      },
      sCtx,
    );
    await labelsService.addLabel(
      item.id,
      labelNames[hash(`spread-label:${s}`) % Math.min(sizes.labels, labelNames.length)]!,
      sCtx,
    );
    await componentsService.addComponent(
      item.id,
      pick(componentIds, `spread-component:${s}`),
      sCtx,
    );
    await watchersService.watch(item.id, ctxOf(pick(memberIds, `spread-watcher:${s}`)));
    const commenters = [
      pick(memberIds, `spread-commenter-a:${s}`),
      pick(memberIds, `spread-commenter-b:${s}`),
    ];
    for (const [k, commenter] of commenters.entries()) {
      const target = pick(
        memberIds.filter((id) => id !== commenter),
        `spread-mention:${s}:${k}`,
      );
      await commentsService.addComment(
        item.id,
        {
          bodyMd:
            k === 0
              ? `${mentionToken(target)} ${pick(COMMENT_PHRASES, `spread-body:${s}:${k}`)}`
              : pick(COMMENT_PHRASES, `spread-body:${s}:${k}`),
          parentCommentId: null,
        },
        ctxOf(commenter),
      );
    }
  }

  // ── Timestamp spread (the seedLargeBoard raw-UPDATE precedent) ────────────
  // Services stamp now(); the paging/interleave boundaries the 5.6 specs
  // assert need a realistic window. ORDER IS PRESERVED (rank over the
  // insertion order), so replies stay after their parents and the All-feed
  // interleave is the true creation sequence. Raw SQL on purpose: a Prisma
  // update would re-stamp `updatedAt` (`@updatedAt`) and erase the spread.
  const spreadDays = SEED_COLLAB_SPREAD_DAYS;
  await db.$executeRaw`
    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (ORDER BY "created_at" ASC, id ASC) AS rn,
             COUNT(*) OVER () AS total
      FROM "comment" WHERE "workspace_id" = ${workspace.id}
    )
    UPDATE "comment" c
    SET "created_at" = now() - (${spreadDays}::float8 * interval '1 day')
                       + (r.rn::float8 / r.total) * (${spreadDays}::float8 * interval '1 day'),
        "updated_at" = now() - (${spreadDays}::float8 * interval '1 day')
                       + (r.rn::float8 / r.total) * (${spreadDays}::float8 * interval '1 day')
    FROM ranked r WHERE c.id = r.id`;
  await db.$executeRaw`
    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (ORDER BY "created_at" ASC, id ASC) AS rn,
             COUNT(*) OVER () AS total
      FROM "attachment" WHERE "workspace_id" = ${workspace.id}
    )
    UPDATE "attachment" a
    SET "created_at" = now() - (${spreadDays}::float8 * interval '1 day')
                       + (r.rn::float8 / r.total) * (${spreadDays}::float8 * interval '1 day')
    FROM ranked r WHERE a.id = r.id`;
  await db.$executeRaw`
    WITH ranked AS (
      SELECT wr.id,
             ROW_NUMBER() OVER (ORDER BY wr."changedAt" ASC, wr.id ASC) AS rn,
             COUNT(*) OVER () AS total
      FROM "work_item_revision" wr
      JOIN "work_item" wi ON wi.id = wr."workItemId"
      WHERE wi."workspaceId" = ${workspace.id}
    )
    UPDATE "work_item_revision" w
    SET "changedAt" = now() - (${spreadDays}::float8 * interval '1 day')
                      + (r.rn::float8 / r.total) * (${spreadDays}::float8 * interval '1 day')
    FROM ranked r WHERE w.id = r.id`;

  // ── Self-check: the seeded shape matches the spec sheet — fail loudly ─────
  const [
    commentCount,
    replyCount,
    mentionCount,
    panelCount,
    editorCount,
    labelCount,
    componentCount,
    watcherCount,
    revisionCount,
    valueCount,
    spreadCount,
  ] = await Promise.all([
    db.comment.count({ where: { workItemId: loaded.id } }),
    db.comment.count({ where: { workItemId: loaded.id, parentCommentId: { not: null } } }),
    db.commentMention.count({ where: { comment: { workItemId: loaded.id } } }),
    db.attachment.count({ where: { workItemId: loaded.id, source: 'panel' } }),
    db.attachment.count({ where: { workItemId: loaded.id, source: 'editor' } }),
    db.workItemLabel.count({ where: { workItemId: loaded.id } }),
    db.workItemComponent.count({ where: { workItemId: loaded.id } }),
    db.watcher.count({ where: { workItemId: loaded.id } }),
    db.workItemRevision.count({ where: { workItemId: loaded.id } }),
    db.customFieldValue.count({ where: { workItemId: loaded.id } }),
    db.workItem.count({ where: { projectId: project.id, id: { not: loaded.id } } }),
  ]);

  const checks: Array<[string, boolean]> = [
    [`comments == ${sizes.comments} (got ${commentCount})`, commentCount === sizes.comments],
    [`threads exist (replies ${replyCount} > 0)`, replyCount > 0],
    [`mention rows == ${mentionRows} (got ${mentionCount})`, mentionCount === mentionRows],
    [
      `panel attachments == ${sizes.panelAttachments} (got ${panelCount})`,
      panelCount === sizes.panelAttachments,
    ],
    [
      `editor attachments == ${sizes.editorAttachments} (got ${editorCount})`,
      editorCount === sizes.editorAttachments,
    ],
    [`labels == ${sizes.labels} (got ${labelCount})`, labelCount === sizes.labels],
    [
      `components on issue == ${onIssueComponents.length} (got ${componentCount})`,
      componentCount === onIssueComponents.length,
    ],
    [
      `watchers >= pool (${memberIds.length}; got ${watcherCount})`,
      watcherCount >= memberIds.length,
    ],
    [`revisions >= ops (${revisionOps}; got ${revisionCount})`, revisionCount >= revisionOps],
    [`all five field types valued (got ${valueCount})`, valueCount === 5],
    [
      `spread issues == ${sizes.spreadIssues} (got ${spreadCount})`,
      spreadCount === sizes.spreadIssues,
    ],
  ];
  const archivedValue = await db.customFieldValue.findFirst({
    where: { workItemId: loaded.id, valueOption: { is: { archived: true } } },
  });
  checks.push(['an archived-option value renders on the rail', archivedValue !== null]);
  const failures = checks.filter(([, ok]) => !ok).map(([label]) => label);
  if (failures.length > 0) {
    throw new Error(`seed-collab self-check FAILED:\n  - ${failures.join('\n  - ')}`);
  }

  return {
    workspaceId: workspace.id,
    projectId: project.id,
    projectIdentifier: project.identifier,
    loadedIssueId: loaded.id,
    loadedIssueIdentifier: `${project.identifier}-1`,
    comments: commentCount,
    replies: replyCount,
    mentionRows: mentionCount,
    panelAttachments: panelCount,
    editorAttachments: editorCount,
    labels: labelCount,
    components: componentCount,
    watchers: watcherCount,
    revisions: revisionCount,
    customFieldsValued: valueCount,
    spreadIssues: spreadCount,
  };
}
