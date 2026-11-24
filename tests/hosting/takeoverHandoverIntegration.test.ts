import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AWS_MEMBER_ROLE_NAME,
  AWS_TENANT_DEPLOY_ROLE,
  HANDOVER_DEPLOY_ROLE,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import {
  TENANT_HANDOVER_STEPS,
  type TenantHandoverStep,
} from '@/lib/ciFleet/hostingTenantAccounts';
import { PRODUCTION_IMAGE_WORKFLOW } from '@/lib/hosting/productionEnablementNames';
import { ApplicationStopFailedError, RepositoryTakenOverError } from '@/lib/hosting/errors';
import { SharedTenantAccountError } from '@/lib/hosting/tenantHandoverErrors';
import { hostedApplicationGraceNotice } from '@/lib/jobs/definitions/hostedApplicationGraceNotice';
import * as certificateProviders from '@/lib/publicAddresses/providers';
import {
  hostedApplicationRepository,
  releasedSlugOf,
} from '@/lib/repositories/hostedApplicationRepository';
import { hostedApplicationGraceNotifier } from '@/lib/services/hostedApplicationGraceNotifier';
import { hostedApplicationHandoverService } from '@/lib/services/hostedApplicationHandoverService';
import { hostedApplicationService } from '@/lib/services/hostedApplicationService';
import { productionConfigRedeployService } from '@/lib/services/productionConfigRedeployService';
import { productionMergeReleaseService } from '@/lib/services/productionMergeReleaseService';
import { productionReleaseService } from '@/lib/services/productionReleaseService';
import { productionRollbackService } from '@/lib/services/productionRollbackService';
import { projectRepoTakeoverService } from '@/lib/services/projectRepoTakeoverService';
import { publicAddressesService } from '@/lib/services/publicAddressesService';
import { withSystemContext } from '@/lib/workspaces/context';
import {
  tenantAccountHandoverService as handover,
  type HandoverActor,
} from '@/lib/services/tenantAccountHandoverService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  ACCOUNT,
  GITHUB_OWNER,
  GITHUB_OWNER_ID,
  MANAGEMENT,
  OWNER_EMAIL,
  type HandoverFault,
} from '../helpers/tenantHandoverFixtures';
import {
  DAY,
  INSTALLATION,
  MOTIR_ORG,
  application,
  at,
  count,
  events,
  failOn,
  onCall,
  repoCalls,
  repository,
  rowsOf,
  runJob,
  seedOrganisationA,
  seedOrganisationB,
  setUpHandover,
  tearDownHandover,
  timeline,
  type HostedRepo,
  type OrganisationA,
} from './takeoverHandoverFixture';

// THE TAKEOVER HANDOVER, ASSEMBLED (Story MOTIR-9800 · MOTIR-12139).
//
// Each card of the story ships its own unit tests, and each stops at its own
// seam. This suite runs the merged cards together, over real Postgres, through
// their real services, repositories, job handlers and route handlers, with only
// the provider clients faked (see ./takeoverHandoverFixture.ts). It owns the
// properties that are RELATIONS between cards, and asserts every ordering on
// the one shared timeline, never from the end state:
//   * the AWS saga in order, a fault at every step and `retry` resuming there;
//   * the account never leaving before AWS's standalone steps; an abandoned
//     handover leaving production and Motir's access intact;
//   * §G of docs/decisions/ci-minutes-allowance.md — every call that needs
//     Motir's access to a repository before that repository's transfer;
//   * the serverless/Fly grace window, its four notices, and a stop cut off at
//     every step never deleting the database before its final export row;
//   * every deploy path answering `taken_over`; the addresses released;
//   * one organisation never reaching another's handover or applications.
// The one module mock is the session gate the routes call.

const { requireCompliantSession } = vi.hoisted(() => ({ requireCompliantSession: vi.fn() }));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantSession }));

const handoverRoute = await import('@/app/api/organizations/[orgId]/hosting/aws-handover/route');
const emailCodeRoute =
  await import('@/app/api/organizations/[orgId]/hosting/aws-handover/email-code/route');
const recheckRoute =
  await import('@/app/api/organizations/[orgId]/hosting/aws-handover/recheck/route');
const retryRoute = await import('@/app/api/organizations/[orgId]/hosting/aws-handover/retry/route');
const exportsRoute =
  await import('@/app/api/organizations/[orgId]/hosting/applications/[applicationId]/exports/route');
const downloadRoute =
  await import('@/app/api/organizations/[orgId]/hosting/applications/[applicationId]/exports/[exportId]/download/route');
const stopRoute =
  await import('@/app/api/organizations/[orgId]/hosting/applications/[applicationId]/stop/route');

let a: OrganisationA;
let admin: HandoverActor;

