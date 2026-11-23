import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AWS_MEMBER_ROLE_NAME,
  AWS_TENANT_DEPLOY_ROLE,
  HANDOVER_DEPLOY_ROLE,
  createAwsHostingDeployPort,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import {
  TENANT_ACCOUNT_HANDOVER_STATES,
  TENANT_HANDOVER_STEPS,
  type TenantHandoverStep,
} from '@/lib/ciFleet/hostingTenantAccounts';
import {
  HandoverActorMissingError,
  HandoverEmailCodeRefusedError,
  HandoverNothingToRetryError,
  HandoverRepositoryNotRealizedError,
  HandoverStepNotWaitingError,
  HandoverStepOutOfOrderError,
  TenantAccountNotReadyError,
  TenantHandoverAlreadyStartedError,
  TenantHandoverInputError,
  TenantHandoverNotAdminError,
  TenantHandoverNotFoundError,
} from '@/lib/hosting/tenantHandoverErrors';
import { GithubIdentityRequiredError } from '@/lib/projectRepos/errors';
import { awsHostingLookupService } from '@/lib/services/awsHostingLookupService';
import { hostedApplicationHandoverService } from '@/lib/services/hostedApplicationHandoverService';
import { hostingTenantAccountService } from '@/lib/services/hostingTenantAccountService';
import {
  runHandoverStep,
  tenantAccountHandoverService as handover,
  type HandoverActor,
} from '@/lib/services/tenantAccountHandoverService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  ACCOUNT,
  FakeHandoverFailure,
  GITHUB_OWNER,
  GITHUB_OWNER_ID,
  OWNER_EMAIL,
  createHandoverFakes,
  seedAwsRepository,
  seedHandoverWorld,
  type HandoverFakes,
  type HandoverFault,
  type HandoverWorld,
} from '../helpers/tenantHandoverFixtures';

// THE AWS ACCOUNT HANDOVER over real Postgres (Story MOTIR-9800 · MOTIR-12131).
// Every boundary is a fake that logs into ONE ordered call log, and the tenant
// account is the orchestrator's fake driven through the real handover calls, so
// "the production stacks are still there" is read off the account.

let world: HandoverWorld;
let fakes: HandoverFakes;
let admin: HandoverActor;

