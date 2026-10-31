import {
  Prisma,
  type ApprovalGate,
  type ApprovalGateAuthority,
  type ApprovalGateDecisionSource,
  type ApprovalGateRefusalVerdict,
  type ApprovalGateKind,
  type ApprovalGateState,
  type ApprovalGateSupersedeCause,
} from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';
import { sqlStateOf } from '@/lib/prisma/sqlstate';
import type { ChosenOption } from '@/lib/approvalGates/choiceOptions';
import type { ConfirmedRecord } from '@/lib/approvalGates/decisionConfirmationRecord';
import type { DecisionGateKind } from '@/lib/approvalGates/decisionRecord';
import {
  ApprovalGateAlreadyAwaitingError,
  ApprovalGateDecidedImmutableError,
} from '@/lib/approvalGates/errors';

// Single-op data access for the `approval_gate` table (Story MOTIR-4778 ·
// Subtask MOTIR-4788; ADR docs/decisions/approval-gates.md). Writes require `tx`
// (the 4-layer rule). Every tenant path runs under withWorkspaceContext so the
// RLS policy's `app.workspace_id` GUC is bound (a pure active-workspace gate —
// no `app.system_admin` hatch, mirroring `design_evidence` /
// `acceptance_evidence`).
//
// The partial unique index `approval_gate_one_awaiting_per_subject` enforces
// AT MOST ONE `awaiting` gate per `(work_item_id, kind, subject_id)`; a losing
// concurrent insert surfaces a typed `ApprovalGateAlreadyAwaitingError` rather
// than a raw `P2002` (the concurrency rule in CLAUDE.md — a raw DB error never
// escapes). This card ships the repository leaf and NO service, so the
// translation lives at this edge — the same disposition
// `workItemLinkRepository` gives the `(fromId, toId, kind)` unique (→
// `DuplicateLinkError`): the decide-door card (MOTIR-4790) catches the typed
// error and branches on it, never inspecting a raw Prisma code.
//
// Reads take an OPTIONAL `tx` and resolve `tx ?? dbRead` (the bindable form
// `tests/rls/singletonReadScan.ts` treats as BINDABLE): a caller inside a
// transaction threads that `tx`; a pure-read service path calls them without
// one under an already-bound workspace context. `dbRead` (not `db`) is the
// fallback — `db` would union two whole Prisma clients and tank the
// type-check (MOTIR-4295).
//
// MOTIR-4912 (the AUDIT columns) adds a SECOND database refusal to this edge —
// the `trg_approval_gate_decided_immutable` trigger, which refuses any UPDATE of
// an `approved` / `changes_requested` row (ADR §6a: a decided gate is immutable).
// Both refusals are now produced in ONE place, `translateApprovalGateWriteError`
// at the foot of this file, so a write method's only obligation is to route its
// `catch` through it. That matters because the two arrive in different SHAPES: a
// unique violation is a Prisma `P2002`, while a trigger rejection comes through
// the pg driver adapter as an error whose `cause.code` is SQLSTATE `23514` and
// whose message carries the `AG_DECIDED_IMMUTABLE` marker. Keying each on the
// wrong one is how a raw Postgres error escapes.

// The causes a LIVE path may write — every enum member EXCEPT `unknown`
// (Story MOTIR-5652 · Subtask MOTIR-5659; docs/decisions/design-result.md
// AMENDMENT 6 Q5).
//
// ⚠️ `unknown` is excluded BY THE COMPILER, not by a convention in a comment.
// It means THIS ROW PREDATES THE COLUMN, and its only writer is the backfill in
// `20260917200000_add_approval_gate_supersede_cause`. A live path reaching for
// it would be recording that it does not know why it itself superseded a gate —
// which is the same silence the required argument exists to end, just spelled
// with a value instead of an omission.
export type LiveSupersedeCause = Exclude<ApprovalGateSupersedeCause, 'unknown'>;

