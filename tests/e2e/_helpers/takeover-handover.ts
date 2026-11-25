import { HANDOVER_DEPLOY_ROLE, type TenantPolicyDocument } from '@motir/orchestrator';
import { hostingFakeControls } from '@/lib/orchestrator/hosting';
import {
  FAKE_AWS_TENANT_STATE_PATH_ENV,
  armFakeAwsTenantFailure,
  markFakeAwsTenantStandalone,
  readFakeAwsTenantState,
  resetFakeAwsTenant,
  seedFakeAwsTenantAccount,
  type FakeTenantCall,
  type SeedTenantStack,
} from '@/lib/test-fake-aws-tenant';

// THE SPEC'S HALF OF THE TAKEOVER HANDOVER'S FAKES (Story MOTIR-9800 ·
// MOTIR-12141). The webServer starts the handover and takes the owner's email
// code, the job worker advances its steps, and a spec seeds and reads the AWS
// tenant they act on through the same file the lane config points all three at
// (`lib/test-fake-aws-tenant.ts`). The Fly grace window's reads come from the
// grace-window fakes and are re-exported here, so a takeover spec needs this
// helper alone. Imports nothing that opens a database.

export {
  armFakePgDumpFailure,
  fakeDatabaseExists,
  readFakeExportDump,
} from './hosting-grace-fakes';
export { armFakeAwsTenantFailure as failTenantOperationOnce };

/** Loud when the lane carries no tenant store: a seed would then reach nobody. */
function requireTenantSeam(): void {
  if (!process.env[FAKE_AWS_TENANT_STATE_PATH_ENV]?.trim()) {
    throw new Error(
      `${FAKE_AWS_TENANT_STATE_PATH_ENV} is not set — run under the acceptance lane, whose config defaults it`,
    );
  }
}

/** One production application in the tenant account, by repository id (the
 *  `mh-<rid>` app ref's `<rid>`). */
export interface TakeoverTenantApp {
  repositoryId: string;
  shape: 'function' | 'container';
  /** Seed an open preview of this pull request too: its release and database. */
  previewPullRequest?: number;
}

export interface TakeoverTenantSeed {
  accountId: string;
  /** The account's primary email before the handover moves it. */
  primaryEmail: string;
  apps: readonly TakeoverTenantApp[];
}

/** The stacks the shipped adapter names for an app (`motir-release-<appRef>`,
 *  `motir-database-<rid>[-pr<n>]`). */
function stacksOf(app: TakeoverTenantApp): Record<string, SeedTenantStack> {
  const appRef = `mh-${app.repositoryId}`;
  // `shapeOfReleaseStack` reads a release's shape off the parameter only that
  // shape's template declares (`TaskCpu` / `InvokePrincipalArn`); without it a
  // preview teardown reads the release as absent and leaves its stack standing.
  const shapeParameter: Record<string, string> =
    app.shape === 'container'
      ? { TaskCpu: '256' }
      : { InvokePrincipalArn: `arn:aws:iam::${'0'.repeat(12)}:role/motir-edge-invoke` };
  const release = (ref: string): SeedTenantStack => ({
    parameters: { AppRef: ref, Shape: app.shape, OriginAccess: 'secret', ...shapeParameter },
    tags: { 'motir:app': ref },
  });
  const stacks: Record<string, SeedTenantStack> = {
    [`motir-release-${appRef}`]: release(appRef),
    [`motir-database-${app.repositoryId}`]: {},
    [`motir-registry-${app.repositoryId}`]: {},
  };
  if (app.previewPullRequest !== undefined) {
    const n = app.previewPullRequest;
    stacks[`motir-release-${appRef}-pr${n}`] = release(`${appRef}-pr${n}`);
    stacks[`motir-database-${app.repositoryId}-pr${n}`] = {};
  }
  return stacks;
}

/** Seed the tenant account a takeover hands over: its production apps' stacks
 *  (and any preview's), Motir's roles, in the Organization, standalone not yet
 *  met. Replaces any account of that id. Answers the stack names seeded. */