beforeEach(async () => {
  await truncateAuthTables();
  world = await seedHandoverWorld();
  fakes = createHandoverFakes(world);
  await fakes.seedStacks();
  admin = { userId: world.fx.ownerId, organizationId: world.organizationId };
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

const start = () =>
  handover.start(
    world.organizationId,
    { ownerEmail: OWNER_EMAIL, githubOwner: GITHUB_OWNER },
    world.fx.ownerId,
    fakes.deps,
  );

/** Run the queued advances until the queue is empty (the job, inline). */
async function drain(limit = 40): Promise<void> {
  for (let i = 0; i < limit && fakes.enqueued.length > 0; i += 1) {
    await handover.advance(fakes.enqueued.shift()!, fakes.deps);
  }
}

const stepRow = (step: TenantHandoverStep) =>
  adminDb.hostingTenantHandoverStep.findUniqueOrThrow({
    where: { tenantAccountId_step: { tenantAccountId: world.tenantAccountId, step } },
  });
const account = () =>
  adminDb.hostingTenantAccount.findUniqueOrThrow({ where: { id: world.tenantAccountId } });
const apps = () =>
  adminDb.hostedApplication.findMany({
    where: { id: { in: world.apps.map((a) => a.id) } },
    orderBy: { createdAt: 'asc' },
  });

/** Start, then answer every person-facing step, until the handover ends. */
async function walkAll(): Promise<void> {
  await start();
  await drain();
  await handover.submitEmailCode(
    world.tenantAccountId,
    fakes.organization.fakeEmailCode(ACCOUNT)!,
    admin,
    fakes.deps,
  );
  await drain();
  await handover.recheckStandalone(world.tenantAccountId, admin, fakes.deps);
  await drain();
}

/** The first index of `entry` in the log, failing loudly when absent. */
function at(entry: string): number {
  const index = fakes.log.indexOf(entry);
  expect(index, `${entry} in ${fakes.log.join(', ')}`).toBeGreaterThanOrEqual(0);
  return index;
}

const stacks = () => [...fakes.clients.cloudformation.stacks.keys()].sort();
const productionStacks = () => world.repos.map((r) => `motir-release-mh-${r.id}`).sort();

describe('start', () => {
  it('records the owner and actor, moves the account to handing_over and lays out eight pending steps', async () => {
    const dto = await start();
    const row = await account();
    expect(row).toMatchObject({
      state: 'handing_over',
      handoverOwnerEmail: OWNER_EMAIL,
      handoverGithubOwner: GITHUB_OWNER,
      handoverStartedByUserId: world.fx.ownerId,
    });
    expect(dto.steps.map((s) => [s.step, s.status])).toEqual(
      TENANT_HANDOVER_STEPS.map((step) => [step, 'pending']),
    );
    expect(fakes.enqueued).toEqual([world.tenantAccountId]);
    expect(JSON.stringify(dto)).not.toContain(OWNER_EMAIL);
  });

  it('refuses an actor with no GitHub identity before writing anything', async () => {
    await adminDb.githubIdentity.deleteMany({ where: { userId: world.fx.ownerId } });
    await expect(start()).rejects.toBeInstanceOf(GithubIdentityRequiredError);
    expect((await account()).state).toBe('ready');
    expect(await adminDb.hostingTenantHandoverStep.count()).toBe(0);
    expect(fakes.enqueued).toEqual([]);
  });

  it('refuses a second handover of the same account', async () => {
    await start();
    await expect(start()).rejects.toBeInstanceOf(TenantHandoverAlreadyStartedError);
    expect(await adminDb.hostingTenantHandoverStep.count()).toBe(8);
  });

  it('refuses an organisation whose account is missing or not ready', async () => {
    await adminDb.hostingTenantAccount.update({
      where: { id: world.tenantAccountId },
      data: { state: 'bootstrapping' },
    });
    await expect(start()).rejects.toBeInstanceOf(TenantAccountNotReadyError);
    await adminDb.hostingTenantAccount.delete({ where: { id: world.tenantAccountId } });
    await expect(start()).rejects.toBeInstanceOf(TenantAccountNotReadyError);
  });

  it.each([
    [{ ownerEmail: 'not-an-email', githubOwner: GITHUB_OWNER }],
    [{ ownerEmail: OWNER_EMAIL, githubOwner: 'no spaces/allowed' }],
  ])('refuses a malformed owner %#', async (input) => {
    await expect(
      handover.start(world.organizationId, input, world.fx.ownerId, fakes.deps),
    ).rejects.toBeInstanceOf(TenantHandoverInputError);
    expect((await account()).state).toBe('ready');
  });
});

describe('the eight steps, in order', () => {
  it('runs destroy_previews → create_deploy_role → open_upstream → move_email → await_standalone → remove_access → leave_organization → transfer_repositories', async () => {
    await walkAll();
    const [shop, api] = world.repos;
    const order = [
      at('destroy_previews'),
      at(`github_account:${GITHUB_OWNER}`),
      at('create_deploy_role'),
      at(`open_upstream:mh-${shop!.id}`),
      at(`open_upstream:mh-${api!.id}`),
      at('start_email_update'),
      at('read_standalone'),
      at(`production_config:${shop!.id}`),
      at('remove_motir_access'),
      at('leave_organization'),
      at(`transfer:${shop!.id}`),
      at(`transfer:${api!.id}`),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const rows = await adminDb.hostingTenantHandoverStep.findMany({
      where: { tenantAccountId: world.tenantAccountId },
    });
    expect(rows.every((r) => r.status === 'done')).toBe(true);
    expect(await handover.advance(world.tenantAccountId, fakes.deps)).toEqual({
      outcome: 'complete',
    });
  });

  it('gives the deploy role the immutable GitHub ids, the preview gone and production kept', async () => {
    await walkAll();
    const role = fakes.clients.iamAccount.roles.get(HANDOVER_DEPLOY_ROLE)!;
    const trust = JSON.stringify(role.trust);
    for (const repo of world.repos) expect(trust).toContain(`repository_id:${repo.githubRepoId}`);
    expect(trust).toContain(`repository_owner_id:${GITHUB_OWNER_ID}`);
    expect(stacks()).toEqual(productionStacks());
  });

  it('opens every production application and records its upstream as handing_over, releasing no address yet', async () => {
    const release = vi.spyOn(hostedApplicationHandoverService, 'releaseApplicationAddresses');
    await start();
    await drain();
    for (const app of await apps()) {
      const repo = world.apps.find((a) => a.id === app.id)!.repoId;
      expect(app).toMatchObject({
        state: 'handing_over',
        upstreamAddress: `https://mh-${repo}.open.example`,
      });
      expect(app.productionAddress).not.toBeNull();
    }
    expect(release).not.toHaveBeenCalled();
    expect((await stepRow('move_email')).status).toBe('waiting_on_you');
  });

  it('hands every application and the account over, each carrying the account id', async () => {
    await walkAll();
    expect((await account()).state).toBe('handed_over');
    for (const app of await apps()) {
      expect(app).toMatchObject({ state: 'handed_over', handedOverAccountId: ACCOUNT });
      expect(app.handedOverAt).toBeInstanceOf(Date);
      expect(app.productionAddress).toBeNull();
    }
  });

  it('calls requestTakeover once per repository, as the admin, to the GitHub owner, after the account left', async () => {
    await walkAll();
    expect(fakes.takeovers.map((t) => t.rowId)).toEqual(world.repos.map((r) => r.id));
    for (const t of fakes.takeovers) {
      expect(t.newOwner).toBe(GITHUB_OWNER);
      expect(t.ctx).toEqual({ userId: world.fx.ownerId, workspaceId: world.fx.workspaceId });
    }
    expect(at(`transfer:${world.repos[0]!.id}`)).toBeGreaterThan(at('leave_organization'));
  });

  it('makes no deploy-credential, Actions-variable or address-release call for a repository after its transfer', async () => {
    const release = vi
      .spyOn(hostedApplicationHandoverService, 'releaseApplicationAddresses')
      .mockImplementation(async function (this: unknown, applicationId, tx) {
        fakes.log.push(`release_addresses:${applicationId}`);
        release.mockRestore();
        const out = await hostedApplicationHandoverService.releaseApplicationAddresses(
          applicationId,
          tx,
        );
        vi.spyOn(hostedApplicationHandoverService, 'releaseApplicationAddresses');
        return out;
      });
    await walkAll();
    for (const repo of world.repos) {
      const app = world.apps.find((a) => a.repoId === repo.id)!;
      const transfer = at(`transfer:${repo.id}`);
      for (const entry of [`production_config:${repo.id}`, `release_addresses:${app.id}`]) {
        if (fakes.log.includes(entry)) expect(fakes.log.lastIndexOf(entry)).toBeLessThan(transfer);
      }
      expect(fakes.log.slice(transfer).some((e) => e.endsWith(repo.id))).toBe(true);
      expect(
        fakes.log
          .slice(transfer + 1)
          .filter((e) => e.startsWith('production_config:') || e.startsWith('release_addresses:')),
      ).toEqual([]);
    }
  });

  it('skips a repository already past the transfer and does not transfer it again', async () => {
    await adminDb.projectRepo.update({
      where: { id: world.repos[0]!.id },
      data: { takeoverState: 'awaiting_reinstall' },
    });
    await walkAll();
    expect(fakes.takeovers.map((t) => t.rowId)).toEqual([world.repos[1]!.id]);
    expect(fakes.log).not.toContain(`production_config:${world.repos[0]!.id}`);
  });
});

describe('a step that throws, then retry', () => {
  /** Which fault fails which step, and where the walk must be when it fires. */
  const CASES: [TenantHandoverStep, HandoverFault][] = [
    ['destroy_previews', 'destroyPreviewStacks'],
    ['create_deploy_role', 'createHandoverDeployRole'],
    ['open_upstream', 'openUpstream'],
    ['move_email', 'startPrimaryEmailUpdate'],
    ['await_standalone', 'readStandaloneReadiness'],
    ['remove_access', 'removeMotirAccess'],
    ['leave_organization', 'removeAccountFromOrganization'],
    ['transfer_repositories', 'requestTakeover'],
  ];
  const MUTATING = [
    'destroy_previews',
    'create_deploy_role',
    'start_email_update',
    'remove_motir_access',
    'leave_organization',
  ];

  it.each(CASES)(
    '%s reads failed with a typed lastError, and retry resumes there',
    async (step, fault) => {
      fakes.faults.add(fault);
      await expect(walkAll())
        .rejects.toBeInstanceOf(Error)
        .catch(() => undefined);
      // The walk stopped where the step failed; nothing after it ran.
      const failed = await stepRow(step);
      expect(failed.status).toBe('failed');
      expect(failed.lastError).toMatch(new RegExp(`^FAKE_${fault.toUpperCase()}: `));
      const before = fakes.log.length;
      const earlier = fakes.log.filter((e) => MUTATING.includes(e)).length;

      await handover.retry(world.tenantAccountId, admin, fakes.deps);
      await drain();
      if (step === 'move_email' || (await stepRow('move_email')).status !== 'done') {
        await handover.submitEmailCode(
          world.tenantAccountId,
          fakes.organization.fakeEmailCode(ACCOUNT)!,
          admin,
          fakes.deps,
        );
        await drain();
      }
      if ((await stepRow('await_standalone')).status !== 'done') {
        await handover.recheckStandalone(world.tenantAccountId, admin, fakes.deps);
        await drain();
      }
      expect((await account()).state).toBe('handed_over');
      // No earlier step's mutating call ran again on the resume.
      const after = fakes.log.slice(before);
      const ranAgain = after.filter((e) => MUTATING.includes(e));
      const stepsBefore = TENANT_HANDOVER_STEPS.slice(0, TENANT_HANDOVER_STEPS.indexOf(step));
      for (const entry of ranAgain) {
        const owner = MUTATING_STEP[entry]!;
        expect(stepsBefore, `${entry} re-ran on resume`).not.toContain(owner);
      }
      expect(earlier).toBeGreaterThanOrEqual(0);
    },
  );

  it('refuses a retry with no failed step', async () => {
    await start();
    await expect(handover.retry(world.tenantAccountId, admin, fakes.deps)).rejects.toBeInstanceOf(
      HandoverNothingToRetryError,
    );
    await walkAll().catch(() => undefined);
    await expect(handover.retry(world.tenantAccountId, admin, fakes.deps)).rejects.toBeInstanceOf(
      HandoverNothingToRetryError,
    );
  });

  it('advance leaves a failed step alone until retry', async () => {
    fakes.faults.add('destroyPreviewStacks');
    await start();
    await drain();
    expect(await handover.advance(world.tenantAccountId, fakes.deps)).toEqual({
      outcome: 'failed',
      step: 'destroy_previews',
    });
    expect(fakes.log.filter((e) => e === 'destroy_previews')).toHaveLength(1);
  });

  it('fails create_deploy_role by name for a repository with no GitHub repository', async () => {
    const bare = await seedAwsRepository(world.fx, 'bare', { application: false });
    await adminDb.projectRepo.update({ where: { id: bare.repo.id }, data: { githubRepoId: null } });
    await start();
    await drain();
    expect((await stepRow('create_deploy_role')).lastError).toMatch(
      new RegExp(`^${new HandoverRepositoryNotRealizedError('x').code}: `),
    );
  });

  it('fails the transfer by name when the admin who started it is gone', async () => {
    await start();
    await drain();
    await adminDb.hostingTenantAccount.update({
      where: { id: world.tenantAccountId },
      data: { handoverStartedByUserId: null },
    });
    await handover.submitEmailCode(
      world.tenantAccountId,
      fakes.organization.fakeEmailCode(ACCOUNT)!,
      admin,
      fakes.deps,
    );
    await drain();
    await handover.recheckStandalone(world.tenantAccountId, admin, fakes.deps);
    await drain();
    expect((await stepRow('transfer_repositories')).lastError).toMatch(
      new RegExp(`^${new HandoverActorMissingError('x').code}: `),
    );
  });

  it('strikes the owner address out of a recorded error', async () => {
    fakes.aws.handover.destroyPreviewStacks = async () => {
      throw new FakeHandoverFailure('FAKE_LEAK');
    };
    const leaky = new FakeHandoverFailure('FAKE_LEAK');
    leaky.message = `mail for ${OWNER_EMAIL} bounced`;
    fakes.aws.handover.destroyPreviewStacks = async () => {
      throw leaky;
    };
    await start();
    await drain();
    const row = await stepRow('destroy_previews');
    expect(row.lastError).toBe('FAKE_LEAK: mail for [owner email] bounced');
  });
});

const MUTATING_STEP: Record<string, TenantHandoverStep> = {
  destroy_previews: 'destroy_previews',
  create_deploy_role: 'create_deploy_role',
  start_email_update: 'move_email',
  remove_motir_access: 'remove_access',
  leave_organization: 'leave_organization',
};

describe('the order guarantees', () => {
  it('refuses remove_access while await_standalone is not done, before any call', async () => {
    await start();
    await expect(
      runHandoverStep(world.tenantAccountId, 'remove_access', fakes.deps),
    ).rejects.toBeInstanceOf(HandoverStepOutOfOrderError);
    expect(fakes.log).toEqual([]);
    expect((await stepRow('remove_access')).status).toBe('pending');
  });

  it('refuses leave_organization while remove_access is not done', async () => {
    await start();
    await expect(
      runHandoverStep(world.tenantAccountId, 'leave_organization', fakes.deps),
    ).rejects.toBeInstanceOf(HandoverStepOutOfOrderError);
    expect(fakes.log).not.toContain('leave_organization');
  });

  it('refuses transfer_repositories while leave_organization is not done', async () => {
    await start();
    await expect(
      runHandoverStep(world.tenantAccountId, 'transfer_repositories', fakes.deps),
    ).rejects.toBeInstanceOf(HandoverStepOutOfOrderError);
    expect(fakes.takeovers).toEqual([]);
  });

  it('sends remove_access back to waiting_on_you when readiness is no longer met, removing nothing', async () => {
    await start();
    await drain();
    await handover.submitEmailCode(
      world.tenantAccountId,
      fakes.organization.fakeEmailCode(ACCOUNT)!,
      admin,
      fakes.deps,
    );
    await drain();
    // Confirmed while met; by the time remove_access starts, AWS says the
    // account is a delegated administrator again.
    const read = fakes.aws.management.readStandaloneReadiness;
    let calls = 0;
    fakes.aws.management.readStandaloneReadiness = async (accountId) => {
      calls += 1;
      const real = await read(accountId);
      return calls === 1
        ? real
        : {
            ...real,
            delegatedAdministrator: { status: 'not_met', services: ['config.amazonaws.com'] },
            ready: false,
          };
    };
    await handover.recheckStandalone(world.tenantAccountId, admin, fakes.deps);
    await drain();
    const row = await stepRow('remove_access');
    expect(row).toMatchObject({ status: 'waiting_on_you', missing: ['delegated_administrator'] });
    expect(fakes.log).not.toContain('remove_motir_access');
    expect(fakes.log.some((e) => e.startsWith('production_config:'))).toBe(false);
    expect((await account()).state).toBe('awaiting_standalone');

    // Met again: the re-check sends it on.
    fakes.aws.management.readStandaloneReadiness = read;
    await handover.recheckStandalone(world.tenantAccountId, admin, fakes.deps);
    await drain();
    expect((await account()).state).toBe('handed_over');
  });

  it('leaves leave_organization waiting_on_you with AWS’s reason when the removal is not ready', async () => {
    fakes.organization.removalRefusals.set(
      ACCOUNT,
      'ACCOUNT_CANNOT_LEAVE_WITHOUT_PHONE_VERIFICATION',
    );
    await walkAll();
    expect(await stepRow('leave_organization')).toMatchObject({
      status: 'waiting_on_you',
      missing: ['ACCOUNT_CANNOT_LEAVE_WITHOUT_PHONE_VERIFICATION'],
    });
    expect(fakes.takeovers).toEqual([]);
    fakes.organization.removalRefusals.delete(ACCOUNT);
    await handover.recheckStandalone(world.tenantAccountId, admin, fakes.deps);
    await drain();
    expect((await stepRow('leave_organization')).status).toBe('done');
    expect((await account()).state).toBe('handed_over');
  });

  it('keeps await_standalone waiting on advance, listing what the owner must meet or confirm', async () => {
    await start();
    await drain();
    await handover.submitEmailCode(
      world.tenantAccountId,
      fakes.organization.fakeEmailCode(ACCOUNT)!,
      admin,
      fakes.deps,
    );
    await drain();
    await handover.advance(world.tenantAccountId, fakes.deps);
    expect(await stepRow('await_standalone')).toMatchObject({
      status: 'waiting_on_you',
      missing: ['payment_method', 'support_plan', 'contact_information'],
    });
    expect((await account()).state).toBe('awaiting_standalone');
    // A re-check while AWS still says the wait has not run keeps it waiting.
    const read = fakes.aws.management.readStandaloneReadiness;
    fakes.aws.management.readStandaloneReadiness = async (accountId) => ({
      ...(await read(accountId)),
      waitPeriod: { status: 'not_met', eligibleAt: new Date('2026-12-01T00:00:00Z') },
      ready: false,
    });
    const dto = await handover.recheckStandalone(world.tenantAccountId, admin, fakes.deps);
    expect(dto.steps.find((s) => s.step === 'await_standalone')).toMatchObject({
      status: 'waiting_on_you',
      missing: ['wait_period', 'payment_method', 'support_plan', 'contact_information'],
    });
    expect(fakes.enqueued).toEqual([]);
  });

  it('marks await_standalone done when the account is already outside the Organization', async () => {
    fakes.organization.removedAccounts.add(ACCOUNT);
    await start();
    await drain();
    await handover.submitEmailCode(
      world.tenantAccountId,
      fakes.organization.fakeEmailCode(ACCOUNT)!,
      admin,
      fakes.deps,
    );
    await drain();
    expect((await stepRow('await_standalone')).status).toBe('done');
    expect((await account()).state).toBe('handed_over');
  });

  it.each([1, 2, 3, 4, 5])(
    'a handover stopped after step %i leaves production and Motir’s access intact',
    async (n) => {
      const member = () => JSON.stringify(fakes.clients.iamAccount.roles.get(AWS_MEMBER_ROLE_NAME));
      const memberBefore = member();
      await start();
      // Run step by step, stopping once the first `n` steps are done.
      for (let i = 0; i < 20; i += 1) {
        const done = (
          await adminDb.hostingTenantHandoverStep.findMany({
            where: { tenantAccountId: world.tenantAccountId, status: 'done' },
          })
        ).length;
        if (done >= n) break;
        if ((await stepRow('move_email')).status === 'waiting_on_you') {
          await handover.submitEmailCode(
            world.tenantAccountId,
            fakes.organization.fakeEmailCode(ACCOUNT)!,
            admin,
            fakes.deps,
          );
        } else if ((await stepRow('await_standalone')).status === 'waiting_on_you') {
          await handover.recheckStandalone(world.tenantAccountId, admin, fakes.deps);
        } else {
          await handover.advance(world.tenantAccountId, fakes.deps);
        }
      }
      for (const name of productionStacks()) expect(stacks()).toContain(name);
      expect(member()).toBe(memberBefore);
      expect(fakes.clients.iamAccount.roles.has(AWS_TENANT_DEPLOY_ROLE)).toBe(true);
      expect(fakes.log).not.toContain('remove_motir_access');
      expect(fakes.log.some((e) => e.startsWith('production_config:'))).toBe(false);
    },
  );
});

describe('the email code', () => {
  it('never starts a second update on a resumed move_email', async () => {
    await start();
    await drain();
    expect(fakes.log.filter((e) => e === 'start_email_update')).toHaveLength(1);
    await handover.advance(world.tenantAccountId, fakes.deps);
    await handover.advance(world.tenantAccountId, fakes.deps);
    expect(fakes.log.filter((e) => e === 'start_email_update')).toHaveLength(1);
    expect((await stepRow('move_email')).status).toBe('waiting_on_you');
  });

  it('refuses a wrong code with AWS’s reason and keeps waiting', async () => {
    await start();
    await drain();
    await expect(
      handover.submitEmailCode(world.tenantAccountId, '000000', admin, fakes.deps),
    ).rejects.toMatchObject({
      constructor: HandoverEmailCodeRefusedError,
      awsReason: 'ValidationException',
    });
    expect((await stepRow('move_email')).status).toBe('waiting_on_you');
  });

  it('refuses a code while move_email is not waiting, and an empty code', async () => {
    await start();
    await expect(
      handover.submitEmailCode(world.tenantAccountId, '123456', admin, fakes.deps),
    ).rejects.toBeInstanceOf(HandoverStepNotWaitingError);
    await drain();
    await expect(
      handover.submitEmailCode(world.tenantAccountId, '   ', admin, fakes.deps),
    ).rejects.toBeInstanceOf(TenantHandoverInputError);
  });

  it('stays waiting when AWS accepted but has not yet moved the address, and an advance finishes it', async () => {
    await start();
    await drain();
    const getPrimaryEmail = fakes.aws.management.getPrimaryEmail;
    fakes.aws.management.getPrimaryEmail = async () => `${ACCOUNT}@motir.example`;
    await handover.submitEmailCode(
      world.tenantAccountId,
      fakes.organization.fakeEmailCode(ACCOUNT)!,
      admin,
      fakes.deps,
    );
    expect((await stepRow('move_email')).status).toBe('waiting_on_you');
    fakes.aws.management.getPrimaryEmail = getPrimaryEmail;
    await handover.advance(world.tenantAccountId, fakes.deps);
    expect((await stepRow('move_email')).status).toBe('done');
  });

  it('stores, logs and returns no part of the one-time code', async () => {
    const SENTINEL = 'SENTINEL-OTP-4242';
    const lines: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });
    }
    await start();
    await drain();
    // A wrong attempt with the sentinel, then AWS's code IS the sentinel.
    await handover
      .submitEmailCode(world.tenantAccountId, SENTINEL, admin, fakes.deps)
      .catch((err: unknown) => {
        expect(String((err as Error).message)).not.toContain(SENTINEL);
      });
    fakes.organization.emailUpdates.get(ACCOUNT)!.code = SENTINEL;
    const answer = await handover.submitEmailCode(
      world.tenantAccountId,
      SENTINEL,
      admin,
      fakes.deps,
    );
    await drain();
    await handover.recheckStandalone(world.tenantAccountId, admin, fakes.deps);
    await drain();
    const status = await handover.status(world.tenantAccountId, admin);
    const stored = JSON.stringify([
      await adminDb.hostingTenantAccount.findMany(),
      await adminDb.hostingTenantHandoverStep.findMany(),
      await adminDb.hostedApplication.findMany(),
      await adminDb.jobRun.findMany().catch(() => []),
    ]);
    for (const haystack of [stored, JSON.stringify(answer), JSON.stringify(status), ...lines]) {
      expect(haystack).not.toContain(SENTINEL);
    }
    expect(JSON.stringify(status)).not.toContain(OWNER_EMAIL);
  });
});