export const approvalGateRepository = {
  /**
   * Insert a gate row. A second `awaiting` gate for the same
   * `(workItemId, kind, subjectId)` hits the partial unique index and is
   * translated to `ApprovalGateAlreadyAwaitingError` — a typed domain error,
   * not a raw `P2002`. Decided/superseded rows are unconstrained (approvals
   * ACCUMULATE, ADR §6d), so re-approving across a card's reopen lifecycle
   * never collides.
   */
  async create(
    data: Prisma.ApprovalGateUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<ApprovalGate> {
    try {
      return await tx.approvalGate.create({ data });
    } catch (err) {
      // The partial unique index is the ONLY unique constraint a create can
      // violate (the PK on `id` is a cuid collision, effectively unreachable),
      // so a P2002 here IS the awaiting-race. Under `motir_app` (FORCE RLS,
      // non-superuser) PostgreSQL declines to describe the conflicting key, so
      // the P2002 carries no `meta.target` — the code is the only reliable
      // signal, exactly as for `workItemLinkRepository`'s `DuplicateLinkError`.
      //
      // The translation itself moved to `translateApprovalGateWriteError`
      // (MOTIR-4912) once a second database refusal existed to translate; it
      // always throws, which is why this `catch` needs no `throw` of its own.
      translateApprovalGateWriteError(err);
    }
  },

  /** One gate by id (the decide door's subject resolve / a re-read after a
   *  decision). */
  async findById(id: string, tx?: Prisma.TransactionClient): Promise<ApprovalGate | null> {
    const client = tx ?? dbRead;
    return client.approvalGate.findUnique({ where: { id } });
  },

  /** The per-card read: every `awaiting` gate on one work item (the decide
   *  door's resolve + the card's own gate surface). Served by the
   *  `approval_gate_work_item_id_idx` index. */
  async findAwaitingByWorkItem(
    workItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ApprovalGate[]> {
    const client = tx ?? dbRead;
    return client.approvalGate.findMany({
      where: { workItemId, state: 'awaiting' },
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * The `awaiting` gates of the given KINDS on a SET of cards (Story MOTIR-7701 ·
   * MOTIR-7703) — the gated close's derivation of what held a run. Oldest first.
   * `tx` required: the close reads it inside its own transaction.
   */
  async findAwaitingByWorkItemsAndKinds(
    workItemIds: string[],
    kinds: readonly ApprovalGateKind[],
    tx: Prisma.TransactionClient,
  ): Promise<Array<Pick<ApprovalGate, 'id' | 'workItemId' | 'kind'>>> {
    if (workItemIds.length === 0 || kinds.length === 0) return [];
    return tx.approvalGate.findMany({
      where: { workItemId: { in: workItemIds }, kind: { in: [...kinds] }, state: 'awaiting' },
      select: { id: true, workItemId: true, kind: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  /**
   * The CARD-LESS form of {@link findAwaitingByWorkItem} (Story MOTIR-6012 ·
   * MOTIR-6034; ADR `approval-gates.md` §11.1–11.2): the `awaiting` gate of one
   * `kind` about one SUBJECT that belongs to no work item — a plan's approval, whose
   * subject is the plan. Keyed on `(subjectId, kind)`, the column list of
   * `approval_gate_one_awaiting_per_cardless_subject`, so there is at most one; it is
   * returned as a list to keep the card form's shape. `workItemId: null` is part of
   * the key: a card gate that happens to share a subject id is a different question.
   */
  /**
   * The CARD-LESS gate a plan's surface renders, WHATEVER STATE IT IS IN (Story
   * MOTIR-6012 · MOTIR-6035) — {@link findLatestByWorkItem}'s rule keyed on the SUBJECT:
   * the oldest `awaiting` row wins (the live question), else the most recent decision
   * or withdrawal. Null when the plan was never asked about.
   */
  async findLatestCardlessBySubject(
    kind: ApprovalGateKind,
    subjectId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ApprovalGate | null> {
    const client = tx ?? dbRead;
    const rows = await client.approvalGate.findMany({
      where: { workItemId: null, kind, subjectId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.find((row) => row.state === 'awaiting') ?? rows[rows.length - 1] ?? null;
  },

  async findAwaitingCardlessBySubject(
    kind: ApprovalGateKind,
    subjectId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ApprovalGate[]> {
    const client = tx ?? dbRead;
    return client.approvalGate.findMany({
      where: { workItemId: null, kind, subjectId, state: 'awaiting' },
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * The gate the FRAME renders — whatever state it is in (Subtask MOTIR-5033).
   *
   * ⚠️ THIS IS NOT `findAwaitingByWorkItem` WITH THE FILTER DROPPED. The
   * awaiting read answers *what is somebody being asked?*; this one answers
   * *what does this card's approval frame show?*, and the two differ exactly
   * once a decision has been made. A decided gate leaves the awaiting set by
   * design, so before this read a page reload took states `E` (approved), `F`
   * (changes requested) and `G` (superseded) off the screen entirely — the
   * record of who decided, when, and on WHICH bytes was written, immutable, and
   * unreachable from the card it was written about.
   *
   * ⚠️ THE ORDERING IS THE CONTRACT, AND ITS FIRST KEY IS NOT RECENCY. A LIVE
   * question outranks a decided one however old it is: a card that was approved
   * on Monday and republished on Tuesday holds a `superseded` gate, an
   * `approved` gate and a new `awaiting` gate, and the only one a reader can
   * ACT on is the awaiting one. Sorting on `createdAt` alone happens to agree
   * here — the republish creates its gate after superseding the old one, in the
   * same transaction — and would stop agreeing the first time a gate is created
   * out of order, which is not a property this read should depend on.
   *
   * So: `awaiting` first (oldest, matching `findAwaitingByWorkItem`'s own
   * determinism), then the most recent of the rest. Both keys are applied in
   * SQL, so the answer is one row and one round trip.
   *
   * Scoped by KIND for the same reason the awaiting read is: ADR §6b's
   * uniqueness is `(workItemId, kind, subjectId)`, so *"the gate"* is only a
   * well-formed question once a kind is named.
   *
   * Served by `approval_gate_work_item_id_idx`.
   */
  /**
   * A DECISION's latest deciding gate, for every decision work item in a set
   * (Story MOTIR-5871 · MOTIR-5958; widened by Bug MOTIR-10146) — the AI boundary's
   * skeleton and item reads carry it so the planner can date and order an epic's
   * decisions, whoever recorded them.
   *
   * The gate that decides a decision depends on who holds it, exactly as the item
   * page's gate set reads it: a `human` decision is confirmed at its
   * `decision_confirmation` gate, a `coding_agent` one (the planner's own record,
   * published as a page) is approved at its `decision_approval` gate. Each row
   * names the kind it was read from, so the caller never re-derives it.
   *
   * ⚠️ ONE STATEMENT, however many decisions the set holds: the work items are
   * filtered to `type = decision` HERE, since the skeleton rows carry neither
   * `type` nor `executor`, and each is joined LATERALLY to its latest gate of its
   * own kind — the live question first, else the most recent. A decision with no
   * gate at all (a defective body, a page not yet published) is a row with a null
   * state. The body rides along because an overturn's owed re-plan is derived from
   * it, and the gate's note because an overturn's reason is the person's own words.
   */
  async findDecisionGatesByWorkItemIds(
    workItemIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<
    Array<{
      workItemId: string;
      descriptionMd: string | null;
      kind: DecisionGateKind;
      state: ApprovalGateState | null;
      decidedAt: Date | null;
      noteMd: string | null;
    }>
  > {
    if (workItemIds.length === 0) return [];
    return tx.$queryRaw`
      SELECT wi."id" AS "workItemId", wi."descriptionMd" AS "descriptionMd",
             d."kind" AS "kind", g."state" AS "state", g."decided_at" AS "decidedAt",
             g."note_md" AS "noteMd"
      FROM "work_item" wi
      CROSS JOIN LATERAL (
        SELECT CASE wi."executor"::text
                 WHEN 'human' THEN 'decision_confirmation'
                 ELSE 'decision_approval'
               END AS "kind"
      ) d
      LEFT JOIN LATERAL (
        SELECT ag."state", ag."decided_at", ag."note_md"
        FROM "approval_gate" ag
        WHERE ag."work_item_id" = wi."id" AND ag."kind"::text = d."kind"
        ORDER BY (ag."state" = 'awaiting') DESC, ag."created_at" DESC
        LIMIT 1
      ) g ON TRUE
      WHERE wi."id" = ANY(${workItemIds}::text[])
        AND wi."type"::text = 'decision'
        AND wi."executor"::text IN ('human', 'coding_agent')`;
  },

  /**
   * The CONFIRMED decisions governing a work item (Story MOTIR-5871 · MOTIR-5959) —
   * every `human` decision under the item's NEAREST `epic` ancestor whose latest
   * `decision_confirmation` gate is `approved`, OLDEST confirmation first. The
   * dispatched prompt hands them to a run with the calendar rule.
   *
   * ⚠️ ONE STATEMENT: the walk UP to the epic, the walk DOWN its subtree and the
   * latest-gate join are all in SQL, so the read costs the same whether the epic
   * holds one decision or twenty. No epic ancestor — or none confirmed — is `[]`.
   * An overturned decision governs nothing and an awaiting one is not agreed, so
   * the latest gate must be `approved`; an archived work item is not read.
   */
  async findConfirmedDecisionsUnderEpicOf(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<
    Array<{ identifier: string; title: string; descriptionMd: string | null; decidedAt: Date }>
  > {
    return tx.$queryRaw`
      WITH RECURSIVE up AS (
        SELECT wi."id", wi."parentId", wi."kind"::text AS "kind", 0 AS "depth"
        FROM "work_item" wi WHERE wi."id" = ${workItemId}
        UNION ALL
        SELECT p."id", p."parentId", p."kind"::text, up."depth" + 1
        FROM "work_item" p JOIN up ON p."id" = up."parentId"
      ),
      epic AS (
        SELECT "id" FROM up WHERE "kind" = 'epic' ORDER BY "depth" ASC LIMIT 1
      ),
      down AS (
        SELECT e."id" FROM epic e
        UNION ALL
        SELECT c."id" FROM "work_item" c JOIN down ON c."parentId" = down."id"
      )
      SELECT wi."identifier" AS "identifier", wi."title" AS "title",
             wi."descriptionMd" AS "descriptionMd", g."decided_at" AS "decidedAt"
      FROM down
      JOIN "work_item" wi ON wi."id" = down."id"
      JOIN LATERAL (
        SELECT ag."state", ag."decided_at"
        FROM "approval_gate" ag
        WHERE ag."work_item_id" = wi."id" AND ag."kind" = 'decision_confirmation'
        ORDER BY (ag."state" = 'awaiting') DESC, ag."created_at" DESC
        LIMIT 1
      ) g ON TRUE
      WHERE wi."type"::text = 'decision'
        AND wi."executor"::text = 'human'
        AND wi."archivedAt" IS NULL
        AND g."state" = 'approved'
        AND g."decided_at" IS NOT NULL
      ORDER BY g."decided_at" ASC, wi."identifier" ASC`;
  },

  /**
   * The APPROVED page decisions under the same epic (Story MOTIR-5761 · MOTIR-7438) —
   * every agent `decision` card whose latest `decision_approval` gate is approved over
   * a PAGE, with the version that approval FROZE (`page_version.frozen_by_gate_id`),
   * oldest approval first. The frozen version, never the page's latest: a run reads
   * the text that was approved. Same epic walk as
   * {@link findConfirmedDecisionsUnderEpicOf}, beside which the prompt merges it.
   */
  async findApprovedPageDecisionsUnderEpicOf(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<
    Array<{
      identifier: string;
      title: string;
      decidedAt: Date;
      pageId: string;
      versionNumber: number;
    }>
  > {
    return tx.$queryRaw`
      WITH RECURSIVE up AS (
        SELECT wi."id", wi."parentId", wi."kind"::text AS "kind", 0 AS "depth"
        FROM "work_item" wi WHERE wi."id" = ${workItemId}
        UNION ALL
        SELECT p."id", p."parentId", p."kind"::text, up."depth" + 1
        FROM "work_item" p JOIN up ON p."id" = up."parentId"
      ),
      epic AS (
        SELECT "id" FROM up WHERE "kind" = 'epic' ORDER BY "depth" ASC LIMIT 1
      ),
      down AS (
        SELECT e."id" FROM epic e
        UNION ALL
        SELECT c."id" FROM "work_item" c JOIN down ON c."parentId" = down."id"
      )
      SELECT wi."identifier" AS "identifier", wi."title" AS "title",
             g."decided_at" AS "decidedAt", pv."page_id" AS "pageId",
             pv."number" AS "versionNumber"
      FROM down
      JOIN "work_item" wi ON wi."id" = down."id"
      JOIN LATERAL (
        SELECT ag."id", ag."state", ag."decided_at"
        FROM "approval_gate" ag
        WHERE ag."work_item_id" = wi."id" AND ag."kind" = 'decision_approval'
        ORDER BY (ag."state" = 'awaiting') DESC, ag."created_at" DESC
        LIMIT 1
      ) g ON TRUE
      JOIN "page_version" pv ON pv."frozen_by_gate_id" = g."id"
      WHERE wi."type"::text = 'decision'
        AND wi."executor"::text <> 'human'
        AND wi."archivedAt" IS NULL
        AND g."state" = 'approved'
        AND g."decided_at" IS NOT NULL
      ORDER BY g."decided_at" ASC, wi."identifier" ASC`;
  },

  async findLatestByWorkItem(
    workItemId: string,
    kind: ApprovalGateKind,
    tx?: Prisma.TransactionClient,
  ): Promise<ApprovalGate | null> {
    const client = tx ?? dbRead;
    const rows = await client.approvalGate.findMany({
      where: { workItemId, kind },
      orderBy: { createdAt: 'asc' },
    });
    if (rows.length === 0) return null;
    // The live question wins, and the OLDEST of those — the same tie-break
    // `findAwaitingByWorkItem` gives, so a surface reading through either door
    // is asked about the same row.
    const awaiting = rows.find((row) => row.state === 'awaiting');
    if (awaiting) return awaiting;
    // Otherwise the most recent decision or withdrawal: approvals ACCUMULATE
    // (ADR §6d), so a card approved, reopened and approved again has several,
    // and the frame shows the latest without disturbing the earlier rows.
    return rows[rows.length - 1]!;
  },

  /**
   * The most recently DECIDED gate on one work item, of ANY kind (Story MOTIR-6070 ·
   * MOTIR-6422) — the read the CHANGES REQUESTED prompt section and `get_work_item`'s
   * `latestRefusal` answer from. The caller keeps it only when its state is
   * `changes_requested`.
   *
   * ⚠️ DELIBERATELY NOT {@link findLatestByWorkItem}: that one is per-KIND and prefers
   * an AWAITING row (the live question). This question is *what was the last thing a
   * person decided about this card*, across kinds — so awaiting and superseded rows
   * (whose `decidedAt` is NULL) are not candidates, and the order is over DECISIONS
   * (`decidedAt`), with `createdAt`/`id` only as deterministic tie-breaks.
   */
  async findLatestDecidedByWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ApprovalGate | null> {
    return tx.approvalGate.findFirst({
      where: { workItemId, decidedAt: { not: null }, state: { notIn: ['awaiting', 'superseded'] } },
      orderBy: [{ decidedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  /**
   * The most recently DECIDED gate of ONE kind on one work item (Story MOTIR-6071 ·
   * MOTIR-6502) — {@link findLatestDecidedByWorkItem} narrowed to a kind. The acceptance
   * re-run class and the acceptance merge hold both ask *what did the last person who
   * watched this story's video say?*, and a later decision of a DIFFERENT kind (a merge
   * gate, a design) is not an answer to that question.
   */
  async findLatestDecidedByWorkItemAndKind(
    workItemId: string,
    kind: ApprovalGateKind,
    tx: Prisma.TransactionClient,
  ): Promise<ApprovalGate | null> {
    return tx.approvalGate.findFirst({
      where: {
        workItemId,
        kind,
        decidedAt: { not: null },
        state: { notIn: ['awaiting', 'superseded'] },
      },
      orderBy: [{ decidedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  /**
   * The most recently DECIDED `approved` gate of one kind, for MANY work items
   * — arm (a) of `design-result.md` AMENDMENT 5 Q2's ladder (Story MOTIR-5553 ·
   * Subtask MOTIR-5557). Returned as a MAP keyed by work-item id.
   *
   * ⚠️ DELIBERATELY NOT {@link findLatestByWorkItem}, and the difference is the
   * whole point rather than a narrowing. That one answers *what question is on
   * this card right now*, so it prefers an AWAITING row — the live question. An
   * approved design is a question that was ANSWERED, so a card that has since
   * been reopened and is awaiting a second decision must still resolve to what
   * the FIRST decision named until the second is made. Reading through the other
   * door would return the awaiting row, whose `subjectId` names a version nobody
   * has approved yet — the exact substitution Q2 exists to prevent.
   *
   * ⚠️ ORDERED ON `decidedAt`, not `createdAt`. Approvals accumulate (ADR §6d)
   * and a reopened card's second gate is created later AND decided later, so the
   * two agree — but the ordering that is CORRECT is the one over decisions,
   * because it is a decision this is looking for.
   *
   * ONE query for the whole set; the per-item head is taken in memory, because
   * the row count per card is the number of times it was approved.
   */
  async findLatestApprovedByWorkItems(
    workItemIds: string[],
    kind: ApprovalGateKind,
    tx?: Prisma.TransactionClient,
  ): Promise<Map<string, ApprovalGate>> {
    if (workItemIds.length === 0) return new Map();
    const client = tx ?? dbRead;
    const rows = await client.approvalGate.findMany({
      where: { workItemId: { in: workItemIds }, kind, state: 'approved' },
      orderBy: { decidedAt: 'desc' },
    });
    const head = new Map<string, ApprovalGate>();
    // Every row matched `workItemId IN (…)`, so none is card-less; the guard narrows the type.
    for (const row of rows) {
      if (row.workItemId !== null && !head.has(row.workItemId)) head.set(row.workItemId, row);
    }
    return head;
  },

  /**
   * The LATEST gate of one kind on MANY work items, with who it waits on and who
   * decided it (Story MOTIR-7460 · MOTIR-7477) — the run surfaces' read of each
   * manual leg's `manual_work` gate, so a skipped leg can say *waiting on you*,
   * *waiting on {name}* or *marked done by {name}*.
   *
   * The head per work item is {@link findLatestByWorkItem}'s, for MANY: the live
   * question first (the OLDEST awaiting row), else the most recent row. ONE query
   * for the whole set; the head is taken in memory, because the rows per card are
   * the number of times a run reached it.
   *
   * The card's assignee and reporter ride along because an awaiting gate's
   * recipient is RE-DERIVED from the live card (`awaitingRoutedToWhere`, §2), never
   * read off `routedToId` — so the run page names the person Waiting on you lists
   * it for.
   */
  async findLatestWithPeopleByWorkItems(
    workItemIds: string[],
    kind: ApprovalGateKind,
    tx?: Prisma.TransactionClient,
  ): Promise<Map<string, GateWithPeople>> {
    if (workItemIds.length === 0) return new Map();
    const client = tx ?? dbRead;
    const rows = await client.approvalGate.findMany({
      where: { workItemId: { in: workItemIds }, kind },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: GATE_WITH_PEOPLE_SELECT,
    });
    const head = new Map<string, GateWithPeople>();
    for (const row of rows) {
      if (row.workItemId === null) continue;
      const held = head.get(row.workItemId);
      // The oldest awaiting row is kept once found; otherwise the later row wins.
      if (held?.state === 'awaiting') continue;
      head.set(row.workItemId, row);
    }
    return head;
  },

  /**
   * How many design refusals a PERSON sent back with **Revise** on this card, up to
   * and including `decidedAt` (MOTIR-700; `hosted-design-rerun-and-design-approval-
   * switch.md` §1e) — the automatic re-run's cap counts these. A GitHub-synced
   * refusal carries no verdict, so the verdict filter already excludes it; the
   * source filter says so rather than relying on that.
   */
  async countPressedRevisesUpTo(
    workItemId: string,
    decidedAt: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.approvalGate.count({
      where: {
        workItemId,
        kind: 'design_result',
        state: 'changes_requested',
        refusalVerdict: 'revise',
        decisionSource: { in: ['ui', 'api', 'mcp'] },
        decidedAt: { lte: decidedAt },
      },
    });
  },

  /**
   * LOCK one gate row and return the fields a DECISION is derived from
   * (MOTIR-4790's decide door, step 1).
   *
   * `SELECT … FOR UPDATE`, because deciding a gate is a READ-DERIVED WRITE: the
   * decision depends on the state it just read, so a plain read-then-write lets
   * two reviewers pressing in the same second both observe `awaiting` and both
   * record a decision. The loser must WAIT for the winner's commit and then
   * re-read what actually happened — which is what makes the refusal able to
   * NAME the winner (`ApprovalGateAlreadyDecidedError`) instead of guessing.
   *
   * ⚠️ NO `SKIP LOCKED`, deliberately, and the contrast with `claim_next_ready`
   * is the whole reason: a dispatch claim skips a locked row because there is a
   * next-best card to hand out, and there is no next-best GATE here — this
   * actor is deciding THIS question. Skipping would return "not found" for a row
   * that exists and is about to be decided, which is the one answer that is
   * never true.
   *
   * ⚠️ It locks the GATE, never the subject. ADR §6a: locking the subject would
   * make two gate kinds on one card contend with each other, so a design
   * approval would serialise against a merge decision for no reason.
   *
   * Returns null when the id names no row THIS transaction can see — missing, or
   * hidden by the workspace RLS policy. The two are indistinguishable on
   * purpose (no existence leak), and the service maps both to a 404.
   *
   * `$queryRaw` because Prisma has no `FOR UPDATE`; the column list is narrow
   * because these are exactly the fields the decision reads, and widening it
   * would invite a caller to write from a snapshot rather than from the row.
   */
  async lockById(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<{
    id: string;
    workspaceId: string;
    projectId: string;
    /** NULL on a card-less (`plan_approval`) gate — ADR §11.1 (MOTIR-6034). */
    workItemId: string | null;
    kind: ApprovalGateKind;
    subjectId: string;
    state: ApprovalGateState;
    decidedById: string | null;
    decidedAt: Date | null;
    decidedByLabel: string | null;
    /** The version the question was ASKED about — read for the stale check's
     *  comparison under this lock (MOTIR-5234), never written from. */
    subjectVersion: string | null;
    /** WHY it was withdrawn, for the refusal's sentence (MOTIR-5667). Read-only:
     *  nothing writes from this snapshot. */
    supersededCause: ApprovalGateSupersedeCause | null;
    /** The stamped option of a chosen `decision_choice` (MOTIR-4914), read so the
     *  planning-session seed guard can tell a PICK under this lock (MOTIR-6434).
     *  Read-only, like the rest of this snapshot. */
    chosenOption: Prisma.JsonValue | null;
    /** The design verdict (MOTIR-6421) — read by the seed guard, which accepts a
     *  design refusal only with `re_plan` (MOTIR-6424). Never written from. */
    refusalVerdict: ApprovalGateRefusalVerdict | null;
    /** THROUGH WHICH SURFACE it was decided — read by the seed guard, which refuses a
     *  GitHub-synced acceptance refusal (MOTIR-6504). Never written from. */
    decisionSource: ApprovalGateDecisionSource | null;
  } | null> {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        workspaceId: string;
        projectId: string;
        workItemId: string | null;
        kind: ApprovalGateKind;
        subjectId: string;
        state: ApprovalGateState;
        decidedById: string | null;
        decidedAt: Date | null;
        decidedByLabel: string | null;
        subjectVersion: string | null;
        supersededCause: ApprovalGateSupersedeCause | null;
        chosenOption: Prisma.JsonValue | null;
        refusalVerdict: ApprovalGateRefusalVerdict | null;
        decisionSource: ApprovalGateDecisionSource | null;
      }>
    >`
      SELECT "id",
             "workspace_id"  AS "workspaceId",
             "project_id"    AS "projectId",
             "work_item_id"  AS "workItemId",
             "kind",
             "subject_id"    AS "subjectId",
             "state",
             "decided_by_id" AS "decidedById",
             "decided_at"    AS "decidedAt",
             "superseded_cause" AS "supersededCause",
             -- READ for the seed guard (MOTIR-6424): a design refusal seeds a
             -- re-plan only with the re_plan verdict.
             "refusal_verdict" AS "refusalVerdict",
             -- READ for the seed guard (MOTIR-6504): a GitHub-synced acceptance
             -- refusal seeds nothing.
             "decision_source" AS "decisionSource",
             -- READ for the stale check (MOTIR-5234): what the question was asked
             -- about, compared with the stamp the reader pressed with.
             "subject_version" AS "subjectVersion",
             -- READ for the REFUSAL, never for a write. The narrow column list
             -- above exists so a caller cannot write from this snapshot; this
             -- one joins decided_by_id / decided_at, which are here for the same
             -- reason - they are what lets the door's already-decided refusal
             -- NAME the winner instead of reporting a bare conflict
             -- (MOTIR-4792). The id is a join key; the label is the only part
             -- of it a person can be shown.
             "decided_by_label" AS "decidedByLabel",
             -- READ for the planning-session seed guard (MOTIR-6434): a chosen
             -- choice's stamp decides whether the gate is a PICK.
             "chosen_option" AS "chosenOption"
      FROM "approval_gate"
      WHERE "id" = ${id}
      FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /**
   * Write the DECISION onto one gate — `state`, `decidedById`, `decidedAt`, the
   * optional note, and THE FIVE DECISION-TIME AUDIT COLUMNS (MOTIR-4790's decide
   * door; the audit set is MOTIR-4912's columns, written here by MOTIR-5046).
   *
   * ⚠️ EVERY AUDIT FIELD IS A REQUIRED PROPERTY OF `data`, THOUGH EVERY COLUMN IS
   * NULLABLE — and that gap is the whole point. The columns shipped nullable so
   * the migration could be additive on a populated table (they are legitimately
   * null while a gate is `awaiting`), and the consequence was that this signature
   * accepted a call that wrote none of them: for the entire life of MOTIR-4912
   * every row in production carried six nulls, indistinguishable at every layer
   * from a correct one, with nothing red anywhere. A caller that genuinely has no
   * answer passes an explicit `null` and has SAID so; a caller that forgot no
   * longer compiles. Do not relax these to optional to make a call site shorter.
   *
   * ⚠️ It carries NO state predicate, BY DESIGN — the same disposition
   * `acceptanceEvidenceRepository.markSupersededByWorkItem` records for the same
   * reason. The `awaiting` check belongs to the SERVICE, which holds the row
   * lock from {@link lockById} and refuses a decided or superseded gate with a
   * typed error. A `WHERE state = 'awaiting'` here would turn that refusal into
   * a SILENT NO-OP: the update would match zero rows, the service would report
   * success, and the reviewer would be told their decision landed. Do not add
   * one in the belief it makes this safer.
   *
   * A DECIDED gate is immutable (ADR §6a — audit evidence that can be edited is
   * not evidence), and that immutability is the service's refusal above plus a
   * DB-level guard a sibling card ships (MOTIR-4912). Nothing else calls this.
   *
   * ⚠️ THAT GUARD HAS NOW SHIPPED, AND THIS IS THE CALL IT CAN FIRE ON — so the
   * `catch` routes through `translateApprovalGateWriteError` (MOTIR-4912). The
   * paragraph above is unchanged and is why the wrap is needed rather than a
   * `WHERE`: the state predicate stays the service's, and if its check is ever
   * absent, bypassed or wrong, the `trg_approval_gate_decided_immutable` trigger
   * refuses the update. Without the wrap that refusal escapes as a raw pg
   * `23514` — the one thing this edge exists to prevent. It is the ONLY write in
   * this repository that can reach the trigger, and the other two cannot for
   * DIFFERENT reasons: `create` because a BEFORE UPDATE trigger does not fire on
   * an INSERT, and {@link supersedeAwaitingByWorkItem} (MOTIR-4913) because its
   * predicate is an equality on the very column the trigger keys on. Its own
   * note carries that argument in full.
   */
  async decide(
    id: string,
    data: {
      state: Extract<
        ApprovalGateState,
        'approved' | 'changes_requested' | 'overturned' | 'declined'
      >;
      /** WHO said yes. NULLABLE since MOTIR-5596: a decision synced out of GitHub
       *  may have been made by somebody with no Motir account at all, and the
       *  column has always been nullable for the neighbouring reason (`SetNull`
       *  when the decider is deleted). `decidedByLabel` carries the attribution in
       *  both cases, which is why a null here never reads as *nobody decided*. */
      decidedById: string | null;
      decidedAt: Date;
      noteMd: string | null;
      /** The subject's immutable version, from the KIND's own seam. */
      subjectVersion: string | null;
      /** The decider's name + email as at the decision — what survives the
       *  `SetNull` on `decidedById`. */
      decidedByLabel: string | null;
      /** Which of §2's three rungs actually authorised the press. */
      decidedUnderAuthority: ApprovalGateAuthority;
      /** Which surface it arrived through. */
      decisionSource: ApprovalGateDecisionSource;
      /** What the decision CAUSED — null when it deliberately caused no status
       *  write, which is a real answer rather than a missing one. */
      outcomeRef: string | null;
      /** What a CHOICE picked (MOTIR-5893) — null on every other decision. */
      chosenOption: ChosenOption | null;
      /** What a CONFIRMED decision's record was (MOTIR-5954) — null on every other
       *  decision. */
      confirmedRecord: ConfirmedRecord | null;
      /** What a Motir-pressed `design_result` REFUSAL meant (MOTIR-6421; ADR §10d) —
       *  null on every other decision. Written HERE, in the deciding write, because the
       *  decided-row trigger refuses any later amendment. */
      refusalVerdict: ApprovalGateRefusalVerdict | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<ApprovalGate> {
    const { chosenOption, confirmedRecord, ...rest } = data;
    try {
      return await tx.approvalGate.update({
        where: { id },
        // A JSON column writes SQL NULL through `Prisma.DbNull`, never a bare `null`.
        data: {
          ...rest,
          chosenOption: chosenOption === null ? Prisma.DbNull : { ...chosenOption },
          confirmedRecord: confirmedRecord === null ? Prisma.DbNull : { ...confirmedRecord },
        },
      });
    } catch (err) {
      translateApprovalGateWriteError(err);
    }
  },

  /**
   * RETIRE every `awaiting` gate of one kind on one work item — the product
   * withdrawing its own question because the subject it asked about is no longer
   * the current one (MOTIR-4913; ADR §6b).
   *
   * ⚠️ IT WRITES `state` AND NOTHING ELSE. No actor, no authority, no note, no
   * `decided_at`. That is the entire reason `superseded` is a separate state
   * rather than a flag beside `changes_requested`: the audit must never be able
   * to read a withdrawn question as a decision somebody made, and the only thing
   * that keeps those two apart on the row is that this write leaves every column
   * a decision fills untouched.
   *
   * ⚠️ KEYED ON `(workItemId, kind)`, NOT on the superseded subject's id — and
   * that is a fact about the DOMAIN, not a shortcut. `design_evidence` carries
   * one CURRENT row per work item (the
   * `design_evidence_one_current_per_item` partial unique index), so an
   * `awaiting` `design_result` gate on this item is by construction asking about
   * the version a publish is replacing. Keying on the prior row's id would need
   * that row read FIRST, which puts this write AFTER the
   * `design_evidence` lock — and the decide door takes those two locks in the
   * opposite order (gate, then evidence). One of the two orders has to give, and
   * the caller's own comment records why this one does.
   *
   * ⚠️ NO `decided`-state rows are touched: the `state: 'awaiting'` predicate is
   * the whole guard. A gate whose decision has landed is somebody's answer and
   * outlives its subject.
   *
   * ⚠️ AND THAT IS WHY THIS WRITE DOES **NOT** ROUTE THROUGH
   * {@link translateApprovalGateWriteError}, unlike the other two — the omission
   * is reasoned, not an oversight, and the reason is not *"a decided row would
   * be a bug"*. `trg_approval_gate_decided_immutable` (MOTIR-4912) keys on
   * `OLD.state`, and this statement's predicate is an EQUALITY on that same
   * column, so the trigger is structurally unreachable from here: under READ
   * COMMITTED an `updateMany` re-evaluates its `WHERE` against the updated row
   * version before writing, so a gate a concurrent decide commits mid-statement
   * stops matching and is skipped rather than refused. A `catch` here would be a
   * branch no test could honestly exercise, which is the thing this repository's
   * `tx ?? dbRead` note already refuses to add.
   *
   * ⚠️ AND THE ZERO-ROW RESULT IS NOT {@link decide}'S SILENT NO-OP. That method
   * carries no state predicate precisely because one would report success on a
   * decision that never landed. Here both causes of a zero count are correct end
   * states — nothing awaiting to retire, or a decide that won the row first —
   * and no caller is told anything happened that did not.
   *
   * Returns the count, which is 0 on every publish that had no prior version —
   * the ordinary first publish.
   *
   * ⚠️ `cause` IS REQUIRED, AND DELIBERATELY NOT OPTIONAL (Story MOTIR-5652 ·
   * Subtask MOTIR-5659; `docs/decisions/design-result.md` AMENDMENT 6 Q5). Six
   * production paths reach this method and its sibling for six different
   * reasons, and until now the row recorded none of them — which is why two
   * surfaces (MOTIR-5586, MOTIR-5651) asserted *a newer design was published*
   * over every one of them, true for one and false for the rest. An OPTIONAL
   * parameter would let a seventh caller omit it in silence, reproducing exactly
   * that defect one path at a time; a required one makes the omission a compile
   * error. `unknown` is not in {@link LiveSupersedeCause} for the same reason —
   * see the type.
   */
  async supersedeAwaitingByWorkItem(
    workItemId: string,
    kind: ApprovalGateKind,
    cause: LiveSupersedeCause,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.approvalGate.updateMany({
      where: { workItemId, kind, state: 'awaiting' },
      data: { state: 'superseded', supersededCause: cause },
    });
    return result.count;
  },

  /**
   * Write (or, with `null`, clear) why an AWAITING `agent_review` gate's review could not
   * run (Story MOTIR-1626 · MOTIR-6820; ADR `approval-gates.md` §12.6). The
   * `state: 'awaiting'` + `kind` predicate is the whole guard: a decided or withdrawn
   * review keeps whatever it had, and the immutability trigger is structurally
   * unreachable. `onlyWhenUnset` writes only over no reason at all, so a run's end never
   * overwrites the more specific refusal its own start recorded. Returns the rows written.
   */
  async setReviewUnavailableReason(
    id: string,
    reason: string | null,
    tx: Prisma.TransactionClient,
    opts: { onlyWhenUnset?: boolean } = {},
  ): Promise<number> {
    const result = await tx.approvalGate.updateMany({
      where: {
        id,
        kind: 'agent_review',
        state: 'awaiting',
        ...(opts.onlyWhenUnset ? { reviewUnavailableReason: null } : {}),
      },
      data: { reviewUnavailableReason: reason },
    });
    return result.count;
  },

  /**
   * The CARD-LESS form of {@link supersedeAwaitingByWorkItem} (MOTIR-6034; ADR §11.7):
   * withdraw the `awaiting` gate of one `kind` about one subject that belongs to no
   * work item, keyed on `(subjectId, kind)` as the card-less index is. The card form's
   * notes hold unchanged — the `state: 'awaiting'` equality is the whole guard, the
   * immutability trigger is structurally unreachable, and `cause` is required.
   */
  async supersedeAwaitingCardlessBySubject(
    kind: ApprovalGateKind,
    subjectId: string,
    cause: LiveSupersedeCause,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.approvalGate.updateMany({
      where: { workItemId: null, kind, subjectId, state: 'awaiting' },
      data: { state: 'superseded', supersededCause: cause },
    });
    return result.count;
  },

  /**
   * LOCK every `awaiting` gate row on one work item, in id order (Story MOTIR-4887
   * · Subtask MOTIR-5527; ADR `approval-gates.md` §6d AMENDMENT, rule 8).
   *
   * ⚠️ A LOCK-ORDER TOOL, and the order is the whole of its purpose. The decide
   * door locks a GATE ({@link lockById}) and then, through the kind's effect,
   * transitions the item — which locks the WORK ITEM. `applyStatusTransition`
   * calls this BEFORE it locks the item, so every transition takes gate rows
   * first and the item second. A funnel that locked the item first and reached
   * for the gate afterwards (to supersede it) would take the same two locks in
   * the opposite order, and a person approving while another pulls the card back
   * would deadlock.
   *
   * Re-locking a row this transaction already holds is a no-op in Postgres, so the
   * decide door's own call into the funnel does not wait on itself. `ORDER BY id`
   * keeps two transitions on one item taking a multi-gate set in the same order.
   * Under READ COMMITTED a row decided while this waited is re-checked against
   * `state = 'awaiting'` and dropped from the result — so the rows it returns ARE
   * the item's awaiting set as of the lock, which is what the approval-gate guard
   * reads (`id` and `kind` are the two fields it needs).
   */
  async lockAwaitingByWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; kind: ApprovalGateKind }>> {
    return tx.$queryRaw<Array<{ id: string; kind: ApprovalGateKind }>>`
      SELECT "id", "kind"
      FROM "approval_gate"
      WHERE "work_item_id" = ${workItemId} AND "state" = 'awaiting'
      ORDER BY "id"
      FOR UPDATE
    `;
  },

  /**
   * RETIRE every `awaiting` gate on one work item, WHATEVER ITS KIND — the
   * withdraw a hand move that pulls the work back performs (Story MOTIR-4887 ·
   * Subtask MOTIR-5527; ADR `approval-gates.md` §6d AMENDMENT, rule 6).
   *
   * The sibling of {@link supersedeAwaitingByWorkItem}, and not that method called
   * once per kind, because the question is different: a republish retires ONE
   * kind's question about a subject that changed, while pulling the work back
   * withdraws EVERY question anyone was asked about this item. A per-kind loop
   * would have to enumerate the kinds, and a kind added later would silently stay
   * `awaiting` on a card nobody is offering for review.
   *
   * Writes `state` and its `cause` and nothing else, exactly as the publish-path
   * supersede does — no actor, no note, no `decided_at` — so the audit cannot
   * read a withdrawn question as a decision. **A cause is not an actor**: it says
   * what happened to the subject, never who decided anything, so recording one
   * leaves §6b's *product write with no actor* intact (AMENDMENT 6 Q5). The
   * `state: 'awaiting'` predicate is the whole guard: a decided gate is somebody's
   * answer and is never touched.
   *
   * ⚠️ `cause` is REQUIRED here for the reason spelled out on
   * {@link supersedeAwaitingByWorkItem}.
   */
  async supersedeAllAwaitingByWorkItem(
    workItemId: string,
    cause: LiveSupersedeCause,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.approvalGate.updateMany({
      where: { workItemId, state: 'awaiting' },
      data: { state: 'superseded', supersededCause: cause },
    });
    return result.count;
  },

  /**
   * The `awaiting` gates of one KIND across a whole PROJECT, locked in id order (Story
   * MOTIR-1626 · MOTIR-6819; `approval-gates.md` §12.5) — what switching the review agent
   * OFF retires: every awaiting `agent_review` in the project, each then superseded by
   * {@link supersedeAwaitingByWorkItem} with its own cause. Locked so a decision racing the
   * switch waits for it and then meets a withdrawn question rather than deciding one.
   */
  async lockAwaitingByProjectAndKind(
    projectId: string,
    kind: ApprovalGateKind,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; workItemId: string | null }>> {
    return tx.$queryRaw<Array<{ id: string; workItemId: string | null }>>`
      SELECT "id", "work_item_id" AS "workItemId"
      FROM "approval_gate"
      WHERE "project_id" = ${projectId}
        AND "kind" = ${kind}::"approval_gate_kind"
        AND "state" = 'awaiting'
      ORDER BY "id"
      FOR UPDATE
    `;
  },

  /**
   * RETIRE every `awaiting` gate on one work item EXCEPT ONE — the withdraw a
   * gate-owned return to To do performs (Story MOTIR-6070 · MOTIR-6423;
   * `docs/decisions/design-refusal-verdict.md` §2).
   *
   * The sibling of {@link supersedeAllAwaitingByWorkItem}, and the exclusion is the
   * whole reason it exists: a handler that returns the card to To do runs INSIDE the
   * decide door, BEFORE the door's deciding write, so the gate being decided is still
   * `awaiting` while this runs. The all-gates form would supersede the very decision
   * being made — and the door's deciding write would then land on a `superseded` row.
   * `id: { not: exceptGateId }` keeps that one row out; every other awaiting question
   * about the card is withdrawn with the caller's cause, writing `state` and `cause`
   * and nothing else, exactly as the pull-back rule does.
   */
  async supersedeOtherAwaitingByWorkItem(
    workItemId: string,
    exceptGateId: string,
    cause: LiveSupersedeCause,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.approvalGate.updateMany({
      where: { workItemId, state: 'awaiting', id: { not: exceptGateId } },
      data: { state: 'superseded', supersededCause: cause },
    });
    return result.count;
  },

  /**
   * RETIRE ONE `awaiting` gate by its id — the withdrawal a gate whose subject no longer
   * resolves takes (MOTIR-7146). By id rather than by card, because the subject is the
   * gate's own: a card can hold one question whose design has gone beside another whose
   * subject is perfectly live, and only the first may go.
   *
   * The siblings' notes hold unchanged — `state` and its `cause` and nothing else, the
   * `state: 'awaiting'` equality is the whole guard, the immutability trigger is
   * structurally unreachable, and `cause` is REQUIRED. Returns 1, or 0 when a decision
   * won the row first.
   */
  async supersedeAwaitingById(
    id: string,
    cause: LiveSupersedeCause,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.approvalGate.updateMany({
      where: { id, state: 'awaiting' },
      data: { state: 'superseded', supersededCause: cause },
    });
    return result.count;
  },

  // ⚠️ `findByWorkItemAndKind`, `findAwaitingBySubject` AND `supersedeAwaitingBySubject`
  // WERE ALL HERE, and all three retired with the kind they were written for
  // (MOTIR-5611 · MOTIR-5613 · MOTIR-5616). Each read or wrote gates BY SUBJECT rather
  // than by card — right when a card delivered by two pull requests held two independent
  // merge questions, and meaningless now that it holds ONE gate over the whole delivery
  // set. The coverage gate is what surfaced the last two: with their callers gone they
  // were never executed, and their `tx ?? dbRead` arms dragged this file's branch
  // coverage under its floor. Dead code is not neutral — it is measured.
  //
  // ⚠️ `supersedeAwaitingBySubject` was the third, and it retired with the kind it was
  // written for (MOTIR-5611 · MOTIR-5613). It withdrew the awaiting gates of a kind
  // asking about ONE SUBJECT rather than one card — right when a card delivered by two
  // pull requests held two independent merge questions, and meaningless now that it
  // holds ONE gate over the whole delivery set. Its two callers went with the per-pull-
  // request gate: `mergeGates.ts`'s withdrawals and the merge entry point's own
  // supersede. {@link supersedeAwaitingByWorkItem} is the verb that survives.

  /**
   * Whether a subject already has a LIVE question — a gate on
   * `(workItemId, kind, subjectId)` that is `awaiting` or `approved` (MOTIR-5532).
   *
   * The re-ask's precondition (ADR §6d AMENDMENT, rule 7): an awaiting gate is
   * already asking, and an approved one has been answered for THESE bytes, so
   * neither is asked again. `changes_requested` and `superseded` do not count —
   * the first sent the work back, the second was withdrawn.
   */
  async hasLiveGateForSubject(
    workItemId: string,
    kind: ApprovalGateKind,
    subjectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const count = await tx.approvalGate.count({
      where: { workItemId, kind, subjectId, state: { in: ['awaiting', 'approved'] } },
    });
    return count > 0;
  },

  /**
   * The CARD-LESS form of {@link hasLiveGateForSubject} (MOTIR-6034; ADR §11.2): a
   * gate on `(subjectId, kind)` that belongs to no work item and is `awaiting` or
   * `approved`. The same two states count, for the same reasons.
   */
  async hasLiveCardlessGateForSubject(
    kind: ApprovalGateKind,
    subjectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const count = await tx.approvalGate.count({
      where: { workItemId: null, kind, subjectId, state: { in: ['awaiting', 'approved'] } },
    });
    return count > 0;
  },

  /**
   * RAISE an `awaiting` gate, or do nothing when one is already awaiting on the
   * same subject (Story MOTIR-4887 · Subtask MOTIR-5532; ADR §6d AMENDMENT,
   * rule 7). Returns whether a row was inserted.
   *
   * ⚠️ NOT {@link create}, and the difference is transactional, not cosmetic.
   * `create` translates the partial unique index's `P2002` into a typed error —
   * right at publish, where a collision is impossible by construction. The re-ask
   * runs INSIDE a status transition, where a concurrent double raise is a normal
   * outcome and must count as "already raised". A caught `P2002` cannot express
   * that: Postgres has already ABORTED the transaction, so the status write that
   * follows would fail. `ON CONFLICT DO NOTHING` (`skipDuplicates`) resolves the
   * race inside the statement, and the transition carries on.
   */
  async createAwaitingIfAbsent(
    data: {
      workspaceId: string;
      projectId: string;
      workItemId: string;
      kind: ApprovalGateKind;
      subjectId: string;
      routedToId: string | null;
      /** The subject's stamp, when the raiser knows it (a `decision_choice` always does). */
      subjectVersion?: string | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const result = await tx.approvalGate.createMany({
      data: [{ ...data, state: 'awaiting' }],
      skipDuplicates: true,
    });
    return result.count > 0;
  },

  /**
   * The CARD-LESS form of {@link createAwaitingIfAbsent} (MOTIR-6034; ADR §11.1–11.2):
   * raise an `awaiting` gate that belongs to NO work item, or do nothing when one is
   * already awaiting on `(subjectId, kind)`. `workItemId` is written NULL and cannot
   * be passed — the CHECK `approval_gate_work_item_iff_not_plan` admits that only for
   * `plan_approval`, and refuses any other kind here as a raw 23514, which is a defect
   * in the caller rather than a race.
   *
   * ⚠️ THE RACE IS RESOLVED BY THE SECOND INDEX. The shipped
   * `approval_gate_one_awaiting_per_subject` keys `work_item_id`, and two NULLs are
   * distinct, so it would admit any number of these; `ON CONFLICT DO NOTHING` names no
   * target, so it yields to `approval_gate_one_awaiting_per_cardless_subject` exactly
   * as the card form yields to the shipped one. The raise itself is MOTIR-6036's.
   */
  async createCardlessAwaitingIfAbsent(
    data: {
      workspaceId: string;
      projectId: string;
      kind: ApprovalGateKind;
      subjectId: string;
      routedToId: string | null;
      subjectVersion?: string | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const result = await tx.approvalGate.createMany({
      data: [{ ...data, workItemId: null, state: 'awaiting' }],
      skipDuplicates: true,
    });
    return result.count > 0;
  },

  /**
   * THE ROUTING READ — one project's `awaiting` gates that are routed to ONE
   * person, oldest-waiting first, as a WINDOW (Story MOTIR-4879 · Subtask
   * MOTIR-4791; ADR docs/decisions/approval-gates.md §2).
   *
   * ⚠️ THIS IS `findAwaitingByWorkspace` NARROWED, NOT A SECOND METHOD BESIDE
   * IT. That read was workspace-scoped, unpaged and routed to nobody — the right
   * LEAF with the wrong scope, as its own comment said (*"the routing read: a
   * workspace's `awaiting` gates (whose Approvals tab)"*). Three things were
   * missing and all three are properties of the surface it was named for: the
   * Workbench is ACTIVE-PROJECT scoped (`homeService`'s own note, MOTIR-2761),
   * the tab asks whose gate it is, and a personal list is paged. Adding a fourth
   * near-identical `findMany` beside it would have left two answers to *whose
   * Approvals tab* differing only in a `where` clause nobody diffs.
   *
   * ⚠️ THE PREDICATE IS APPLIED IN THE QUERY, NEVER TO ITS OUTPUT — and the
   * `projectIds` ARRAY is what carries the ACCESS decision in. An actor who may
   * not browse their own active project is passed an EMPTY array and the query
   * returns nothing, which is the no-existence-leak convention every other
   * project gate follows. A post-read filter would shorten pages instead of
   * failing, and *"the list sometimes ends early"* is a bug nobody traces back to
   * an access rule (`homeService`'s `resolveActiveProjectScope`, verbatim reasoning).
   *
   * ⚠️ ROUTING IS RE-DERIVED FROM THE WORK ITEM, NOT READ FROM `routed_to_id` —
   * and the two genuinely differ, so this is a decision rather than an
   * oversight. `routed_to_id` is §2's answer FROZEN AT CREATION, and ADR §6a
   * keeps it for exactly that: it is the audit record of *who was actually
   * asked*, which must not move when a card is reassigned. A live QUEUE asks a
   * different question — *whose job is it to look, now* — and answering it from
   * the frozen column would strand every gate on a reassigned card in the
   * previous assignee's tab, including one belonging to somebody who has left.
   * That is the failure §2's amendment widened AUTHORITY to escape, and it
   * should not be reintroduced through the routing half. The audit column and
   * this predicate are both right, about different questions.
   *
   * `assigneeId = :me OR (assigneeId IS NULL AND reporterId = :me)` — §2's
   * `assigneeId ?? reporterId`, expressed as a predicate. Exactly one recipient,
   * which is why it is NOT `workItemRepository.findByAssigneeOrReporterInWorkspace`'s
   * union: that one is right for a WORK LIST and wrong for a DECISION QUEUE.
   *
   * Ordered `createdAt asc` — oldest-waiting first, matching
   * {@link findAwaitingByWorkItem}'s own determinism. A queue optimises for what
   * has been waiting, because the cost of a gate is the work stalled behind it.
   *
   * Served by `approval_gate_project_id_state_idx` (this card's migration): the
   * gate side narrows to one project's awaiting rows and the join to
   * `work_item` is by primary key. The old `(workspace_id, state)` index stays
   * for the workspace-tier read MOTIR-2920 will add.
   *
   * ⚠️ `tx` IS REQUIRED, UNLIKE ITS NEIGHBOURS' `tx ?? dbRead` — and this is
   * MOTIR-2797's disposition, applied to a new pair rather than inherited by
   * habit. `designEvidenceRepository` records the reasoning in full: a fallback
   * arm with no caller *"was dead code that returned an EMPTY result under
   * `motir_app` and raised nothing — the exact silent failure this cutover
   * exists to remove. A branch that cannot be honestly exercised in both role
   * modes should not exist."* Both callers here are
   * `approvalGatesService.listAwaitingMe` / `.countAwaitingMe`, which read
   * INSIDE `withWorkspaceContext` and thread it. Measured, not assumed: calling
   * this without a `tx` returns `[]` on a populated fixture, because `dbRead` is
   * a second connection with no `app.workspace_id` bound — an empty queue and no
   * error, which is the worst answer this surface could give.
   */
  async findAwaitingRoutedTo(
    scope: AwaitingRoutingScope,
    window: { skip: number; take: number },
    tx: Prisma.TransactionClient,
  ): Promise<AwaitingGateRow[]> {
    return tx.approvalGate.findMany({
      where: awaitingRoutedToWhere(scope),
      select: AWAITING_GATE_SELECT,
      orderBy: { createdAt: 'asc' },
      skip: window.skip,
      take: window.take,
    });
  },

  /**
   * HOW MANY gates {@link findAwaitingRoutedTo} would return over the whole set
   * — the tab strip's badge, and the pager's denominator.
   *
   * ⚠️ IT IS THE SAME PREDICATE, from the same function, and that is the point
   * rather than a tidiness. The strip's number and the list's rows are two reads
   * of one question, so a copy of the `where` clause here is a copy that can
   * drift — and a badge saying `3` above a list of two is the exact bug the
   * story's own criterion (*"one read, not two, so they cannot disagree"*)
   * names. `awaitingRoutedToWhere` is the one place the predicate is written.
   */
  async countAwaitingRoutedTo(
    scope: AwaitingRoutingScope,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.approvalGate.count({ where: awaitingRoutedToWhere(scope) });
  },

  /**
   * The PLANS routed to this reader and still awaiting a decision (Story
   * MOTIR-6179 · MOTIR-6330) — the ids of the plans whose card-less
   * `plan_approval` gate is waiting on them, the Plans room's third `mine` arm.
   *
   * ⚠️ THE ROUTING PREDICATE IS CALLED, NOT RESTATED — `awaitingRoutedToWhere`,
   * the same builder the Workbench tab and the Approvals room read, narrowed to
   * the plan kind. So a plan that is on the reader's To approve tab is in their
   * Plans room's Mine view by construction, and the two cannot disagree about
   * whose decision it is.
   */
  async findAwaitingRoutedPlanIds(
    scope: AwaitingRoutingScope,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const rows = await tx.approvalGate.findMany({
      where: { AND: [awaitingRoutedToWhere(scope), { kind: 'plan_approval' }] },
      select: { subjectId: true },
    });
    return rows.map((row) => row.subjectId);
  },

  /**
   * THE APPROVALS TAB'S WATERMARK (Story MOTIR-5238 · MOTIR-5240) — how many
   * gates are waiting on this reader, and the most recent `updatedAt` among
   * them, in ONE query.
   *
   * ⚠️ THE SAME PREDICATE AS THE LIST AND THE COUNT, from the same builder. A
   * third reader of `awaitingRoutedToWhere` rather than a third copy of it: a
   * watermark taken over a different set than the tab renders is a tab that goes
   * stale while nothing ever nudges — the silent half of the badge-says-3 bug
   * this builder was extracted for.
   *
   * ⚠️ AND THE MAXIMUM IS WHAT CATCHES A SUBJECT MOVING. A republish supersedes
   * the prior version's gate (`designEvidenceService`, ADR §6b) — so the count
   * moves when the set changes size, and `updatedAt` moves when a row is edited
   * in place or replaced within a tab of the same size. Neither number alone is
   * a change detector; the pair is.
   *
   * Required `tx`, for the reason `findAwaitingRoutedTo` states at length:
   * without a bound `app.workspace_id` this returns an empty answer and raises
   * nothing, which on a watermark reads as *nothing has changed*.
   */
  async watermarkAwaitingRoutedTo(
    scope: AwaitingRoutingScope,
    tx: Prisma.TransactionClient,
  ): Promise<{ count: number; latest: Date | null }> {
    const row = await tx.approvalGate.aggregate({
      where: awaitingRoutedToWhere(scope),
      _count: { _all: true },
      _max: { updatedAt: true },
    });
    return { count: row._count._all, latest: row._max.updatedAt ?? null };
  },

  /**
   * EVERY `awaiting` gate on a SET of work items — the decision-waiting marker's
   * read (Story MOTIR-4908 · MOTIR-5876), one query whatever the set's size.
   *
   * ⚠️ NOT {@link findAwaitingRoutedTo} WITH A LIST OF IDS, and the difference is
   * the whole of why this exists. That read filters by the READER, so it can only
   * ever say *yours*; a marker also has to say *someone else's*, which needs every
   * awaiting gate on the set. The routing test moves to the service, which applies
   * `routingTargetId` to the `assigneeId` / `reporterId` this selects — the same
   * expression the queue's SQL spells, so the two cannot disagree about who a gate
   * is routed to.
   *
   * ⚠️ THE CARRIED MERGE GATE IS EXCLUDED IN THE QUERY, by the same constant every
   * queue read spreads. A design card with an open pull request holds two
   * `awaiting` gates and asks ONE question (MOTIR-5712); a marker counting the merge
   * gate would call a card someone else's when its primary is yours.
   *
   * Empty input costs no query: a board with no cards, or a page with no rows,
   * must not pay a round trip to learn nothing.
   *
   * ⚠️ `tx` IS REQUIRED, for {@link findAwaitingRoutedTo}'s measured reason: without
   * a bound `app.workspace_id` this returns `[]` on a populated fixture and raises
   * nothing — every card would read *no decision waiting*.
   */
  async findAwaitingOnItems(
    workItemIds: string[],
    projectIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<AwaitingOnItemRow[]> {
    if (workItemIds.length === 0 || projectIds.length === 0) return [];
    return tx.approvalGate.findMany({
      where: awaitingOnItemsWhere(workItemIds, projectIds),
      select: AWAITING_ON_ITEM_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  /**
   * THE APPROVALS ROOM's PENDING half (Story MOTIR-5299 · MOTIR-5301) — one
   * project's `awaiting` gates as a window, in `design/approvals/design-notes.md`'s
   * order: `createdAt asc, id asc`.
   *
   * The ORDER is ADOPTED from {@link findAwaitingRoutedTo} (the notes' § The ORDER):
   * a pending row in a record room is still work stalled behind a question, and in
   * the own-records view this half IS the tab's rows, so it must list them in the
   * tab's order. The `id` tie-break is the room's addition — two gates raised in one
   * transaction share a `createdAt`, and a window over an unstable order serves a
   * row twice across a page boundary.
   *
   * ⚠️ `tx` IS REQUIRED, for {@link findAwaitingRoutedTo}'s measured reason: without
   * one this returns `[]` on a populated fixture and raises nothing.
   */
  async findRecordsAwaiting(
    scope: ApprovalRecordsScope,
    window: { skip: number; take: number },
    tx: Prisma.TransactionClient,
  ): Promise<RecordGateRow[]> {
    return tx.approvalGate.findMany({
      where: recordsAwaitingWhere(scope),
      select: RECORD_GATE_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: window.skip,
      take: window.take,
    });
  },

  /** HOW MANY rows {@link findRecordsAwaiting} would return — the same `where` builder. */
  async countRecordsAwaiting(
    scope: ApprovalRecordsScope,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.approvalGate.count({ where: recordsAwaitingWhere(scope) });
  },

  /**
   * THE APPROVALS ROOM's DECIDED half (MOTIR-5301) — one project's decided gates
   * (`approved`, `changes_requested`, `overturned`, a plan's `declined`) as a window, most recently decided first:
   * `decidedAt desc, id desc` (the notes' § The ORDER).
   *
   * ⚠️ `superseded` IS NOT A DECISION AND IS NOT HERE, IN EITHER VIEW. ADR §6b writes
   * a null `decidedById` to mean *the question was withdrawn and nobody decided it*,
   * so the own-records arm excludes it for free — and the full view excludes it on
   * purpose, because the design settles that a room of records must not list an
   * abandoned question beside a decision (the notes' § `superseded` is NOT in the
   * room). It is the STATE list that excludes it, not the decider test, so the
   * full view does not depend on a column being null.
   *
   * Served by `approval_gate_project_id_decided_by_id_decided_at_idx` in the
   * own-records view — see the index's own note in `prisma/schema.prisma`.
   *
   * ⚠️ `tx` IS REQUIRED, for the same reason as {@link findRecordsAwaiting}.
   */
  async findRecordsDecided(
    scope: ApprovalRecordsScope,
    window: { skip: number; take: number },
    tx: Prisma.TransactionClient,
  ): Promise<RecordGateRow[]> {
    return tx.approvalGate.findMany({
      where: recordsDecidedWhere(scope),
      select: RECORD_GATE_SELECT,
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      skip: window.skip,
      take: window.take,
    });
  },

  /** HOW MANY rows {@link findRecordsDecided} would return — the same `where` builder. */
  async countRecordsDecided(
    scope: ApprovalRecordsScope,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.approvalGate.count({ where: recordsDecidedWhere(scope) });
  },
};

/**
 * WHICH projects the read may see, and WHO it is routed to.
 *
 * `projectIds` is an ARRAY of at most one rather than a bare id, deliberately —
 * the same shape and the same reason as `homeService`'s `HomeProjectScope[]`: an
 * actor who may not browse their active project resolves to `[]`, and a call
 * shape that took a bare id could not express that without an early return, at
 * which point the access decision has left the query.
 */
export interface AwaitingRoutingScope {
  projectIds: string[];
  /** The reader — §2's single recipient. */
  userId: string;
  /**
   * The planning sessions of these projects that STILL WAIT on their person right now
   * (`AWAITING_PERSON_WHERE`; Story MOTIR-7905 · MOTIR-7913) — resolved by the SERVICE in
   * the same transaction, because a `planning_session` gate's subject is an opaque id with
   * no relation to join. A gate row of that kind is listed only if its subject is in this
   * set, so a session that has since failed or ended never shows a stale row whatever the
   * gate row still says. Empty ⇒ no planning-session row is listed.
   */
  awaitingSessionIds: readonly string[];
  /**
   * The plans a REVISION holds right now (Bug MOTIR-7988), whose `plan_approval`
   * gates leave the queue while the planner rewrites them — resolved by the
   * service from the revision lease, which no column says. Omitted or empty, no
   * plan gate is excluded.
   */
  heldPlanIds?: readonly string[];
}

/** The card-less kind whose row is live only while its subject session still waits. */
const PLANNING_SESSION_KIND = 'planning_session' as const;

/**
 * The planning-session LIVENESS clause (MOTIR-7913), written once for every reader of
 * the awaiting predicate: any kind but `planning_session` passes; a `planning_session`
 * row passes only when its session is in {@link AwaitingRoutingScope.awaitingSessionIds}.
 */
function planningSessionLiveWhere(scope: AwaitingRoutingScope): Prisma.ApprovalGateWhereInput {
  return {
    OR: [
      { kind: { not: PLANNING_SESSION_KIND } },
      { kind: PLANNING_SESSION_KIND, subjectId: { in: [...scope.awaitingSessionIds] } },
    ],
  };
}

/**
 * §2's routing predicate, written ONCE — the list and the count both call it.
 *
 * The `OR` is the SQL spelling of `assigneeId ?? reporterId`: the second arm is
 * guarded by `assigneeId: null`, which is what makes it a FALLBACK rather than
 * the union the work tabs use. Drop that guard and this becomes
 * `homeService`'s membership predicate, which is the exact "fix" ADR §2 records
 * itself to stop.
 */
function awaitingRoutedToWhere(scope: AwaitingRoutingScope): Prisma.ApprovalGateWhereInput {
  return {
    projectId: { in: scope.projectIds },
    state: 'awaiting',
    OR: [
      {
        workItem: {
          OR: [{ assigneeId: scope.userId }, { assigneeId: null, reporterId: scope.userId }],
        },
      },
      // ⚠️ THE CARD-LESS ARM (Story MOTIR-6012 · MOTIR-6034; ADR `approval-gates.md`
      // §11.6). A gate with no work item has no assignee to re-derive routing from, so
      // the relation arm above can never match it. Its recipient is the one written into
      // `routed_to_id` at creation — the plan's requester, or the workspace owner for a
      // cadence plan — and that is not frozen in the sense the note above warns about:
      // nothing reassigns a plan's requester, so the creation answer IS the live one.
      { workItemId: null, routedToId: scope.userId },
    ],
    // ⚠️ THE REVIEW AGENT'S QUESTION IS NEVER ON A PERSON'S LIST (MOTIR-6819;
    // `approval-gates.md` §12.1). It is routed by §2's rule only so the routed person can
    // CONTINUE WITHOUT THE REVIEW on the card (§12.3); it asks the agent, not them, so it
    // is excluded here — the list, its count, the home count and the marker all read this.
    kind: { not: 'agent_review' },
    ...CARRIED_MERGE_GATE_EXCLUDED,
    AND: [
      // …a planning-session row is listed only while its session still waits (MOTIR-7913)…
      planningSessionLiveWhere(scope),
      // ⚠️ …and A PLAN BEING REWRITTEN IS NOT WAITING ON ANYBODY (Bug MOTIR-7988;
      // `approval-gates.md` §11.5c's 2026-10-09 amendment). Its gate stays `awaiting`
      // and HELD — the decide door refuses it — but the person has nothing to decide
      // until the revision lands, so it is off the list, its count and the watermark,
      // and listed under Planning instead. It returns when the lease ends.
      ...(scope.heldPlanIds && scope.heldPlanIds.length > 0
        ? [{ NOT: { kind: 'plan_approval' as const, subjectId: { in: [...scope.heldPlanIds] } } }]
        : []),
    ],
  };
}

/**
 * ONE ROW PER QUESTION A PERSON IS ASKED, not one per gate (Bug MOTIR-5712;
 * `design-result.md` AMENDMENT 6 Q1 and Q4).
 *
 * A design card with an open pull request holds TWO `awaiting` gates, and
 * `resolveGateSet` names the design gate PRIMARY: one press on it decides the
 * design AND the merge (`approvePrimaryAndMerge`). The merge gate is still a real
 * row — its lifecycle is its own (Q2) — but while the design question is open it
 * is CARRIED by that press, not asked beside it. Q4: *"not a second question."*
 *
 * So a queue lists the primary only. Listing both put the card on To approve
 * twice, counted it twice, and offered the merge row as a press of its own —
 * which merges the commits and leaves the design question awaiting, the exact
 * outcome MOTIR-5667 re-shaped the item page's frame to prevent.
 *
 * ⚠️ IN THE PREDICATE, NEVER AFTER THE READ — the list, its count, the home
 * count and the room all call a builder that spreads this, so none of them can
 * disagree, and a page is never shortened by a post-read filter. When the design
 * is decided the merge gate stops being carried and appears alone (Q2), with no
 * change here.
 */
const CARRIED_MERGE_GATE_EXCLUDED = {
  NOT: {
    kind: 'pull_request_approval',
    workItem: {
      approvalGates: {
        // EVERY primary carries the merge, so the merge gate beside an open one is not a
        // second question: the design gate (MOTIR-5712), the DECISION gate (Story
        // MOTIR-4907 · MOTIR-5677; §8's FIFTH AMENDMENT, clause 5) and a story's
        // ACCEPTANCE gate (MOTIR-5789; §1's MOTIR-5787 amendment, point 2).
        some: {
          kind: { in: ['design_result', 'decision_approval', 'acceptance_result'] },
          state: 'awaiting',
        },
      },
    },
  },
} as const satisfies Prisma.ApprovalGateWhereInput;

/**
 * The decision-waiting marker's predicate (MOTIR-5876): every `awaiting` gate on
 * the given work items, less the merge gate a primary carries. No routing term —
 * the marker's `others` state is exactly the rows a routing term would drop.
 */
function awaitingOnItemsWhere(
  workItemIds: string[],
  projectIds: string[],
): Prisma.ApprovalGateWhereInput {
  return {
    projectId: { in: projectIds },
    workItemId: { in: workItemIds },
    state: 'awaiting',
    ...CARRIED_MERGE_GATE_EXCLUDED,
  };
}

/**
 * What the marker reads off each gate: which card, which kind, when, and the two
 * columns §2's routing rule is computed from. Nothing else — a marker draws no
 * subject and names nobody by itself.
 */
const AWAITING_ON_ITEM_SELECT = {
  id: true,
  workItemId: true,
  kind: true,
  createdAt: true,
  workItem: { select: { assigneeId: true, reporterId: true } },
} as const satisfies Prisma.ApprovalGateSelect;

/** One row of {@link approvalGateRepository.findAwaitingOnItems}, as Prisma returns it. */
export type AwaitingOnItemRow = Prisma.ApprovalGateGetPayload<{
  select: typeof AWAITING_ON_ITEM_SELECT;
}>;

/**
 * WHAT the Approvals room's read may see (MOTIR-5301).
 *
 * `projectIds` carries the ACCESS floor in, exactly as {@link AwaitingRoutingScope}
 * does: `[]` for a reader who may not browse their active project, and the query
 * returns nothing. `fullView` carries the SERVICE's answer to *does this reader
 * hold `approval:view_any`* — decided there from `projectAccessService.getPermissions`
 * and never by a caller, which is why this type is built only by the service.
 */
export interface ApprovalRecordsScope extends AwaitingRoutingScope {
  fullView: boolean;
  /**
   * A Visitor's WITHHOLDING (Story MOTIR-6170 · MOTIR-6645): a record on a
   * private epic's descendant, and a card-less `plan_approval` record whose plan
   * is withheld, are in neither section and in no count. Absent ⇒ no clause.
   */
  withheld?: { workItemIds: readonly string[]; planIds: readonly string[] };
}

/** The withholding clause of {@link ApprovalRecordsScope.withheld}, or `{}`. */
function recordsWithheldWhere(scope: ApprovalRecordsScope): Prisma.ApprovalGateWhereInput {
  const w = scope.withheld;
  if (!w || (w.workItemIds.length === 0 && w.planIds.length === 0)) return {};
  // Under `AND`, never a top-level `NOT`: the awaiting predicate already carries
  // one (`CARRIED_MERGE_GATE_EXCLUDED`), and a spread would silently replace it.
  // ⚠️ NULL-SAFE ON PURPOSE: a card-less gate has `work_item_id IS NULL`, and
  // `NOT (work_item_id IN (…))` is NULL for it — which would drop EVERY plan gate.
  return {
    AND: [
      ...(w.workItemIds.length > 0
        ? [{ OR: [{ workItemId: null }, { workItemId: { notIn: [...w.workItemIds] } }] }]
        : []),
      ...(w.planIds.length > 0
        ? [{ NOT: { kind: 'plan_approval' as const, subjectId: { in: [...w.planIds] } } }]
        : []),
    ],
  };
}

/**
 * The room's PENDING predicate, written once. Without the key it IS §2's routing
 * predicate — CALLED, never restated, so the room's first section and the
 * Workbench tab cannot disagree about whose gate it is. With the key it is every
 * `awaiting` gate of the project.
 */
function recordsAwaitingWhere(scope: ApprovalRecordsScope): Prisma.ApprovalGateWhereInput {
  if (!scope.fullView) return awaitingRoutedToWhere(scope);
  return {
    projectId: { in: scope.projectIds },
    state: 'awaiting',
    ...CARRIED_MERGE_GATE_EXCLUDED,
    // Under `AND`: the withholding clause is itself an `AND`, and a spread of both would
    // silently replace one with the other.
    AND: [planningSessionLiveWhere(scope), recordsWithheldWhere(scope)],
  };
}

/**
 * The room's DECIDED predicate, written once. The two decision states only; without
 * the key, only the ones this reader decided — `decidedById` records who actually
 * pressed, whatever authority they held, so this arm needs no routing rule.
 */
function recordsDecidedWhere(scope: ApprovalRecordsScope): Prisma.ApprovalGateWhereInput {
  return {
    projectId: { in: scope.projectIds },
    // An OVERTURN is a decision a person made (MOTIR-5956) — the room lists it. So is a
    // plan a person DECLINED (MOTIR-6037; design Part XXII §22.3, Panel 3).
    state: { in: ['approved', 'changes_requested', 'overturned', 'declined'] },
    ...(scope.fullView ? {} : { decidedById: scope.userId }),
    ...recordsWithheldWhere(scope),
  };
}

/**
 * What ONE queue row reads off the gate and its card — the projection the
 * Approvals tab is built on.
 *
 * Narrow on purpose: a queue row is not the gate DTO. The audit set (§6a) is
 * null on every row this read returns, because every row is `awaiting`, so
 * selecting it would be six columns of guaranteed nulls travelling to a surface
 * that cannot render them.
 */
const AWAITING_GATE_SELECT = {
  id: true,
  kind: true,
  state: true,
  subjectId: true,
  createdAt: true,
  // The CARD-LESS row's recipient (MOTIR-6034; ADR §11.6) — a gate with no work item
  // names its *waiting on* from the column written at creation, since there is no
  // `assigneeId ?? reporterId` to read. A card row still names it from the card.
  routedToId: true,
  // NULL on a card-less (`plan_approval`) row: what it is about is `subjectId`.
  workItem: {
    // ⚠️ `assigneeId` / `reporterId` are here for the ROW's *waiting on* line
    // (MOTIR-5191), not for the predicate — `awaitingRoutedToWhere` selects on
    // them in SQL and never returns them. Reading them back lets the service
    // name the recipient from the ROW rather than from the fact that the
    // predicate pinned it to the reader; the two agree today, and a surface
    // that depended on them agreeing would start lying silently the day §2's
    // routing widened.
    select: {
      id: true,
      key: true,
      identifier: true,
      title: true,
      kind: true,
      type: true,
      assigneeId: true,
      reporterId: true,
    },
  },
} as const satisfies Prisma.ApprovalGateSelect;

/**
 * What ONE Approvals-room row reads — the queue row's projection plus the AUDIT
 * fields a record renders (MOTIR-5301): WHEN it was decided, by WHOM as recorded at
 * the decision (`decidedByLabel`, which survives the user's deletion where the FK
 * does not), and ON WHICH BYTES (`subjectVersion`). A decided row that does not say
 * which version was approved is a list entry, not a record.
 */
const RECORD_GATE_SELECT = {
  ...AWAITING_GATE_SELECT,
  decidedAt: true,
  // The decider's id — a Visitor's read names them from the user row, never the
  // stored `Name <email>` label (MOTIR-6646).
  decidedById: true,
  decidedByLabel: true,
  // The room's person cell says WHERE a decision was made as well as who
  // (MOTIR-5599) — the two are one question in a 144px cell.
  decisionSource: true,
  // A refusal's REASON (MOTIR-6075) — the mapper keeps it on `changes_requested` only.
  noteMd: true,
  subjectVersion: true,
  // What a CHOICE picked (MOTIR-5897) — a decided choice row names it.
  chosenOption: true,
  // What a CONFIRMED decision's record was (MOTIR-5961) — its row says with or without.
  confirmedRecord: true,
  // What a design REFUSAL meant (MOTIR-6421) — the mapper keeps it on `changes_requested`.
  refusalVerdict: true,
} as const satisfies Prisma.ApprovalGateSelect;

/** One row of the Approvals room's read, as Prisma returns it. */
export type RecordGateRow = Prisma.ApprovalGateGetPayload<{
  select: typeof RECORD_GATE_SELECT;
}>;

/** One row of the routing read, as Prisma returns it. */
export type AwaitingGateRow = Prisma.ApprovalGateGetPayload<{
  select: typeof AWAITING_GATE_SELECT;
}>;

const PERSON_SELECT = { id: true, name: true, email: true } as const;

/**
 * The run surfaces' read of a leg's gate (MOTIR-7477): its state, the card's
 * live routing (§2's `assigneeId ?? reporterId`, with the people to name) and who
 * decided it.
 */
const GATE_WITH_PEOPLE_SELECT = {
  id: true,
  workItemId: true,
  state: true,
  decidedByLabel: true,
  decidedBy: { select: PERSON_SELECT },
  workItem: {
    select: {
      assigneeId: true,
      reporterId: true,
      assignee: { select: PERSON_SELECT },
      reporter: { select: PERSON_SELECT },
    },
  },
} as const satisfies Prisma.ApprovalGateSelect;

/** One row of {@link approvalGateRepository.findLatestWithPeopleByWorkItems}. */
export type GateWithPeople = Prisma.ApprovalGateGetPayload<{
  select: typeof GATE_WITH_PEOPLE_SELECT;
}>;

/**
 * Translate an `approval_gate` WRITE-path error into one of this domain's typed
 * errors, so no raw Prisma / Postgres failure escapes the repository edge (the
 * concurrency rule in CLAUDE.md). Anything it does not recognise is rethrown
 * UNCHANGED. **Always throws — the return type is `never`**, which is what lets a
 * `catch` block end in a bare call to it and still satisfy the method's return
 * type.
 *
 * BOTH writes on this table route their `catch` through here — `create` and
 * `decide` — and that is the invariant to preserve when a third is added. Two
 * failures, and they arrive in DIFFERENT shapes, which is the whole reason this
 * is one function rather than a check copied into each caller:
 *
 * | failure | how it arrives | typed as |
 * | --- | --- | --- |
 * | a second `awaiting` gate for one `(workItem, kind, subject)` | Prisma `P2002` on the partial unique index | `ApprovalGateAlreadyAwaitingError` |
 * | an UPDATE of an already-DECIDED row | the `trg_approval_gate_decided_immutable` trigger, via the pg adapter: SQLSTATE `23514` + the `AG_DECIDED_IMMUTABLE` marker in the message | `ApprovalGateDecidedImmutableError` |
 *
 * The marker is checked FIRST and the SQLSTATE only CONFIRMS it, mirroring
 * `workItemLinkRepository.translateWriteError`: the marker is a unique string we
 * control, while `23514` is the generic `check_violation` class that any future
 * CHECK constraint on this table would also raise. Either signal alone is
 * accepted, because a driver upgrade can drop `cause` without changing the
 * message.
 *
 * EXPORTED so a test can assert the pair the guard actually consists of — the
 * database refusing, and the refusal arriving typed — without either half
 * standing in for the other. Asserting only the typed error would keep passing if
 * the trigger were dropped and something else started raising `23514`; asserting
 * only the raw refusal would not prove it ever reaches a caller as a domain
 * error.
 */
export function translateApprovalGateWriteError(err: unknown): never {
  const message = extractMessage(err);

  // ⚠️ The CARD-OR-NO-CARD CHECK (MOTIR-6032, ADR §11.1) raises the same SQLSTATE
  // 23514 as the immutability trigger. It is a DEFECT in the writer (a card-less row
  // of a card kind, or a plan gate given a card), never "already decided", so it is
  // rethrown as it stands — the message names the constraint.
  if (message.includes('approval_gate_work_item_iff_not_plan')) throw err;

  if (message.includes('AG_DECIDED_IMMUTABLE') || sqlStateOf(err) === '23514') {
    throw new ApprovalGateDecidedImmutableError();
  }

  // Defensive: an `approval_gate` write fails either on the partial unique
  // (P2002) or on the immutability trigger, and both are handled above — so the
  // else arm below is unreachable through every shipped caller. The invariant is
  // pinned by `tests/approval-gate-coverage-floor.test.ts` § 'the repository
  // translates the write failures it OWNS'.
  //
  // ⚠️ This was `/* istanbul ignore else */`, which the **v8** provider this repo
  // configures does not read — so it suppressed nothing and the arm was counted
  // as uncovered. A directive that does not suppress is worse than none: it
  // tells a reader the arm has been dispositioned while the number disagrees.
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new ApprovalGateAlreadyAwaitingError();
  }

  // Defensive rethrow: an unrecognised write failure is not this domain's to
  // name. Same disposition, and same re-spelling, as the arm above.
  /* v8 ignore next */
  throw err;
}

/** SQLSTATE from a pg driver-adapter error's `cause`, if present. */

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  // Defensive: `approval_gate` write errors are always `Error` instances, so
  // both arms below guard a non-Error throw no shipped path produces. Same
  // re-spelling as the arms above — `istanbul ignore` is inert under v8.
  /* v8 ignore next 3 */
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  /* v8 ignore next */
  return '';
}