beforeEach(async () => {
  await setUpHandover();
  a = await seedOrganisationA();
  admin = { userId: a.people.ownerId, organizationId: a.world.organizationId };
  // The production configuration and the transfer go through the SHIPPED
  // services (GitHub faked at fetch, `transferRepo` on the timeline).
  a.fakes.deps.removeProductionConfig = undefined;
  a.fakes.deps.requestTakeover = undefined;
  // The address release's certificate provider withdraws nothing at a
  // handover; any call to it is on the timeline.
  vi.spyOn(certificateProviders, 'certificateProvider').mockResolvedValue({
    request: async () => {
      throw new Error('no certificate is requested at a handover');
    },
    check: async () => {
      throw new Error('no certificate is checked at a handover');
    },
    remove: async (hostname: string) => {
      timeline.log.push(`certificate:remove ${hostname}`);
    },
  });
  // The address release, on the timeline, calling through.
  const release = hostedApplicationHandoverService.releaseApplicationAddresses.bind(
    hostedApplicationHandoverService,
  );
  vi.spyOn(hostedApplicationHandoverService, 'releaseApplicationAddresses').mockImplementation(
    async (applicationId, tx) => {
      timeline.log.push(`release_addresses:${applicationId}`);
      return release(applicationId, tx);
    },
  );
});

