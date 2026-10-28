import { vi } from 'vitest';

// THE RUNNER ROLE, FAKED FOR THE FLEET TESTS (MOTIR-9847). An `aws` account's
// EC2 client is built from a session of its `motir-fleet-runner` role, assumed
// from the management credential (`awsShardClient` in `lib/orchestrator`), so a
// test that answers each account with its own EC2 fake keys it on the session's
// access key id: `grant` says which key id the account's role session carries,
// and `ec2For` resolves the client's credential provider to pick the fake.
//
// `createAwsManagementApi` and `createEc2Api` are what a test's
// `vi.mock('@motir/orchestrator', …)` replaces with `management()` and `ec2For`.

/** The management role ARN the tests configure — the only management variable
 *  the role path needs (MOTIR-9839). */
export const TEST_MANAGEMENT_ROLE_ARN = 'arn:aws:iam::576360162297:role/motir-add-shard';

/** Configure the management credential as the role ARN alone. */
export function stubRunnerRoleManagementEnv(): void {
  vi.stubEnv('AWS_ORG_ADMIN_ROLE_ARN', TEST_MANAGEMENT_ROLE_ARN);
}

interface Ec2Config {
  accessKeyId?: string;
  credentialProvider?: () => Promise<{ accessKeyId: string }>;
}

export interface RunnerRoleFake {
  /** The account's role session carries `accessKeyId`; an account never granted
   *  is refused the assume, as IAM refuses a role that does not trust the caller.
   *  `secretAccessKey` lets a test plant a marker it then asserts never leaks. */
  grant(accountId: string, accessKeyId: string, secretAccessKey?: string): void;
  /** Accounts whose role was assumed, in order. */
  readonly assumed: string[];
  /** The management API the composition root builds: only the runner assume. */
  management(): { assumeRunnerRole(accountId: string): Promise<SessionLike> };
  /** An EC2 client for `config`: a key is looked up at once; a credential
   *  provider is resolved on the first call, and every call is forwarded to the
   *  fake its session's key id names. */
  ec2For<T extends object>(config: Ec2Config, lookup: (accessKeyId: string) => T | undefined): T;
  reset(): void;
}

interface SessionLike {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date | null;
}

export function createRunnerRoleFake(): RunnerRoleFake {
  const keys = new Map<string, { accessKeyId: string; secretAccessKey: string }>();
  const assumed: string[] = [];

  async function assumeRunnerRole(accountId: string): Promise<SessionLike> {
    assumed.push(accountId);
    const key = keys.get(accountId);
    if (!key) {
      const { AwsManagementApiError } = await import('@motir/orchestrator');
      throw new AwsManagementApiError('sts', 'AccessDenied', 403);
    }
    return {
      ...key,
      sessionToken: `session-token-${accountId}`,
      expiration: null,
    };
  }

  function ec2For<T extends object>(
    config: Ec2Config,
    lookup: (accessKeyId: string) => T | undefined,
  ): T {
    const find = (accessKeyId: string): T => {
      const ec2 = lookup(accessKeyId);
      if (!ec2) throw new Error(`no EC2 fake for ${accessKeyId}`);
      return ec2;
    };
    if (config.accessKeyId) return find(config.accessKeyId);
    const provider = config.credentialProvider;
    if (!provider) throw new Error('an EC2 client with neither a key nor a credential provider');
    let resolved: Promise<T> | null = null;
    const target = () => (resolved ??= provider().then((session) => find(session.accessKeyId)));
    return new Proxy({} as T, {
      get(_obj, method) {
        // Never a thenable: `await ec2` must not call through.
        if (method === 'then') return undefined;
        return async (...args: unknown[]) => {
          const ec2 = (await target()) as Record<PropertyKey, unknown>;
          const fn = ec2[method];
          if (typeof fn !== 'function') throw new Error(`EC2 fake has no ${String(method)}`);
          return (fn as (...a: unknown[]) => unknown).apply(ec2, args);
        };
      },
    });
  }

  return {
    grant: (accountId, accessKeyId, secretAccessKey = `session-secret-${accountId}`) =>
      void keys.set(accountId, { accessKeyId, secretAccessKey }),
    assumed,
    management: () => ({ assumeRunnerRole }),
    ec2For,
    reset() {
      keys.clear();
      assumed.length = 0;
    },
  };
}

/** The test file's one fake: a `vi.mock` factory and the tests share it, since
 *  both import this module from the same registry. */
export const runnerRole = createRunnerRoleFake();
