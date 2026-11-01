import { APIError } from 'better-auth/api';
import { db } from '@/lib/db';
import { assertNoStaffSessionCookie } from '@/lib/platform/staffSession';
import { auth } from '@/lib/auth';
import { deviceCodeRepository } from '@/lib/repositories/deviceCodeRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { apiTokenRepository } from '@/lib/repositories/apiTokenRepository';
import { toApiTokenDto } from '@/lib/mappers/apiTokenMappers';
import { ApiTokenNotFoundError, InvalidTokenBindingError } from '@/lib/apiTokens/errors';
import { ImpersonationCredentialRefusedError } from '@/lib/platform/errors';
import { workspacesService } from '@/lib/services/workspacesService';
import { withUserContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
// The device flow's RFC 8628 `scope` wire parameter, which is a PROTOCOL field
// the CLI and server agree on — not our capability vocabulary. MOTIR-2572
// changes what a token GRANTS, not what the device handshake puts on the wire,
// so this stays on the legacy strings deliberately.
import { CLI_TOKEN_SCOPES } from '@/lib/mcp/scopes';
import {
  CLI_CLIENT_ID,
  CLI_TOKEN_EXPIRY_DAYS,
  cliTokenLabel,
  normalizeHostname,
} from '@/lib/cliDevice/constants';
import {
  DeviceGrantDeniedError,
  DeviceGrantExpiredError,
  DeviceGrantForbiddenError,
  DeviceGrantNotClaimedError,
  DeviceGrantNotPendingError,
  DeviceGrantPendingError,
  DeviceGrantSlowDownError,
  DeviceGrantUnboundError,
  DeviceGrantWorkspaceRequiredError,
  DeviceUpdateNotCliTokenError,
  DeviceUpdateRefusedError,
  InvalidDeviceGrantError,
} from '@/lib/cliDevice/errors';
import { NotAMemberError } from '@/lib/workspaces/errors';
import {
  toDeviceGrantDescriptionDTO,
  toDeviceGrantStartDTO,
  toDeviceGrantTokenDTO,
  toDeviceGrantUpdatedDTO,
} from '@/lib/mappers/cliDeviceMappers';
import type { IssuedDeviceCode } from '@/lib/mappers/cliDeviceMappers';
import type {
  DeviceGrantDescriptionDTO,
  DeviceGrantStartDTO,
  DeviceGrantTokenDTO,
  DeviceGrantUpdatedDTO,
  CliTokenStatusDTO,
} from '@/lib/dto/cliDevice';
import type { PermissionKey } from '@/lib/permissions/catalog';

// The `motir login` device-authorization flow (Story MOTIR-1863 · Subtask
// MOTIR-1865), implementing `docs/decisions/cli-login.md`. Three acts, two clients:
// the terminal STARTS a grant and POLLS it; the browser APPROVES it.
//
// WHY THIS SERVICE EXISTS AT ALL — Better-Auth's `deviceAuthorization` plugin
// already owns code issuance, the claim, expiry, the throttle, and the
// pending/approved/denied machine, and Motir keeps every bit of that. It gets
// exactly ONE thing wrong for us: `POST /api/auth/device/token` completes into a
// SESSION (`internalAdapter.createSession` → `access_token: session.token`), and no
// bearer gate in this repo accepts a session token — `lib/apiTokens/routeAuth.ts`
// and the MCP transport gate resolve `motir_pat_…` and nothing else. So Motir owns
// the CLI-FACING routes (`/api/cli/device/*`) and the plugin stays a private
// implementation detail. The two rejected alternatives are worth remembering,
// because both look cheaper and both leak: a `hooks.after` that rewrites the token
// response cannot un-create the session the plugin already committed (an orphan
// browser credential per login), and "poll the plugin, then exchange the session
// token for a PAT" has the same orphan plus a window where a session token is the
// CLI's credential.
//
// THE MINT HAPPENS AT THE POLL, NOT AT APPROVAL. `apiTokensService` states the
// invariant this preserves: "the plaintext secret lives in exactly ONE place ever —
// `create`'s return value." Minting at approval would mean parking a plaintext (or
// reversibly encrypted) secret at rest until the CLI collected it. So approval
// records a DECISION (workspace + status) and the poll that observes it mints. A
// user who approves and then kills the CLI leaves NO token behind — nothing minted,
// nothing to revoke. That is a feature, and it is why this ordering was chosen over
// the more obvious one.
//
// CONCURRENCY — the poll is a read-derived write racing itself. The CLI polls on an
// interval, so two requests can observe the same `approved` row, and the failure
// mode is TWO PATs for one approval. The guard is that the single-use DELETE is the
// claim: the poll locks the row `FOR UPDATE`, re-reads it, and deletes it inside the
// same transaction, so the loser of a race re-reads nothing and answers
// `invalid_grant`. The mint runs AFTER that transaction commits — deliberately, and
// in that order — because Prisma cannot nest interactive transactions
// (`apiTokensService.create` opens its own), so one of the two writes has to be
// outside. Claim-then-mint fails CLOSED: a crash in the window mints nothing and the
// user re-runs `motir login`. Mint-then-claim would fail OPEN — a crash after the
// mint leaves the row `approved` and the next poll mints a SECOND credential, which
// is exactly the outcome the acceptance criteria forbid.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The five poll outcomes, returned OUT of the claim transaction instead of thrown
 * from inside it. This is load-bearing, not style: throwing from inside
 * `db.$transaction` rolls the transaction back — which would discard the
 * `lastPolledAt` stamp on every `authorization_pending` poll and leave `slow_down`
 * permanently unreachable, and would resurrect grants the poll had just reaped. The
 * transaction commits its writes; the caller translates the outcome to the RFC 8628
 * error afterwards.
 */
type PollOutcome =
  | { kind: 'granted'; userId: string; workspaceId: string; hostname: string | null }
  | { kind: 'updated'; userId: string; tokenId: string }
  | { kind: 'invalid' }
  | { kind: 'slow_down' }
  | { kind: 'expired' }
  | { kind: 'pending' }
  | { kind: 'denied' }
  | { kind: 'unbound' };

/**
 * Canonicalise a human-typed code to the stored form. Better-Auth strips grouping
 * dashes itself, so a typed `ABCD-EFGH` already matches a stored `ABCDEFGH`; Motir's
 * own row lookups must strip the same way or they would miss the row the plugin then
 * finds. The uppercase is Motir's addition — the generator's charset is uppercase-only,
 * so folding case can only ever help someone who typed `abcd-efgh` — and it is
 * applied ONCE here, with the canonical form passed on to the plugin, so both sides
 * always resolve the same row.
 */
function normalizeUserCode(userCode: string): string {
  return userCode.replace(/-/g, '').toUpperCase();
}

export const cliDeviceService = {
  /**
   * Open a grant for a terminal (`POST /api/cli/device/start`). Delegates issuance
   * to the plugin — codes, expiry, the polling interval, and the verification URIs
   * resolved against Better-Auth's `baseURL` chain — then records the CLI-reported
   * `hostname`, which the plugin has no field for and which the approval screen
   * needs in order to answer "what is connecting".
   *
   * Unauthenticated by design: a device grant is opened BEFORE anyone is identified.
   * `client_id` is pinned server-side, so the caller cannot open a grant for some
   * other client, and the scope string is pinned too — the grant is deliberately
   * unconfigurable (ADR Q2), so a request cannot ask for more than
   * `CLI_TOKEN_SCOPES`.
   *
   * No row lock here: the device code has not left the server yet, so no concurrent
   * writer can have it.
   */
  async start(input: {
    hostname?: string | null;
    /** `motir auth refresh` (MOTIR-10189): the bearer secret the terminal holds.
     * Present ⇒ this grant UPDATES that token instead of minting one. The secret
     * is the proof of possession — the token is resolved FROM it, never named. */
    updateToken?: string | null;
  }): Promise<DeviceGrantStartDTO> {
    const updateTokenId = input.updateToken ? await resolveUpdateToken(input.updateToken) : null;

    const issued = (await auth.api.deviceCode({
      body: { client_id: CLI_CLIENT_ID, scope: CLI_TOKEN_SCOPES.join(' ') },
    })) as IssuedDeviceCode;

    await db.$transaction(async (tx) => {
      const row = await deviceCodeRepository.findByDeviceCode(issued.device_code, tx);
      // The plugin created it one statement ago; a miss means the adapter and this
      // repository disagree about the table, which is a wiring bug, not a race.
      if (!row) throw new InvalidDeviceGrantError('The issued device code was not persisted.');
      await deviceCodeRepository.setHostname(row.id, normalizeHostname(input.hostname), tx);
      if (updateTokenId) await deviceCodeRepository.setUpdateToken(row.id, updateTokenId, tx);
    });

    return toDeviceGrantStartDTO(issued);
  },

  /**
   * CLAIM the code and DESCRIBE what is connecting (`GET /api/cli/device/grant`,
   * Subtask MOTIR-1888) — the read the `/device` approval screen is built on, and the
   * only way the browser can answer the ADR's "what is connecting". Better-Auth's own
   * verify endpoint returns `{ user_code, status }`; the `hostname` and `createdAt`
   * the screen needs sit unread on Motir's own row.
   *
   * ONE CALL DOES BOTH, ON PURPOSE. The claim (`userId` stamped on the row) is a hard
   * precondition of approve — skipping it is the `DeviceGrantNotClaimedError` 409 the
   * substrate documents — so splitting this into "describe" + "claim" would let a page
   * render the facts, offer an Approve button, and only then discover the sequencing
   * bug. Fusing them means a screen that renders at all is a screen that can approve.
   *
   * ORDER: claim first, read second. The claim is what makes `userId` readable, so a
   * read before it could not tell "mine" from "someone else's". The plugin also owns
   * the unknown-code and expiry checks, and it runs them BEFORE it looks at the
   * session — so those two answers come back from it rather than being duplicated here
   * (unlike `approve`, whose pre-checks must run before its own binding write).
   *
   * No transaction and no row lock: nothing here writes. See
   * `deviceCodeRepository.findByUserCodeForRead` for why a lock would guard nothing.
   */
  async describe(input: {
    userCode: string;
    actorUserId: string;
    headers: Headers;
  }): Promise<DeviceGrantDescriptionDTO> {
    const userCode = normalizeUserCode(input.userCode);

    try {
      // The CANONICAL code, and the request's own headers — the plugin reads the
      // session itself (as with `deviceApprove`), and a claim is exactly what a
      // session-less call must NOT perform.
      await auth.api.deviceVerify({ query: { user_code: userCode }, headers: input.headers });
    } catch (err) {
      throw translateVerifyError(err);
    }

    const row = await deviceCodeRepository.findByUserCodeForRead(userCode);
    // The plugin just resolved this code, so a miss means a concurrent poll reaped the
    // row (denied/expired are deleted on discovery) in the window between. Gone is
    // indistinguishable from never-existed, which is the right answer either way.
    if (!row) throw new InvalidDeviceGrantError('Invalid user code');

    // The claim did not land, so this session cannot be shown the grant. Reachable when
    // the caller gates on a session but forwards no cookies for the plugin's own read —
    // a client-sequencing bug, surfaced as the SAME 409 `approve` answers rather than
    // silently returning facts to a session that cannot then approve them.
    if (!row.userId) throw new DeviceGrantNotClaimedError();
    // Claimed by a DIFFERENT signed-in user. The phishing-relevant case, and the reason
    // this read is attributed at all: the facts on this screen are the mitigation, so
    // they are shown to the session that owns the grant and to no one else.
    if (row.userId !== input.actorUserId) throw new DeviceGrantForbiddenError();

    // An UPDATE grant names the token it would change — read as the approver, so
    // RLS hides a token that is not theirs. A refresh code someone else's terminal
    // opened is therefore never described to this session: the facts on the screen
    // are the phishing defence, and a stranger's token label is not one of them.
    if (row.updateTokenId) {
      const token = await withUserContext(input.actorUserId, (tx) =>
        apiTokenRepository.findByIdForUser(row.updateTokenId as string, input.actorUserId, tx),
      );
      if (!token) throw new DeviceGrantForbiddenError();
      return toDeviceGrantDescriptionDTO(row, toApiTokenDto(token));
    }
    return toDeviceGrantDescriptionDTO(row);
  },

  /**
   * Approve a grant from the browser (`POST /api/cli/device/approve`) — the act that
   * authorizes the mint. Authority is the APPROVER'S SESSION, established on the
   * `/device` page; no bearer token authorizes anything here, which is why this does
   * not weaken `docs/mcp.md`'s rule that a PAT cannot mint more PATs.
   *
   * ORDER MATTERS. Motir's workspace binding is written FIRST, under the row lock,
   * and only then does the plugin flip the status. The reverse order has a real
   * failure mode: an `approved` row with no `workspaceId` is a grant the poll cannot
   * honour (it has nowhere to mint), and the CLI would sit on a `server_error`. This
   * way a failure between the two steps leaves the row `pending` — the user presses
   * Approve again.
   *
   * The pre-checks below duplicate the plugin's own guards on purpose: the plugin
   * validates at FLIP time, which is after Motir has already written the binding, so
   * "is this row still pending, unexpired, and claimed by ME" has to be answered
   * before that write. The plugin re-validates under its own read; a state change in
   * between surfaces as its typed error, translated back here.
   */
  async approve(input: {
    userCode: string;
    /** The workspace a NEW credential binds to. Null only for an UPDATE grant,
     * whose token already has one. */
    workspaceId: string | null;
    actorUserId: string;
    headers: Headers;
  }): Promise<void> {
    const userCode = normalizeUserCode(input.userCode);
    const workspaceId = input.workspaceId;

    // The page sends a workspace only for a LOGIN (a refresh's token already has
    // one), so the login's two pre-checks run exactly when it names one, before
    // anything is claimed — the order they always had.
    if (workspaceId) {
      // A `motir login` credential minted as the customer inside a staff "View as"
      // session would outlive it (MOTIR-749) — refused before anything is claimed.
      await assertNoStaffSessionCookie();
      // The token BINDS to this workspace, so the approver must be a member of it.
      // `apiTokensService.create` re-asserts this at mint time — the check here is
      // what makes the refusal visible on the approval screen (403) instead of
      // surfacing as a failed poll minutes later.
      await workspacesService.assertMembership(input.actorUserId, workspaceId);
    }

    // ONE locked read decides the flow. An unknown code — or a refresh whose token
    // was deleted since, which the FK cascade takes the grant with — is the 404
    // here, never "pick a workspace" for a flow that has none.
    const updateTokenId = await db.$transaction(async (tx) => {
      const row = await lockPendingClaimedRow(userCode, input.actorUserId, tx);
      if (row.updateTokenId) return row.updateTokenId;
      if (!workspaceId) throw new DeviceGrantWorkspaceRequiredError();
      await deviceCodeRepository.setWorkspaceBinding(row.id, workspaceId, tx);
      return null;
    });
    if (updateTokenId) {
      await approveUpdate({ ...input, userCode, updateTokenId });
      return;
    }

    try {
      // The CANONICAL code, not the raw input — so the plugin's own lookup resolves
      // the same row this transaction just bound.
      await auth.api.deviceApprove({ body: { userCode }, headers: input.headers });
    } catch (err) {
      throw translateApproveError(err);
    }
  },

  /**
   * What `motir auth status` asks of its stored token (MOTIR-10189,
   * `GET /api/cli/token`): is it a CLI sign-in, and which keys of today's
   * `CLI_TOKEN_GRANT` does it lack? Answered from the presented secret, so it says
   * nothing a holder of the token could not already learn from `GET /api/v1/me`;
   * it adds only the comparison against the CLI's current set, which the CLI
   * package cannot import.
   */
  async tokenStatus(secret: string): Promise<CliTokenStatusDTO> {
    const verified = await apiTokensService.verify(secret);
    const cliSignIn = isCliSignIn(verified);
    const held = new Set<PermissionKey>(verified.grant);
    return {
      cliSignIn,
      missing: cliSignIn ? CLI_TOKEN_GRANT.filter((key) => !held.has(key)) : [],
    };
  },

  /**
   * The CLI's poll (`POST /api/cli/device/token`). Answers one of five states, and
   * on `approved` CLAIMS the grant and mints the PAT — the one place a device-minted
   * plaintext ever exists.
   *
   * The branch order mirrors the plugin's exactly (client → throttle → stamp →
   * expiry → pending → denied → approved) so a caller written against RFC 8628 or
   * against Better-Auth's own endpoint sees identical behaviour. In particular the
   * throttle is checked BEFORE the clock is stamped: a throttled poll must not push
   * the window forward, or a hot-looping client could never recover.
   */
  async poll(input: {
    deviceCode: string;
    clientId: string;
  }): Promise<DeviceGrantTokenDTO | DeviceGrantUpdatedDTO> {
    // A `client_id` that is not the CLI's cannot be honoured — the pinned identifier
    // is what keeps an unrelated caller from driving grants on this deployment.
    if (input.clientId !== CLI_CLIENT_ID) {
      throw new InvalidDeviceGrantError('Client ID mismatch');
    }

    const outcome = await db.$transaction<PollOutcome>(async (tx) => {
      await deviceCodeRepository.lockByDeviceCode(input.deviceCode, tx);
      const row = await deviceCodeRepository.findByDeviceCode(input.deviceCode, tx);
      // Unknown, or already consumed by the poll that won the race — indistinguishable
      // on purpose (the single-use contract: the plaintext is returned exactly once).
      if (!row) return { kind: 'invalid' };
      if (row.clientId && row.clientId !== input.clientId) return { kind: 'invalid' };

      const now = new Date();
      if (
        row.lastPolledAt &&
        row.pollingInterval &&
        now.getTime() - row.lastPolledAt.getTime() < row.pollingInterval
      ) {
        return { kind: 'slow_down' };
      }
      await deviceCodeRepository.touchLastPolled(row.id, now, tx);

      // Expired and denied are REAPED here: deleting on discovery means neither can
      // be re-polled, and the table never accumulates dead grants.
      if (row.expiresAt.getTime() <= now.getTime()) {
        await deviceCodeRepository.deleteById(row.id, tx);
        return { kind: 'expired' };
      }
      if (row.status === 'denied') {
        await deviceCodeRepository.deleteById(row.id, tx);
        return { kind: 'denied' };
      }
      if (row.status !== 'approved') return { kind: 'pending' };
      // An approved UPDATE: approval already changed the token, so the poll only
      // has to consume the grant and say so. Nothing is minted.
      if (row.updateTokenId && row.userId) {
        await deviceCodeRepository.deleteById(row.id, tx);
        return { kind: 'updated', userId: row.userId, tokenId: row.updateTokenId };
      }
      // An approved row without both bindings cannot be honoured. Unreachable via
      // `approve` (which writes the workspace before the flip, under this same lock).
      if (!row.userId || !row.workspaceId) return { kind: 'unbound' };

      // THE CLAIM. Deleting under the lock is what makes the mint exactly-once: a
      // concurrent poll waiting on this lock re-reads no row and answers
      // `invalid_grant`.
      await deviceCodeRepository.deleteById(row.id, tx);
      return {
        kind: 'granted',
        userId: row.userId,
        workspaceId: row.workspaceId,
        hostname: row.hostname,
      };
    });

    switch (outcome.kind) {
      case 'invalid':
        throw new InvalidDeviceGrantError();
      case 'slow_down':
        throw new DeviceGrantSlowDownError();
      case 'expired':
        throw new DeviceGrantExpiredError();
      case 'pending':
        throw new DeviceGrantPendingError();
      case 'denied':
        throw new DeviceGrantDeniedError();
      case 'unbound':
        throw new DeviceGrantUnboundError();
      case 'granted':
        return mintForGrant(outcome);
      case 'updated':
        return describeUpdated(outcome);
    }
  },
};

/** A device credential — what `motir login` mints: bound to no project and to no
 * run. Only its grant is the product's to set (`CLI_TOKEN_GRANT`). */
function isCliSignIn(token: { projectId: string | null; dispatchRunId: string | null }): boolean {
  return token.projectId === null && token.dispatchRunId === null;
}

/**
 * Resolve the bearer secret `motir auth refresh` presented to the token it names.
 * An unknown, revoked or expired secret propagates as the api-token error the
 * start route maps to 401 — the CLI's cue to say "run `motir login`". A token that
 * is not a CLI sign-in is refused here, before any grant exists.
 */
async function resolveUpdateToken(secret: string): Promise<string> {
  const verified = await apiTokensService.verify(secret);
  if (!isCliSignIn(verified)) throw new DeviceUpdateNotCliTokenError();
  return verified.tokenId;
}

/**
 * Lock the grant by user code and assert it is approvable by this actor: present,
 * unexpired, pending, and claimed by them. Shared by both approvals, so a refresh
 * cannot be approved in a state a login could not.
 */
async function lockPendingClaimedRow(
  userCode: string,
  actorUserId: string,
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
) {
  await deviceCodeRepository.lockByUserCode(userCode, tx);
  const row = await deviceCodeRepository.findByUserCode(userCode, tx);
  if (!row) throw new InvalidDeviceGrantError('Invalid user code');
  if (row.expiresAt.getTime() <= Date.now()) throw new DeviceGrantExpiredError();
  if (row.status !== 'pending') throw new DeviceGrantNotPendingError();
  // `userId` is stamped by the plugin's `GET /device?user_code=…`, which the page
  // calls on mount while signed in. Unclaimed means the client skipped that step.
  if (!row.userId) throw new DeviceGrantNotClaimedError();
  if (row.userId !== actorUserId) throw new DeviceGrantForbiddenError();
  return row;
}

/**
 * Approve a `motir auth refresh` grant (MOTIR-10189): set the token's grant to
 * `CLI_TOKEN_GRANT` through `apiTokensService.updatePermissions` — so the owner
 * check, the binding check and the staff "View as" refusal are that method's own —
 * and only then flip the grant to approved, which the terminal's poll observes.
 *
 * Unlike a login, the change happens HERE rather than at the poll: there is no
 * secret to hand over, so nothing has to wait for the terminal, and the staff
 * refusal can only be judged on the approver's own request (the poll carries no
 * browser cookie).
 *
 * A refusal DENIES the grant, so the terminal stops waiting and says the token is
 * unchanged instead of sitting on a code that can no longer succeed.
 */
async function approveUpdate(input: {
  userCode: string;
  updateTokenId: string;
  actorUserId: string;
  headers: Headers;
}): Promise<void> {
  // The grant was locked and checked (pending, unexpired, claimed by this actor) by
  // `approve`'s own transaction a moment ago; the plugin re-checks at the flip.
  try {
    await apiTokensService.updatePermissions(input.actorUserId, input.updateTokenId, {
      fixedGrant: CLI_TOKEN_GRANT,
    });
  } catch (err) {
    const refused =
      err instanceof ApiTokenNotFoundError ||
      err instanceof InvalidTokenBindingError ||
      err instanceof ImpersonationCredentialRefusedError;
    if (!refused) throw err;
    await auth.api
      .deviceDeny({ body: { userCode: input.userCode }, headers: input.headers })
      .catch(() => undefined);
    throw new DeviceUpdateRefusedError((err as Error).message);
  }

  try {
    await auth.api.deviceApprove({ body: { userCode: input.userCode }, headers: input.headers });
  } catch (err) {
    throw translateApproveError(err);
  }
}

/** The answer to an approved UPDATE's poll: the token as it now stands, for the
 * CLI's one-line confirmation. Nothing secret — the terminal already holds it. */
async function describeUpdated(grant: {
  userId: string;
  tokenId: string;
}): Promise<DeviceGrantUpdatedDTO> {
  const token = await withUserContext(grant.userId, (tx) =>
    apiTokenRepository.findByIdForUser(grant.tokenId, grant.userId, tx),
  );
  const user = await userRepository.findById(grant.userId);
  // Revoked between the approval and this poll: the update landed on a token that
  // no longer exists, which is the same "run `motir login`" answer as any gone token.
  if (!token || !user) throw new InvalidDeviceGrantError('The updated token no longer exists.');
  return toDeviceGrantUpdatedDTO({ dto: toApiTokenDto(token), user });
}

/**
 * Mint the CLI credential for a CLAIMED grant. Runs after the claim transaction has
 * committed (see the concurrency note at the top of this file), so it is reached at
 * most once per approval.
 *
 * The grant is unconfigurable: fixed `CLI_TOKEN_SCOPES`, fixed 90-day expiry, label
 * `CLI · <hostname>`. Nothing about the request can widen any of them.
 */
async function mintForGrant(grant: {
  userId: string;
  workspaceId: string;
  hostname: string | null;
}): Promise<DeviceGrantTokenDTO> {
  let minted;
  try {
    minted = await apiTokensService.create(grant.userId, grant.workspaceId, {
      label: cliTokenLabel(grant.hostname),
      expiresAt: new Date(Date.now() + CLI_TOKEN_EXPIRY_DAYS * DAY_MS),
      // FIXED, not chosen — so it binds to no project and is not capped against
      // the approver's own access. `motir login` is the one credential the
      // product picks the grant for (ADR Amendment 1 §A.2).
      fixedGrant: CLI_TOKEN_GRANT,
    });
  } catch (err) {
    // The approver lost access to the bound workspace between approving and the
    // poll (removed from the org / workspace). The grant is already consumed, so
    // there is nothing to retry against: `invalid_grant` is the honest answer, and
    // re-running `motir login` is the fix.
    if (err instanceof NotAMemberError) {
      throw new InvalidDeviceGrantError('The approved workspace is no longer accessible.');
    }
    throw err;
  }

  // Read the identity + workspace the CLI prints its confirmation from. The
  // workspace read binds the RLS context (`findByIdInTx`); the db-singleton variant
  // returns null under the non-bypass app role.
  // MOTIR-3077 — bucket B (peer reads), left on `Promise.all` deliberately.
  // The grant is validated above and `findById` resolves to `null` for a
  // missing user rather than rejecting, so the transaction-opening arm has
  // no sibling that can abandon it.
  const [user, workspace] = await Promise.all([
    userRepository.findById(grant.userId),
    withWorkspaceContext({ userId: grant.userId, workspaceId: grant.workspaceId }, (tx) =>
      workspaceRepository.findByIdInTx(grant.workspaceId, tx),
    ),
  ]);
  if (!user || !workspace) throw new DeviceGrantUnboundError();

  return toDeviceGrantTokenDTO({ token: minted.token, dto: minted.dto, user, workspace });
}

/**
 * Translate the plugin's `APIError` from the CLAIM (`deviceVerify`) into this domain's
 * typed errors.
 *
 * ⚠️ SEPARATE FROM `translateApproveError` ON PURPOSE — do not merge them. Both
 * endpoints raise `invalid_request`, and it means DIFFERENT things: on `deviceVerify`
 * it is `INVALID_USER_CODE` (the code does not exist → 404), while on `deviceApprove`
 * it is "this grant is not in an approvable state" (→ 409 NOT_PENDING). Routing the
 * claim through the approve translator would answer 409 for a mistyped code, which is
 * precisely the state the `/device` page renders as "already approved".
 *
 * Unlike the approve path, neither branch here is a race: the plugin checks the code
 * and its expiry before it ever looks at the session, so both are ordinary answers to
 * an ordinary request. An unrecognised body still rethrows rather than being swallowed.
 */
function translateVerifyError(err: unknown): unknown {
  if (!(err instanceof APIError)) return err;
  const code = (err.body as { error?: string } | undefined)?.error;
  if (code === 'expired_token') return new DeviceGrantExpiredError();
  if (code === 'invalid_request') return new InvalidDeviceGrantError('Invalid user code');
  return err;
}

/**
 * Translate the plugin's `APIError` from the status flip into this domain's typed
 * errors. Reached only when the row changed state between Motir's pre-checks and the
 * flip (a concurrent deny, or the code expiring in that window), so every branch is
 * a genuine race — which is why it never swallows: an unrecognised body rethrows.
 */
function translateApproveError(err: unknown): unknown {
  if (!(err instanceof APIError)) return err;
  const code = (err.body as { error?: string } | undefined)?.error;
  if (code === 'expired_token') return new DeviceGrantExpiredError();
  if (code === 'access_denied') return new DeviceGrantForbiddenError();
  if (code === 'unauthorized') return new DeviceGrantForbiddenError();
  if (code === 'invalid_request') return new DeviceGrantNotPendingError();
  return err;
}
