import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { openUrl } from '../browser.js';
import { MotirClient } from '../client.js';
import { fetchTokenStatus, startDeviceGrant } from '../deviceAuth.js';
import { CliError } from '../errors.js';
import { awaitApproval, printGrant } from './login.js';
import { info, out } from '../output.js';
import { isInteractive, promptLine, promptSecret } from '../prompts.js';
import { DEFAULT_SERVER_URL, resolveServerUrl } from '../serverResolve.js';
import {
  TOKEN_ENV_VAR,
  displayTokenPrefix,
  envToken,
  normalizeServerUrl,
  removeCredential,
  resolveCredential,
  setCredential,
} from '../config/userConfig.js';

// `motir auth` — the credential commands. A STORED PAT lives only in the user
// config (chmod 600); login validates it with a real connect + tool-list
// round-trip before storing, so an invalid/revoked token is rejected at login
// time rather than failing later mid-dispatch.
//
// `auth login` deliberately keeps its own shape: `MOTIR_TOKEN` is a fallback for
// the PROMPT here (an explicit login on a laptop should still persist), whereas
// everywhere else the env var is a credential in its own right that is never
// written to disk. `auth status` is the command that makes the difference
// visible — it names which tier supplied the credential it is reporting on.

export interface AuthLoginOptions {
  server?: string;
  token?: string;
}

export async function authLogin(opts: AuthLoginOptions): Promise<void> {
  let serverUrl = opts.server;
  if (!serverUrl) {
    if (!isInteractive()) {
      throw new CliError('No server URL given.', { hint: 'Pass --server <url>.' });
    }
    serverUrl = await promptLine('Server URL', DEFAULT_SERVER_URL);
  }
  serverUrl = normalizeServerUrl(serverUrl);

  let token = opts.token ?? envToken();
  if (!token) {
    if (!isInteractive()) {
      throw new CliError('No token given.', {
        hint: 'Pass --token <pat>, set MOTIR_TOKEN, or run interactively.',
      });
    }
    token = await promptSecret('Personal access token');
  }
  if (!token) throw new CliError('A token is required.');

  // Validate by RESOLVING the token — `whoami` reads `/api/v1/me`, so a bad or
  // revoked PAT surfaces as the 401 the transport maps to `AuthError`, and a
  // good one answers with the very thing the success line has to print. The old
  // probe listed MCP tools, which proved the credential worked and told the
  // human nothing (11.5.6).
  const client = new MotirClient({ serverUrl, token });
  const who = await client.whoami();
  setCredential(serverUrl, { token, user: who.user });
  const ws = who.workspace ? ` (workspace ${who.workspace.name})` : '';
  info(`Logged in as ${who.user.email} on ${serverUrl}${ws}.`);
}

export interface AuthScopeOptions {
  server?: string;
}

export async function authStatus(opts: AuthScopeOptions): Promise<void> {
  const serverUrl = resolveServerUrl(opts.server);
  const cred = resolveCredential(serverUrl);
  if (!cred) {
    throw new CliError(`Not logged in to ${serverUrl}.`, {
      hint: `Run \`motir auth login\`, or set ${TOKEN_ENV_VAR}.`,
    });
  }

  out(`Server:    ${serverUrl}`);
  out(`Token:     ${displayTokenPrefix(cred.token)}`);
  // WHICH tier supplied it — the answer to "why am I the wrong account". A
  // `MOTIR_TOKEN` exported in a shell profile outranks a stored login silently,
  // so the source belongs beside the token, not in a troubleshooting doc.
  out(`Source:    ${cred.origin}`);

  // A live whoami both confirms the token is still valid (a revoked one surfaces
  // as the auth error) and shows the current owner + active workspace.
  const client = new MotirClient({ serverUrl, token: cred.token });
  const who = await client.whoami();
  out(`User:      ${who.user.name || who.user.email} <${who.user.email}>`);
  if (who.workspace) out(`Workspace: ${who.workspace.name} (${who.workspace.slug})`);

  // The refresh hint (MOTIR-10189). A CLI sign-in keeps the grant it was minted
  // with, so a CLI release that needs a new permission leaves older sign-ins short
  // of it. Say so here, where a person looks when a command is refused. Only for a
  // STORED sign-in: an env token is refreshed by whoever set it, not by this
  // terminal. Best-effort: a server without the route prints no hint.
  if (cred.source !== 'config') return;
  const status = await fetchTokenStatus({ serverUrl, token: cred.token });
  if (!status?.cliSignIn || status.missing.length === 0) return;
  const n = status.missing.length;
  out(
    `Permissions: missing ${n} the CLI now uses (${status.missing.join(', ')}). Run \`motir auth refresh\` to add ${n === 1 ? 'it' : 'them'}.`,
  );
}

