import {
  AwsAccountCreationRefusedError,
  type AwsManagementApi,
  type AwsOrganizationAccount,
  type AwsPolicyDocument,
  type AwsSessionCredentials,
} from '@motir/orchestrator';
import { vi } from 'vitest';
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

/** An in-memory AWS organization: accounts by name, CreateAccount requests, quotas
 *  and IAM users, with every call recorded by name. */
export class FakeOrganization implements AwsManagementApi {
  readonly calls: string[] = [];
  readonly accounts = new Map<string, AwsOrganizationAccount>();
  readonly inProgress = new Map<string, string>();
  readonly iamUsers = new Set<string>();
  quota = SHARD_VCPU_QUOTA_TARGET - 1_000;
  createFailure: string | null = null;
  private seq = 0;

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
    const account = { accountId: this.nextAccountId(), name: input.name, status: 'ACTIVE' };
    this.accounts.set(input.name, account);
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
    return this.session;
  }

  async readVcpuQuota(credentials: AwsSessionCredentials, regionId: string) {
    this.calls.push(
      `readVcpuQuota:${regionId}:${credentials.accessKeyId === this.session.accessKeyId}`,
    );
    return this.quota;
  }

  async ensureRunnerIamUser(_credentials: AwsSessionCredentials, policy: AwsPolicyDocument) {
    this.calls.push('ensureRunnerIamUser');
    if (this.iamUsers.has(JSON.stringify(policy))) return { created: [] };
    this.iamUsers.add(JSON.stringify(policy));
    return { created: ['iam-user:motir-fleet-runner', 'iam-policy:motir-fleet-runner-ec2'] };
  }
}
