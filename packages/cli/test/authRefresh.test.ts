import { mkdtempSync, readFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MotirClient } from '../src/client.js';
import { authRefresh, authStatus, type AuthRefreshDeps } from '../src/commands/auth.js';
import { loginCommand } from '../src/commands/login.js';
import { configPath, getCredential, setCredential } from '../src/config/userConfig.js';
import { fetchTokenStatus } from '../src/deviceAuth.js';
import { CliError } from '../src/errors.js';
import {
  UPDATED_GRANT,
  startDeviceTestServer,
  type DeviceTestServer,
  type DeviceTestServerOptions,
} from './helpers/deviceTestServer.js';

// `motir auth refresh` and `motir auth status`'s refresh hint (MOTIR-10189).
//
// Driven against the same REAL scripted device server `motir login`'s tests use,
// so what is asserted is what crossed the wire: the held token presented as the
// bearer on `start`, an `{ updated: true }` poll taken as success, and — on every
// path — the stored credential left byte-for-byte as it was.

const HELD_TOKEN = 'motir_pat_held_by_this_terminal';

let server: DeviceTestServer | undefined;
let home: string;
let slept: number[];
let stderr: string;
let stdout: string;

function deps(overrides: AuthRefreshDeps = {}): AuthRefreshDeps {
  return {
    sleep: async (ms: number) => {
      slept.push(ms);
    },
    openUrl: async () => true,
    hostname: () => 'yue-mbp',
    ...overrides,
  };
}

async function serve(options: DeviceTestServerOptions = {}): Promise<DeviceTestServer> {
  server = await startDeviceTestServer(options);
  return server;
}

/** The stored config file, raw — the "nothing was written" evidence. */
function storedConfig(): string {
  return readFileSync(configPath(), 'utf8');
}

async function refreshFailure(s: DeviceTestServer): Promise<CliError> {
  const failure = await authRefresh({ server: s.url }, deps()).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(CliError);
  return failure as CliError;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'motir-refresh-'));
  vi.stubEnv('MOTIR_CONFIG_HOME', home);
  vi.stubEnv('MOTIR_SERVER', '');
  vi.stubEnv('MOTIR_TOKEN', '');
  vi.stubEnv('MOTIR_RUN_TOKEN', '');
  slept = [];
  stderr = '';
  stdout = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await server?.close();
  server = undefined;
});

describe('motir auth refresh — the happy path', () => {
  it('presents the held token, prints the code, and keeps the stored token on approval', async () => {
    const s = await serve({ poll: [{ error: 'authorization_pending' }, { updated: true }] });
    setCredential(s.url, { token: HELD_TOKEN });
    const before = storedConfig();

    await authRefresh({ server: s.url }, deps());

    // The UPDATE grant is opened with the token as the bearer, reporting the host.
    expect(s.starts).toEqual([{ hostname: 'yue-mbp', authorization: `Bearer ${HELD_TOKEN}` }]);
    expect(stderr).toContain('Your code:  K4TP-9RXM');
    expect(stderr).toContain('Opened your browser — approve the update there.');
    expect(s.polls).toHaveLength(2);
    // Nothing is minted, so nothing is written: the same token, the same file.
    expect(storedConfig()).toBe(before);
    expect(getCredential(s.url)).toEqual({ token: HELD_TOKEN });
    expect(stderr).toContain(
      `Updated ${UPDATED_GRANT.label} on ${s.url} (workspace ${UPDATED_GRANT.workspace.name}).`,
    );
  });

  it('with --no-browser never launches one and says where to go', async () => {
    const s = await serve({ poll: [{ updated: true }] });
    setCredential(s.url, { token: HELD_TOKEN });
    const open = vi.fn(async () => true);

    await authRefresh({ server: s.url, browser: false }, deps({ openUrl: open }));

    expect(open).not.toHaveBeenCalled();
    expect(stderr).toContain('Open that URL on any device, sign in, and enter the code.');
  });

  it('falls back to printing the URL when no browser opens, reporting the real hostname', async () => {
    const s = await serve({ poll: [{ updated: true }] });
    setCredential(s.url, { token: HELD_TOKEN });

    await authRefresh({ server: s.url }, { sleep: async () => {}, openUrl: async () => false });

    expect(s.starts[0]?.hostname).toBe(hostname());
    expect(stderr).toContain('Open that URL on any device, sign in, and enter the code.');
  });
});

