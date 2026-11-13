import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RunnerJitApiError,
  RunnerJitTimeoutError,
  RunnerRegistrationRateLimitedError,
  runnerJitConfigClient,
  RUNNER_JIT_REQUEST_TIMEOUT_MS,
} from '@/lib/github/runnerJitConfig';
import { _resetProvisioningInstallationCache } from '@/lib/github/repoProvisioning';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';

// The JIT-CONFIG boundary (Story MOTIR-1916 · MOTIR-1921) — the wire, at the
// level the service above it cannot reach. Sibling of
// `runnerGroupClient.test.ts`, and the same harness: no database, `fetch` is the
// only fake.
//
// The assertions that matter here are the ones the card names as acceptance
// criteria: WHAT the mint request carries (the project's group, the single
// label) and WHICH refusals are retryable. A 403 that means "you are going too
// fast" and a 403 that means "your App lacks the permission" demand opposite
// responses, and getting that wrong turns a burst into an outage or a
// misconfiguration into an infinite retry.

const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '556677';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  /** The deadline's `AbortSignal` — null is the regression MOTIR-2011 fixed. */
  signal: AbortSignal | null;
}

let calls: Call[];
let handler: (call: Call) => Response | Promise<Response>;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** The requests that are the client's own, not the App-auth handshake. */
function runnerCalls(): Call[] {
  return calls.filter((c) => c.url.includes('/actions/runners'));
}

/** GitHub's own success shape: the runner row comes back ALREADY REGISTERED,
 *  which is the §7.4 finding the whole de-registration path exists for. */
function mintSuccess(runnerId = 9001): Response {
  return json(201, {
    runner: { id: runnerId, name: 'motir-intent-1', os: 'linux', status: 'offline', busy: false },
    encoded_jit_config: 'eyJhZ2VudCI6ICJtb3RpciJ9',
  });
}

