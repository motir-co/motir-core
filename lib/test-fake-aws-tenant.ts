// A FAKE AWS TENANT ACCOUNT THE ACCEPTANCE LANE SHARES ACROSS PROCESSES (Story
// MOTIR-9800 · MOTIR-12141). Node-only, installed from `lib/test-mock-seams.ts`
// whenever `MOTIR_FAKE_AWS_TENANT_STATE_PATH` is set — by the webServer
// (`instrumentation.ts`) and the job worker (`scripts/worker.ts`) alike — and
// dormant everywhere else.
//
// ⚠️ IT FAKES THE PROVIDER, NOT THE HANDOVER. The override sits in the shipped
// factories (`createAwsManagementApi`, `createTenantClients`,
// `createTenantMemberIam` — `@motir/orchestrator`'s `testOverrides.ts`), so the
// REAL handover (`createTenantHandover`) and the REAL saga
// (`tenantAccountHandoverService`) run against it: their stack parsing, their
// trust documents, their resume logic. Only what AWS would answer is faked.
//
// ⚠️ ONE FILE, KEYED BY ACCOUNT, and the in-package fakes do the answering. The
// handover's webServer half and its worker half share no memory, so every
// CloudFormation and IAM call reads the file, HYDRATES the package's own
// in-process fakes (`createFakeTenantCloudFormation`,
// `createFakeTenantIamAccount`) with that account's state, makes the call on
// them, and writes the state back whole (`replaceFixtureFileSync`: a sibling
// renamed over). So a refusal here is the in-process fake's refusal — the deploy
// role's scope, a role that no longer trusts the management account — not a
// second, drifting copy. A missing or unreadable file reads as no accounts. Last
// write wins, with no lock: the lane runs its specs serially.
//
// The other tenant services (RDS Data, Lambda, ECS, …) are the package's
// in-process fakes, per process: the handover reaches them only through a
// preview's destroy, whose database teardown is per call. The management API
// fakes only what the handover calls; anything else is the not-configured error
// the lane gave before, when no management role was set at all.
//
// The spec steers and reads it through `tests/e2e/_helpers/takeover-handover.ts`.
// File access goes through `lib/test-fixture-file.ts` — the NFT-tracing rule its
// header documents.

import { randomInt } from 'node:crypto';
import {
  AWS_MEMBER_ROLE_NAME,
  AwsManagementApiError,
  FAKE_MANAGEMENT_ACCOUNT_ID,
  OrchestratorNotConfiguredError,
  TenantRoleUnavailableError,
  createFakeTenantClients,
  createFakeTenantCloudFormation,
  createFakeTenantIamAccount,
  fakeTenantStackOutputs,
  seedFakeTenantIam,
  setAwsManagementOverrideForTests,
  setAwsTenantClientsOverrideForTests,
  type AwsManagementApi,
  type AwsPrimaryEmailUpdateStatus,
  type AwsStandaloneReadiness,
  type FakeIamPolicy,
  type FakeIamRole,
  type FakeStackRecord,
  type FakeTenantCloudFormation,
  type FakeTenantIamAccount,
  type TenantClients,
  type TenantCloudFormation,
  type TenantIam,
  type TenantPolicyDocument,
  type TenantStackWrite,
} from '@motir/orchestrator';
import {
  fixtureFileExistsSync,
  readFixtureFileSync,
  removeFixtureFileSync,
  replaceFixtureFileSync,
} from '@/lib/test-fixture-file';

/** The state file every lane process shares. */
export const FAKE_AWS_TENANT_STATE_PATH_ENV = 'MOTIR_FAKE_AWS_TENANT_STATE_PATH';

/** The management role the lane names: in the account the in-package IAM fake
 *  trusts as Motir's management account. A placeholder — no credential. */
export const FAKE_AWS_ORG_ADMIN_ROLE_ARN = `arn:aws:iam::${FAKE_MANAGEMENT_ACCOUNT_ID}:role/motir-org-admin`;

/** The deploy role's name in a tenant account. */
const DEPLOY_ROLE = 'motir-tenant-deploy';

// ── The file ────────────────────────────────────────────────────────────────

/** One stack, as the file holds it. */
export interface StoredTenantStack {
  status: string;
  templateBody: string;
  parameters: Record<string, string>;
  tags: Record<string, string>;
  outputs: Record<string, string>;
  pendingPolls: number;
  settlesTo: string;
  next: TenantStackWrite | null;
  createdAt: string;
}