describe('motir auth refresh — refusals before any grant', () => {
  it('refuses with no credential and points at motir login', async () => {
    const s = await serve();
    const failure = await refreshFailure(s);
    expect(failure.message).toContain('Not logged in');
    expect(failure.hint).toContain('motir login');
    expect(s.starts).toEqual([]);
  });

  it('refuses a MOTIR_TOKEN credential, and never contacts the server or writes it', async () => {
    const s = await serve();
    vi.stubEnv('MOTIR_TOKEN', 'motir_pat_from_the_environment');

    const failure = await refreshFailure(s);

    expect(failure.message).toContain('environment (MOTIR_TOKEN)');
    expect(failure.hint).toContain('Settings → Account → Tokens');
    expect(s.starts).toEqual([]);
    expect(getCredential(s.url)).toBeUndefined();
  });

  it('a 401 at start (revoked or expired token) says to run motir login', async () => {
    const s = await serve({ startStatus: 401 });
    setCredential(s.url, { token: HELD_TOKEN });
    const failure = await refreshFailure(s);
    expect(failure.message).toContain('no longer valid');
    expect(failure.hint).toContain('motir login');
  });

  it('a 422 at start (not a CLI sign-in) points at Settings', async () => {
    const s = await serve({ startStatus: 422 });
    setCredential(s.url, { token: HELD_TOKEN });
    const failure = await refreshFailure(s);
    expect(failure.message).toContain('not created by `motir login`');
    expect(failure.hint).toContain('Settings → Account → Tokens');
  });

  it('any other refusal at start says nothing was changed', async () => {
    const s = await serve({ startStatus: 500 });
    setCredential(s.url, { token: HELD_TOKEN });
    const failure = await refreshFailure(s);
    expect(failure.message).toContain('refused to start a refresh (HTTP 500)');
    expect(failure.hint).toContain('Nothing was changed');
  });
});

describe('motir auth refresh — every losing ending leaves the token as it was', () => {
  it.each([
    ['access_denied', 'The refresh was denied. The token’s permissions are unchanged.'],
    ['expired_token', 'The code expired before it was approved. Nothing was changed.'],
    ['invalid_grant', 'The refresh could not be completed (HTTP 400).'],
  ])('%s', async (error, message) => {
    const s = await serve({ poll: [{ error }] });
    setCredential(s.url, { token: HELD_TOKEN });
    const before = storedConfig();

    const failure = await refreshFailure(s);

    expect(failure.message).toBe(message);
    expect(storedConfig()).toBe(before);
  });

  it('a revoked token (invalid_grant) names motir login as the way back', async () => {
    const s = await serve({ poll: [{ error: 'invalid_grant' }] });
    setCredential(s.url, { token: HELD_TOKEN });
    expect((await refreshFailure(s)).hint).toContain('run `motir login`');
  });

  it('times out with nothing changed when no approval ever comes', async () => {
    const s = await serve({
      grant: { expires_in: 60, interval: 5 },
      poll: [{ error: 'authorization_pending' }],
    });
    setCredential(s.url, { token: HELD_TOKEN });
    const failure = await refreshFailure(s);
    expect(failure.message).toBe('Timed out waiting for approval.');
    expect(failure.hint).toContain('Nothing was changed');
  });

  it('a server that answers with a NEW token is out of contract, and nothing is written', async () => {
    const s = await serve({ poll: [{ granted: true }] });
    setCredential(s.url, { token: HELD_TOKEN });
    const before = storedConfig();

    const failure = await refreshFailure(s);

    expect(failure.message).toContain('new token instead of an update');
    expect(storedConfig()).toBe(before);
  });

  it('a 200 that is neither an update nor a token is refused', async () => {
    const s = await serve({ poll: [{ granted: true }], grantedBody: { nope: true } });
    setCredential(s.url, { token: HELD_TOKEN });
    expect((await refreshFailure(s)).message).toContain('answered the refresh with something');
  });
});

