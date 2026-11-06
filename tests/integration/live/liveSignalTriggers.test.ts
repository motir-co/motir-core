import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { db } from '@/lib/db';
import { LIVE_SIGNAL_CHANNEL, parseLiveNotification } from '@/lib/live/liveNotification';
import { LIVE_SIGNAL_TABLES } from '@/lib/live/liveSignalTables';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createTestProject } from '../../fixtures/projectFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { currentWorkerAdminUrl } from '../../helpers/parallelDb';
import { LIVE_READING_METHODS, tablesReadBy, uncoveredReads } from './watermarkInputTables';

// The live-signal triggers (Story MOTIR-8542 · Subtask MOTIR-8727), against the
// worker's real Postgres. Every write is RAW SQL committed outside any service,
// because "every writer is heard" is the property the triggers exist for. The
// writer is the OWNER connection (fixtures' credentials), so RLS does not stand
// between the test and the row it writes.
//
// Exactness without sleeping: after each write the writer NOTIFYs a sentinel.
// Postgres delivers notifications in commit order, so everything the listener
// received before the sentinel is exactly what that write emitted.

const DB_TEST_TIMEOUT_MS = 60_000;

let listener: Client;
let writer: Client;
let received: string[] = [];
let sentinelSeq = 0;
let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  listener = new Client({ connectionString: currentWorkerAdminUrl() });
  writer = new Client({ connectionString: currentWorkerAdminUrl() });
  await Promise.all([listener.connect(), writer.connect()]);
  // The pull request a delivery links and a GitHub review hangs off (Bug MOTIR-10504).
  // Neither `github_installation`, `github_repo` nor `github_pull_request` is heard, so
  // this set-up emits nothing into the case below.
  await writer.query(
    `INSERT INTO "github_installation" ("id","installation_id","workspace_id","account_login","account_type","updated_at")
     VALUES ('gi-ls-1','inst-ls-1',$1,'moooon','Organization',now())`,
    [fx.workspaceId],
  );
  await writer.query(
    `INSERT INTO "github_repo" ("id","installation_id","workspace_id","organization_id","repo_id","owner","name","default_branch","updated_at")
     SELECT 'gr-ls-1','gi-ls-1',w."id",w."organizationId",'9001','moooon','acme','main',now()
       FROM "workspace" w WHERE w."id" = $1`,
    [fx.workspaceId],
  );
  await writer.query(
    `INSERT INTO "github_pull_request" ("id","repo_id","number","state","head_ref","updated_at")
     VALUES ('gpr-ls-1','gr-ls-1',1,'open','subtask/PROD-9001',now())`,
  );
  received = [];
  listener.on('notification', (msg) => {
    if (msg.channel === LIVE_SIGNAL_CHANNEL) received.push(msg.payload ?? '');
  });
  await listener.query(`LISTEN ${LIVE_SIGNAL_CHANNEL}`);
});

