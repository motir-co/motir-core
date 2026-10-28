import {
  AwsAccountCreationRefusedError,
  AwsManagementApiError,
  AwsStackOutputsMissingError,
  awsAgentHosterPolicyDocument,
  awsRunnerPolicyDocument,
  type AwsManagementApi,
  type AwsOrganizationAccount,
  type AwsPolicyDocument,
  type AwsQuotaTarget,
  type AwsSessionCredentials,
  type AwsStackInstanceTarget,
} from '@motir/orchestrator';
import { vi } from 'vitest';
import { AWS_POOL_DEFINITION_ENV, awsPoolUnitEnvName } from '@/lib/fleetShards/awsPoolDefinition';
import { SHARD_VCPU_QUOTA_TARGET } from '@/lib/ciFleet/shardTargets';

// The fakes `fleet-admin add-shard --provider aws` runs against (MOTIR-9278),
// shared by its own tests and the story's seam test (MOTIR-9280): GitHub stubbed
// at `fetch` (the Enterprise org and App installation the shared steps call), and
// an in-memory AWS organization standing in for `AwsManagementApi`.

export const ADD_SHARD_ENTERPRISE_SLUG = 'moooon-bv';
export const ADD_SHARD_APP_CLIENT_ID = 'Iv1.studio';

export interface GithubWorld {
  orgs: Set<string>;
  installed: Set<string>;
  calls: string[];
}

export function newGithubWorld(): GithubWorld {
  return { orgs: new Set(), installed: new Set(), calls: [] };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Stub `fetch` with the GitHub calls add-shard's shared steps make. */
export function installAddShardGithub(github: GithubWorld, installationToken: string): void {
  const SLUG = ADD_SHARD_ENTERPRISE_SLUG;
  const CLIENT_ID = ADD_SHARD_APP_CLIENT_ID;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const path = url.pathname;
      github.calls.push(`${method} ${path}`);
      if (method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
        return json({ token: installationToken, expires_at: '2099-01-01T00:00:00Z' }, 201);
      }
      if (method === 'GET' && path === '/app/installations') {
        return json([
          { id: 150298786, target_type: 'Organization', account: { login: 'motir-projects' } },
          { id: 174620715, target_type: 'Enterprise', account: { slug: SLUG } },
        ]);
      }
      if (method === 'GET' && path === '/app') return json({ client_id: CLIENT_ID });
      if (method === 'GET' && /^\/orgs\/[^/]+\/installation$/.test(path)) return json({ id: 9001 });
      const org = path.match(/^\/orgs\/([^/]+)$/);
      if (method === 'GET' && org) {
        return github.orgs.has(org[1]!) ? json({ login: org[1], id: 77 }) : json({}, 404);
      }
      if (method === 'POST' && path === '/graphql') {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: { input?: { login: string } };
        };
        if (body.query.includes('enterprise(slug')) {
          return json({ data: { enterprise: { id: 'E_kgDOAAyC2w' } } });
        }
        const login = body.variables.input!.login;
        github.orgs.add(login);
        return json({
          data: { createEnterpriseOrganization: { organization: { login, databaseId: 77 } } },
        });
      }
      const installs = path.match(
        new RegExp(`^/enterprises/${SLUG}/apps/organizations/([^/]+)/installations$`),
      );
      if (installs && method === 'GET') {
        return json(
          github.installed.has(installs[1]!)
            ? [{ id: 5, client_id: CLIENT_ID, app_slug: 'motir-studio' }]
            : [],
        );
      }
      if (installs && method === 'POST') {
        github.installed.add(installs[1]!);
        return json({ id: 5, client_id: CLIENT_ID, app_slug: 'motir-studio' });
      }
      return json({ message: `unstubbed ${method} ${path}` }, 500);
    }),
  );
}

/** A step the fake can be cut off after, once (MOTIR-9940 · MOTIR-9941). */
export type FakeOrganizationStep =
  | 'createOrganizationAccount'
  | 'ensureOrganizationalUnit'
  | 'moveAccountToOrganizationalUnit'
  | 'tenantRoleCreated'
  | 'tenantRolePolicyPut'
  | 'accountTagged'
  | 'quotaRaiseFiled';

/** An in-memory AWS organization: accounts by name, CreateAccount requests, quotas
 *  and IAM users, with every call recorded by name. */