afterEach(() => {
  tearDownHandover();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── The AWS saga's drivers ──────────────────────────────────────────────────

const tenantAccountId = () => a.world.tenantAccountId;
const account = () =>
  adminDb.hostingTenantAccount.findUniqueOrThrow({ where: { id: tenantAccountId() } });
const stepRows = () =>
  adminDb.hostingTenantHandoverStep.findMany({ where: { tenantAccountId: tenantAccountId() } });
const statusOf = async (step: TenantHandoverStep) =>
  (await stepRows()).find((r) => r.step === step)?.status;
const awsApps = () =>
  adminDb.hostedApplication.findMany({
    where: { id: { in: a.world.apps.map((x) => x.id) } },
  });
const stacks = () => [...a.fakes.clients.cloudformation.stacks.keys()].sort();

const start = () =>
  handover.start(
    a.world.organizationId,
    { ownerEmail: OWNER_EMAIL, githubOwner: GITHUB_OWNER },
    a.people.ownerId,
    a.fakes.deps,
  );

/** Drive the saga the way its job and the owner do — advance, answer the
 *  email code, confirm the standalone steps — until it ends, a step fails, or
 *  `stopAt` says to stop. A step's throw is the job's failure, read off the
 *  step row. */
async function drive(
  stopAt: (status: Awaited<ReturnType<typeof stepRows>>) => boolean = () => false,
  opts: { confirmStandalone?: boolean } = {},
): Promise<void> {
  const confirm = opts.confirmStandalone ?? true;
  for (let i = 0; i < 60; i += 1) {
    if ((await account()).state === 'handed_over') return;
    const rows = await stepRows();
    if (rows.some((r) => r.status === 'failed') || stopAt(rows)) return;
    const waiting = rows.find((r) => r.status === 'waiting_on_you');
    try {
      if (waiting?.step === 'move_email') {
        await handover.submitEmailCode(
          tenantAccountId(),
          a.fakes.organization.fakeEmailCode(ACCOUNT)!,
          admin,
          a.fakes.deps,
        );
      } else if (waiting && confirm) {
        await handover.recheckStandalone(tenantAccountId(), admin, a.fakes.deps);
      } else {
        await handover.advance(tenantAccountId(), a.fakes.deps);
      }
    } catch {
      // A failed step is recorded on its row; the loop reads it there.
    }
  }
}

/** The entry each step's own provider call writes, and how to fail it once. */
const shopName = () => a.world.repos[0]!.name;
const STEP_CALLS: [TenantHandoverStep, HandoverFault | 'transfer', () => string][] = [
  ['destroy_previews', 'destroyPreviewStacks', () => 'destroy_previews'],
  ['create_deploy_role', 'createHandoverDeployRole', () => 'create_deploy_role'],
  ['open_upstream', 'openUpstream', () => `open_upstream:mh-${a.world.repos[0]!.id}`],
  ['move_email', 'startPrimaryEmailUpdate', () => 'start_email_update'],
  ['await_standalone', 'readStandaloneReadiness', () => 'read_standalone'],
  ['remove_access', 'removeMotirAccess', () => 'remove_motir_access'],
  ['leave_organization', 'removeAccountFromOrganization', () => 'leave_organization'],
  ['transfer_repositories', 'transfer', () => `transfer:${shopName()}`],
];

/** The one-shot calls of each step: made once on a walk with no fault. */
const ONE_SHOT: Partial<Record<TenantHandoverStep, () => string[]>> = {
  destroy_previews: () => ['destroy_previews'],
  create_deploy_role: () => ['create_deploy_role'],
  open_upstream: () => a.world.repos.map((r) => `open_upstream:mh-${r.id}`),
  move_email: () => ['start_email_update'],
  remove_access: () => ['remove_motir_access'],
  leave_organization: () => ['leave_organization'],
  transfer_repositories: () => a.world.repos.map((r) => `transfer:${r.name}`),
};

describe('the AWS saga, end to end', () => {
  it('runs the eight steps in order and hands both applications and the account over', async () => {
    await start();
    await drive();
    const [shop, api] = a.world.repos;
    const order = [
      at('destroy_previews'),
      at('create_deploy_role'),
      at(`open_upstream:mh-${shop!.id}`),
      at(`open_upstream:mh-${api!.id}`),
      at('start_email_update'),
      at('read_standalone'),
      at('remove_motir_access'),
      at('leave_organization'),
      at(`transfer:${shop!.name}`),
      at(`transfer:${api!.name}`),
    ];
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(await account()).toMatchObject({ state: 'handed_over' });
    for (const app of await awsApps()) {
      const repoId = a.world.apps.find((x) => x.id === app.id)!.repoId;
      expect(app).toMatchObject({
        state: 'handed_over',
        handedOverAccountId: ACCOUNT,
        upstreamAddress: `https://mh-${repoId}.open.example`,
      });
    }
    const rows = await stepRows();
    expect(rows.map((r) => r.step).sort()).toEqual([...TENANT_HANDOVER_STEPS].sort());
    expect(rows.every((r) => r.status === 'done')).toBe(true);
  });

  it.each(STEP_CALLS)(
    'fails at %s, stops there, and retry resumes at that step repeating no earlier call',
    async (step, fault, entry) => {
      if (fault === 'transfer') failOn(`transfer:${shopName()}`);
      else a.fakes.faults.add(fault);
      await start();
      await drive();

      const index = TENANT_HANDOVER_STEPS.indexOf(step);
      for (const row of await stepRows()) {
        const i = TENANT_HANDOVER_STEPS.indexOf(row.step as TenantHandoverStep);
        expect(row.status, row.step).toBe(i < index ? 'done' : i === index ? 'failed' : 'pending');
      }
      const failedCalls = count(entry());
      expect(failedCalls).toBeGreaterThanOrEqual(1);
      const before = timeline.log.length;

      await handover.retry(tenantAccountId(), admin, a.fakes.deps);
      await drive();

      expect((await account()).state).toBe('handed_over');
      const after = timeline.log.slice(before);
      // The failed call is made again, exactly once more for a one-shot call.
      expect(after).toContain(entry());
      if (ONE_SHOT[step]) expect(count(entry())).toBe(failedCalls + 1);
      // No earlier step's call runs again.
      for (const earlier of TENANT_HANDOVER_STEPS.slice(0, index)) {
        for (const call of ONE_SHOT[earlier]?.() ?? []) {
          expect(after, `${call} repeated after retrying ${step}`).not.toContain(call);
        }
      }
    },
  );
});

describe('the account never leaves before AWS’s standalone steps', () => {
  const notReady = () => {
    const read = a.fakes.aws.management.readStandaloneReadiness;
    a.fakes.aws.management.readStandaloneReadiness = async (accountId) => {
      timeline.log.push('read_standalone');
      return {
        ...(await read.call(a.fakes.aws.management, accountId)),
        waitPeriod: { status: 'not_met', eligibleAt: new Date('2026-12-01T00:00:00Z') },
        ready: false,
      };
    };
    return () => {
      a.fakes.aws.management.readStandaloneReadiness = read;
    };
  };

  it('keeps await_standalone waiting while AWS answers not ready, removing nothing; once ready, remove_access precedes leave_organization', async () => {
    const restore = notReady();
    await start();
    await drive((rows) =>
      rows.some((r) => r.step === 'await_standalone' && r.status !== 'pending'),
    );
    for (let i = 0; i < 3; i += 1) await handover.advance(tenantAccountId(), a.fakes.deps);
    await handover.recheckStandalone(tenantAccountId(), admin, a.fakes.deps).catch(() => undefined);
    await handover.advance(tenantAccountId(), a.fakes.deps);

    expect(await statusOf('await_standalone')).toBe('waiting_on_you');
    expect(timeline.log).not.toContain('remove_motir_access');
    expect(timeline.log).not.toContain('leave_organization');

    restore();
    await drive();
    expect((await account()).state).toBe('handed_over');
    expect(at('remove_motir_access')).toBeLessThan(at('leave_organization'));
  });

  it('a handover abandoned at await_standalone leaves every production stack, Motir’s access and the addresses as they were', async () => {
    const member = () => JSON.stringify(a.fakes.clients.iamAccount.roles.get(AWS_MEMBER_ROLE_NAME));
    const deployRole = () =>
      JSON.stringify(a.fakes.clients.iamAccount.roles.get(AWS_TENANT_DEPLOY_ROLE));
    const memberBefore = member();
    const deployBefore = deployRole();
    const addressesBefore = (await awsApps()).map((app) => app.productionAddress);
    await start();
    await drive(
      (rows) => rows.some((r) => r.step === 'await_standalone' && r.status !== 'pending'),
      {
        confirmStandalone: false,
      },
    );
    expect(await statusOf('await_standalone')).toBe('waiting_on_you');

    for (const repo of a.world.repos) {
      expect(stacks()).toContain(`motir-release-mh-${repo.id}`);
      expect(stacks()).toContain(`motir-database-${repo.id}`);
    }
    expect(member()).toBe(memberBefore);
    expect(deployRole()).toBe(deployBefore);
    expect(deployBefore).not.toBe(undefined);
    const apps = await awsApps();
    expect(apps.every((app) => app.state === 'handing_over')).toBe(true);
    expect(apps.map((app) => app.productionAddress)).toEqual(addressesBefore);
    expect(timeline.log.some((e) => e.startsWith('release_addresses:'))).toBe(false);
  });

  it('destroy_previews deletes the preview release and its database only', async () => {
    const before = stacks();
    const shop = a.world.repos[0]!;
    const preview = [`motir-release-mh-${shop.id}-pr3`, `motir-database-${shop.id}-pr3`];
    expect(before).toEqual(expect.arrayContaining(preview));
    await start();
    await handover.advance(tenantAccountId(), a.fakes.deps);
    expect(await statusOf('destroy_previews')).toBe('done');
    expect(stacks()).toEqual(before.filter((name) => !preview.includes(name)));
  });

  it('creates the deploy role trusting only the handed-over repositories at the destination owner, and no Motir principal', async () => {
    await start();
    await drive((rows) => rows.some((r) => r.step === 'create_deploy_role' && r.status === 'done'));
    const role = a.fakes.clients.iamAccount.roles.get(HANDOVER_DEPLOY_ROLE)!;
    expect(role.trust.Statement).toHaveLength(1);
    const statement = role.trust.Statement[0]!;
    expect(statement.Principal).toEqual({
      Federated: `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`,
    });
    const subjects = (statement.Condition as { StringLike: Record<string, string[]> }).StringLike[
      'token.actions.githubusercontent.com:sub'
    ]!;
    // The merged trust binds GitHub's immutable ids, not `repo:<owner>/<name>`:
    // a renamed or re-created repository cannot claim it.
    expect([...subjects].sort()).toEqual(
      a.world.repos
        .map((r) => `repository_owner_id:${GITHUB_OWNER_ID}:repository_id:${r.githubRepoId}:*`)
        .sort(),
    );
    expect(JSON.stringify(role.trust)).not.toContain(MANAGEMENT);
  });
});

describe('a single-repository takeover on a shared AWS account', () => {
  it('is refused with TAKEOVER_SHARED_AWS_ACCOUNT naming the other repository, changing no row and calling no provider', async () => {
    const [shop, api] = a.world.repos;
    const before = await rowsOf(a.world.organizationId);
    const error = await projectRepoTakeoverService
      .requestTakeover(shop!.id, GITHUB_OWNER, a.fx.ctx)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SharedTenantAccountError);
    expect((error as SharedTenantAccountError).code).toBe('TAKEOVER_SHARED_AWS_ACCOUNT');
    expect((error as SharedTenantAccountError).repositories).toEqual([api!.name]);
    expect(await rowsOf(a.world.organizationId)).toEqual(before);
    expect(timeline.log).toEqual([]);
  });
});

// ── §G ──────────────────────────────────────────────────────────────────────

/** Every call that needs Motir's access to `name` precedes its transfer, and
 *  none follows it. */
function expectAccessBeforeTransfer(name: string, extra: string[] = []): void {
  const transfer = at(`transfer:${name}`);
  const calls = repoCalls(name);
  expect(calls.length, `GitHub calls on ${name}`).toBeGreaterThan(0);
  for (const { entry, index } of calls) expect(index, entry).toBeLessThan(transfer);
  for (const entry of extra) expect(at(entry), entry).toBeLessThan(transfer);
}

describe('§G — nothing needing Motir’s access to a repository runs after its transfer', () => {
  it('on the AWS path: production configuration, the Actions re-enable and the address release precede each transfer', async () => {
    await start();
    await drive();
    expect((await account()).state).toBe('handed_over');
    for (const repo of a.world.repos) {
      const app = a.world.apps.find((x) => x.repoId === repo.id)!;
      expectAccessBeforeTransfer(repo.name, [`release_addresses:${app.id}`]);
      expect(
        repoCalls(repo.name).some(({ entry }) => entry.includes('/environments/production')),
        `production environment of ${repo.name}`,
      ).toBe(true);
    }
  });

  it.each(['fly', 'serverless'] as const)(
    'on the %s path: the credential, environment and variables go before the transfer',
    async (target) => {
      const hosted = a[target];
      await projectRepoTakeoverService.requestTakeover(hosted.repoId, GITHUB_OWNER, a.fx.ctx);
      expectAccessBeforeTransfer(hosted.name, ['hosting:revokeDeployCredentials']);
      expect((await repository(hosted.repoId)).takeoverState).toBe('awaiting_reinstall');
    },
  );
});

// ── The serverless / Fly grace window ──────────────────────────────────────

const noticeEvents = async (applicationId: string) =>
  (
    await events<{ applicationId: string; kind: string }>('hosting.application-grace.notice')
  ).filter((e) => e.data.applicationId === applicationId);

/** Run the notice job for every notice queued, as the engine would. */
async function runNotices(): Promise<void> {
  for (const e of await events('hosting.application-grace.notice')) {
    await runJob(hostedApplicationGraceNotice, 'hosting.application-grace.notice', e.data);
  }
}

describe('the Fly takeover and its grace window', () => {
  it('freezes the application before the transfer, then opens grace 30 days from the transfer with one transferred notice', async () => {
    const fly = a.fly;
    let atTransfer: string | null = null;
    const { repoTransferClient } = await import('@/lib/github/repoTransfer');
    const real = vi.mocked(repoTransferClient.transferRepo).getMockImplementation()!;
    vi.mocked(repoTransferClient.transferRepo).mockImplementationOnce(async (input) => {
      atTransfer = (await application(fly.applicationId)).state;
      return real(input);
    });

    await projectRepoTakeoverService.requestTakeover(fly.repoId, GITHUB_OWNER, a.fx.ctx);

    expect(atTransfer).toBe('handing_over');
    const transfer = at(`transfer:${fly.name}`);
    expect(at('hosting:revokeDeployCredentials')).toBeLessThan(transfer);
    const deleted = repoCalls(fly.name).filter(({ entry }) => entry.startsWith('github:DELETE'));
    expect(deleted.map(({ entry }) => entry)).toEqual(
      expect.arrayContaining([
        `github:DELETE /repos/${MOTIR_ORG}/${fly.name}/environments/production`,
      ]),
    );
    expect(deleted.length).toBeGreaterThanOrEqual(3);
    for (const { index } of deleted) expect(index).toBeLessThan(transfer);

    const row = await repository(fly.repoId);
    const app = await application(fly.applicationId);
    expect(app.state).toBe('grace');
    expect(row.takeoverTransferredAt).toBeInstanceOf(Date);
    expect(app.stopsAt!.getTime()).toBe(row.takeoverTransferredAt!.getTime() + 30 * DAY);
    const notices = await noticeEvents(fly.applicationId);
    expect(notices.map((n) => n.data.kind)).toEqual(['transferred']);
  });

  it('a transfer that fails after the preparation starts no grace and puts the application back to live', async () => {
    const fly = a.fly;
    failOn(`transfer:${fly.name}`);
    await expect(
      projectRepoTakeoverService.requestTakeover(fly.repoId, GITHUB_OWNER, a.fx.ctx),
    ).rejects.toBeInstanceOf(Error);
    expect(at('hosting:revokeDeployCredentials')).toBeLessThan(at(`transfer:${fly.name}`));
    const app = await application(fly.applicationId);
    expect(app).toMatchObject({ state: 'live', stopsAt: null });
    expect((await repository(fly.repoId)).takeoverState).toBe('failed');
    expect(await noticeEvents(fly.applicationId)).toEqual([]);
  });
});

describe('the four grace notices', () => {
  it('sends transferred, seven_days, one_day and stopped once each, mailing each admin once per kind and never the member', async () => {
    const app = a.serverless;
    await projectRepoTakeoverService.requestTakeover(app.repoId, GITHUB_OWNER, a.fx.ctx);
    await runNotices();
    await runNotices();
    const stopsAt = (await application(app.applicationId)).stopsAt!;

    for (const before of [7 * DAY, DAY]) {
      const now = new Date(stopsAt.getTime() - before + 3_600_000);
      await hostedApplicationGraceNotifier.sendDueReminders(now);
      await hostedApplicationGraceNotifier.sendDueReminders(now);
      await runNotices();
      await runNotices();
    }
    await hostedApplicationHandoverService.stopApplication(
      app.applicationId,
      { kind: 'user', userId: a.people.adminId },
      { organizationId: a.world.organizationId },
    );
    await runNotices();
    await runNotices();

    const recorded = await adminDb.hostedApplicationNotice.findMany({
      where: { applicationId: app.applicationId },
    });
    expect(recorded.map((n) => n.kind).sort()).toEqual(
      ['one_day', 'seven_days', 'stopped', 'transferred'].sort(),
    );

    const users = await adminDb.user.findMany({
      where: { id: { in: [a.people.ownerId, a.people.adminId, a.people.memberId] } },
    });
    const email = (id: string) => users.find((u) => u.id === id)!.email;
    const mails = (
      await events<{ to: string; data: { kind: string; repositoryName: string } }>('email.send')
    ).filter((m) => m.data.data.repositoryName === app.name);
    for (const kind of ['transferred', 'seven_days', 'one_day', 'stopped']) {
      const to = mails.filter((m) => m.data.data.kind === kind).map((m) => m.data.to);
      expect(to.sort(), kind).toEqual([email(a.people.ownerId), email(a.people.adminId)].sort());
    }
    expect(mails.map((m) => m.data.to)).not.toContain(email(a.people.memberId));
  });
});

// ── The stop ────────────────────────────────────────────────────────────────

/** Take the Fly repository over, so its application is in grace. */
async function flyInGrace(): Promise<HostedRepo> {
  await projectRepoTakeoverService.requestTakeover(a.fly.repoId, GITHUB_OWNER, a.fx.ctx);
  expect((await application(a.fly.applicationId)).state).toBe('grace');
  timeline.log.length = 0;
  return a.fly;
}

const finalExports = (applicationId: string) =>
  adminDb.hostedApplicationExport.findMany({ where: { applicationId, kind: 'final' } });

describe('stopApplication, cut off after each step and run again', () => {
  const cuts: [string, () => void][] = [
    ['stop_serving (the provider)', () => failOn('hosting:destroyApp')],
    [
      'stop_serving (its record)',
      () => {
        vi.spyOn(hostedApplicationRepository, 'clearProductionPointers').mockRejectedValueOnce(
          new Error('cut off'),
        );
      },
    ],
    ['final_export', () => failOn('database:connectionEnv')],
    ['delete_database (the provider)', () => failOn('database:deleteDatabase')],
    [
      'delete_database (its record)',
      () => {
        vi.spyOn(hostedApplicationRepository, 'clearDatabase').mockRejectedValueOnce(
          new Error('cut off'),
        );
      },
    ],
    [
      'record',
      () => {
        vi.spyOn(hostedApplicationRepository, 'releaseAddresses').mockRejectedValueOnce(
          new Error('cut off'),
        );
      },
    ],
  ];

  it.each(cuts)(
    'cut at %s: the database is deleted only after the final export row exists, and the retry ends handed_over with one final export',
    async (_label, cut) => {
      const fly = await flyInGrace();
      const exportsAtDelete: number[] = [];
      onCall('database:deleteDatabase', async () => {
        exportsAtDelete.push((await finalExports(fly.applicationId)).length);
      });
      const actor = { kind: 'user' as const, userId: a.people.ownerId };
      const scope = { organizationId: a.world.organizationId };
      cut();

      const error = await hostedApplicationHandoverService
        .stopApplication(fly.applicationId, actor, scope)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApplicationStopFailedError);
      expect((await application(fly.applicationId)).state).toBe('grace');

      await hostedApplicationHandoverService.stopApplication(fly.applicationId, actor, scope);

      expect(exportsAtDelete.length).toBeGreaterThan(0);
      expect(exportsAtDelete.every((n) => n === 1)).toBe(true);
      const app = await application(fly.applicationId);
      expect(app.state).toBe('handed_over');
      expect(app.handedOverAt).toBeInstanceOf(Date);
      expect(await finalExports(fly.applicationId)).toHaveLength(1);
    },
  );
});