afterEach(async () => {
  await Promise.allSettled([listener.end(), writer.end()]);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Run `write` (committed), then answer the raw payloads it emitted — and only those. */
async function emittedBy(write: () => Promise<unknown>): Promise<string[]> {
  received = [];
  await write();
  const sentinel = `{"sentinel":${++sentinelSeq}}`;
  await writer.query('SELECT pg_notify($1, $2)', [LIVE_SIGNAL_CHANNEL, sentinel]);
  for (let i = 0; i < 500 && !received.includes(sentinel); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const at = received.indexOf(sentinel);
  if (at === -1) throw new Error('the sentinel never arrived');
  // Postgres spaces `json_build_object`'s text; compare the JSON, not the spacing.
  return received.slice(0, at).map((raw) => JSON.stringify(JSON.parse(raw)));
}

const sql =
  (text: string, values: unknown[] = []) =>
  () =>
    writer.query(text, values);

function signal(workspaceId: string, projectId: string | null, planId: string | null) {
  return JSON.stringify({ w: workspaceId, p: projectId, plan: planId });
}

/** One row of each covered table, inserted in dependency order. */
function rowSpecs(f: WorkItemFixture) {
  const w = f.workspaceId;
  const p = f.projectId;
  return [
    {
      table: 'work_item',
      id: 'wi-ls-1',
      insert: sql(
        `INSERT INTO "work_item" ("id","workspaceId","projectId","kind","key","identifier","title","reporterId","position","updatedAt")
         VALUES ('wi-ls-1',$1,$2,'task',9001,'PROD-9001','Live signal row',$3,'a0',now())`,
        [w, p, f.ownerId],
      ),
      expected: signal(w, p, null),
    },
    {
      table: 'watcher',
      id: 'wt-ls-1',
      insert: sql(
        `INSERT INTO "watcher" ("id","work_item_id","user_id") VALUES ('wt-ls-1','wi-ls-1',$1)`,
        [f.ownerId],
      ),
      expected: signal(w, p, null),
    },
    {
      table: 'plan_change_session',
      id: 'pcs-ls-1',
      insert: sql(
        `INSERT INTO "plan_change_session" ("id","workspace_id","project_id","updated_at") VALUES ('pcs-ls-1',$1,$2,now())`,
        [w, p],
      ),
      expected: signal(w, p, null),
    },
    {
      table: 'plan',
      id: 'pl-ls-1',
      insert: sql(
        `INSERT INTO "plan" ("id","workspace_id","project_id") VALUES ('pl-ls-1',$1,$2)`,
        [w, p],
      ),
      expected: signal(w, p, 'pl-ls-1'),
    },
    {
      table: 'approval_gate',
      id: 'ag-ls-1',
      insert: sql(
        `INSERT INTO "approval_gate" ("id","workspace_id","project_id","kind","subject_id","updated_at")
         VALUES ('ag-ls-1',$1,$2,'plan_approval','pl-ls-1',now())`,
        [w, p],
      ),
      expected: signal(w, p, 'pl-ls-1'),
    },
    // The review rows behind a To approve row's review line (Bug MOTIR-10504).
    {
      table: 'review_verdict_record',
      id: 'rvr-ls-1',
      insert: sql(
        `INSERT INTO "review_verdict_record" ("id","workspace_id","project_id","work_item_id","subject_version","verdict","outcome","harness","model")
         VALUES ('rvr-ls-1',$1,$2,'wi-ls-1','moooon/acme#1@sha-a','changes_requested','recorded','Claude Code','claude-opus-5-5')`,
        [w, p],
      ),
      expected: signal(w, p, null),
    },
    {
      table: 'review_dismissal',
      id: 'rd-ls-1',
      insert: sql(
        `INSERT INTO "review_dismissal" ("id","workspace_id","project_id","work_item_id","review_verdict_record_id","subject_version","reason_md")
         VALUES ('rd-ls-1',$1,$2,'wi-ls-1','rvr-ls-1','moooon/acme#1@sha-a','Reviewed by hand.')`,
        [w, p],
      ),
      expected: signal(w, p, null),
    },
    {
      table: 'work_item_delivery',
      id: 'wid-ls-1',
      insert: sql(
        `INSERT INTO "work_item_delivery" ("id","workspace_id","work_item_id","github_pull_request_id","repo_id")
         VALUES ('wid-ls-1',$1,'wi-ls-1','gpr-ls-1','gr-ls-1')`,
        [w],
      ),
      expected: signal(w, p, null),
    },
    {
      table: 'github_pull_request_review',
      id: 'gprr-ls-1',
      insert: sql(
        `INSERT INTO "github_pull_request_review" ("id","github_review_id","github_pull_request_id","reviewer_github_user_id","reviewer_login","reviewer_type","state","commit_sha","reviewer_permission","submitted_at","updated_at")
         VALUES ('gprr-ls-1','9001','gpr-ls-1','77','octo','User','approved','sha-a','write',now(),now())`,
      ),
      expected: signal(w, p, null),
    },
    {
      table: 'plan_item',
      id: 'pi-ls-1',
      insert: sql(
        `INSERT INTO "plan_item" ("id","workspace_id","plan_id","op") VALUES ('pi-ls-1',$1,'pl-ls-1','add')`,
        [w],
      ),
      expected: signal(w, p, 'pl-ls-1'),
    },
    {
      table: 'plan_revision',
      id: 'pr-ls-1',
      insert: sql(
        `INSERT INTO "plan_revision" ("id","plan_id","change_kind","diff") VALUES ('pr-ls-1','pl-ls-1','edit','{}'::jsonb)`,
      ),
      expected: signal(w, p, 'pl-ls-1'),
    },
    {
      table: 'plan_step',
      id: 'ps-ls-1',
      insert: sql(
        `INSERT INTO "plan_step" ("id","plan_id","session_key","kind","started_at") VALUES ('ps-ls-1','pl-ls-1','s1','lay',now())`,
      ),
      expected: signal(w, p, 'pl-ls-1'),
    },
    {
      table: 'plan_narration',
      id: 'pn-ls-1',
      insert: sql(
        `INSERT INTO "plan_narration" ("id","plan_id","session_key","seq","body") VALUES ('pn-ls-1','pl-ls-1','s1',1,'Laying the plan')`,
      ),
      expected: signal(w, p, 'pl-ls-1'),
    },
    {
      table: 'plan_narration_session',
      id: 'pns-ls-1',
      insert: sql(
        `INSERT INTO "plan_narration_session" ("id","plan_id","session_key","step_kind","updated_at") VALUES ('pns-ls-1','pl-ls-1','s1','lay',now())`,
      ),
      expected: signal(w, p, 'pl-ls-1'),
    },
  ];
}

describe('live-signal triggers', () => {
  it('cover exactly the tables in LIVE_SIGNAL_TABLES', async () => {
    const r = await writer.query<{ table: string; trigger: string }>(
      `SELECT c.relname AS "table", t.tgname AS "trigger"
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND t.tgname LIKE 'trg_live_signal_%'
        ORDER BY c.relname`,
    );
    const covered = Object.keys(LIVE_SIGNAL_TABLES).sort();
    expect(r.rows.map((row) => row.table)).toEqual(covered);
    for (const row of r.rows) expect(row.trigger).toBe(`trg_live_signal_${row.table}`);
  });

  it(
    'hear a raw INSERT, UPDATE and DELETE on every covered table, with the right ids',
    async () => {
      const specs = rowSpecs(fx);
      expect(specs.map((s) => s.table).sort()).toEqual(Object.keys(LIVE_SIGNAL_TABLES).sort());

      for (const spec of specs) {
        expect(await emittedBy(spec.insert), `${spec.table} INSERT`).toEqual([spec.expected]);
      }
      for (const spec of specs) {
        const update = sql(`UPDATE "${spec.table}" SET "id" = "id" WHERE "id" = $1`, [spec.id]);
        expect(await emittedBy(update), `${spec.table} UPDATE`).toEqual([spec.expected]);
      }
      for (const spec of [...specs].reverse()) {
        const del = sql(`DELETE FROM "${spec.table}" WHERE "id" = $1`, [spec.id]);
        expect(await emittedBy(del), `${spec.table} DELETE`).toEqual([spec.expected]);
      }
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'tell the plans of a session when the session moves — its turn count is part of their review version',
    async () => {
      const [wi, , pcs, plan] = rowSpecs(fx);
      for (const spec of [wi!, pcs!, plan!]) await emittedBy(spec.insert);
      await emittedBy(sql(`UPDATE "plan" SET "session_id" = 'pcs-ls-1' WHERE "id" = 'pl-ls-1'`));

      const out = await emittedBy(
        sql(
          `UPDATE "plan_change_session" SET "turn_count" = "turn_count" + 1 WHERE "id" = 'pcs-ls-1'`,
        ),
      );
      expect(out).toEqual([signal(fx.workspaceId, fx.projectId, 'pl-ls-1')]);
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'tell the project a work item LEFT, as well as the one it moved to',
    async () => {
      const other = await createTestProject({
        workspaceId: fx.workspaceId,
        actorUserId: fx.ownerId,
        identifier: 'OTHR',
      });
      await emittedBy(rowSpecs(fx)[0]!.insert);
      const out = await emittedBy(
        sql(`UPDATE "work_item" SET "projectId" = $1 WHERE "id" = 'wi-ls-1'`, [other.id]),
      );
      expect(out.sort()).toEqual(
        [signal(fx.workspaceId, other.id, null), signal(fx.workspaceId, fx.projectId, null)].sort(),
      );
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'tell every project whose card delivers a pull request about its GitHub review, and nobody when no card does',
    async () => {
      const specs = rowSpecs(fx);
      const byTable = (table: string) => specs.find((spec) => spec.table === table)!;
      await emittedBy(byTable('work_item').insert);

      // No card delivers the pull request yet: the review reaches no row, so it emits nothing…
      expect(await emittedBy(byTable('github_pull_request_review').insert)).toEqual([]);

      // …and the link that makes a row draw it is heard on its own.
      expect(await emittedBy(byTable('work_item_delivery').insert)).toEqual([
        signal(fx.workspaceId, fx.projectId, null),
      ]);

      // A second project's card delivers the same pull request: an edit of the review is
      // heard by both projects, once each.
      const other = await createTestProject({
        workspaceId: fx.workspaceId,
        actorUserId: fx.ownerId,
        identifier: 'REVW',
      });
      await emittedBy(
        sql(
          `INSERT INTO "work_item" ("id","workspaceId","projectId","kind","key","identifier","title","reporterId","position","updatedAt")
           VALUES ('wi-ls-2',$1,$2,'task',1,'REVW-1','Second delivery',$3,'a0',now())`,
          [fx.workspaceId, other.id, fx.ownerId],
        ),
      );
      await emittedBy(
        sql(
          `INSERT INTO "work_item_delivery" ("id","workspace_id","work_item_id","github_pull_request_id","repo_id")
           VALUES ('wid-ls-2',$1,'wi-ls-2','gpr-ls-1','gr-ls-1')`,
          [fx.workspaceId],
        ),
      );
      const edit = await emittedBy(
        sql(
          `UPDATE "github_pull_request_review" SET "state" = 'dismissed', "updated_at" = now() WHERE "id" = 'gprr-ls-1'`,
        ),
      );
      expect(edit.sort()).toEqual(
        [signal(fx.workspaceId, fx.projectId, null), signal(fx.workspaceId, other.id, null)].sort(),
      );

      // A card deleted with its deliveries still never breaks the write: the cascade's
      // delivery rows read no project and wake the workspace instead.
      const itemDelete = await emittedBy(sql(`DELETE FROM "work_item" WHERE "id" = 'wi-ls-2'`));
      expect(itemDelete).toContain(signal(fx.workspaceId, other.id, null));
      const left = await writer.query(
        `SELECT count(*)::int AS n FROM "work_item_delivery" WHERE "work_item_id" = 'wi-ls-2'`,
      );
      expect(left.rows[0].n).toBe(0);
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'carry ids only — a title change puts no title text in any payload',
    async () => {
      const all: string[] = [];
      const specs = rowSpecs(fx);
      for (const spec of specs) all.push(...(await emittedBy(spec.insert)));
      all.push(
        ...(await emittedBy(
          sql(
            `UPDATE "work_item" SET "title" = 'A very distinctive secret title' WHERE "id" = 'wi-ls-1'`,
          ),
        )),
      );
      expect(all.length).toBeGreaterThan(0);
      for (const raw of all) {
        expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual(['p', 'plan', 'w']);
        expect(raw).not.toContain('distinctive');
        expect(parseLiveNotification(raw)).not.toBeNull();
      }
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'signal nothing for a rolled-back write, and once for many rows of one project in one transaction',
    async () => {
      await emittedBy(rowSpecs(fx)[0]!.insert);

      const rolledBack = await emittedBy(async () => {
        await writer.query('BEGIN');
        await writer.query(`UPDATE "work_item" SET "title" = 'x' WHERE "id" = 'wi-ls-1'`);
        await writer.query('ROLLBACK');
      });
      expect(rolledBack).toEqual([]);

      const bulk = await emittedBy(async () => {
        await writer.query('BEGIN');
        await writer.query(
          `INSERT INTO "work_item" ("id","workspaceId","projectId","kind","key","identifier","title","reporterId","position","updatedAt")
           SELECT 'wi-bulk-' || g, $1, $2, 'task', 9100 + g, 'PROD-' || (9100 + g), 'Bulk ' || g, $3, 'a' || g, now()
             FROM generate_series(1, 60) AS g`,
          [fx.workspaceId, fx.projectId, fx.ownerId],
        );
        await writer.query(
          `UPDATE "work_item" SET "title" = "title" || '!' WHERE "id" LIKE 'wi-bulk-%'`,
        );
        await writer.query('COMMIT');
      });
      expect(bulk).toEqual([signal(fx.workspaceId, fx.projectId, null)]);
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'never break a write: a plan with children and a work item with watchers and gates delete cleanly',
    async () => {
      const specs = rowSpecs(fx);
      for (const spec of specs) await emittedBy(spec.insert);
      await writer.query(
        `INSERT INTO "approval_gate" ("id","workspace_id","project_id","work_item_id","kind","subject_id","updated_at")
         VALUES ('ag-ls-wi',$1,$2,'wi-ls-1','design_result','ev-1',now())`,
        [fx.workspaceId, fx.projectId],
      );

      const planDelete = await emittedBy(sql(`DELETE FROM "plan" WHERE "id" = 'pl-ls-1'`));
      expect(planDelete).toContain(signal(fx.workspaceId, fx.projectId, 'pl-ls-1'));
      const left = await writer.query(
        `SELECT count(*)::int AS n FROM "plan_item" WHERE "plan_id" = 'pl-ls-1'`,
      );
      expect(left.rows[0].n).toBe(0);

      const itemDelete = await emittedBy(sql(`DELETE FROM "work_item" WHERE "id" = 'wi-ls-1'`));
      expect(itemDelete).toContain(signal(fx.workspaceId, fx.projectId, null));
      const gates = await writer.query(
        `SELECT count(*)::int AS n FROM "approval_gate" WHERE "work_item_id" = 'wi-ls-1'`,
      );
      expect(gates.rows[0].n).toBe(0);
    },
    DB_TEST_TIMEOUT_MS,
  );
});

describe('the trigger set is derived from the live readings', () => {
  it('every table a live reading touches is covered or recorded as access-only', () => {
    const read = tablesReadBy(LIVE_READING_METHODS);
    // Every named method resolves — a renamed method must fail here, not pass silently.
    expect([...read.keys()].sort()).toEqual([...LIVE_READING_METHODS].sort());
    expect(uncoveredReads(LIVE_READING_METHODS)).toEqual([]);
  });

  it('names the table and the method when a reading touches an uncovered table', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'live-signal-scan-'));
    try {
      mkdirSync(path.join(root, 'prisma'));
      mkdirSync(path.join(root, 'lib', 'repositories'), { recursive: true });
      writeFileSync(
        path.join(root, 'prisma', 'schema.prisma'),
        `model WorkItem {\n  id String @id\n  @@map("work_item")\n}\n\nmodel Sprint {\n  id String @id\n  @@map("sprint")\n}\n`,
      );
      writeFileSync(
        path.join(root, 'lib', 'repositories', 'sprintRepository.ts'),
        `export const sprintRepository = {\n  async watermarkSprints(tx: any) {\n    return tx.sprint.findMany({});\n  },\n  async watermarkItems(tx: any) {\n    return tx.workItem.findMany({});\n  },\n};\n`,
      );
      expect(
        uncoveredReads(
          ['sprintRepository.watermarkSprints', 'sprintRepository.watermarkItems'],
          root,
        ),
      ).toEqual([{ method: 'sprintRepository.watermarkSprints', table: 'sprint' }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