describe('motir login refuses an update answer', () => {
  it('a login answered with `{ updated: true }` stores nothing', async () => {
    const s = await serve({ poll: [{ updated: true }] });
    const failure = await loginCommand(
      { server: s.url },
      { sleep: async () => {}, openUrl: async () => true },
    ).catch((e: unknown) => e);
    expect((failure as CliError).message).toContain('approved the login but returned no token');
    expect(getCredential(s.url)).toBeUndefined();
  });
});

describe('motir auth status — the refresh hint', () => {
  function stubWhoami(): void {
    vi.spyOn(MotirClient.prototype, 'whoami').mockResolvedValue({
      user: { id: 'u', name: 'Zhu Yue', email: 'yue@motir.test' },
      workspace: { id: 'w', name: 'Moooon', slug: 'moooon' },
    } as Awaited<ReturnType<MotirClient['whoami']>>);
  }

  it('names the missing permissions and the command that adds them', async () => {
    const s = await serve({
      tokenStatus: { status: 200, body: { cliSignIn: true, missing: ['comment:add'] } },
    });
    setCredential(s.url, { token: HELD_TOKEN });
    stubWhoami();

    await authStatus({ server: s.url });

    expect(s.tokenStatusRequests).toEqual([`Bearer ${HELD_TOKEN}`]);
    expect(stdout).toContain(
      'Permissions: missing 1 the CLI now uses (comment:add). Run `motir auth refresh` to add it.',
    );
  });

  it('pluralises for several', async () => {
    const s = await serve({
      tokenStatus: { status: 200, body: { cliSignIn: true, missing: ['a:b', 'c:d'] } },
    });
    setCredential(s.url, { token: HELD_TOKEN });
    stubWhoami();
    await authStatus({ server: s.url });
    expect(stdout).toContain(
      'missing 2 the CLI now uses (a:b, c:d). Run `motir auth refresh` to add them.',
    );
  });

  it.each([
    ['nothing missing', { status: 200, body: { cliSignIn: true, missing: [] } }],
    ['not a CLI sign-in', { status: 200, body: { cliSignIn: false, missing: ['a:b'] } }],
    ['the route refuses', { status: 401, body: { code: 'API_TOKEN_INVALID' } }],
    ['a malformed body', { status: 200, body: { cliSignIn: 'yes' } }],
  ])('prints no hint when %s', async (_name, tokenStatus) => {
    const s = await serve({ tokenStatus });
    setCredential(s.url, { token: HELD_TOKEN });
    stubWhoami();
    await authStatus({ server: s.url });
    expect(stdout).toContain('Workspace: Moooon (moooon)');
    expect(stdout).not.toContain('Permissions:');
  });

  it('never asks about an environment token — this terminal cannot refresh it', async () => {
    const s = await serve({
      tokenStatus: { status: 200, body: { cliSignIn: true, missing: ['a:b'] } },
    });
    vi.stubEnv('MOTIR_TOKEN', 'motir_pat_from_the_environment');
    stubWhoami();
    await authStatus({ server: s.url });
    expect(s.tokenStatusRequests).toEqual([]);
    expect(stdout).not.toContain('Permissions:');
  });
});

describe('fetchTokenStatus is best-effort', () => {
  it('answers undefined on a server without the route (an HTML 404)', async () => {
    const s = await serve();
    expect(await fetchTokenStatus({ serverUrl: s.url, token: HELD_TOKEN })).toBeUndefined();
  });

  it('answers undefined when the server cannot be reached', async () => {
    expect(
      await fetchTokenStatus({ serverUrl: 'http://127.0.0.1:1', token: HELD_TOKEN }),
    ).toBeUndefined();
  });

  it('drops non-string keys from missing', async () => {
    const s = await serve({
      tokenStatus: { status: 200, body: { cliSignIn: true, missing: ['a:b', 7] } },
    });
    expect(await fetchTokenStatus({ serverUrl: s.url, token: HELD_TOKEN })).toEqual({
      cliSignIn: true,
      missing: ['a:b'],
    });
  });
});