// ── The release freeze ──────────────────────────────────────────────────────

describe('every deploy path answers taken_over', () => {
  const setups: [string, (fly: HostedRepo) => Promise<unknown>][] = [
    [
      'a repository whose takeover reads awaiting_reinstall',
      (fly) =>
        adminDb.projectRepo.update({
          where: { id: fly.repoId },
          data: { takeoverState: 'awaiting_reinstall', takeoverTransferredAt: new Date() },
        }),
    ],
    [
      'a repository whose takeover reads done',
      (fly) =>
        adminDb.projectRepo.update({
          where: { id: fly.repoId },
          data: {
            takeoverState: 'done',
            takeoverTransferredAt: new Date(),
            takeoverCompletedAt: new Date(),
          },
        }),
    ],
    ...(['handing_over', 'grace', 'handed_over'] as const).map(
      (state): [string, (fly: HostedRepo) => Promise<unknown>] => [
        `an application ${state}`,
        (fly) =>
          adminDb.hostedApplication.update({
            where: { id: fly.applicationId },
            data: { state },
          }),
      ],
    ),
  ];

  const mergeRun = (fly: HostedRepo) => ({
    providerRepoId: fly.providerRepoId,
    repoOwner: MOTIR_ORG,
    repoName: fly.name,
    workflowName: PRODUCTION_IMAGE_WORKFLOW,
    event: 'push',
    headBranch: 'main',
    headSha: 'd'.repeat(40),
    conclusion: 'success',
    runId: '9100',
    runAttempt: 1,
    headCommitSubject: null,
    pullRequestNumber: null,
  });

  it('a live repository is released by the merge path (the control)', async () => {
    const outcome = await productionMergeReleaseService.handleProductionImageRun(
      mergeRun(a.fly),
      INSTALLATION,
    );
    expect(outcome).toEqual({ outcome: 'enqueued', projectRepositoryIds: [a.fly.repoId] });
  });

  it.each(setups)('for %s: merge, config redeploy, rollback and deploy-a-ref', async (_l, set) => {
    const fly = a.fly;
    await set(fly);
    const facts = await hostedApplicationService.readHandoverFacts(fly.repoId, a.fx.workspaceId);
    expect(facts?.deployRefusal).toBe('taken_over');
    const mergeJobs = (await events('hosting/merge-release.requested')).length;

    expect(
      await productionMergeReleaseService.handleProductionImageRun(mergeRun(fly), INSTALLATION),
    ).toEqual({ outcome: 'ignored', reason: 'not_switched_on' });
    expect(await events('hosting/merge-release.requested')).toHaveLength(mergeJobs);

    expect(
      await productionConfigRedeployService.runProductionRedeploy({
        projectRepositoryId: fly.repoId,
        attempt: 0,
      }),
    ).toEqual({ outcome: 'skipped_taken_over' });

    await expect(
      productionRollbackService.rollbackProduction({
        projectRepositoryId: fly.repoId,
        actor: a.fx.ctx,
      }),
    ).rejects.toBeInstanceOf(RepositoryTakenOverError);

    await expect(
      productionReleaseService.deployProductionRelease({
        projectRepositoryId: fly.repoId,
        commitSha: 'e'.repeat(40),
        ref: 'v1.2.0',
        artifactRef: `registry.fly.io/mh-${fly.repoId}:${'e'.repeat(40)}`,
        cause: 'ref',
      }),
    ).rejects.toBeInstanceOf(RepositoryTakenOverError);

    expect(timeline.log.filter((e) => e.startsWith('hosting:'))).toEqual([]);
  });
});

