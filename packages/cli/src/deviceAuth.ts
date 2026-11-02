import { CliError } from './errors.js';

// THE DEVICE-AUTHORIZATION TRANSPORT — the one place `packages/cli` reaches a
// route outside `/api/v1`, and why that is not a drift.
//
// Every other command goes through `client.ts`, whose every request carries an
// `Authorization: Bearer <pat>`. `motir login` structurally cannot use it — it
// runs BEFORE a credential exists, so there is no bearer to present. It
// therefore speaks plain JSON/HTTP to Motir's own `/api/cli/device/*` routes.
//
// NOT Better-Auth's `/api/auth/device/*`, which is the obvious guess and the wrong
// one: that endpoint completes into a browser SESSION, and no bearer gate in this
// repo accepts a session token. Motir owns the CLI-facing routes for exactly that
// reason (`lib/services/cliDeviceService.ts`, `docs/decisions/cli-login.md`), and
// the plugin stays a private implementation detail behind them.
//
// The exception is bounded by construction: two endpoints, both unauthenticated by
// design, both reached only from `commands/login.ts`, and the moment the poll
// succeeds the CLI holds a PAT and everything after it is `/api/v1`.
//
// `motir auth refresh` (MOTIR-10189) reuses the same two endpoints with the token
// it already holds as the bearer on `start`: that opens an UPDATE grant for the
// token, whose approval changes the token's permissions and mints nothing. The
// third route, `GET /api/cli/token`, answers `motir auth status`'s one question
// (does this token lack anything the CLI now needs?). It compares against the
// CLI's own fixed set, which is this flow's business, not the public API's.

/**
 * The `client_id` this CLI presents. Pinned server-side too
 * (`lib/cliDevice/constants.ts` — `CLI_CLIENT_ID`); the literal is duplicated
 * rather than imported because `packages/cli` is a separate package with its own
 * build and cannot reach into the app root. Changing it is a contract change on
 * both sides at once — old binaries get `invalid_grant`.
 */
export const CLI_CLIENT_ID = 'motir-cli';

/** RFC 8628 §3.4 — the only grant type the poll endpoint honours. */
const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

export const DEVICE_START_PATH = '/api/cli/device/start';
export const DEVICE_TOKEN_PATH = '/api/cli/device/token';
export const CLI_TOKEN_STATUS_PATH = '/api/cli/token';

/** Which command a grant serves. It changes only the words a failure prints: the
 *  wire is the same, and a refresh's failures all say the token is unchanged. */
export type DeviceFlow = 'login' | 'refresh';

/** The grant, as `POST /api/cli/device/start` hands it back (RFC 8628 §3.2). */
export interface DeviceGrant {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  /** Seconds until the codes expire — the CLI's own polling budget. */
  expires_in: number;
  /** Minimum seconds between polls; faster answers `slow_down`. */
  interval: number;
}

/**
 * The successful poll. `user` / `workspace` are Motir's additions to the RFC
 * shape, added by the substrate SO THAT `motir login` can print its confirmation
 * without a second round trip — see `lib/dto/cliDevice.ts`, which says so. The
 * device path also skips the `whoami` validation the paste path performs: a
 * server-minted token cannot be the wrong token.
 */
export interface DeviceCredential {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  user: { id: string; name: string; email: string };
  workspace: { id: string; name: string; slug: string };
}

/**
 * The successful poll of an UPDATE grant (`motir auth refresh`). There is no token
 * in it: the terminal keeps the secret it holds, which now carries `scope`.
 */
export interface DeviceUpdate {
  updated: true;
  /** The token's label, e.g. `CLI · yue-mbp`. */
  label: string;
  scope: string;
  user: { id: string; name: string; email: string };
  workspace: { id: string; name: string };
}

/**
 * What one poll answered. The three NON-terminal states are values; the three
 * terminal failures are thrown, because there is nothing for the caller to decide
 * about them.
 *
 * `pending` and `slow_down` are the NORMAL path — the CLI sits in them for the
 * whole time the human is walking to a browser — which is why neither is an error
 * here even though RFC 8628 transports them as one.
 */
export type PollResult =
  | { state: 'granted'; credential: DeviceCredential }
  | { state: 'updated'; update: DeviceUpdate }
  | { state: 'pending' }
  | { state: 'slow_down' }
  /** HTTP 500 `server_error` — "not your fault, try again." Keep polling. */
  | { state: 'retry' };

