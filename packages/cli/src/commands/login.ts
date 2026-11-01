import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { openUrl } from '../browser.js';
import { CliError } from '../errors.js';
import { MotirClient, type ProjectSummary } from '../client.js';
import { info } from '../output.js';
import { autoLinkAfterLogin } from '../projectLink.js';
import { resolveServerUrl } from '../serverResolve.js';
import { configPath, setCredential, TOKEN_ENV_VAR } from '../config/userConfig.js';
import {
  pollDeviceGrant,
  startDeviceGrant,
  type DeviceCredential,
  type DeviceFlow,
  type DeviceGrant,
  type DeviceUpdate,
} from '../deviceAuth.js';

// `motir login` — tier 2 of the three credential tiers, and the verb a person
// reaches for (`gh auth login` is the precedent for both the name and the shape).
//
// It is a DEVICE GRANT, not a loopback redirect, because the terminal and the
// browser are frequently not the same machine: a Motir run dispatches where the
// repos are, which is routinely a box reached over SSH or a dev container with no
// graphical session and no way to accept an inbound connection. A loopback
// redirect needs the browser to resolve `http://127.0.0.1:<port>` on that same
// host, so it would serve the laptop case and leave every other one on the paste
// path (docs/decisions/cli-login.md Q0b).
//
// ⚠️ HEADLESS IS NOT THE FALLBACK — IT IS THE PATH THE DESIGN IS FOR.
// The browser launch is purely additive on top of an always-printed code + URL:
// `openUrl()` resolves `false` on a headless box and never throws, so nothing
// about whether the login can COMPLETE depends on it. `--no-browser` skips the
// launch outright, and the two are asserted as separate cases in the tests
// precisely so a later change cannot quietly make the browser load-bearing.
//
// The transport lives in `../deviceAuth.ts` — the ONE place the CLI speaks
// something other than MCP, since the credential does not exist yet. Its header
// comment carries the full reasoning; the "MCP client only" contract is not
// weakened by it.

/** Added to the poll interval each time the server answers `slow_down` (ADR §Q4). */
const SLOW_DOWN_STEP_MS = 5_000;

/** Floor for the server-supplied poll interval — a zero would hot-loop. */
const MIN_POLL_SECONDS = 1;

/** Floor for the polling budget when a server reports an implausibly short
 *  lifetime. Motir's own codes last 15 minutes. */
const MIN_BUDGET_SECONDS = 60;

export interface LoginOptions {
  server?: string;
  /**
   * `false` when `--no-browser` was passed (commander's negated-boolean form, so
   * the attribute is `browser`). Skips the launch entirely; the printed code and
   * URL are always sufficient on their own.
   */
  browser?: boolean;
}

/** Injectable seams; never overridden in production. */
export interface LoginDeps {
  /** The wait between polls. Injected so the tests can assert the `slow_down`
   *  back-off as a WIDENED DELAY rather than sitting through it. */
  sleep?: (ms: number) => Promise<void>;
  openUrl?: typeof openUrl;
  /** Enumerate the fresh token's projects, for the auto-link step. Injected so
   *  the login tests drive every auto-link branch against the device server they
   *  already run, with no second (MCP) server to stand up. */
  listProjects?: (input: { serverUrl: string; token: string }) => Promise<ProjectSummary[]>;
  /** The directory the link would be written to, and the home directory it must
   *  never be. Injected so the four negative cases are assertions about the
   *  RULE rather than about wherever the runner happens to be standing. */
  cwd?: string;
  home?: string;
}

/** Read the projects the just-minted token can reach (MOTIR-1879). */
async function listProjectsWith(input: {
  serverUrl: string;
  token: string;
}): Promise<ProjectSummary[]> {
  const client = new MotirClient(input);
  const { projects } = await client.listProjects();
  return projects;
}

/**
 * Group a user code for reading off one screen and typing on another —
 * `K4TP9RXM` → `K4TP-9RXM`. The server strips dashes before it matches
 * (`normalizeUserCode`), so the grouped form and the raw form resolve the same
 * grant; this is purely for the human in the middle.
 *
 * Exported for the test that pins it: a code printed as one 8-character run is
 * measurably harder to re-type, and the sandbox / SSH case is a person reading
 * this off a container's stderr.
 */
export function groupUserCode(code: string): string {
  if (code.includes('-')) return code;
  const groups = code.match(/.{1,4}/g);
  return groups ? groups.join('-') : code;
}

/**
 * Print the code and the URL. The CODE COMES FIRST and each sits on its own
 * line, unwrapped: this block is read aloud, photographed, or retyped on another
 * machine, so nothing about it may depend on terminal width or on a browser
 * having opened.
 *
 * All of it goes to stderr (output.ts) — stdout stays a clean payload channel, so
 * `motir login` inside a pipeline never corrupts what is being piped.
 */
export function printGrant(grant: DeviceGrant): void {
  info('');
  info(`  Your code:  ${groupUserCode(grant.user_code)}`);
  info(`  Open:       ${grant.verification_uri}`);
  info('');
}

/**
 * Store the credential, translating a write failure into ONE sentence that names
 * the fix.
 *
 * The sandbox mounts the config dir READ-ONLY on purpose — it consumes a
 * credential and never mints one — so `EROFS` here is a supported configuration
 * being used correctly, not a crash to surface as a stack trace (MOTIR-1836 is
 * that class of bug). The way forward is the env tier, which is never written to
 * disk at all.
 */