// ── The address release ─────────────────────────────────────────────────────

const applicationOnHost = (host: string) =>
  withSystemContext((tx) => hostedApplicationRepository.findByProductionAddress(host, tx));

async function expectReleased(
  applicationId: string,
  slug: string,
  host: string,
  domains: string[],
): Promise<void> {
  // The `<app>--<workspace>` host is looked up by its production address: no
  // application answers on it any more.
  expect(await applicationOnHost(host)).toBeNull();
  const app = await application(applicationId);
  expect(app).toMatchObject({ slug: releasedSlugOf(applicationId), productionAddress: null });
  const workspace = await adminDb.workspace.findUniqueOrThrow({ where: { id: a.fx.workspaceId } });
  expect(workspace.defaultApplicationId).toBeNull();
  for (const hostname of domains) {
    const row = await adminDb.publicAddress.findUniqueOrThrow({ where: { hostname } });
    expect(row.applicationId, hostname).toBeNull();
    expect((await publicAddressesService.resolveHost(hostname)).kind, hostname).toBe(
      'no_application',
    );
  }
  // The freed slug: a new application of the workspace takes it.
  const repo = await adminDb.projectRepo.create({
    data: {
      workspaceId: a.fx.workspaceId,
      projectId: a.fx.projectId,
      role: 'web',
      name: `${slug}-next`,
      position: `z-${slug}`,
      seedSource: 'initialised',
      state: 'created',
    },
  });
  await expect(
    adminDb.hostedApplication.create({
      data: {
        workspaceId: a.fx.workspaceId,
        projectId: a.fx.projectId,
        projectRepositoryId: repo.id,
        target: 'fly',
        slug,
      },
    }),
  ).resolves.toMatchObject({ slug });
}