/** One role, as the file holds it. */
export interface StoredTenantRole {
  path: string;
  trust: TenantPolicyDocument;
  inline: Record<string, TenantPolicyDocument>;
  attached: string[];
  description: string;
  maxSessionSeconds: number;
  tags: Record<string, string>;
  instanceProfiles: string[];
}

/** The account's primary-email update in flight, with its one-time code. */
export interface StoredEmailUpdate {
  email: string;
  code: string;
  status: AwsPrimaryEmailUpdateStatus;
  updatedAt: string;
}

/** One tenant account, as the file holds it. */
export interface StoredTenantAccount {
  stacks: Record<string, StoredTenantStack>;
  iam: {
    roles: Record<string, StoredTenantRole>;
    policies: Record<string, FakeIamPolicy>;
    instanceProfiles: string[];
  };
  organization: {
    inOrganization: boolean;
    primaryEmail: string;
    emailUpdate: StoredEmailUpdate | null;
    /** AWS's standalone requirements: the readable two, and the three only the
     *  removal itself can judge (payment, support plan, contact information). */
    standalone: {
      waitPeriodMet: boolean;
      delegatedServices: string[];
      unreadableMet: boolean;
    };
  };
}

/** One entry of the call log. `construct` is a tenant-client construction (a
 *  session that would assume a role into the account); `operation` is a call
 *  that changed something. */
export interface FakeTenantCall {
  accountId: string;
  kind: 'construct' | 'operation';
  /** Whose session: the deploy role, the member access role, or the
   *  management account's own API. */
  as: 'deploy' | 'member' | 'management';
  operation: string;
  target: string;
  at: string;
}

export interface FakeAwsTenantState {
  accounts: Record<string, StoredTenantAccount>;
  calls: FakeTenantCall[];
}

/** The names a key may never be: each reaches `Object.prototype` through the
 *  plain records the file parses into. */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function safeKey(key: string): string {
  if (UNSAFE_KEYS.has(key)) throw new Error(`"${key}" is not a fake AWS tenant key`);
  return key;
}

/** The state file's path, or null when the seam is off. */
export function fakeAwsTenantStatePath(): string | null {
  const raw = process.env[FAKE_AWS_TENANT_STATE_PATH_ENV]?.trim();
  return raw ? raw : null;
}

function requiredPath(): string {
  const path = fakeAwsTenantStatePath();
  if (!path) {
    throw new Error(`${FAKE_AWS_TENANT_STATE_PATH_ENV} is not set — the fake AWS tenant is off`);
  }
  return path;
}

const emptyState = (): FakeAwsTenantState => ({ accounts: {}, calls: [] });

/** What the file holds — no accounts when it is missing or unreadable. */
export function readFakeAwsTenantState(): FakeAwsTenantState {
  const path = requiredPath();
  if (!fixtureFileExistsSync(path)) return emptyState();
  try {
    const parsed = JSON.parse(readFixtureFileSync(path)) as Partial<FakeAwsTenantState>;
    return { accounts: parsed.accounts ?? {}, calls: parsed.calls ?? [] };
  } catch {
    return emptyState();
  }
}

/** Replace the file with `state`, whole. */
export function writeFakeAwsTenantState(state: FakeAwsTenantState): void {
  replaceFixtureFileSync(requiredPath(), JSON.stringify(state));
}

/** Read, change and write the file in one synchronous step. */
export function updateFakeAwsTenantState<T>(change: (state: FakeAwsTenantState) => T): T {
  const state = readFakeAwsTenantState();
  const answer = change(state);
  writeFakeAwsTenantState(state);
  return answer;
}

/** Forget every account, the call log and any armed failure. */
export function resetFakeAwsTenant(): void {
  writeFakeAwsTenantState(emptyState());
  removeFixtureFileSync(failurePath());
}

// ── Take-once failures (a sidecar, so taking one never rewrites the state) ──

const failurePath = () => `${requiredPath()}.fail.json`;