function storeCredential(serverUrl: string, credential: DeviceCredential): void {
  try {
    setCredential(serverUrl, { token: credential.access_token, user: credential.user });
  } catch {
    throw new CliError(`Could not write the credential to ${configPath()}.`, {
      hint: `Make that directory writable, point MOTIR_CONFIG_HOME at one that is, or set ${TOKEN_ENV_VAR} instead — the environment tier is never written to disk.`,
    });
  }
}

/**
 * Poll until the grant resolves. Returns only on approval; every other ending
 * throws, and NOTHING is written before this returns — which is what makes
 * "denied / expired / timed out / Ctrl-C leaves nothing behind" structural rather
 * than a promise kept by remembering to.
 *
 * The budget is measured in SLEPT time rather than wall clock: every wait in this
 * loop goes through `sleep`, so the count is exact under the real clock and
 * deterministic under an injected one. The server's own `expired_token` normally
 * wins the race and carries the better message; this budget is the backstop for a
 * server that never says so.
 */
export async function awaitApproval(input: {
  serverUrl: string;
  grant: DeviceGrant;
  sleep: (ms: number) => Promise<void>;
}): Promise<DeviceCredential>;
export async function awaitApproval(input: {
  serverUrl: string;
  grant: DeviceGrant;
  sleep: (ms: number) => Promise<void>;
  flow: 'refresh';
}): Promise<DeviceUpdate>;
export async function awaitApproval(input: {
  serverUrl: string;
  grant: DeviceGrant;
  sleep: (ms: number) => Promise<void>;
  flow?: DeviceFlow;
}): Promise<DeviceCredential | DeviceUpdate> {
  const refresh = input.flow === 'refresh';
  let intervalMs = Math.max(input.grant.interval, MIN_POLL_SECONDS) * 1_000;
  const budgetMs = Math.max(input.grant.expires_in, MIN_BUDGET_SECONDS) * 1_000;
  let waitedMs = 0;

  for (;;) {
    await input.sleep(intervalMs);
    waitedMs += intervalMs;

    const result = await pollDeviceGrant({
      serverUrl: input.serverUrl,
      deviceCode: input.grant.device_code,
      flow: input.flow ?? 'login',
    });
    // Each flow accepts only its own success. A refresh's poll already refuses a
    // minted token, so the one mismatch left is a login answered with an update.
    if (result.state === 'granted') return result.credential;
    if (result.state === 'updated') {
      if (!refresh) {
        throw new CliError(`${input.serverUrl} approved the login but returned no token.`, {
          hint: 'Run `motir login` again to start a fresh grant.',
        });
      }
      return result.update;
    }
    if (result.state === 'slow_down') intervalMs += SLOW_DOWN_STEP_MS;

    if (waitedMs >= budgetMs) {
      if (refresh) {
        throw new CliError('Timed out waiting for approval.', {
          hint: 'Nothing was changed. Run `motir auth refresh` again when you are ready to approve it.',
        });
      }
      throw new CliError('Timed out waiting for approval.', {
        hint: 'Nothing was written. Run `motir login` again when you are ready to approve it.',
      });
    }
  }
}

export async function loginCommand(opts: LoginOptions, deps: LoginDeps = {}): Promise<void> {
  const sleep = deps.sleep ?? delay;
  const open = deps.openUrl ?? openUrl;

  // The ladder is MOTIR-1876's and is applied, not re-derived: --server >
  // MOTIR_SERVER > the .motir.json link > the single stored server >
  // https://app.motir.co. It ends at the hosted default rather than a prompt,
  // which is what lets `motir login` run unattended in a container.
  const serverUrl = resolveServerUrl(opts.server);

  const grant = await startDeviceGrant({ serverUrl, hostname: hostname() });
  printGrant(grant);

  // `verification_uri_complete` pre-fills the code, so the browser path is one
  // click; the PRINTED url is the plain one, because that is the one a human
  // retypes. `openUrl` resolves false rather than throwing when there is no
  // display — a headless box simply keeps the printed link.
  const opened = opts.browser === false ? false : await open(grant.verification_uri_complete);
  if (opened) info('Opened your browser — approve the request there.');
  else info('Open that URL on any device, sign in, and enter the code.');
  info('Waiting for approval…');

  const credential = await awaitApproval({ serverUrl, grant, sleep });
  storeCredential(serverUrl, credential);

  // The same sentence `motir auth login` prints, from the poll response rather
  // than a second round trip: the substrate returns `user` / `workspace` on the
  // grant FOR this (lib/dto/cliDevice.ts), and a server-minted token cannot be
  // the wrong token, so there is nothing left to validate.
  info(
    `Logged in as ${credential.user.email} on ${serverUrl} (workspace ${credential.workspace.name}).`,
  );

  // Bind this folder when that is unambiguous, so the common case is genuinely
  // ONE command. Every guard, and why writing a link is the risky half of this,
  // lives in projectLink.ts. The login itself is already complete and stored —
  // this step can decline, but it can never fail the login.
  const listProjects = deps.listProjects ?? listProjectsWith;
  await autoLinkAfterLogin({
    serverUrl,
    workspace: credential.workspace.slug,
    listProjects: () => listProjects({ serverUrl, token: credential.access_token }),
    ...(deps.cwd === undefined ? {} : { cwd: deps.cwd }),
    ...(deps.home === undefined ? {} : { home: deps.home }),
  });
}