/** The application's production host, made one the public-address resolver
 *  reads, and resolving before the release. */
async function servedHost(applicationId: string, slug: string): Promise<string> {
  const workspace = await adminDb.workspace.findUniqueOrThrow({ where: { id: a.fx.workspaceId } });
  const host = `${slug}--${workspace.slug}.motir.example`;
  await adminDb.hostedApplication.update({
    where: { id: applicationId },
    data: { productionAddress: host },
  });
  expect((await applicationOnHost(host))?.id).toBe(applicationId);
  return host;
}

describe('the address release', () => {
  it('by the AWS remove_access step: host, slug, workspace default and customer domain all freed', async () => {
    const shop = a.world.apps[0]!;
    const slug = (await application(shop.id)).slug;
    await adminDb.workspace.update({
      where: { id: a.fx.workspaceId },
      data: { defaultApplicationId: shop.id },
    });
    const host = await servedHost(shop.id, slug);
    await start();
    await drive();
    expect((await account()).state).toBe('handed_over');
    await expectReleased(shop.id, slug, host, ['shop.acme.example']);
  });

  it('by the Fly stop: host, slug, workspace default and customer domain all freed', async () => {
    const fly = await flyInGrace();
    const slug = (await application(fly.applicationId)).slug;
    const host = await servedHost(fly.applicationId, slug);
    await hostedApplicationHandoverService.stopApplication(
      fly.applicationId,
      { kind: 'user', userId: a.people.ownerId },
      { organizationId: a.world.organizationId },
    );
    await expectReleased(fly.applicationId, slug, host, [fly.domain]);
  });
});