export class FakeOrganization implements AwsManagementApi {
  readonly calls: string[] = [];
  readonly accounts = new Map<string, AwsOrganizationAccount>();
  readonly inProgress = new Map<string, string>();
  quota = SHARD_VCPU_QUOTA_TARGET - 1_000;
  /** Per member account: its granted quota, else `quota` (MOTIR-9458). */
  readonly quotaByAccount = new Map<string, number>();
  /** Per member account: the error its quota read throws (MOTIR-9458). */
  readonly readFailures = new Map<string, Error>();
  /** The quota raises filed, by AWS request id (MOTIR-9459). */
  readonly quotaRequests = new Map<
    string,
    { accountId: string; status: string; desiredValue: number }
  >();
  /** What the next raise filing throws, once. */
  requestFailure: Error | null = null;
  /** Per AWS request id: the error reading it throws. */
  readonly requestReadFailures = new Map<string, Error>();
  createFailure: string | null = null;
  /** Member-account root emails already used — CreateAccount refuses a clash
   *  (MOTIR-9460). */
  readonly usedEmails = new Set<string>();
  /** The member accounts holding the runner role, and its policy (MOTIR-9460). */
  readonly runnerRoles = new Map<string, string>();
  /** Per member account: the error assuming its runner role throws. */
  readonly runnerAssumeFailures = new Map<string, Error>();
  /** Each account's organisational unit (MOTIR-9844); absent means the root. */
  readonly accountUnits = new Map<string, string>();
  /** The pool StackSet's instances, keyed `<stack set>/<account>/<region>`. */
  readonly stackInstances = new Map<
    string,
    { unitId: string; overrides: Record<string, string>; outputs: Record<string, string> }
  >();
  /** The outputs a newly created instance answers. */
  stackOutputs: Record<string, string> = {};
  /** What creating an instance builds, answering its outputs — `buildStacksInto`
   *  seeds the tagged network in the in-memory EC2. Null: `stackOutputs`. */
  stackBuilder:
    | ((
        input: AwsStackInstanceTarget & { parameterOverrides: Record<string, string> },
      ) => Record<string, string>)
    | null = null;
  /** Thrown once by the next `ensureStackInstance` AFTER it records the
   *  instance — a run that dies while waiting for CURRENT. */
  stackInstanceFailure: Error | null = null;
  /** Organizational units under the root, by name to id (MOTIR-9940). */
  readonly organizationalUnits = new Map<string, string>();
  /** Per step: an error thrown ONCE after the step's effect lands, as a pass cut
   *  off after AWS answered would see it (MOTIR-9940). */
  readonly failAfter = new Map<FakeOrganizationStep, Error>();
  /** Per member account: the tenant deploy role's policy, null before it is put
   *  (MOTIR-9941). */
  readonly tenantRoles = new Map<string, string | null>();
  /** Per account: its Organizations tags. */
  readonly accountTags = new Map<string, Map<string, string>>();
  /** Per `<account>:<quotaCode>`: the applied value (0 when unset). */
  readonly appliedQuotas = new Map<string, number>();
  /** Per `<account>:<quotaCode>`: the open raise's desired value. */
  readonly openQuotaRaises = new Map<string, number>();
  private seq = 0;
  private requestSeq = 0;
  private ouSeq = 0;
  /** Which member account each answered session is for. */
  private readonly sessionAccount = new WeakMap<AwsSessionCredentials, string>();

  /** `session` is what every member-role assumption answers. */
  constructor(private readonly session: AwsSessionCredentials) {}

  private nextAccountId(): string {
    this.seq += 1;
    return String(400_000_000_000 + this.seq);
  }

  async findOrganizationAccount(name: string) {
    this.calls.push('findOrganizationAccount');
    return {
      account: this.accounts.get(name) ?? null,
      inProgressRequestId: this.inProgress.get(name) ?? null,
    };
  }

  async createOrganizationAccount(input: { name: string; email: string }) {
    this.calls.push('createOrganizationAccount');
    if (this.createFailure)
      throw new AwsAccountCreationRefusedError(input.name, this.createFailure);
    if (this.usedEmails.has(input.email)) {
      throw new AwsAccountCreationRefusedError(input.name, 'EMAIL_ALREADY_EXISTS');
    }
    this.usedEmails.add(input.email);
    const account = { accountId: this.nextAccountId(), name: input.name, status: 'ACTIVE' };
    this.accounts.set(input.name, account);
    this.failOnceAfter('createOrganizationAccount');
    return account;
  }