beforeEach(() => {
  calls = [];
  handler = () => json(200, {});
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const call: Call = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        signal: init?.signal ?? null,
      };
      calls.push(call);
      if (call.url.endsWith(`/orgs/${MOTIR_ORG}/installation`)) {
        return json(200, { id: Number(INSTALLATION_ID) });
      }
      if (call.url.includes('/access_tokens')) {
        return json(200, {
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      return handler(call);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('mint — a JIT config, scoped at MINT time', () => {
  it('names the project runner group and EXACTLY the one fleet label', async () => {
    // The card's acceptance criterion, asserted on the request the client makes:
    // "minted with a JIT config naming the project's `runner_group_id` and the
    // single fleet label". Both are §7.3/§7.4 in one call — the group scoping is
    // applied by the orchestrator at mint rather than trusted to the container.
    handler = () => mintSuccess();

    const config = await runnerJitConfigClient.mint({
      name: 'motir-intent-1',
      runnerGroupId: 5042,
      labels: [MOTIR_RUNNER_LABEL],
    });

    expect(config).toEqual({
      runnerId: 9001,
      runnerName: 'motir-intent-1',
      encodedJitConfig: 'eyJhZ2VudCI6ICJtb3RpciJ9',
    });

    const mint = runnerCalls()[0]!;
    expect(mint.method).toBe('POST');
    expect(mint.url).toBe(
      `https://api.github.com/orgs/${MOTIR_ORG}/actions/runners/generate-jitconfig`,
    );
    expect(mint.body).toEqual({
      name: 'motir-intent-1',
      runner_group_id: 5042,
      labels: [MOTIR_RUNNER_LABEL],
      work_folder: '_work',
    });
    // NOT the `Default` group (id 1, `visibility: all`) — §7.3's forbidden
    // fallback, which would silently restore cross-tenant pickup.
    expect(mint.body?.['runner_group_id']).not.toBe(1);
  });

  it('NO registration token is minted anywhere on this path', async () => {
    // The card's acceptance criterion stated as an absence: §7.4 replaced the
    // registration token, and an absence is only enforceable by asserting it.
    handler = () => mintSuccess();
    await runnerJitConfigClient.mint({
      name: 'motir-intent-1',
      runnerGroupId: 5042,
      labels: [MOTIR_RUNNER_LABEL],
    });
    expect(calls.some((c) => c.url.includes('registration-token'))).toBe(false);
  });

  it('carries the provisioning App installation token', async () => {
    handler = () => mintSuccess();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await runnerJitConfigClient.mint({
      name: 'r',
      runnerGroupId: 7,
      labels: [MOTIR_RUNNER_LABEL],
    });
    const mintCall = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).find(
      ([url]) => String(url).includes('generate-jitconfig'),
    );
    const headers = mintCall?.[1].headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer ghs_provisioning');
  });

  it('refuses a 201 whose shape it cannot read, rather than returning half a config', async () => {
    // WORSE than a refusal: GitHub has registered a runner we cannot name, so we
    // could not de-register it either. Failing loudly is what makes that
    // reachable by the reconciliation instead of invisible.
    handler = () => json(201, { runner: { name: 'x' } });
    await expect(
      runnerJitConfigClient.mint({ name: 'r', runnerGroupId: 7, labels: [MOTIR_RUNNER_LABEL] }),
    ).rejects.toBeInstanceOf(RunnerJitApiError);
  });

  it('refuses a 201 with no encoded config', async () => {
    handler = () => json(201, { runner: { id: 5 }, encoded_jit_config: '' });
    await expect(
      runnerJitConfigClient.mint({ name: 'r', runnerGroupId: 7, labels: [MOTIR_RUNNER_LABEL] }),
    ).rejects.toBeInstanceOf(RunnerJitApiError);
  });

  it('falls back to the requested name when GitHub echoes none', async () => {
    handler = () => json(201, { runner: { id: 12 }, encoded_jit_config: 'abc' });
    const config = await runnerJitConfigClient.mint({
      name: 'motir-fallback',
      runnerGroupId: 7,
      labels: [MOTIR_RUNNER_LABEL],
    });
    expect(config.runnerName).toBe('motir-fallback');
  });

  it('surfaces a plain refusal as the typed API error with its status', async () => {
    handler = () => json(422, { message: 'Runner group not found' });
    await expect(
      runnerJitConfigClient.mint({ name: 'r', runnerGroupId: 999, labels: [MOTIR_RUNNER_LABEL] }),
    ).rejects.toMatchObject({ code: 'RUNNER_JIT_API_FAILED', status: 422 });
  });

  it('normalizes a transport failure to the typed error with a null status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith(`/orgs/${MOTIR_ORG}/installation`)) {
          return json(200, { id: Number(INSTALLATION_ID) });
        }
        if (String(url).includes('/access_tokens')) {
          return json(200, {
            token: 'ghs_provisioning',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          });
        }
        throw new Error('ECONNRESET');
      }),
    );
    await expect(
      runnerJitConfigClient.mint({ name: 'r', runnerGroupId: 7, labels: [MOTIR_RUNNER_LABEL] }),
    ).rejects.toMatchObject({ code: 'RUNNER_JIT_API_FAILED', status: null });
  });
});