describe('who may act', () => {
  async function member(role: 'member' | 'admin') {
    const user = await createTestUser();
    await adminDb.organizationMembership.create({
      data: { organizationId: world.organizationId, userId: user.id, role },
    });
    return user.id;
  }

  it('refuses a member who is not an admin on every call (403)', async () => {
    await start();
    const userId = await member('member');
    const actor = { userId, organizationId: world.organizationId };
    await expect(
      handover.start(
        world.organizationId,
        { ownerEmail: OWNER_EMAIL, githubOwner: GITHUB_OWNER },
        userId,
        fakes.deps,
      ),
    ).rejects.toBeInstanceOf(TenantHandoverNotAdminError);
    for (const call of [
      () => handover.submitEmailCode(world.tenantAccountId, '1', actor, fakes.deps),
      () => handover.recheckStandalone(world.tenantAccountId, actor, fakes.deps),
      () => handover.retry(world.tenantAccountId, actor, fakes.deps),
      () => handover.status(world.tenantAccountId, actor),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(TenantHandoverNotAdminError);
    }
  });

  it('lets another admin of the organisation read and answer', async () => {
    await start();
    const userId = await member('admin');
    const dto = await handover.status(world.tenantAccountId, {
      userId,
      organizationId: world.organizationId,
    });
    expect(dto.tenantAccountId).toBe(world.tenantAccountId);
  });

  it('answers 404-shaped for a non-member and for another organisation’s account', async () => {
    await start();
    const stranger = await createTestUser();
    const outsider = { userId: stranger.id, organizationId: world.organizationId };
    await expect(handover.status(world.tenantAccountId, outsider)).rejects.toBeInstanceOf(
      TenantHandoverNotFoundError,
    );
    await expect(
      handover.start(
        world.organizationId,
        { ownerEmail: OWNER_EMAIL, githubOwner: GITHUB_OWNER },
        stranger.id,
        fakes.deps,
      ),
    ).rejects.toBeInstanceOf(TenantHandoverNotFoundError);
    // An admin of ANOTHER organisation naming this account through their own.
    const other = await seedHandoverWorld({ domain: 'shop.other.example' });
    const theirs = { userId: other.fx.ownerId, organizationId: other.organizationId };
    for (const call of [
      () => handover.status(world.tenantAccountId, theirs),
      () => handover.submitEmailCode(world.tenantAccountId, '1', theirs, fakes.deps),
      () => handover.recheckStandalone(world.tenantAccountId, theirs, fakes.deps),
      () => handover.retry(world.tenantAccountId, theirs, fakes.deps),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(TenantHandoverNotFoundError);
    }
  });
});

describe('the checklist', () => {
  it('lists each application’s upstream and the customer domains to repoint', async () => {
    await start();
    await drain();
    const dto = await handover.status(world.tenantAccountId, admin);
    const shop = dto.applications.find((a) => a.slug === 'shop')!;
    expect(shop).toMatchObject({
      state: 'handing_over',
      upstreamAddress: `https://mh-${world.repos[0]!.id}.open.example`,
      customerDomains: [
        {
          host: 'shop.acme.example',
          upstreamAddress: `https://mh-${world.repos[0]!.id}.open.example`,
        },
      ],
    });
    expect(dto.deployRoleArn).toBe(
      `arn:aws:iam::${ACCOUNT}:role/motir-handover/${HANDOVER_DEPLOY_ROLE}`,
    );
    expect(dto.steps.find((s) => s.step === 'move_email')).toMatchObject({
      status: 'waiting_on_you',
      lastError: null,
      missing: [],
    });
  });

  it('answers busy while another worker holds the step', async () => {
    await start();
    await adminDb.hostingTenantHandoverStep.update({
      where: {
        tenantAccountId_step: { tenantAccountId: world.tenantAccountId, step: 'destroy_previews' },
      },
      data: { leaseHolder: 'other', leaseExpiresAt: new Date(Date.now() + 60_000) },
    });
    expect(await handover.advance(world.tenantAccountId, fakes.deps)).toEqual({
      outcome: 'busy',
      step: 'destroy_previews',
    });
    expect(fakes.log).toEqual([]);
  });

  it('answers not_in_handover for an account not being handed over or not found', async () => {
    expect(await handover.advance(world.tenantAccountId, fakes.deps)).toEqual({
      outcome: 'not_in_handover',
    });
    expect(await handover.advance('no-such-account', fakes.deps)).toEqual({
      outcome: 'not_in_handover',
    });
    expect(await runHandoverStep('no-such-account', 'destroy_previews', fakes.deps)).toEqual({
      outcome: 'not_in_handover',
    });
  });

  it('refuses a re-check when no readiness step waits', async () => {
    await start();
    await expect(
      handover.recheckStandalone(world.tenantAccountId, admin, fakes.deps),
    ).rejects.toBeInstanceOf(HandoverStepNotWaitingError);
    await walkAll().catch(() => undefined);
    await expect(
      handover.recheckStandalone(world.tenantAccountId, admin, fakes.deps),
    ).rejects.toBeInstanceOf(HandoverStepNotWaitingError);
  });
});

describe('no AWS call for an account in a handover state', () => {
  it.each([...TENANT_ACCOUNT_HANDOVER_STATES])(
    '%s: the reconcile and ensureTenantAccount reach neither STS nor Organizations',
    async (state) => {
      await adminDb.hostingTenantAccount.update({
        where: { id: world.tenantAccountId },
        data: { state },
      });
      const aws = {
        create: vi.fn(async () => ({ accountId: ACCOUNT })),
        bootstrap: vi.fn(async () => undefined),
        checkQuotas: vi.fn(async () => ({ quotaRaisesFiled: 0, quotaRaisesPending: 0 })),
      };
      const summary = await hostingTenantAccountService.runReconcile(
        aws as unknown as Parameters<typeof hostingTenantAccountService.runReconcile>[0],
      );
      expect(summary.organizations).toEqual([]);
      expect(
        await hostingTenantAccountService.reconcileOrganization(world.organizationId, aws as never),
      ).toEqual({ organizationId: world.organizationId, outcome: 'in_handover' });
      expect(aws.create).not.toHaveBeenCalled();
      expect(aws.bootstrap).not.toHaveBeenCalled();
      expect(aws.checkQuotas).not.toHaveBeenCalled();

      expect(await awsHostingLookupService.ensureTenantAccount(world.organizationId)).toEqual({
        ready: false,
        accountId: ACCOUNT,
      });
      // A hosting call: the adapter never builds the account's clients, which
      // is where its session would be assumed.
      const clientsFor = vi.fn(() => fakes.clients);
      const port = createAwsHostingDeployPort({
        clientsFor,
        region: 'us-east-1',
        ensureTenantAccount: (org) => awsHostingLookupService.ensureTenantAccount(org),
        organizationOf: async () => world.organizationId,
        isCustomerRepository: async () => false,
        githubIdsOf: async () => ({ githubRepositoryId: '1', githubOwnerId: '2' }),
        forwarderPrincipalArn: 'arn:aws:iam::1:role/f',
        originSecretKey: 'k',
      });
      await port.ensureApp({
        repositoryId: world.repos[0]!.id,
        environment: { kind: 'production' },
      });
      expect(clientsFor).not.toHaveBeenCalled();
      expect(fakes.organization.calls).toEqual([]);
    },
  );
});

describe('edges', () => {
  it('marks an application with no current release handing_over, opening nothing for it', async () => {
    const [, api] = world.apps;
    await adminDb.hostedApplication.update({
      where: { id: api!.id },
      data: { currentReleaseId: null },
    });
    await start();
    await drain();
    const row = (await apps()).find((a) => a.id === api!.id)!;
    expect(row).toMatchObject({ state: 'handing_over', upstreamAddress: null });
    expect(fakes.log).not.toContain(`open_upstream:mh-${api!.repoId}`);
  });

  it('leaves an application already off Motir alone', async () => {
    const [, api] = world.apps;
    await adminDb.hostedApplication.update({
      where: { id: api!.id },
      data: { state: 'grace' },
    });
    await start();
    await drain();
    expect((await apps()).find((a) => a.id === api!.id)!.state).toBe('grace');
    expect(fakes.log).not.toContain(`open_upstream:mh-${api!.repoId}`);
  });

  it('fails a step whose account lost its AWS account id, naming why', async () => {
    await start();
    await adminDb.hostingTenantAccount.update({
      where: { id: world.tenantAccountId },
      data: { awsAccountId: null },
    });
    await drain();
    const row = await stepRow('destroy_previews');
    expect(row.status).toBe('failed');
    expect(row.lastError).toMatch(/^TENANT_ACCOUNT_NOT_READY: /);
  });

  it('records an untyped failure by its name, strikes the owner’s address, and a thrown non-error as unknown', async () => {
    const deps = {
      ...fakes.deps,
      githubAccountIdOf: async () => {
        throw new Error(`no GitHub account for ${OWNER_EMAIL}`);
      },
    };
    await start();
    await handover.advance(world.tenantAccountId, deps);
    await handover.advance(world.tenantAccountId, deps);
    const first = await stepRow('create_deploy_role');
    expect(first.lastError).toBe('Error: no GitHub account for [owner email]');
    expect(first.lastError).not.toContain(OWNER_EMAIL);

    await handover.retry(world.tenantAccountId, admin, fakes.deps);
    await handover.advance(world.tenantAccountId, {
      ...fakes.deps,
      githubAccountIdOf: async () => {
        throw 'down';
      },
    });
    expect((await stepRow('create_deploy_role')).lastError).toBe('UnknownError: ');
  });

  it('withdraws production configuration and transfers through the shipped services by default', async () => {
    const { productionRepositoryConfigService } =
      await import('@/lib/services/productionRepositoryConfigService');
    const { projectRepoTakeoverService } =
      await import('@/lib/services/projectRepoTakeoverService');
    const removed = vi
      .spyOn(productionRepositoryConfigService, 'removeFromRepository')
      .mockResolvedValue(undefined);
    const transferred = vi
      .spyOn(projectRepoTakeoverService, 'requestTakeover')
      .mockResolvedValue({} as never);
    fakes.deps.removeProductionConfig = undefined;
    fakes.deps.requestTakeover = undefined;
    await walkAll();
    expect(removed.mock.calls.map(([repo]) => repo.id).sort()).toEqual(
      world.repos.map((r) => r.id).sort(),
    );
    expect(transferred.mock.calls.map(([rowId]) => rowId).sort()).toEqual(
      world.repos.map((r) => r.id).sort(),
    );
    expect((await account()).state).toBe('handed_over');
  });
});