  async waitForCreateAccount(requestId: string, name: string) {
    this.calls.push(`waitForCreateAccount:${requestId}`);
    this.inProgress.delete(name);
    const account = { accountId: this.nextAccountId(), name, status: 'ACTIVE' };
    this.accounts.set(name, account);
    return account;
  }

  async assumeMemberRole(accountId: string) {
    this.calls.push(`assumeMemberRole:${accountId}`);
    const session = { ...this.session };
    this.sessionAccount.set(session, accountId);
    return session;
  }

  async readVcpuQuota(credentials: AwsSessionCredentials, regionId: string) {
    this.calls.push(
      `readVcpuQuota:${regionId}:${credentials.accessKeyId === this.session.accessKeyId}`,
    );
    const accountId = this.sessionAccount.get(credentials);
    const failure = accountId ? this.readFailures.get(accountId) : undefined;
    if (failure) throw failure;
    return (accountId ? this.quotaByAccount.get(accountId) : undefined) ?? this.quota;
  }

  async requestVcpuQuotaIncrease(
    credentials: AwsSessionCredentials,
    _regionId: string,
    desired: number,
  ) {
    const accountId = this.sessionAccount.get(credentials) ?? 'unknown';
    this.calls.push(`requestVcpuQuotaIncrease:${accountId}:${desired}`);
    if (this.requestFailure) {
      const failure = this.requestFailure;
      this.requestFailure = null;
      throw failure;
    }
    const open = [...this.quotaRequests.values()].find(
      (r) => r.accountId === accountId && (r.status === 'PENDING' || r.status === 'CASE_OPENED'),
    );
    if (open)
      throw new AwsManagementApiError('service-quotas', 'ResourceAlreadyExistsException', 400);
    this.requestSeq += 1;
    const requestId = `quota-req-${this.requestSeq}`;
    this.quotaRequests.set(requestId, { accountId, status: 'PENDING', desiredValue: desired });
    return { requestId, status: 'PENDING', desiredValue: desired };
  }

  async getQuotaRequest(_credentials: AwsSessionCredentials, _regionId: string, requestId: string) {
    this.calls.push(`getQuotaRequest:${requestId}`);
    const failure = this.requestReadFailures.get(requestId);
    if (failure) throw failure;
    const request = this.quotaRequests.get(requestId);
    if (!request) throw new AwsManagementApiError('service-quotas', 'NoSuchResourceException', 400);
    return { requestId, status: request.status, desiredValue: request.desiredValue };
  }

  async findOpenQuotaRequest(credentials: AwsSessionCredentials) {
    const accountId = this.sessionAccount.get(credentials) ?? 'unknown';
    this.calls.push(`findOpenQuotaRequest:${accountId}`);
    for (const [requestId, r] of this.quotaRequests) {
      if (r.accountId === accountId && (r.status === 'PENDING' || r.status === 'CASE_OPENED')) {
        return { requestId, status: r.status, desiredValue: r.desiredValue };
      }
    }
    return null;
  }

  /** Move a filed raise on, as AWS would; `APPROVED` grants its value (or
   *  `granted`) to the account's quota. */
  settleQuotaRequest(requestId: string, status: string, granted?: number): void {
    const request = this.quotaRequests.get(requestId);
    if (!request) throw new Error(`no fake quota request ${requestId}`);
    request.status = status;
    if (status === 'APPROVED') {
      this.quotaByAccount.set(request.accountId, granted ?? request.desiredValue);
    }
  }

  async ensureRunnerRole(credentials: AwsSessionCredentials, policy: AwsPolicyDocument) {
    const accountId = this.sessionAccount.get(credentials) ?? 'unknown';
    this.calls.push(`ensureRunnerRole:${accountId}`);
    const wanted = JSON.stringify(policy);
    const current = this.runnerRoles.get(accountId);
    this.runnerRoles.set(accountId, wanted);
    if (current === undefined) {
      return { created: ['iam-role:motir-fleet-runner', 'iam-role-policy:motir-fleet-runner-ec2'] };
    }
    return { created: current === wanted ? [] : ['iam-role-policy:motir-fleet-runner-ec2'] };
  }

  async assumeRunnerRole(accountId: string) {
    this.calls.push(`assumeRunnerRole:${accountId}`);
    const failure = this.runnerAssumeFailures.get(accountId);
    if (failure) throw failure;
    if (!this.runnerRoles.has(accountId)) {
      throw new AwsManagementApiError('sts', 'AccessDenied', 403);
    }
    return { ...this.session };
  }