/** Injectable seams for `motir auth refresh`; never overridden in production. */
export interface AuthRefreshDeps {
  sleep?: (ms: number) => Promise<void>;
  openUrl?: typeof openUrl;
  hostname?: () => string;
}

export interface AuthRefreshOptions extends AuthScopeOptions {
  /** `false` for `--no-browser`, as on `motir login`. */
  browser?: boolean;
}

/**
 * `motir auth refresh` (MOTIR-10189) — bring this terminal's CLI sign-in up to the
 * permissions the CLI uses today, keeping the token.
 *
 * It is `motir login`'s device flow with the held token as the bearer on `start`:
 * the person approves in a browser, the server updates THAT token's grant, and the
 * poll answers `{ updated: true }` with no secret. So nothing is written to disk on
 * any path — the stored token is the same token before and after, which is also why
 * every failure can promise the token is unchanged.
 */
export async function authRefresh(
  opts: AuthRefreshOptions,
  deps: AuthRefreshDeps = {},
): Promise<void> {
  const serverUrl = resolveServerUrl(opts.server);
  const cred = resolveCredential(serverUrl);
  if (!cred) {
    throw new CliError(`Not logged in to ${serverUrl}.`, {
      hint: 'Run `motir login` to connect this terminal.',
    });
  }
  // A token from the environment belongs to whoever exported it. Refreshing it
  // from here would change a credential this terminal did not mint, and the CLI
  // never writes an env token to disk, so refuse and say where to change it.
  if (cred.source === 'environment') {
    throw new CliError(`The token comes from ${cred.origin}, so this terminal cannot refresh it.`, {
      hint: 'Change that token’s permissions in Settings → Account → Tokens, or unset the variable and run `motir login`.',
    });
  }

  const sleep = deps.sleep ?? delay;
  const open = deps.openUrl ?? openUrl;
  const grant = await startDeviceGrant({
    serverUrl,
    hostname: (deps.hostname ?? hostname)(),
    updateToken: cred.token,
  });
  printGrant(grant);

  const opened = opts.browser === false ? false : await open(grant.verification_uri_complete);
  if (opened) info('Opened your browser — approve the update there.');
  else info('Open that URL on any device, sign in, and enter the code.');
  info('Waiting for approval…');

  const update = await awaitApproval({ serverUrl, grant, sleep, flow: 'refresh' });
  info(
    `Updated ${update.label} on ${serverUrl} (workspace ${update.workspace.name}). It keeps its token and now has the CLI’s current permissions.`,
  );
}

export async function authLogout(opts: AuthScopeOptions): Promise<void> {
  const serverUrl = resolveServerUrl(opts.server);
  const removed = removeCredential(serverUrl);
  if (removed) info(`Logged out of ${serverUrl}.`);
  else info(`No stored credential for ${serverUrl}.`);
  // Logout can only remove what is on DISK. Saying "logged out" while an env
  // credential is still in force would be a lie the next command exposes, so
  // name it here instead.
  if (envToken()) {
    info(`${TOKEN_ENV_VAR} is still set — it overrides the stored credential. Unset it to finish.`);
  }
}
