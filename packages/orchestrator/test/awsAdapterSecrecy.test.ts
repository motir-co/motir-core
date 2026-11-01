import { describe, expect, it } from 'vitest';
import type { DeployReleaseInput, HostingEnvironment, ReleaseShape } from '../src/index';
import {
  AWS_ORIGIN_KEY,
  awsAdapterHarness,
  type AwsAdapterHarness,
} from './contract/awsHostingHarness';

// NO CONNECTION STRING, PASSWORD OR SECRET LEAVES THE AWS ADAPTER (MOTIR-10012).
// The fake Secrets Manager is seeded so every generated database secret holds a
// KNOWN password; the database module then writes connection URLs built from
// it. Each port operation runs in both shapes — uninterrupted, and cut off at
// every call of a deploy and replayed — and every value it returned, every
// error it threw, every line the adapter's `log` dep captured and every stack
// parameter it wrote is scanned for the password, each URL, each secret value
// and the release's own secret variable.

const KNOWN_PASSWORD = 'PwKnownDoNotLeak0123456789';
const RELEASE_SECRET = 'sk_live_release_do_not_leak';
const PRODUCTION: HostingEnvironment = { kind: 'production' };
const PREVIEW: HostingEnvironment = { kind: 'preview', pullRequest: 4 };
const RID = 'cmrepo1';

function release(
  shape: ReleaseShape,
  appRef: string,
  environment: HostingEnvironment,
  digest = 'sha256:aaa',
): DeployReleaseInput {
  return {
    appRef,
    environment,
    artifact: { kind: 'image', ref: 'release', digest },
    runtime: {
      port: 3000,
      healthCheck: { path: '/healthz' },
      startCommand: 'node server.js',
      database: { kind: 'postgres' },
    },
    env: [
      { name: 'NODE_ENV', value: 'production', secret: false },
      { name: 'STRIPE_KEY', value: RELEASE_SECRET, secret: true },
    ],
    size: 'small',
    idle: shape === 'container' ? { mode: 'always_on' } : { mode: 'suspend', idleSeconds: 300 },
    shape,
  };
}

/** The harness, with every database secret the stacks generate holding the
 *  known password. */
function seeded(): AwsAdapterHarness {
  const h = awsAdapterHarness();
  const secrets = h.fakes.secretsManager;
  const read = secrets.getSecretValue.bind(secrets);
  Object.assign(secrets, {
    getSecretValue: async (secretId: string) => {
      if (!secrets.values.has(secretId) && secretId.startsWith('arn:aws:secretsmanager:')) {
        secrets.values.set(secretId, JSON.stringify({ password: KNOWN_PASSWORD }));
      }
      return read(secretId);
    },
  });
  return h;
}

/** What a caller or an operator sees: answers, errors, log lines and the
 *  parameters of every stack the adapter wrote. */
class Seen {
  readonly items: unknown[] = [];
  async run<T>(work: () => Promise<T>): Promise<T | undefined> {
    try {
      const value = await work();
      this.items.push(value);
      return value;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.items.push({ name: error.name, message: error.message, text: String(err) });
      return undefined;
    }
  }
}

function expectNoSecretIn(h: AwsAdapterHarness, seen: Seen): void {
  const values = [...h.fakes.secretsManager.values.values()];
  const urls = values.flatMap((value) => value.match(/postgres(?:ql)?:\/\/[^"\s]+/g) ?? []);
  // The scan must have something to look for: the seeded password reached a
  // written connection URL.
  expect(urls.some((url) => url.includes(KNOWN_PASSWORD))).toBe(true);
  const forbidden = [
    KNOWN_PASSWORD,
    RELEASE_SECRET,
    AWS_ORIGIN_KEY,
    'postgres://',
    'postgresql://',
    ...urls,
    // Every whole secret value long enough to mean something (an empty `{}`
    // environment secret is not one).
    ...values.filter((value) => value.length >= 16),
    ...[...h.fakes.rdsData.roles.values()].map((role) => role.password),
  ];
  const stackParameters = [...h.fakes.cloudformation.stacks.values()].map((s) => s.parameters);
  const surfaces = {
    answers: JSON.stringify(seen.items),
    logs: JSON.stringify(h.logs),
    stackParameters: JSON.stringify(stackParameters),
  };
  expect(seen.items.length).toBeGreaterThan(0);
  expect(h.logs.length).toBeGreaterThan(0);
  for (const [surface, text] of Object.entries(surfaces)) {
    for (const secret of forbidden) {
      expect(text.includes(secret), `${surface} carries ${secret.slice(0, 12)}…`).toBe(false);
    }
  }
}

describe.each<ReleaseShape>(['function', 'container'])('the %s shape', (shape) => {
  it('no operation answers, throws, logs or writes a secret', async () => {
    const h = seeded();
    const seen = new Seen();
    const prod = await seen.run(() =>
      h.port.ensureApp({ repositoryId: RID, environment: PRODUCTION }),
    );
    const pr = await seen.run(() => h.port.ensureApp({ repositoryId: RID, environment: PREVIEW }));
    await seen.run(() => h.port.mintDeployCredential({ pushNamespace: prod!.pushNamespace }));

    const a = await seen.run(() => h.port.deploy(release(shape, prod!.appRef, PRODUCTION)));
    const p = await seen.run(() => h.port.deploy(release(shape, pr!.appRef, PREVIEW)));
    h.advanceSeconds(120);
    await seen.run(() => h.port.deploy(release(shape, prod!.appRef, PRODUCTION, 'sha256:bbb')));
    await seen.run(() => h.port.describe(a!));
    await seen.run(() => h.port.rollback({ appRef: prod!.appRef, environment: PRODUCTION }));
    await seen.run(() => h.port.usageSince(a!, new Date(0)));
    await seen.run(() => h.port.listReleases({ appRef: prod!.appRef }));
    // A refused rollback and a destroy that fails at the provider, too.
    await seen.run(() => h.port.rollback({ appRef: pr!.appRef, environment: PREVIEW }));
    h.fakes.cloudformation.failAt('deleteStack', 1);
    await seen.run(() => h.port.destroy(p!, 'pull_request_closed'));
    await seen.run(() => h.port.destroy(p!, 'pull_request_closed'));
    await seen.run(() => h.port.destroy(a!, 'retired'));
    await seen.run(() => h.port.deploy(release(shape, prod!.appRef, PRODUCTION)));
    await seen.run(() => h.port.destroyApp({ appRef: prod!.appRef }));

    expect(seen.items.some((item) => item && typeof item === 'object' && 'message' in item)).toBe(
      true,
    );
    expectNoSecretIn(h, seen);
  });

  it('a deploy cut off at every call, and its replay, leak nothing either', async () => {
    const reference = seeded();
    await reference.port.deploy(release(shape, `mh-${RID}`, PRODUCTION));
    const positions = reference.recorder.calls.length;

    for (let n = 1; n <= positions; n += 1) {
      for (const when of ['before', 'after'] as const) {
        const h = seeded();
        const seen = new Seen();
        h.recorder.failAt(n, when);
        await seen.run(() => h.port.deploy(release(shape, `mh-${RID}`, PRODUCTION)));
        const handle = await seen.run(() => h.port.deploy(release(shape, `mh-${RID}`, PRODUCTION)));
        await seen.run(() => h.port.describe(handle!));
        expectNoSecretIn(h, seen);
      }
    }
  });
});