/** A JSON body, or `undefined` when the response carried something else. */
async function readJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    // A non-JSON body means we are not talking to a Motir device endpoint at all
    // (an HTML 404 from a wrong host, a proxy error page). The callers turn that
    // into "this server does not look like Motir" rather than a parse crash.
    return undefined;
  }
}

/**
 * POST a JSON body, turning a transport failure into a `CliError` naming the
 * server. A `fetch` rejection here is DNS / TLS / connection-refused — the user
 * mistyped `--server` or the host is down — and the raw `TypeError: fetch failed`
 * says none of that.
 */
async function postJson(
  url: string,
  body: unknown,
  serverUrl: string,
  bearer?: string,
): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new CliError(`Could not reach ${serverUrl}.`, {
      hint: 'Check the URL (--server <url> or MOTIR_SERVER) and that the server is running.',
    });
  }
}

/** The RFC 8628 `error` value out of an error body, if it carried one. */
function oauthErrorCode(body: unknown): string | undefined {
  const error = (body as { error?: unknown } | undefined)?.error;
  return typeof error === 'string' ? error : undefined;
}

/**
 * Open a grant (`POST /api/cli/device/start`). Unauthenticated by design — a
 * device grant is opened before anyone is identified.
 *
 * `hostname` is reported so the approval screen can answer "WHAT is connecting",
 * which the ADR leans on as the device grant's phishing mitigation, and so the
 * minted token is labelled `CLI · <hostname>` in Settings → Account → Tokens.
 * It is display-only on the server and never interpreted.
 */
export async function startDeviceGrant(input: {
  serverUrl: string;
  hostname: string;
  /** The token `motir auth refresh` holds. Present, it opens an UPDATE grant for
   *  that token instead of a login. */
  updateToken?: string;
}): Promise<DeviceGrant> {
  const res = await postJson(
    input.serverUrl + DEVICE_START_PATH,
    { hostname: input.hostname },
    input.serverUrl,
    input.updateToken,
  );
  const body = await readJson(res);

  if (!res.ok && input.updateToken !== undefined) {
    // A refresh's refusals each name the one way forward, and none changed anything.
    if (res.status === 401) {
      throw new CliError('This terminal’s token is no longer valid, so it cannot be refreshed.', {
        hint: 'It was revoked or has expired. Run `motir login` to connect this terminal again.',
      });
    }
    if (res.status === 422) {
      throw new CliError(
        'This token was not created by `motir login`, so it cannot be refreshed.',
        {
          hint: 'Change its permissions in Settings → Account → Tokens, or run `motir login` to connect this terminal with a CLI sign-in.',
        },
      );
    }
    throw new CliError(`${input.serverUrl} refused to start a refresh (HTTP ${res.status}).`, {
      hint: 'Nothing was changed. If this is a self-hosted Motir, it may predate `motir auth refresh`.',
    });
  }
  if (!res.ok) {
    throw new CliError(`${input.serverUrl} refused to start a login (HTTP ${res.status}).`, {
      hint: 'If this is a self-hosted Motir, it may predate `motir login` — use `motir auth login --token <pat>` instead.',
    });
  }

  const grant = body as Partial<DeviceGrant> | undefined;
  // A 200 that is not a grant means the URL resolves to something that is not a
  // Motir device endpoint. Naming that is worth more than an undefined-property
  // crash three lines later.
  if (typeof grant?.device_code !== 'string' || typeof grant.user_code !== 'string') {
    throw new CliError(`${input.serverUrl} did not return a device grant.`, {
      hint: 'Check that --server points at a Motir server (it should serve /api/cli/device/start).',
    });
  }
  return grant as DeviceGrant;
}

/**
 * Poll once (`POST /api/cli/device/token`). The five RFC 8628 states plus
 * `server_error`, mapped onto {@link PollResult} — the three the caller can act on
 * are returned, the three that end the login are thrown as `CliError`s carrying
 * the way forward.
 *
 * Every terminal failure here happens BEFORE anything is written to disk (the
 * caller stores only on `granted`), which is what makes "a denied, expired or
 * interrupted login writes no credential" structural rather than a promise.
 */
