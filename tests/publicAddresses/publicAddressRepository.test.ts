import { Prisma, type ProjectAccessMode } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/lib/db';
import { HostnameTakenError } from '@/lib/publicAddresses/errors';
import { publicAddressRepository } from '@/lib/repositories/publicAddressRepository';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { projectAccessData, setProjectAccess } from '@/tests/helpers/projectAccess';

// The public-address store — Story MOTIR-3878 · Subtask MOTIR-4209.
//
// Three things are proved here, and each is a property nothing else in the tree
// can hold:
//
//   1. THE POLICIES EXIST AND HAVE THE SHAPE THE MIGRATION CLAIMS — read from
//      `pg_policies`, the CATALOG, never from the migration file. A migration is
//      a claim about the database; the catalog is the fact. (The same
//      distinction `tests/rls/policyArms.ts` opens with.)
//   2. THE PUBLIC ARM ADMITS AND REFUSES IN BOTH DIRECTIONS. ⚠️ The admit case
//      comes FIRST, because a policy that refuses everyone passes every denial
//      test ever written — that is the shape a security assertion hides in.
//   3. THE HOSTNAME RACE RESOLVES TO ONE WINNER, on two real connections. The
//      global unique index is the arbiter, so this is the one place the
//      P2002 → HostnameTakenError translation is exercised for real rather than
//      by constructing a fake error.

interface Tenant {
  ownerId: string;
  organizationId: string;
  workspaceId: string;
  projectId: string;
}

/** A workspace holding a PUBLIC project — the addresses here are readable. */
let host: Tenant;
/** A workspace whose only project is `limited` — its addresses must stay hidden. */
let neighbour: Tenant;