// ── Isolation ───────────────────────────────────────────────────────────────

describe('one organisation never reaches another’s handover or applications', () => {
  function signInAs(userId: string): void {
    requireCompliantSession.mockResolvedValue({
      ok: true,
      session: { user: { id: userId, email: `${userId}@example.test` } },
    });
  }

  const json = (body: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('refuses another organisation’s admin and a member of the same organisation on every route, changing nothing and calling no provider', async () => {
    const b = await seedOrganisationB();
    await start();
    await drive((rows) => rows.some((r) => r.step === 'move_email' && r.status !== 'pending'));
    const fly = await flyInGrace();
    const exported = await adminDb.hostedApplicationExport.create({
      data: {
        workspaceId: a.fx.workspaceId,
        applicationId: fly.applicationId,
        kind: 'on_demand',
        requestedByUserId: a.people.ownerId,
        storageKey: `hosting-exports/${a.fx.workspaceId}/${fly.applicationId}/e.dump`,
        sizeBytes: BigInt(7),
        expiresAt: new Date(Date.now() + DAY),
      },
    });
    const accountA = tenantAccountId();
    const appA = fly.applicationId;

    const calls = (orgId: string): [string, () => Promise<Response>][] => {
      const base = `http://localhost:3000/api/organizations/${orgId}/hosting`;
      const org = { params: Promise.resolve({ orgId }) };
      const app = { params: Promise.resolve({ orgId, applicationId: appA }) };
      return [
        [
          'start',
          () =>
            handoverRoute.POST(
              new Request(
                `${base}/aws-handover`,
                json({ ownerEmail: OWNER_EMAIL, githubOwner: GITHUB_OWNER }),
              ),
              org,
            ),
        ],
        [
          'status',
          () =>
            handoverRoute.GET(new Request(`${base}/aws-handover?tenantAccountId=${accountA}`), org),
        ],
        [
          'email code',
          () =>
            emailCodeRoute.POST(
              new Request(
                `${base}/aws-handover/email-code`,
                json({ tenantAccountId: accountA, code: '123456' }),
              ),
              org,
            ),
        ],
        [
          'recheck',
          () =>
            recheckRoute.POST(
              new Request(`${base}/aws-handover/recheck`, json({ tenantAccountId: accountA })),
              org,
            ),
        ],
        [
          'retry',
          () =>
            retryRoute.POST(
              new Request(`${base}/aws-handover/retry`, json({ tenantAccountId: accountA })),
              org,
            ),
        ],
        [
          'export create',
          () =>
            exportsRoute.POST(
              new Request(`${base}/applications/${appA}/exports`, { method: 'POST' }),
              app,
            ),
        ],
        [
          'export list',
          () => exportsRoute.GET(new Request(`${base}/applications/${appA}/exports`), app),
        ],
        [
          'export download',
          () =>
            downloadRoute.GET(
              new Request(`${base}/applications/${appA}/exports/${exported.id}/download`),
              {
                params: Promise.resolve({ orgId, applicationId: appA, exportId: exported.id }),
              },
            ),
        ],
        [
          'stop now',
          () =>
            stopRoute.POST(
              new Request(`${base}/applications/${appA}/stop`, { method: 'POST' }),
              app,
            ),
        ],
      ];
    };

    const beforeA = await rowsOf(a.world.organizationId);
    const beforeB = await rowsOf(b.organizationId);
    const exportJobs = (await events('hosting.application-export')).length;
    timeline.log.length = 0;

    const callers: [string, string, string][] = [
      ['B’s admin, through A', b.people.adminId, a.world.organizationId],
      ['B’s admin, through B', b.people.adminId, b.organizationId],
      ['B’s owner, through B', b.people.ownerId, b.organizationId],
      ['A’s member', a.people.memberId, a.world.organizationId],
    ];
    for (const [who, userId, orgId] of callers) {
      signInAs(userId);
      for (const [route, call] of calls(orgId)) {
        const res = await call();
        // `start` through B is B's OWN account: allowed to start, but never
        // A's — it is checked below by A's rows staying as they were.
        if (route === 'start' && orgId === b.organizationId) continue;
        expect([403, 404], `${who} · ${route} answered ${res.status}`).toContain(res.status);
      }
    }

    expect(await rowsOf(a.world.organizationId)).toEqual(beforeA);
    expect(timeline.log).toEqual([]);
    expect(await events('hosting.application-export')).toHaveLength(exportJobs);
    expect((await rowsOf(b.organizationId)).apps).toEqual(beforeB.apps);
  });
});