  async assumeTenantDeployRole(accountId: string) {
    this.calls.push(`assumeTenantDeployRole:${accountId}`);
    return { ...this.session };
  }

  async moveAccountToOrganizationalUnit(accountId: string, organizationalUnitId: string) {
    this.calls.push(`moveAccountToOrganizationalUnit:${accountId}:${organizationalUnitId}`);
    if (this.accountUnits.get(accountId) === organizationalUnitId) return { moved: false };
    this.accountUnits.set(accountId, organizationalUnitId);
    this.failOnceAfter('moveAccountToOrganizationalUnit');
    return { moved: true };
  }

  async ensureStackInstance(
    input: AwsStackInstanceTarget & {
      organizationalUnitId: string;
      parameterOverrides: Readonly<Record<string, string>>;
    },
  ) {
    this.calls.push(`ensureStackInstance:${input.accountId}`);
    const key = stackInstanceKey(input);
    const existing = this.stackInstances.get(key);
    const overrides = { ...input.parameterOverrides };
    if (!existing) {
      const outputs = this.stackBuilder
        ? this.stackBuilder({ ...input, parameterOverrides: overrides })
        : { ...this.stackOutputs };
      this.stackInstances.set(key, { unitId: input.organizationalUnitId, overrides, outputs });
      // The stack builds the runner role, with the policy its parameters pick.
      this.runnerRoles.set(input.accountId, stackRunnerPolicy(input.region, overrides));
      if (this.stackInstanceFailure) {
        const failure = this.stackInstanceFailure;
        this.stackInstanceFailure = null;
        throw failure;
      }
      return { action: 'created' as const };
    }
    if (JSON.stringify(existing.overrides) === JSON.stringify(overrides)) {
      return { action: 'none' as const };
    }
    existing.overrides = overrides;
    this.runnerRoles.set(input.accountId, stackRunnerPolicy(input.region, overrides));
    return { action: 'updated' as const };
  }

  async readStackInstanceOutputs(target: AwsStackInstanceTarget) {
    this.calls.push(`readStackInstanceOutputs:${target.accountId}`);
    const instance = this.stackInstances.get(stackInstanceKey(target));
    if (!instance) throw new AwsStackOutputsMissingError(target, 'stack instance');
    return { ...instance.outputs };
  }

  private failOnceAfter(step: FakeOrganizationStep) {
    const failure = this.failAfter.get(step);
    if (!failure) return;
    this.failAfter.delete(step);
    throw failure;
  }

  async ensureOrganizationalUnit(name: string) {
    this.calls.push(`ensureOrganizationalUnit:${name}`);
    const existing = this.organizationalUnits.get(name);
    if (existing) return { ouId: existing, created: false };
    this.ouSeq += 1;
    const ouId = `ou-fake-${this.ouSeq}`;
    this.organizationalUnits.set(name, ouId);
    this.failOnceAfter('ensureOrganizationalUnit');
    return { ouId, created: true };
  }

  async ensureTenantDeployRole(credentials: AwsSessionCredentials, policy: AwsPolicyDocument) {
    const accountId = this.sessionAccount.get(credentials) ?? 'unknown';
    this.calls.push(`ensureTenantDeployRole:${accountId}`);
    let created = false;
    if (!this.tenantRoles.has(accountId)) {
      this.tenantRoles.set(accountId, null);
      created = true;
      this.failOnceAfter('tenantRoleCreated');
    }
    const wanted = JSON.stringify(policy);
    if (this.tenantRoles.get(accountId) !== wanted) {
      this.tenantRoles.set(accountId, wanted);
      this.failOnceAfter('tenantRolePolicyPut');
    }
    return { created };
  }

  async ensureAccountTag(accountId: string, key: string, value: string) {
    this.calls.push(`ensureAccountTag:${accountId}:${key}`);
    const tags = this.accountTags.get(accountId) ?? new Map<string, string>();
    this.accountTags.set(accountId, tags);
    if (tags.get(key) === value) return { tagged: false };
    tags.set(key, value);
    this.failOnceAfter('accountTagged');
    return { tagged: true };
  }