beforeEach(async () => {
  await truncateAuthTables();
  host = await seedTenant('host', 'HOST', 'public');
  neighbour = await seedTenant('nbr', 'NBR', 'members');
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ───────────────────────────────────────────────────────────────────────────

describe('the policies, read from the catalog', () => {
  it('carries both arms on public_address, with the commands the migration claims', async () => {
    const rows = await adminDb.$queryRaw<
      Array<{ policyname: string; cmd: string; qual: string | null; with_check: string | null }>
    >`
      SELECT policyname, cmd, qual, with_check
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'public_address'
      ORDER BY policyname
    `;
    const byName = new Map(rows.map((r) => [r.policyname, r]));

    // Exactly three, and the list is the point: an arm added later without a
    // test is the thing this assertion exists for — and it did its job. It read
    // TWO until MOTIR-4219 added the system arm (20260903020000), which the
    // cross-tenant certificate sweep needs to WRITE. Without that arm the sweep
    // read fine through the public arm and updated zero rows, silently.
    expect([...byName.keys()]).toEqual([
      'public_address_active_workspace',
      'public_address_public_read',
      'public_address_system',
    ]);

    // The tenancy gate governs every command, and carries a WITH CHECK — which
    // is what stops a row being inserted or moved into a foreign workspace.
    const tenancy = byName.get('public_address_active_workspace')!;
    expect(tenancy.cmd).toBe('ALL');
    expect(tenancy.qual).toContain('app.workspace_id');
    expect(tenancy.with_check).toContain('app.workspace_id');

    // ⚠️ The public arm is SELECT-ONLY, and that is the load-bearing half. As a
    // FOR ALL policy its USING would widen UPDATE and DELETE too, and DELETE has
    // no WITH CHECK to catch it — so an unbound caller could delete any address
    // pointing at a public project. Asserted on the catalog rather than trusted
    // from the migration text.
    const publicArm = byName.get('public_address_public_read')!;
    expect(publicArm.cmd).toBe('SELECT');
    expect(publicArm.with_check).toBeNull();

    // The system arm governs every command — the sweep reads AND writes — and
    // carries a WITH CHECK so it cannot be used to write a row into a state the
    // USING clause would not admit.
    const system = byName.get('public_address_system')!;
    expect(system.cmd).toBe('ALL');
    expect(system.qual).toContain('app.system_admin');
    expect(system.with_check).toContain('app.system_admin');
  });

  it('has RLS enabled AND forced', async () => {
    // FORCE is what subjects the table OWNER to the policies. Without it the
    // arms are inert for exactly the role migrations run as.
    const rows = await adminDb.$queryRaw<
      Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>
    >`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE relname = 'public_address'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.relrowsecurity).toBe(true);
    expect(rows[0]!.relforcerowsecurity).toBe(true);
  });
});

describe('the public read arm', () => {
  it("ADMITS a public project's custom domain with nothing bound", async () => {
    // The admit case first. This is the read `GET /api/public/hosts/{host}`
    // makes on every request, anonymously: no workspace, no user, no system flag.
    await seedCustomDomain(host, 'roadmap.acme.example');
    const rows = await asAppRole({}, (tx) => selectAddress(tx, 'roadmap.acme.example'));
    expect(rows).toHaveLength(1);
  });

  it('ADMITS a workspace subdomain when the workspace holds a public project', async () => {
    await seedSubdomain(host, 'acme.motir.example');
    const rows = await asAppRole({}, (tx) => selectAddress(tx, 'acme.motir.example'));
    expect(rows).toHaveLength(1);
  });

  it('REFUSES a custom domain whose project is not public', async () => {
    // The narrowing, and the whole reason the arm is a join rather than
    // `USING (true)`. A private project's domain must resolve to nothing for an
    // anonymous reader — including the fact that it exists.
    await seedCustomDomain(neighbour, 'roadmap.nbr.example');
    const rows = await asAppRole({}, (tx) => selectAddress(tx, 'roadmap.nbr.example'));
    expect(rows).toHaveLength(0);
  });

  it('REFUSES a subdomain of a workspace with no public project', async () => {
    await seedSubdomain(neighbour, 'nbr.motir.example');
    const rows = await asAppRole({}, (tx) => selectAddress(tx, 'nbr.motir.example'));
    expect(rows).toHaveLength(0);
  });

  it('follows the PROJECT: making it non-public hides its domain, and back', async () => {
    // The arm reads the project's live `access_mode`, so a project going private
    // takes its address out of the public set with no write to this table. Both
    // directions on the SAME row, so the only variable is the access mode.
    await seedCustomDomain(host, 'roadmap.acme.example');
    for (const mode of ['workspace', 'members'] as const) {
      await setProjectAccess(adminDb, host.projectId, mode);
      const hidden = await asAppRole({}, (tx) => selectAddress(tx, 'roadmap.acme.example'));
      expect(hidden, `accessMode=${mode} must hide the address`).toHaveLength(0);
    }
    await adminDb.project.update({
      where: { id: host.projectId },
      data: projectAccessData('public'),
    });
    const shown = await asAppRole({}, (tx) => selectAddress(tx, 'roadmap.acme.example'));
    expect(shown).toHaveLength(1);
  });

  it('does NOT let an unbound reader DELETE the address it can now read', async () => {
    // READ-ONLY is the whole claim, and it is the property the SELECT-only
    // policy buys. Asserted on the ROW, because "0 rows affected" is not an
    // error and would pass a statement-level assertion.
    await seedCustomDomain(host, 'roadmap.acme.example');
    await asAppRole(
      {},
      (tx) =>
        tx.$executeRaw`DELETE FROM "public_address" WHERE "hostname" = 'roadmap.acme.example'`,
    );
    const survivor = await adminDb.publicAddress.findUnique({
      where: { hostname: 'roadmap.acme.example' },
    });
    expect(survivor).not.toBeNull();
  });

  it('does NOT open for a BOUND tenant read — the arm is gated on an unset GUC', async () => {
    // The gate asks "is this the context-less public connection?". A bound
    // request that happens to be in a different workspace must still see
    // nothing, or the arm would be a cross-tenant read dressed as a public one.
    await seedCustomDomain(host, 'roadmap.acme.example');
    const rows = await asAppRole({ workspaceId: neighbour.workspaceId }, (tx) =>
      selectAddress(tx, 'roadmap.acme.example'),
    );
    expect(rows).toHaveLength(0);
  });
});

describe('the hostname race', () => {
  it('resolves two concurrent claims of one name to ONE winner and ONE typed error', async () => {
    // Two REAL connections, both inside their own transaction, both claiming the
    // same label. The global unique index is the arbiter — there is no
    // count-then-write to lose, which is why this needs no advisory lock.
    const hostname = 'contended.motir.example';
    const attempt = () =>
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.workspace_id', ${host.workspaceId}, true)`;
        return publicAddressRepository.createSubdomain(
          { workspaceId: host.workspaceId, hostname },
          tx,
        );
      });

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // ⚠️ The typed error, not a raw Prisma one. This is the assertion that
    // matters: a `P2002` escaping the repository would make every caller
    // re-implement the same string match against a Prisma error code.
    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(HostnameTakenError);
    expect((err as HostnameTakenError).code).toBe('HOSTNAME_TAKEN');
    expect((err as HostnameTakenError).hostname).toBe(hostname);

    // And exactly one row exists afterwards.
    const rows = await adminDb.publicAddress.findMany({ where: { hostname } });
    expect(rows).toHaveLength(1);
  });

  it('is GLOBAL — a second WORKSPACE cannot take a name the first holds', async () => {
    // The unique is on `hostname` alone, not `(workspace_id, hostname)`, because
    // a hostname resolves to one owner on the public internet. Two tenants
    // holding one name is an impossibility, not a tenancy question.
    await seedSubdomain(host, 'shared.motir.example');
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.workspace_id', ${neighbour.workspaceId}, true)`;
        return publicAddressRepository.createSubdomain(
          { workspaceId: neighbour.workspaceId, hostname: 'shared.motir.example' },
          tx,
        );
      }),
    ).rejects.toBeInstanceOf(HostnameTakenError);
  });

  it('holds a LEGACY alias row against re-claim until the cleanup removes it', async () => {
    // A rename no longer writes an alias (§8 Amendment 3, MOTIR-9507), but rows
    // written before it stay until the one-off cleanup (MOTIR-9520). Until then
    // the row keeps the name, and the index goes on refusing everyone —
    // including the workspace that used to hold it.
    await adminDb.publicAddress.create({
      data: {
        workspaceId: host.workspaceId,
        hostname: 'acme.motir.example',
        kind: 'workspace_subdomain_alias',
        status: 'alias',
      },
    });

    for (const claimant of [host, neighbour]) {
      await expect(
        db.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.workspace_id', ${claimant.workspaceId}, true)`;
          return publicAddressRepository.createSubdomain(
            { workspaceId: claimant.workspaceId, hostname: 'acme.motir.example' },
            tx,
          );
        }),
      ).rejects.toBeInstanceOf(HostnameTakenError);
    }
  });
});