export function seedTakeoverTenant(seed: TakeoverTenantSeed): string[] {
  requireTenantSeam();
  const stacks = Object.assign({}, ...seed.apps.map(stacksOf)) as Record<string, SeedTenantStack>;
  seedFakeAwsTenantAccount({ accountId: seed.accountId, primaryEmail: seed.primaryEmail, stacks });
  return Object.keys(stacks).sort();
}

/** The one-time code AWS "mailed" for the pending primary-email update, or
 *  null when none is pending. */
export function readTenantEmailCode(accountId: string): string | null {
  requireTenantSeam();
  const update = readFakeAwsTenantState().accounts[accountId]?.organization.emailUpdate;
  return update && update.status === 'PENDING' ? update.code : null;
}

/** The new owner met AWS's standalone requirements. */
export function markTenantStandaloneDone(accountId: string): void {
  requireTenantSeam();
  markFakeAwsTenantStandalone(accountId);
}

/** What a spec reads back about the account. */
export interface TenantAccountView {
  stacks: Array<{ name: string; status: string; parameters: Record<string, string> }>;
  roles: Record<string, { path: string; trust: TenantPolicyDocument }>;
  inOrganization: boolean;
  primaryEmail: string;
  emailUpdateStatus: string | null;
}

/** The account as the fake holds it now, or null when it was never seeded. */
export function readTenantAccount(accountId: string): TenantAccountView | null {
  requireTenantSeam();
  const account = readFakeAwsTenantState().accounts[accountId];
  if (!account) return null;
  return {
    stacks: Object.entries(account.stacks)
      .map(([name, stack]) => ({ name, status: stack.status, parameters: stack.parameters }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    roles: Object.fromEntries(
      Object.entries(account.iam.roles).map(([name, role]) => [
        name,
        { path: role.path, trust: role.trust },
      ]),
    ),
    inOrganization: account.organization.inOrganization,
    primaryEmail: account.organization.primaryEmail,
    emailUpdateStatus: account.organization.emailUpdate?.status ?? null,
  };
}

/** The GitHub-OIDC subjects the handover deploy role trusts — one
 *  `repository_owner_id:<owner>:repository_id:<id>:*` per repository — or an
 *  empty list when the role does not exist. */
export function handoverRoleSubjects(accountId: string): string[] {
  const trust = readTenantAccount(accountId)?.roles[HANDOVER_DEPLOY_ROLE]?.trust;
  if (!trust) return [];
  return trust.Statement.flatMap((statement) => {
    const like = (statement['Condition'] as { StringLike?: Record<string, unknown> } | undefined)
      ?.StringLike;
    return Object.entries(like ?? {})
      .filter(([key]) => key.endsWith(':sub'))
      .flatMap(([, value]) => (Array.isArray(value) ? value.map(String) : [String(value)]));
  });
}

/** The roles whose trust still names `principalAccountId` — after Motir's
 *  access is removed, none may name the management account. */
export function rolesTrusting(accountId: string, principalAccountId: string): string[] {
  const view = readTenantAccount(accountId);
  return Object.entries(view?.roles ?? {})
    .filter(([, role]) => JSON.stringify(role.trust).includes(`:${principalAccountId}:`))
    .map(([name]) => name)
    .sort();
}

/** The account's call log: every tenant-client construction and every call
 *  that changed something, in order — optionally only those at or after `since`. */
export function tenantCalls(accountId: string, since?: Date): FakeTenantCall[] {
  requireTenantSeam();
  return readFakeAwsTenantState().calls.filter(
    (call) =>
      call.accountId === accountId && (!since || new Date(call.at).getTime() >= since.getTime()),
  );
}

/** The address `openUpstream` opened an AWS app's production release at, or
 *  null while it is not open. */
export function openedUpstreamOf(appRef: string): string | null {
  return hostingFakeControls('aws').app(appRef)?.openedUpstream ?? null;
}

/** Forget the tenant account, its call log and any armed failure. */
export function resetTakeoverTenant(): void {
  requireTenantSeam();
  resetFakeAwsTenant();
}