function armedFailures(): string[] {
  const path = failurePath();
  if (!fixtureFileExistsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFixtureFileSync(path)) as { operations?: unknown };
    return Array.isArray(parsed.operations)
      ? parsed.operations.filter((o): o is string => typeof o === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Make the NEXT call of `operation` — `<service>.<method>`, e.g.
 *  `cloudformation.deleteStack`, `iam.deleteRole`,
 *  `management.removeAccountFromOrganization` — fail once, in whichever process
 *  makes it. */
export function armFakeAwsTenantFailure(operation: string): void {
  replaceFixtureFileSync(
    failurePath(),
    JSON.stringify({ operations: [...armedFailures(), operation] }),
  );
}

/** Consume an armed failure of `operation`: answers whether one was armed. */
function takeFailure(operation: string): boolean {
  const armed = armedFailures();
  const index = armed.indexOf(operation);
  if (index < 0) return false;
  armed.splice(index, 1);
  replaceFixtureFileSync(failurePath(), JSON.stringify({ operations: armed }));
  return true;
}

// ── Seeding ─────────────────────────────────────────────────────────────────

/** A stack to seed, settled (`CREATE_COMPLETE` unless said otherwise). */
export interface SeedTenantStack {
  parameters?: Record<string, string>;
  tags?: Record<string, string>;
  outputs?: Record<string, string>;
  status?: string;
  templateBody?: string;
}

export interface SeedTenantAccount {
  accountId: string;
  region?: string;
  primaryEmail: string;
  stacks?: Record<string, SeedTenantStack>;
}

/** A tenant account as Motir provisions one: in the Organization, its member
 *  access role and deploy role trusting the management account, the given
 *  stacks settled, and AWS's standalone requirements not yet met. Replaces any
 *  account of that id. */
export function seedFakeAwsTenantAccount(input: SeedTenantAccount): void {
  const iam = createFakeTenantIamAccount({ accountId: input.accountId });
  seedFakeTenantIam(iam);
  const outputsOf = fakeTenantStackOutputs(input.accountId, input.region ?? 'us-east-1');
  const stacks: Record<string, StoredTenantStack> = {};
  for (const [name, stack] of Object.entries(input.stacks ?? {})) {
    const parameters = stack.parameters ?? {};
    stacks[safeKey(name)] = {
      status: stack.status ?? 'CREATE_COMPLETE',
      templateBody: stack.templateBody ?? '{}',
      parameters,
      tags: stack.tags ?? {},
      outputs: stack.outputs ?? outputsOf(name, parameters, 1),
      pendingPolls: 0,
      settlesTo: stack.status ?? 'CREATE_COMPLETE',
      next: null,
      createdAt: new Date().toISOString(),
    };
  }
  updateFakeAwsTenantState((state) => {
    state.accounts[safeKey(input.accountId)] = {
      stacks,
      iam: storeIam(iam),
      organization: {
        inOrganization: true,
        primaryEmail: input.primaryEmail,
        emailUpdate: null,
        standalone: { waitPeriodMet: false, delegatedServices: [], unreadableMet: false },
      },
    };
  });
}

/** Mark AWS's standalone requirements met, as the new owner does at AWS: the
 *  wait over, no delegated administration, payment, support and contact set. */
export function markFakeAwsTenantStandalone(accountId: string): void {
  updateFakeAwsTenantState((state) => {
    const account = accountOf(state, accountId);
    account.organization.standalone = {
      waitPeriodMet: true,
      delegatedServices: [],
      unreadableMet: true,
    };
  });
}

// ── Hydrating the in-package fakes ──────────────────────────────────────────

function accountOf(state: FakeAwsTenantState, accountId: string): StoredTenantAccount {
  const account = state.accounts[safeKey(accountId)];
  if (!account) {
    // AWS answers an account it does not know with a refused assume.
    throw new TenantRoleUnavailableError(accountId, 'AccessDenied');
  }
  return account;
}

function storeRole(role: FakeIamRole): StoredTenantRole {
  return {
    path: role.path,
    trust: role.trust,
    inline: Object.fromEntries(role.inline),
    attached: [...role.attached],
    description: role.description,
    maxSessionSeconds: role.maxSessionSeconds,
    tags: role.tags,
    instanceProfiles: [...role.instanceProfiles],
  };
}

function storeIam(iam: FakeTenantIamAccount): StoredTenantAccount['iam'] {
  return {
    roles: Object.fromEntries([...iam.roles].map(([name, role]) => [name, storeRole(role)])),
    policies: Object.fromEntries(iam.policies),
    instanceProfiles: [...iam.instanceProfiles],
  };
}

function hydrateIam(accountId: string, stored: StoredTenantAccount['iam']): FakeTenantIamAccount {
  const iam = createFakeTenantIamAccount({ accountId });
  for (const [name, role] of Object.entries(stored.roles)) {
    iam.putRole(name, {
      path: role.path,
      trust: role.trust,
      inline: new Map(Object.entries(role.inline)),
      attached: new Set(role.attached),
      description: role.description,
      maxSessionSeconds: role.maxSessionSeconds,
      tags: role.tags,
      instanceProfiles: new Set(role.instanceProfiles),
    });
  }
  for (const [arn, policy] of Object.entries(stored.policies)) iam.policies.set(arn, policy);
  for (const profile of stored.instanceProfiles) iam.instanceProfiles.add(profile);
  return iam;
}

function storeStacks(cf: FakeTenantCloudFormation): Record<string, StoredTenantStack> {
  return Object.fromEntries(
    [...cf.stacks].map(([name, record]) => [
      name,
      { ...record, createdAt: record.createdAt.toISOString() } satisfies StoredTenantStack,
    ]),
  );
}

function hydrateStacks(
  accountId: string,
  region: string,
  stored: Record<string, StoredTenantStack>,
): FakeTenantCloudFormation {
  const cf = createFakeTenantCloudFormation({ outputs: fakeTenantStackOutputs(accountId, region) });
  const stacks = cf.stacks as Map<string, FakeStackRecord>;
  for (const [name, record] of Object.entries(stored)) {
    stacks.set(name, { ...record, createdAt: new Date(record.createdAt) });
  }
  return cf;
}

/** The writes worth logging: a call that changes something. */
const MUTATING = /^(create|update|delete|put|detach|remove|start|accept|attach)/;

function logCall(state: FakeAwsTenantState, call: Omit<FakeTenantCall, 'at'>): void {
  state.calls.push({ ...call, at: new Date().toISOString() });
}

/** The deploy session is refused, as AWS refuses the assume, once the deploy
 *  role is gone or no longer trusts the management account — the handover's
 *  removal of Motir's access. */
function assertDeployAssumable(accountId: string, account: StoredTenantAccount): void {
  const role = account.iam.roles[DEPLOY_ROLE];
  const trusted =
    role?.trust.Statement.some(
      (st) =>
        st['Effect'] === 'Allow' &&
        JSON.stringify(st['Principal'] ?? '').includes(`:${FAKE_MANAGEMENT_ACCOUNT_ID}:`),
    ) ?? false;
  if (!trusted) throw new TenantRoleUnavailableError(accountId, 'AccessDenied');
}

function injected(service: string, operation: string): AwsManagementApiError {
  return new AwsManagementApiError(service, `InjectedFault:${operation}`, 500);
}

// ── The file-backed tenant clients ──────────────────────────────────────────

function fileBackedCloudFormation(accountId: string, region: string): TenantCloudFormation {
  async function call<T>(
    operation: keyof TenantCloudFormation,
    target: string,
    act: (cf: FakeTenantCloudFormation) => Promise<T>,
  ): Promise<T> {
    if (takeFailure(`cloudformation.${operation}`)) throw injected('cloudformation', operation);
    const state = readFakeAwsTenantState();
    const account = accountOf(state, accountId);
    assertDeployAssumable(accountId, account);
    const cf = hydrateStacks(accountId, region, account.stacks);
    const answer = await act(cf);
    // A describe settles an in-progress stack, so every call writes back.
    account.stacks = storeStacks(cf);
    if (MUTATING.test(operation))
      logCall(state, {
        accountId,
        kind: 'operation',
        as: 'deploy',
        operation: `cloudformation.${operation}`,
        target,
      });
    writeFakeAwsTenantState(state);
    return answer;
  }
  return {
    listStacks: () => call('listStacks', '*', (cf) => cf.listStacks()),
    describeStack: (name) => call('describeStack', name, (cf) => cf.describeStack(name)),
    getTemplateBody: (name) => call('getTemplateBody', name, (cf) => cf.getTemplateBody(name)),
    createStack: (input) => call('createStack', input.name, (cf) => cf.createStack(input)),
    updateStack: (input) => call('updateStack', input.name, (cf) => cf.updateStack(input)),
    deleteStack: (name) => call('deleteStack', name, (cf) => cf.deleteStack(name)),
  };
}

function fileBackedIam(accountId: string, as: 'deploy' | 'member'): TenantIam {
  const principal = as === 'deploy' ? DEPLOY_ROLE : AWS_MEMBER_ROLE_NAME;
  function call<K extends keyof TenantIam>(operation: K, target: string) {
    return async (
      ...args: Parameters<TenantIam[K]>
    ): Promise<Awaited<ReturnType<TenantIam[K]>>> => {
      if (takeFailure(`iam.${operation}`)) throw injected('iam', operation);
      const state = readFakeAwsTenantState();
      const account = accountOf(state, accountId);
      const iam = hydrateIam(accountId, account.iam);
      const session = iam.session(principal);
      const method = session[operation] as (
        ...a: Parameters<TenantIam[K]>
      ) => ReturnType<TenantIam[K]>;
      const answer = await method(...args);
      if (iam.writes.length > 0) {
        account.iam = storeIam(iam);
        logCall(state, { accountId, kind: 'operation', as, operation: `iam.${operation}`, target });
        writeFakeAwsTenantState(state);
      }
      return answer as Awaited<ReturnType<TenantIam[K]>>;
    };
  }
  const first = (...args: unknown[]) => String(args[0] ?? '*');
  const methods: (keyof TenantIam)[] = [
    'getRole',
    'createRole',
    'updateAssumeRolePolicy',
    'getRolePolicy',
    'putRolePolicy',
    'deleteRolePolicy',
    'listRolePolicies',
    'listAttachedRolePolicies',
    'detachRolePolicy',
    'listInstanceProfilesForRole',
    'removeRoleFromInstanceProfile',
    'deleteInstanceProfile',
    'deleteRole',
    'listRoles',
    'listPolicies',
    'deletePolicy',
  ];
  return Object.fromEntries(
    methods.map((operation) => [
      operation,
      (...args: unknown[]) => {
        const target =
          operation === 'createRole'
            ? String((args[0] as { name?: string } | undefined)?.name ?? '*')
            : first(...args);
        return (call(operation, target) as (...a: unknown[]) => Promise<unknown>)(...args);
      },
    ]),
  ) as unknown as TenantIam;
}

function logConstruction(accountId: string, as: 'deploy' | 'member'): void {
  updateFakeAwsTenantState((state) =>
    logCall(state, { accountId, kind: 'construct', as, operation: 'session', target: accountId }),
  );
}

/** One tenant account's clients on its deploy role — what `createTenantClients`
 *  answers while the seam is installed. */
export function fakeAwsTenantClients(target: { accountId: string; region: string }): TenantClients {
  logConstruction(target.accountId, 'deploy');
  const rest = createFakeTenantClients({ accountId: target.accountId, region: target.region });
  return {
    ...rest,
    accountId: target.accountId,
    region: target.region,
    cloudformation: fileBackedCloudFormation(target.accountId, target.region),
    iam: fileBackedIam(target.accountId, 'deploy'),
  };
}

/** The account's IAM on its member access role — what `createTenantMemberIam`
 *  answers while the seam is installed. */
export function fakeAwsTenantMemberIam(target: { accountId: string; region: string }): TenantIam {
  logConstruction(target.accountId, 'member');
  return fileBackedIam(target.accountId, 'member');
}

// ── The management API ──────────────────────────────────────────────────────

/** The calls the handover makes of the management account, file-backed. */
type FakedManagement = Pick<
  AwsManagementApi,
  | 'startPrimaryEmailUpdate'
  | 'acceptPrimaryEmailUpdate'
  | 'getPrimaryEmail'
  | 'getPrimaryEmailUpdateStatus'
  | 'readStandaloneReadiness'
  | 'removeAccountFromOrganization'
>;

function managementCall<T>(
  operation: keyof FakedManagement,
  accountId: string,
  act: (account: StoredTenantAccount, state: FakeAwsTenantState) => T,
): Promise<T> {
  if (takeFailure(`management.${operation}`)) {
    return Promise.reject(injected('organizations', operation));
  }
  try {
    const state = readFakeAwsTenantState();
    const account = state.accounts[safeKey(accountId)];
    if (!account) throw new AwsManagementApiError('organizations', 'AccountNotFoundException', 400);
    const answer = act(account, state);
    if (MUTATING.test(operation) || operation === 'getPrimaryEmailUpdateStatus') {
      if (MUTATING.test(operation)) {
        logCall(state, {
          accountId,
          kind: 'operation',
          as: 'management',
          operation: `management.${operation}`,
          target: accountId,
        });
      }
      writeFakeAwsTenantState(state);
    }
    return Promise.resolve(answer);
  } catch (err) {
    return Promise.reject(err);
  }
}

/** A one-time code as AWS mails one: six digits. */
const oneTimeCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

const fakedManagement: FakedManagement = {
  startPrimaryEmailUpdate: (accountId, email) =>
    managementCall('startPrimaryEmailUpdate', accountId, (account) => {
      account.organization.emailUpdate = {
        email,
        code: oneTimeCode(),
        status: 'PENDING',
        updatedAt: new Date().toISOString(),
      };
      return { status: 'PENDING' as const };
    }),

  acceptPrimaryEmailUpdate: (accountId, email, code) =>
    managementCall('acceptPrimaryEmailUpdate', accountId, (account) => {
      const update = account.organization.emailUpdate;
      if (!update || update.status !== 'PENDING') {
        return { outcome: 'code_refused' as const, reason: 'ResourceNotFoundException' };
      }
      if (update.email.toLowerCase() !== email.trim().toLowerCase() || update.code !== code) {
        return { outcome: 'code_refused' as const, reason: 'ValidationException' };
      }
      // AWS moves the address on acceptance; the update reads ACCEPTED until
      // its next status read settles it COMPLETED.
      account.organization.primaryEmail = update.email;
      account.organization.emailUpdate = {
        ...update,
        status: 'ACCEPTED',
        updatedAt: new Date().toISOString(),
      };
      return { outcome: 'accepted' as const, status: 'ACCEPTED' as const };
    }),

  getPrimaryEmail: (accountId) =>
    managementCall('getPrimaryEmail', accountId, (account) => account.organization.primaryEmail),

  getPrimaryEmailUpdateStatus: (accountId) =>
    managementCall('getPrimaryEmailUpdateStatus', accountId, (account) => {
      const update = account.organization.emailUpdate;
      if (!update) return null;
      const answer = { status: update.status, updatedAt: new Date(update.updatedAt) };
      if (update.status === 'ACCEPTED') update.status = 'COMPLETED';
      return answer;
    }),

  readStandaloneReadiness: (accountId) =>
    managementCall('readStandaloneReadiness', accountId, (account): AwsStandaloneReadiness => {
      const { inOrganization, standalone } = account.organization;
      const waitPeriod = {
        status: standalone.waitPeriodMet ? ('met' as const) : ('not_met' as const),
        eligibleAt: null,
      };
      const delegatedAdministrator = {
        status: standalone.delegatedServices.length === 0 ? ('met' as const) : ('not_met' as const),
        services: standalone.delegatedServices,
      };
      const blocked =
        waitPeriod.status === 'not_met' || delegatedAdministrator.status === 'not_met';
      return {
        inOrganization,
        waitPeriod,
        delegatedAdministrator,
        paymentMethod: 'unknown',
        supportPlan: 'unknown',
        contactInformation: 'unknown',
        ready: inOrganization && blocked ? false : null,
      };
    }),

  removeAccountFromOrganization: (accountId) =>
    managementCall('removeAccountFromOrganization', accountId, (account) => {
      const { organization } = account;
      if (!organization.inOrganization) return { outcome: 'removed' as const };
      const missing: string[] = [];
      if (!organization.standalone.waitPeriodMet) missing.push('wait_period');
      if (organization.standalone.delegatedServices.length > 0) {
        missing.push('delegated_administrator');
      }
      if (!organization.standalone.unreadableMet) {
        missing.push('payment_method', 'support_plan', 'contact_information');
      }
      if (missing.length > 0) return { outcome: 'not_ready' as const, missing };
      organization.inOrganization = false;
      return { outcome: 'removed' as const };
    }),
};

/** The management API the seam installs: the handover's calls file-backed,
 *  every other call the not-configured error the lane gave before it named a
 *  management role. */
export function fakeAwsTenantManagementApi(): AwsManagementApi {
  return new Proxy(fakedManagement as AwsManagementApi, {
    get(target, property, receiver) {
      if (typeof property === 'string' && !(property in target)) {
        return () =>
          Promise.reject(
            new OrchestratorNotConfiguredError(
              `the acceptance lane's fake AWS tenant does not fake ${property}`,
            ),
          );
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/** Wire the fake behind the shipped factories. Called once per process, from
 *  the seam table. */
export function installFakeAwsTenantSeam(): void {
  setAwsManagementOverrideForTests(() => fakeAwsTenantManagementApi());
  setAwsTenantClientsOverrideForTests({
    clients: fakeAwsTenantClients,
    memberIam: fakeAwsTenantMemberIam,
  });
}

/** Take the fake down — for unit tests. */
export function uninstallFakeAwsTenantSeam(): void {
  setAwsManagementOverrideForTests(null);
  setAwsTenantClientsOverrideForTests(null);
}