describe('the registration ceiling is a TYPED, RETRYABLE refusal — not an opaque 4xx', () => {
  it('a 403 with `retry-after` is the rate limit, and says how long', async () => {
    // The card: "surface it as a typed, retryable refusal rather than an opaque
    // 4xx". GitHub reports a secondary limit as 403 or 429 with a `retry-after`.
    handler = () =>
      json(
        403,
        { message: 'You have exceeded a secondary rate limit' },
        {
          'retry-after': '30',
        },
      );
    const err = await runnerJitConfigClient
      .mint({ name: 'r', runnerGroupId: 7, labels: [MOTIR_RUNNER_LABEL] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerRegistrationRateLimitedError);
    expect(err).toMatchObject({ retryable: true, status: 403, retryAfterSeconds: 30 });
  });

  it('a 429 with an exhausted remaining budget is the rate limit too', async () => {
    handler = () => json(429, { message: 'Too many requests' }, { 'x-ratelimit-remaining': '0' });
    const err = await runnerJitConfigClient
      .mint({ name: 'r', runnerGroupId: 7, labels: [MOTIR_RUNNER_LABEL] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerRegistrationRateLimitedError);
    expect(err).toMatchObject({ retryAfterSeconds: null });
  });

  it('a PLAIN 403 is NOT retryable — a missing permission must fail loudly', async () => {
    // The distinction that matters: treating a permissions failure as retryable
    // would make a misconfigured App retry forever instead of failing on the
    // first job, and the fleet would look slow rather than unwired.
    handler = () => json(403, { message: 'Resource not accessible by integration' });
    const err = await runnerJitConfigClient
      .mint({ name: 'r', runnerGroupId: 7, labels: [MOTIR_RUNNER_LABEL] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerJitApiError);
    expect(err).not.toBeInstanceOf(RunnerRegistrationRateLimitedError);
  });

  it('ignores a non-numeric `retry-after` rather than reporting NaN seconds', async () => {
    handler = () => json(403, { message: 'nope' }, { 'retry-after': 'soon' });
    const err = await runnerJitConfigClient
      .mint({ name: 'r', runnerGroupId: 7, labels: [MOTIR_RUNNER_LABEL] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerJitApiError);
  });
});

describe('deleteRunner — the dangling-JIT cleanup', () => {
  it('de-registers by id', async () => {
    handler = () => new Response(null, { status: 204 });
    await runnerJitConfigClient.deleteRunner(9001);
    const call = runnerCalls()[0]!;
    expect(call.method).toBe('DELETE');
    expect(call.url).toBe(`https://api.github.com/orgs/${MOTIR_ORG}/actions/runners/9001`);
  });

  it('treats a 404 as the desired end state — the HAPPY path', async () => {
    // An ephemeral runner de-registers ITSELF when its one job finishes, so 404
    // is what a successful run looks like from here. Throwing on it would make
    // every good run log an error.
    handler = () => json(404, { message: 'Not Found' });
    await expect(runnerJitConfigClient.deleteRunner(9001)).resolves.toBeUndefined();
  });

  it('surfaces a real refusal', async () => {
    handler = () => json(500, { message: 'Server Error' });
    await expect(runnerJitConfigClient.deleteRunner(9001)).rejects.toMatchObject({
      code: 'RUNNER_JIT_API_FAILED',
      status: 500,
    });
  });
});

describe('removeRunner — a delete whose answer the caller decides on (MOTIR-11230)', () => {
  it("answers 'removed' when GitHub deleted it", async () => {
    handler = () => new Response(null, { status: 204 });
    await expect(runnerJitConfigClient.removeRunner(9001)).resolves.toBe('removed');
    expect(runnerCalls()[0]).toMatchObject({
      method: 'DELETE',
      url: `https://api.github.com/orgs/${MOTIR_ORG}/actions/runners/9001`,
    });
  });

  it("answers 'gone' on a 404 — the runner already left", async () => {
    handler = () => json(404, { message: 'Not Found' });
    await expect(runnerJitConfigClient.removeRunner(9001)).resolves.toBe('gone');
  });

  it('throws on a refusal — GitHub will not delete a runner that is running a job', async () => {
    handler = () => json(422, { message: 'Runner is still running a job' });
    await expect(runnerJitConfigClient.removeRunner(9001)).rejects.toMatchObject({
      code: 'RUNNER_JIT_API_FAILED',
      status: 422,
    });
  });
});

describe('readRunner — is the runner running a job? (MOTIR-11230)', () => {
  it('reads busy and online from the runner row', async () => {
    handler = () => json(200, { id: 9001, name: 'motir-intent-1', status: 'online', busy: true });
    await expect(runnerJitConfigClient.readRunner(9001)).resolves.toEqual({
      busy: true,
      online: true,
    });
    expect(runnerCalls()[0]).toMatchObject({
      method: 'GET',
      url: `https://api.github.com/orgs/${MOTIR_ORG}/actions/runners/9001`,
    });
  });

  it('an offline idle runner is not busy and not online', async () => {
    handler = () => json(200, { id: 9001, status: 'offline', busy: false });
    await expect(runnerJitConfigClient.readRunner(9001)).resolves.toEqual({
      busy: false,
      online: false,
    });
  });

  it('answers null on a 404 — GitHub no longer knows the runner', async () => {
    handler = () => json(404, { message: 'Not Found' });
    await expect(runnerJitConfigClient.readRunner(9001)).resolves.toBeNull();
  });

  it('throws on a failed read rather than guessing', async () => {
    handler = () => json(502, { message: 'Bad Gateway' });
    await expect(runnerJitConfigClient.readRunner(9001)).rejects.toMatchObject({
      code: 'RUNNER_JIT_API_FAILED',
      status: 502,
    });
  });

  it('throws on a body with no busy flag — an unknown answer is not "idle"', async () => {
    handler = () => json(200, { id: 9001, status: 'online' });
    await expect(runnerJitConfigClient.readRunner(9001)).rejects.toThrow(/no busy flag/);
  });
});

describe('deleteRunnersNamed — cleaning up a mint that never answered', () => {
  /** GitHub's list-runners shape, narrowed to what the client reads. */
  function runnerList(...runners: Array<{ id: number; name: string }>): Response {
    return json(200, { total_count: runners.length, runners });
  }

  it('finds the runner by NAME and de-registers it — the mint gave back no id', async () => {
    // The whole reason this method exists: §7.4 says the runner is registered
    // BEFORE the mint responds, so a mint that times out is exactly the case
    // with a dangling runner and nothing to name it by except the deterministic
    // name the mint was asked for.
    handler = (call) =>
      call.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : runnerList({ id: 9001, name: 'motir-intent-1' });

    await expect(runnerJitConfigClient.deleteRunnersNamed('motir-intent-1')).resolves.toEqual([
      9001,
    ]);

    const [lookup, remove] = runnerCalls();
    expect(lookup?.method).toBe('GET');
    expect(lookup?.url).toContain('name=motir-intent-1');
    expect(remove?.method).toBe('DELETE');
    expect(remove?.url).toBe(`https://api.github.com/orgs/${MOTIR_ORG}/actions/runners/9001`);
  });

  it('DELETES ONLY AN EXACT NAME MATCH, even when GitHub returns the whole list', async () => {
    // ⚠️ The assertion that keeps this method from being a fleet-wide outage. If
    // a GitHub that ignored the `name` filter answered with every runner in the
    // org, an unfiltered delete would de-register every container mid-job. The
    // client-side match is what makes that impossible rather than unlikely.
    handler = (call) =>
      call.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : runnerList(
            { id: 1, name: 'motir-intent-1-old' },
            { id: 2, name: 'motir-intent-1' },
            { id: 3, name: 'some-other-tenant-runner' },
          );

    await expect(runnerJitConfigClient.deleteRunnersNamed('motir-intent-1')).resolves.toEqual([2]);
    expect(
      runnerCalls()
        .filter((c) => c.method === 'DELETE')
        .map((c) => c.url),
    ).toEqual([`https://api.github.com/orgs/${MOTIR_ORG}/actions/runners/2`]);
  });

  it('reports NOTHING removed when GitHub registered nothing — the good case', async () => {
    handler = () => runnerList();
    await expect(runnerJitConfigClient.deleteRunnersNamed('motir-intent-1')).resolves.toEqual([]);
    expect(runnerCalls().filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('tolerates a 200 with no `runners` array at all', async () => {
    // A shape we cannot read must be "nothing to clean up", never a throw: this
    // runs on a failure path whose job is already going back in the queue, and
    // an exception here would convert a retryable outcome into an untyped one.
    handler = () => json(200, { total_count: 0 });
    await expect(runnerJitConfigClient.deleteRunnersNamed('motir-intent-1')).resolves.toEqual([]);
    expect(runnerCalls().filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('accepts a STRING id and drops one that is not a number', async () => {
    // GitHub sends numeric ids, but this is the cleanup path for a call that
    // ALREADY misbehaved, so the parse is defensive: a numeric string is still a
    // runner worth de-registering, and an unparseable one is skipped rather than
    // sent as `/actions/runners/NaN`.
    handler = (call) =>
      call.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : json(200, {
            total_count: 2,
            runners: [
              { id: '55', name: 'motir-intent-1' },
              { id: 'not-a-number', name: 'motir-intent-1' },
            ],
          });

    await expect(runnerJitConfigClient.deleteRunnersNamed('motir-intent-1')).resolves.toEqual([55]);
    expect(
      runnerCalls()
        .filter((c) => c.method === 'DELETE')
        .map((c) => c.url),
    ).toEqual([`https://api.github.com/orgs/${MOTIR_ORG}/actions/runners/55`]);
  });

  it('surfaces a refusal of the lookup itself', async () => {
    handler = () => json(500, { message: 'Server Error' });
    await expect(runnerJitConfigClient.deleteRunnersNamed('motir-intent-1')).rejects.toMatchObject({
      code: 'RUNNER_JIT_API_FAILED',
      status: 500,
    });
  });
});

describe('deadlines — every call is bounded (docs/jobs.md rule 3, MOTIR-2011)', () => {
  /** A transport that ACCEPTS the request and never answers — the shape that used
   *  to ride all the way to the platform's `FUNCTION_INVOCATION_TIMEOUT`. */
  function stallUntilAborted(signal: AbortSignal | null): Promise<Response> {
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () =>
        reject(new DOMException('This operation was aborted', 'AbortError')),
      );
    });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a mint that never answers becomes a TYPED timeout, inside the budget', async () => {
    vi.useFakeTimers();
    handler = (call) => stallUntilAborted(call.signal);

    const pending = runnerJitConfigClient.mint({
      name: 'motir-intent-1',
      runnerGroupId: 5042,
      labels: [MOTIR_RUNNER_LABEL],
    });
    const settled = pending.catch((e: unknown) => e);

    // Let the App-auth handshake finish so the mint's own deadline is ARMED —
    // asserted rather than assumed, because advancing before the timer exists
    // would make this test pass for the wrong reason.
    await vi.advanceTimersByTimeAsync(0);
    expect(runnerCalls()).toHaveLength(1);

    // One millisecond short of the deadline it is still waiting: the bound is
    // the stated number, not "eventually".
    await vi.advanceTimersByTimeAsync(RUNNER_JIT_REQUEST_TIMEOUT_MS - 1);
    await expect(Promise.race([settled, Promise.resolve('still pending')])).resolves.toBe(
      'still pending',
    );

    await vi.advanceTimersByTimeAsync(1);
    const err = await settled;
    expect(err).toBeInstanceOf(RunnerJitTimeoutError);
    expect(err).toMatchObject({ code: 'RUNNER_JIT_TIMEOUT', retryable: true, operation: 'mint' });
    // The message names the number an operator would have to change.
    expect((err as Error).message).toContain(String(RUNNER_JIT_REQUEST_TIMEOUT_MS));
  });

  it('the de-registration is bounded too — the cleanup path cannot hang the cleanup', async () => {
    vi.useFakeTimers();
    handler = (call) => stallUntilAborted(call.signal);

    const settled = runnerJitConfigClient.deleteRunner(9001).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RUNNER_JIT_REQUEST_TIMEOUT_MS);

    expect(await settled).toBeInstanceOf(RunnerJitTimeoutError);
  });

  it('EVERY request the module makes carries the signal — asserted on the wire, not on a call count', async () => {
    // ⚠️ Written as a property of every observed request rather than as a list
    // of today's three call sites: a fourth endpoint added later inherits this
    // assertion instead of quietly escaping it.
    handler = (call) => {
      if (call.url.includes('generate-jitconfig')) return mintSuccess();
      if (call.method === 'DELETE') return new Response(null, { status: 204 });
      return json(200, { total_count: 1, runners: [{ id: 9001, name: 'motir-intent-1' }] });
    };

    await runnerJitConfigClient.mint({
      name: 'motir-intent-1',
      runnerGroupId: 5042,
      labels: [MOTIR_RUNNER_LABEL],
    });
    await runnerJitConfigClient.deleteRunner(9001);
    await runnerJitConfigClient.deleteRunnersNamed('motir-intent-1');

    expect(runnerCalls().length).toBeGreaterThanOrEqual(4);
    for (const call of runnerCalls()) {
      expect(call.signal, `${call.method} ${call.url} carries no deadline`).toBeInstanceOf(
        AbortSignal,
      );
    }
  });

  it('a transport failure is still the generic API error, NOT a timeout', async () => {
    // The distinction the boot path branches on: "GitHub refused the connection"
    // and "GitHub never answered" leave different debris behind, so collapsing
    // them would send the wrong cleanup.
    handler = () => {
      throw new TypeError('fetch failed');
    };
    const err = await runnerJitConfigClient.deleteRunner(9001).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunnerJitApiError);
    expect(err).not.toBeInstanceOf(RunnerJitTimeoutError);
  });
});