  async ensureQuotaRaise(
    credentials: AwsSessionCredentials,
    _regionId: string,
    target: AwsQuotaTarget,
  ) {
    const accountId = this.sessionAccount.get(credentials) ?? 'unknown';
    this.calls.push(`ensureQuotaRaise:${accountId}:${target.quotaCode}`);
    const key = `${accountId}:${target.quotaCode}`;
    if ((this.appliedQuotas.get(key) ?? 0) >= target.desiredValue) {
      return { filed: false, pending: false };
    }
    if (this.openQuotaRaises.has(key)) return { filed: false, pending: true };
    this.openQuotaRaises.set(key, target.desiredValue);
    this.failOnceAfter('quotaRaiseFiled');
    return { filed: true, pending: true };
  }
}

/** The runner role's policy the stack applies, chosen by its parameters as the
 *  template's condition chooses it (motir-infra `lib/pool-account/stack.ts`). */
function stackRunnerPolicy(region: string, overrides: Record<string, string>): string {
  const build =
    overrides['RunnerPolicy'] === 'hoster' ? awsAgentHosterPolicyDocument : awsRunnerPolicyDocument;
  return JSON.stringify(
    build({
      shardTag: overrides['ShardTag'] ?? '',
      regionId: region,
      reapUntagged: overrides['ReapUntagged'] === 'true',
    }),
  );
}

function stackInstanceKey(target: AwsStackInstanceTarget): string {
  return `${target.stackSetName}/${target.accountId}/${target.region}`;
}

// THE POOL-ACCOUNT DEFINITION IN THE FAKES (MOTIR-9845): add-shard builds a new
// account by applying the pool StackSet's instance. `stubPoolDefinitionEnv` sets
// the deployment configuration it reads; `buildStacksInto` makes a created
// instance seed the tagged network in the in-memory EC2, as the stack would.

/** The configured StackSet and units; never a real account's. */
export const POOL_DEFINITION = {
  stackSetName: 'motir-test-pool-account',
  requestedVcpuQuota: '640',
  unitId: (fleetKind: string) => `ou-test-${fleetKind.replaceAll('_', '-')}`,
} as const;

const FLEET_KINDS = ['ci_runner', 'code_graph_index', 'hosted_agent', 'agent_instance'];

export function stubPoolDefinitionEnv(): void {
  vi.stubEnv(AWS_POOL_DEFINITION_ENV.stackSetName, POOL_DEFINITION.stackSetName);
  vi.stubEnv(AWS_POOL_DEFINITION_ENV.requestedVcpuQuota, POOL_DEFINITION.requestedVcpuQuota);
  for (const kind of FLEET_KINDS)
    vi.stubEnv(awsPoolUnitEnvName(kind), POOL_DEFINITION.unitId(kind));
}

/** The in-memory EC2's seeding surface (`packages/orchestrator/test/contract/awsEc2Fake.ts`). */
interface SeedableEc2 {
  zones?: readonly { zoneName: string }[] | readonly string[];
  seedShardNetwork(
    shardTag: string,
    zones?: readonly string[],
  ): {
    vpcId: string;
    internetGatewayId: string;
    routeTableId: string;
    groupId: string;
    subnetIds: string[];
  };
}

function zonesOf(ec2: SeedableEc2, region: string): string[] {
  const listed = (ec2.zones ?? []).map((z) => (typeof z === 'string' ? z : z.zoneName));
  const inRegion = listed.filter((zone) => zone.startsWith(region));
  return (inRegion.length > 0 ? inRegion : [`${region}a`, `${region}b`]).sort().slice(0, 3);
}

/** A created instance seeds its network in `ec2Of()` and answers the template's outputs. */
export function buildStacksInto(organization: FakeOrganization, ec2Of: () => unknown): void {
  organization.stackBuilder = (input) => {
    const ec2 = ec2Of() as SeedableEc2;
    const shardTag = input.parameterOverrides['ShardTag'] ?? '';
    const zones = zonesOf(ec2, input.region);
    const built = ec2.seedShardNetwork(shardTag, zones);
    return {
      VpcId: built.vpcId,
      InternetGatewayId: built.internetGatewayId,
      RouteTableId: built.routeTableId,
      SecurityGroupId: built.groupId,
      ...Object.fromEntries(
        zones.map((zone, i) => [`SubnetId${zone.slice(-1).toUpperCase()}`, built.subnetIds[i]]),
      ),
      RunnerRoleArn: `arn:aws:iam::${input.accountId}:role/motir-fleet-runner`,
      TrailArn: `arn:aws:cloudtrail:${input.region}:${input.accountId}:trail/motir-pool`,
    };
  };
}