export async function pollDeviceGrant(input: {
  serverUrl: string;
  deviceCode: string;
  flow?: DeviceFlow;
}): Promise<PollResult> {
  const refresh = input.flow === 'refresh';
  const res = await postJson(
    input.serverUrl + DEVICE_TOKEN_PATH,
    {
      grant_type: DEVICE_CODE_GRANT_TYPE,
      device_code: input.deviceCode,
      client_id: CLI_CLIENT_ID,
    },
    input.serverUrl,
  );
  const body = await readJson(res);

  if (res.ok) {
    // An update grant answers with the token's new grant and no secret.
    if ((body as { updated?: unknown } | undefined)?.updated === true) {
      return { state: 'updated', update: body as DeviceUpdate };
    }
    if (refresh) {
      // Never a new secret for a refresh: the terminal keeps the one it holds, and
      // nothing is written, whatever the body carried.
      const minted =
        typeof (body as { access_token?: unknown } | undefined)?.access_token === 'string';
      throw new CliError(
        minted
          ? `${input.serverUrl} answered the refresh with a new token instead of an update. Nothing was written.`
          : `${input.serverUrl} answered the refresh with something unexpected.`,
        { hint: 'Run `motir auth status` to see the token’s permissions now.' },
      );
    }
    const credential = body as Partial<DeviceCredential> | undefined;
    if (typeof credential?.access_token !== 'string') {
      throw new CliError(`${input.serverUrl} approved the login but returned no token.`);
    }
    return { state: 'granted', credential: credential as DeviceCredential };
  }

  switch (oauthErrorCode(body)) {
    case 'authorization_pending':
      return { state: 'pending' };
    case 'slow_down':
      return { state: 'slow_down' };
    case 'server_error':
      return { state: 'retry' };
    case 'access_denied':
      // A refresh is also denied when the token could not be updated (revoked
      // meanwhile, or approved from a staff session) — the token is unchanged
      // either way, which is the one thing the person needs to know.
      if (refresh) {
        throw new CliError('The refresh was denied. The token’s permissions are unchanged.', {
          hint: 'Run `motir auth refresh` again to ask for a fresh code.',
        });
      }
      throw new CliError('Approval was denied. No credential was written.', {
        hint: 'Run `motir login` again if that was not you — and revoke nothing: nothing was created.',
      });
    case 'expired_token':
      if (refresh) {
        throw new CliError('The code expired before it was approved. Nothing was changed.', {
          hint: 'Codes last 15 minutes. Run `motir auth refresh` again for a fresh one.',
        });
      }
      throw new CliError('The code expired before it was approved.', {
        hint: 'Codes last 15 minutes. Run `motir login` again for a fresh one.',
      });
    default:
      // `invalid_grant` (unknown / already-consumed device code, client mismatch),
      // `invalid_request`, or an unrecognised body. All are bugs or tampering, not
      // something a retry fixes. For a refresh, a REVOKED token lands here too: its
      // grant row goes with it, so the device code is unknown.
      if (refresh) {
        throw new CliError(`The refresh could not be completed (HTTP ${res.status}).`, {
          hint: 'If the token was revoked, run `motir login` to connect this terminal again; otherwise run `motir auth refresh` again.',
        });
      }
      throw new CliError(`The login could not be completed (HTTP ${res.status}).`, {
        hint: 'Run `motir login` again to start a fresh grant.',
      });
  }
}

/** `GET /api/cli/token`'s answer: is the token a CLI sign-in, and which of the
 *  CLI's current permissions does it lack? */
export interface CliTokenStatus {
  cliSignIn: boolean;
  missing: string[];
}

/**
 * Ask the server about the token this terminal holds, for `motir auth status`'s
 * refresh hint. Best-effort by contract: ANY failure (an older server without the
 * route, a network blip, a body of the wrong shape) answers `undefined`, and the
 * status command simply prints no hint. It never fails the command it decorates.
 */
export async function fetchTokenStatus(input: {
  serverUrl: string;
  token: string;
}): Promise<CliTokenStatus | undefined> {
  try {
    const res = await fetch(input.serverUrl + CLI_TOKEN_STATUS_PATH, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${input.token}` },
    });
    if (!res.ok) return undefined;
    const body = (await readJson(res)) as Partial<CliTokenStatus> | undefined;
    if (typeof body?.cliSignIn !== 'boolean' || !Array.isArray(body.missing)) return undefined;
    return {
      cliSignIn: body.cliSignIn,
      missing: body.missing.filter((k) => typeof k === 'string'),
    };
  } catch {
    return undefined;
  }
}
