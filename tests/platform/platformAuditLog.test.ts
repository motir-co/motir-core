import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  PLATFORM_AUDIT_ACTIONS,
  PLATFORM_AUDIT_READ_ACTIONS,
  isPlatformAuditAction,
  reasonPolicyFor,
  reasonSatisfied,
} from '@/lib/platform/auditActions';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import { MissingAuditReasonError } from '@/lib/platform/errors';
import { platformAuditLogRepository } from '@/lib/repositories/platformAuditLogRepository';
import { assertReasonSatisfied, platformAuditService } from '@/lib/services/platformAuditService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `PlatformAuditLog` — the record, its write path, and the two properties that
// make it worth having (MOTIR-2896 · `docs/decisions/platform-staff-auth.md` §3).
//
// The ADR's load-bearing claim about this table is STRUCTURAL rather than
// procedural: *"a read that rolls back leaves no audit row, and a read that
// commits cannot exist without one."* That is a claim about a transaction, so
// it is tested by rolling one back — not by reading `withPlatformRead` and
// agreeing with it.

async function seedStaff(role: 'support' | 'operator' | 'superadmin' = 'support') {
  const user = await createTestUser({ email: `ops+${role}@moooon.net` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the write path', () => {
  it('persists actor, actor role, action, target and timestamp', async () => {
    const principal = await seedStaff('operator');
    const owner = await createTestUser({ email: 'owner@example.com' });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const organizationId = workspace.organizationId;

    const before = new Date();
    await platformAuditService.record(principal, {
      action: 'estate.read',
      targetKind: 'organization',
      targetId: organizationId,
      targetLabel: 'Acme',
      organizationId,
    });
    const after = new Date();

    const rows = await adminDb.platformAuditLog.findMany();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.actorUserId).toBe(principal.userId);
    expect(row.actorRole).toBe('operator');
    expect(row.action).toBe('estate.read');
    expect(row.targetKind).toBe('organization');
    expect(row.targetId).toBe(organizationId);
    expect(row.targetLabel).toBe('Acme');
    expect(row.organizationId).toBe(organizationId);
    expect(row.reason).toBeNull();
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(row.createdAt.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
  });

  it('snapshots the role AT THE TIME — a later revoke does not rewrite history', async () => {
    const principal = await seedStaff('superadmin');
    await platformAuditService.record(principal, {
      action: 'console.open',
      targetKind: 'platform',
    });

    await adminDb.user.update({ where: { id: principal.userId }, data: { platformRole: null } });

    const row = await adminDb.platformAuditLog.findFirstOrThrow();
    expect(row.actorRole).toBe('superadmin');
  });

  it('writes the audit row BEFORE the work, in the same transaction', async () => {
    // The ADR's structural claim, both directions. The work throws, so the
    // transaction rolls back, so the audit row that was already INSERTed goes
    // with it — auditing is the price of the transaction, not a step beside it.
    const principal = await seedStaff();

    await expect(
      withPlatformRead(principal, { action: 'estate.read', targetKind: 'platform' }, async () => {
        throw new Error('the read failed');
      }),
    ).rejects.toThrow('the read failed');

    expect(await adminDb.platformAuditLog.count()).toBe(0);

    // And the commit direction: the row is there, and it was visible to the
    // work itself, which is what "first statement inside" means.
    const seenInside = await withPlatformRead(
      principal,
      { action: 'estate.read', targetKind: 'platform' },
      (tx) => platformAuditLogRepository.listByActor(principal.userId, 10, tx),
    );
    expect(seenInside).toHaveLength(1);
    expect(await adminDb.platformAuditLog.count()).toBe(1);
  });

  it('reads back through the DTO, with an ISO timestamp', async () => {
    const principal = await seedStaff();
    await platformAuditService.record(principal, {
      action: 'console.open',
      targetKind: 'platform',
    });

    const rows = await platformAuditService.listByActor(principal, principal.userId);
    // Two: the recorded `console.open`, plus the `estate.read` that reading the
    // log is itself audited as. Reading the audit trail is a platform read.
    expect(rows.map((r) => r.action)).toContain('console.open');
    expect(rows[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(rows[0]!.actorRole).toBe('support');
  });
});

describe('append-only, as an application property', () => {
  it('the repository exposes create and reads and NO mutator', () => {
    // The database policy is `FOR ALL` because the four-verb totality guard
    // requires every verb to be covered — so what makes this table append-only
    // is exactly this surface. A future `update` / `delete` added here fails the
    // assertion rather than passing review.
    expect(Object.keys(platformAuditLogRepository).sort()).toEqual([
      // MOTIR-751's verifier reads — the per-batch walk and the "N after it" count.
      'countAfterSeq',
      'create',
      // MOTIR-751's append path: the head the next row chains to, read under
      // `lockChainHead`. A read, and an advisory lock that writes nothing.
      'findBySeq',
      'findChainHead',
      // MOTIR-6905's last-stop line on the tenant page's Fleet card (MOTIR-7320):
      // the newest `fleet.stop` on one target. A READ, added by the story and
      // missed here until its integration gate (MOTIR-7321) ran this file.
      'findLatestByTargetAndAction',
      'listByActor',
      'listByOrganization',
      // MOTIR-1167's target read — Panel 9's "Support actions" log. A READ, so
      // it belongs on this list rather than falsifying it. The assertion is
      // pinned TIGHT on purpose: a consumer adding a read extends it and says
      // so, which is the moment a `deleteMany` slipped in beside one would have
      // to be argued for rather than merged.
      'listByTarget',
      // MOTIR-712's starter library: who retired each entry on a page, why and
      // when — the retirements of a batch of keys, newest first. A READ.
      'listByTargetsAndAction',
      'listChainBatch',
      'lockChainHead',
      // MOTIR-751's audit-log search — a read.
      'search',
    ]);
  });
});

describe('the reason rule', () => {
  // ⚠️ THE POLICY PER ACTION IS THE ADR'S §7 ALLOCATION TABLE, ASSERTED AS A MAP.
  //
  // This case used to read *"every seeded action is a READ, so none requires a
  // reason"* — true of MOTIR-2896's build, and it stopped being true the moment
  // MOTIR-1167 added the day-1 writes, exactly as the sibling case below
  // predicted it would. A loop asserting one value over every member cannot say
  // anything once the members differ, so it is replaced by the allocation
  // itself: each action, its required degree of accountability, named. A new
  // verb added without a decided policy fails the exhaustiveness check below
  // rather than defaulting into whichever arm the loop happened to assert.
  const EXPECTED_POLICY = {
    'console.open': 'never',
    'estate.read': 'never',
    'health.read': 'never',
    'user.read': 'never',
    'user.password_reset_sent': 'required',
    'user.suspend': 'required',
    'user.unsuspend': 'required',
    // MOTIR-4565's org classification — the first members from outside Epic 10
    // and Story 8.5, and the first at the `superadmin` degree. Both `required`:
    // they change what an organization is BILLED, and ADR §7's table puts every
    // billing-affecting write there with a reason. The unset carries one for the
    // reason `user.unsuspend` does — the trail has to answer "why is this org
    // being billed again?" as readably as it answers why it stopped.
    'org.internal_billing_set': 'required',
    'org.internal_billing_unset': 'required',
    // The platform planning model per audience (Story MOTIR-7220 · MOTIR-7227) —
    // `superadmin` and `required`, like every billing-class row in ADR §7.
    'ai.planner_model.set': 'required',
    // The planning-model list (Story MOTIR-7521 · MOTIR-7524) — same degree.
    'ai.planner_model_list.add': 'required',
    'ai.planner_model_list.remove': 'required',
    // The hosted-run model list (Story MOTIR-7521 · MOTIR-7525).
    'ai.run_model_list.seed': 'required',
    'ai.run_model_list.add': 'required',
    'ai.run_model_list.remove': 'required',
    // The planning-lesson curate acts (Story MOTIR-1408 · MOTIR-1411) — each
    // changes what a planner is told, so each carries a reason.
    'ai.lesson.edit': 'required',
    'ai.lesson.enable': 'required',
    'ai.lesson.disable': 'required',
    'ai.lesson.promote': 'required',
    // The lesson-retirement window (MOTIR-1463) — superadmin, one platform rule.
    'ai.lesson.retention_set': 'required',
    // Story 10.3's credit & plan ops (MOTIR-747) — `superadmin`, `required`: they
    // change what an organization holds and is charged.
    'org.credit_grant': 'required',
    'org.credit_adjust': 'required',
    'org.plan_set': 'required',
    // MOTIR-748 — suspending and reactivating an organization are writes.
    'org.suspend': 'required',
    'org.reactivate': 'required',
    // MOTIR-750 — flipping a per-org kill-switch is a write.
    'org.kill_switch_off': 'required',
    'org.kill_switch_on': 'required',
    // MOTIR-749 — staff "View as" sessions. The START is a write whose reason the
    // operator types; the END and every mutating request inside a full-access
    // session are writes carrying the SESSION's reason (`inherited`); a page
    // opened inside a session is a read.
    'user.impersonation_start': 'required',
    'user.impersonation_end': 'inherited',
    'user.impersonation_view': 'never',
    'user.impersonation_action': 'inherited',
    // MOTIR-751 — reading the audit log, and verifying its chain, are platform
    // READS like any other: audited, reason-free.
    'audit.read': 'never',
    'audit.verify': 'never',
    // A platform admin's stop of one organisation's fleet (Story MOTIR-6905 ·
    // MOTIR-7317) — destructive and cross-tenant, so `superadmin` with a reason.
    'fleet.stop': 'required',
    // The fleet org CI setting (Story MOTIR-8699 · MOTIR-8714): moves another
    // org's CI onto the fleet, so `superadmin` with a reason, both directions.
    'fleet.org_ci.enable': 'required',
    'fleet.org_ci.disable': 'required',
    // The agent hoster's Fly↔AWS switch (MOTIR-9503): a flip says why.
    'fleet.agent_hosting.enable': 'required',
    'fleet.agent_hosting.disable': 'required',
    // `fleet-admin add-shard` / `refresh-limits` (Story MOTIR-8953 · MOTIR-8967):
    // a fleet account added or its quota re-read — writes, reason by the service.
    'fleet.shard.add': 'required',
    'fleet.shard.limits': 'required',
    // Its account controls (MOTIR-8972): ceiling, disable, enable — writes.
    'fleet.shard.ceiling': 'required',
    'fleet.shard.disable': 'required',
    'fleet.shard.enable': 'required',
    // One pool growth (Story MOTIR-9362 · MOTIR-9461), audited as Motir's system
    // account with a reason the growth pass writes.
    'fleet.pool.grow': 'required',
    // `fleet-admin request-quota` (MOTIR-9463): raises filed on fleet accounts.
    'fleet.shard.quota_request': 'required',
    // A Host organisation's capacity requests (MOTIR-9583): reading the list is a
    // read; linking and closing are writes that say why.
    'fleet.capacity_request.list': 'never',
    'fleet.capacity_request.link': 'required',
    'fleet.capacity_request.close': 'required',
    // The idea store (Story MOTIR-7662 · MOTIR-7671): retiring and deleting say
    // why an idea left the public list; the rest carry the caller's context.
    'idea.add': 'inherited',
    'idea.update': 'inherited',
    'idea.retire': 'required',
    'idea.delete': 'required',
    'idea.tag_add': 'inherited',
    'idea.tag_translate': 'inherited',
    'idea.research_run': 'inherited',
    // The capacity alert share (Story MOTIR-9539 · MOTIR-9609): a write whose
    // reason the service supplies when the screen gives none.
    'capacity.alert_share.set': 'inherited',
    // The capacity limits edit (Story MOTIR-9539 · MOTIR-9613): a gateway write
    // audited in core, with a default reason when the screen gives none.
    'capacity.limits.edit': 'inherited',
    // A dead letter replayed from /admin/jobs (Story MOTIR-9980 · MOTIR-9985):
    // the screen has no reason field, so the service writes its default.
    'jobs.dlq_replay': 'inherited',
    // The seed registry's curation (Story MOTIR-704 · MOTIR-710; decision
    // MOTIR-706 v2 §3.6): reading the promoted row is a read; promoting and
    // retiring are writes that say why.
    'seed_registry.promote_source_read': 'never',
    // The starter library's two console reads (MOTIR-712): estate-wide, no reason.
    'seed_registry.library_read': 'never',
    'seed_registry.promote_sources_read': 'never',
    'seed_registry.promote': 'required',
    'seed_registry.retire': 'required',
  } as const;

  it('every action carries the policy the ADR allocates it', () => {
    for (const action of Object.keys(PLATFORM_AUDIT_ACTIONS)) {
      const key = action as keyof typeof PLATFORM_AUDIT_ACTIONS;
      expect(EXPECTED_POLICY[key], `${action} has no decided reason policy`).toBeDefined();
      expect(reasonPolicyFor(key), action).toBe(EXPECTED_POLICY[key]);
    }
    // Both directions: an action retired from the vocabulary must not linger
    // here claiming to be governed.
    expect(Object.keys(PLATFORM_AUDIT_ACTIONS).sort()).toEqual(Object.keys(EXPECTED_POLICY).sort());
  });

  it('every READ is reason-free and every WRITE demands one', () => {
    // The property underneath the table above, stated so it survives the table
    // growing: the ADR's rule is *"REQUIRED for every write action, NULL for a
    // read"*. Since MOTIR-749 the kind is explicit, so this pins the two columns
    // together: a read is `never`, and a write is `required` or — inside a staff
    // session — `inherited` (the session's reason, still non-blank on the row).
    const READS = [
      'console.open',
      'estate.read',
      'health.read',
      'user.read',
      'user.impersonation_view',
      'audit.read',
      'audit.verify',
      // The platform admin's list of capacity requests (MOTIR-9583).
      'fleet.capacity_request.list',
      // The source row a starter promotion reads (MOTIR-710).
      'seed_registry.promote_source_read',
      // The starter library and the promote form's picker (MOTIR-712).
      'seed_registry.library_read',
      'seed_registry.promote_sources_read',
    ];
    for (const action of Object.keys(PLATFORM_AUDIT_ACTIONS)) {
      const key = action as keyof typeof PLATFORM_AUDIT_ACTIONS;
      if (READS.includes(action)) {
        expect(PLATFORM_AUDIT_ACTIONS[key].kind, action).toBe('read');
        expect(reasonPolicyFor(key), action).toBe('never');
      } else {
        expect(PLATFORM_AUDIT_ACTIONS[key].kind, action).toBe('write');
        expect(reasonPolicyFor(key), action).not.toBe('never');
      }
    }
    expect([...PLATFORM_AUDIT_READ_ACTIONS].sort()).toEqual([...READS].sort());
  });

  it('holds in both arms', () => {
    // Written by MOTIR-2896 when NO action carried `required`, so that the
    // rule's load-bearing half did not ship unexecuted. MOTIR-1167's three
    // writes are now the first callers to take that arm through the action
    // lookup, and the case stays as the direct test of the pure function.
    expect(reasonSatisfied('never', null)).toBe(true);
    expect(reasonSatisfied('never', 'anything')).toBe(true);
    expect(reasonSatisfied('required', 'customer asked us to')).toBe(true);
    expect(reasonSatisfied('required', null)).toBe(false);
    expect(reasonSatisfied('required', undefined)).toBe(false);
    expect(reasonSatisfied('required', '')).toBe(false);
    // A space is not a reason. The design puts it behind a confirm dialog
    // precisely so somebody has to type one.
    expect(reasonSatisfied('required', '   ')).toBe(false);
    // `inherited` (MOTIR-749) is held to the same bar — the service copies the
    // session's reason onto the row, and a blank one is still no reason.
    expect(reasonSatisfied('inherited', 'reproduce ticket #4507')).toBe(true);
    expect(reasonSatisfied('inherited', null)).toBe(false);
    expect(reasonSatisfied('inherited', '  ')).toBe(false);
  });

  it('a read passes the service check with no reason', () => {
    expect(() =>
      assertReasonSatisfied({ action: 'console.open', targetKind: 'platform' }),
    ).not.toThrow();
  });

  it('MissingAuditReasonError names the action it refused', () => {
    const err = new MissingAuditReasonError('account.suspend');
    expect(err.code).toBe('MISSING_AUDIT_REASON');
    expect(err.action).toBe('account.suspend');
    expect(err.message).toContain('account.suspend');
  });

  it('the vocabulary guard narrows a value read back out of the String column', () => {
    expect(isPlatformAuditAction('console.open')).toBe(true);
    expect(isPlatformAuditAction('account.suspend')).toBe(false);
    // Not a prototype probe: `Object.hasOwn`, not `in`.
    expect(isPlatformAuditAction('toString')).toBe(false);
  });
});

describe('row-level security', () => {
  it('ships ENABLE + FORCE and ONE policy covering all four verbs', async () => {
    const [table] = await adminDb.$queryRawUnsafe<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'platform_audit_log'`,
    );
    expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const policies = await adminDb.$queryRawUnsafe<{ policyname: string; cmd: string }[]>(
      `SELECT policyname, cmd FROM pg_policies WHERE tablename = 'platform_audit_log'`,
    );
    expect(policies).toEqual([{ policyname: 'platform_audit_log_platform_only', cmd: 'ALL' }]);
  });

  it('has NO tenant arm — no workspace, org or user GUC appears in the predicate', async () => {
    // The whole point of the table: a tenant request cannot read the operator
    // audit trail even by accident, and no `app.system_admin` arm hands it to
    // the job runtime either (ADR §3's three reasons).
    const [policy] = await adminDb.$queryRawUnsafe<{ qual: string; with_check: string }[]>(
      `SELECT qual, with_check FROM pg_policies WHERE tablename = 'platform_audit_log'`,
    );
    for (const clause of [policy!.qual, policy!.with_check]) {
      expect(clause).toContain('app.platform_staff');
      expect(clause).not.toContain('app.workspace_id');
      expect(clause).not.toContain('app.organization_id');
      expect(clause).not.toContain('app.project_id');
      expect(clause).not.toContain('app.system_admin');
    }
  });

  // Unconditional since MOTIR-2734 retired `TEST_DB_APP_ROLE`: `@/lib/db` is
  // always `motir_app`, so this is the only arm there is.
  it('refuses an UNBOUND reader under the non-bypass role', async () => {
    const principal = await seedStaff();
    await platformAuditService.record(principal, {
      action: 'console.open',
      targetKind: 'platform',
    });
    expect(await adminDb.platformAuditLog.count()).toBe(1);

    // `db` is the application client. Outside a platform context the GUC is
    // unset, the predicate is false, and the row is invisible — zero rows, no
    // error, which is why the repository requires `tx` rather than allowing the
    // singleton (`CLAUDE.md`'s read-method rule is deliberately tightened there).
    expect(await db.platformAuditLog.count()).toBe(0);
  });
});