describe('the primary FK', () => {
  it('falls back to the default rather than deleting the project when the address goes', async () => {
    // SET NULL, not CASCADE. "Remove this domain" must not delete the project it
    // served — which is the reading a cascade here would ship.
    const address = await seedCustomDomain(host, 'roadmap.acme.example');
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${host.workspaceId}, true)`;
      await publicAddressRepository.setPrimary(host.projectId, address.id, tx);
    });
    expect(
      (await adminDb.project.findUnique({ where: { id: host.projectId } }))?.primaryAddressId,
    ).toBe(address.id);

    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${host.workspaceId}, true)`;
      await publicAddressRepository.remove(address.id, tx);
    });

    const project = await adminDb.project.findUnique({ where: { id: host.projectId } });
    expect(project, 'the project must survive its address being removed').not.toBeNull();
    expect(project?.primaryAddressId).toBeNull();
  });
});

describe('the job sweep read', () => {
  it('puts a NEVER-CHECKED address first, not last', async () => {
    // `NULLS FIRST` on an ascending sort, and it is a decision rather than a
    // default: a row nobody has ever asked the platform about is the most urgent
    // one to ask about, and Postgres's own default for ASC is NULLS LAST.
    const never = await seedCustomDomain(host, 'never.acme.example', 'pending_certificate');
    const old = await seedCustomDomain(host, 'old.acme.example', 'pending_certificate');
    await adminDb.publicAddress.update({
      where: { id: old.id },
      data: { lastCheckedAt: new Date(Date.now() - 60_000) },
    });

    // Bound: the sweep is cross-tenant, so the job binds a system context for
    // it rather than reading unbound (where the public arm would silently
    // narrow it to public projects and return a plausible, wrong subset).
    const due = await db.$transaction((tx) =>
      publicAddressRepository.listByStatusOlderThan('pending_certificate', new Date(), 10, tx),
    );
    expect(due.map((a) => a.hostname)).toEqual(['never.acme.example', 'old.acme.example']);
    expect(due[0]!.id).toBe(never.id);
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function asAppRole<T>(
  ctx: { userId?: string; workspaceId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    // RLS is inert under the superuser (BYPASSRLS), so the role switch is what
    // makes every assertion above mean anything — and it makes them mean the
    // same thing whether or not TEST_DB_APP_ROLE is set.
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

function selectAddress(tx: Prisma.TransactionClient, hostname: string) {
  return tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "public_address" WHERE "hostname" = ${hostname}`;
}

function seedSubdomain(tenant: Tenant, hostname: string) {
  return adminDb.publicAddress.create({
    data: {
      workspaceId: tenant.workspaceId,
      hostname,
      kind: 'workspace_subdomain',
      status: 'active',
    },
  });
}

function seedCustomDomain(
  tenant: Tenant,
  hostname: string,
  status: 'unverified' | 'issued' | 'pending_certificate' = 'issued',
) {
  return adminDb.publicAddress.create({
    data: {
      workspaceId: tenant.workspaceId,
      projectId: tenant.projectId,
      hostname,
      kind: 'custom_domain',
      status,
      verificationToken: `motir-verify-${hostname}`,
    },
  });
}

async function seedTenant(
  tag: string,
  identifier: string,
  mode: ProjectAccessMode,
): Promise<Tenant> {
  const owner = await adminDb.user.create({
    data: { email: `${tag}-owner@example.com`, name: `${tag} owner` },
  });
  const organization = await adminDb.organization.create({
    data: { name: `Org ${tag}`, slug: `org-${tag}` },
  });
  await adminDb.organizationMembership.create({
    data: { organizationId: organization.id, userId: owner.id, role: 'owner' },
  });
  const workspace = await adminDb.workspace.create({
    data: { name: `Workspace ${tag}`, slug: `ws-${tag}`, organizationId: organization.id },
  });
  await adminDb.workspaceMembership.create({
    data: { userId: owner.id, workspaceId: workspace.id, workspaceRole: 'manager' },
  });
  const project = await adminDb.project.create({
    data: {
      workspaceId: workspace.id,
      name: `Project ${identifier}`,
      slug: identifier.toLowerCase(),
      identifier,
      ...projectAccessData(mode),
    },
  });
  return {
    ownerId: owner.id,
    organizationId: organization.id,
    workspaceId: workspace.id,
    projectId: project.id,
  };
}
