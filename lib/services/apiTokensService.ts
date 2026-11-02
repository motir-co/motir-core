import type { User } from '@/generated/prisma/client';
import { withSystemContext, withUserContext } from '@/lib/workspaces/context';
import { workspacesService } from '@/lib/services/workspacesService';
import { organizationsService } from '@/lib/services/organizationsService';
import { apiTokenRepository } from '@/lib/repositories/apiTokenRepository';
import { toApiTokenDto } from '@/lib/mappers/apiTokenMappers';
import { generateToken, hashToken, tokenPrefixOf } from '@/lib/apiTokens/token';
import {
  ApiTokenExpiredError,
  ApiTokenNotFoundError,
  ApiTokenRevokedError,
  InvalidApiTokenError,
  InvalidApiTokenLabelError,
  InvalidTokenBindingError,
  InvalidTokenGrantError,
} from '@/lib/apiTokens/errors';
import {
  GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER,
  IRREVERSIBLE_PERMISSIONS,
  expandStoredGrant,
  grantableFor,
} from '@/lib/tokens/grant';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { OrganizationSuspendedError } from '@/lib/organizations/errors';
import type {
  ApiTokenDto,
  CreateApiTokenResult,
  TokenScopeOrgDTO,
  TokenScopeProjectDTO,
  TokenScopeWorkspaceDTO,
} from '@/lib/dto/apiTokens';
import { projectsService } from '@/lib/services/projectsService';
import { assertNoStaffSessionCookie } from '@/lib/platform/staffSession';

// API-token service (Story 7.8 · Subtask 7.8.1) — the auth substrate every
// other 7.8 subtask rides. Owns transactions, token generation/hashing,
// validation, the last-used throttle, DTO mapping, and typed errors over the
// `apiTokenRepository` leaf (CLAUDE.md 4-layer split).
//
// Two scoping contexts, by design:
//   * OWNER (create / listForUser / revoke) run under `withUserContext`, which
//     binds the `app.user_id` GUC the `api_token` RLS policy reads — a user
//     only ever sees/mutates their OWN tokens. Cross-user ids read as null →
//     ApiTokenNotFoundError (the 404-not-403 contract, no existence leak).
//   * SYSTEM (verify) runs under `withSystemContext`: the MCP bearer gate
//     resolves a presented secret BEFORE any user context exists, so it cannot
//     bind `app.user_id`. The system context (a constant, never user input —
//     the value verified is the hash, bound as a query param) lets the
//     hash probe see the row regardless of owner (the job-ledger precedent).
//
// The plaintext secret lives in exactly ONE place ever: `create`'s return
// value. It is generated, hashed, and persisted-as-hash; the row, every DTO,
// and every log hold only the hash + the display prefix.

/** Max label length — a human-facing name ("claude-code"), not free text. */
const MAX_LABEL_LENGTH = 100;

/** Skip the `lastUsedAt` write when the token was touched within this window,
 * so a chatty agent session does not write-amplify on every MCP call. */
const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

export interface CreateApiTokenInput {
  /** User-facing name, e.g. "claude-code". Required, trimmed, ≤ 100 chars. */
  label: string;
  /** Absolute expiry, or null/undefined to never expire. The settings UI
   * derives this from its 30/90/365-day-or-never select. */
  expiresAt?: Date | null;
  /** The GRANT — the permission keys this token may exercise (MOTIR-2572).
   *
   * ⚠️ SUPPLYING THIS REQUIRES {@link CreateApiTokenInput.projectId} (MOTIR-2606;
   * ADR Amendment 1 §A.5). A CHOSEN grant is meaningless without a project —
   * permissions resolve per project, so "may this token edit work items?" has no
   * answer until one is named. Each key is validated against what the CALLER can
   * confer IN THAT PROJECT, not against the static grantable set.
   *
   * Omit it for the DEVICE path, which supplies the fixed `CLI_TOKEN_GRANT` and
   * no project; the default is then `DEFAULT_TOKEN_GRANT`. */
  permissions?: string[];
  /** The PROJECT this token is bound to (MOTIR-2606). Required with
   * `permissions`, forbidden without — the two legal shapes, see
   * {@link InvalidTokenBindingError}. A project the caller cannot browse
   * resolves to "you may confer nothing", never a 403 that confirms it exists. */
  projectId?: string;
  /** A FIXED grant, for the one path that does not choose one: `motir login`'s
   * device approval, which mints `CLI_TOKEN_GRANT` and shows it without letting
   * anyone edit it.
   *
   * ⚠️ NOT validated against the actor, and that is the point — there is no
   * offer to cap, because the product picked this set, not a person. It is also
   * why such a token binds to no project: with nothing chosen there is no
   * per-project question to answer, and `grant ∩ role` settles it at dispatch.
   *
   * Mutually exclusive with {@link CreateApiTokenInput.permissions}. */
  fixedGrant?: readonly PermissionKey[];
}

/**
 * What `updatePermissions` replaces a token's grant with (MOTIR-10188). The
 * same two shapes `create` knows, minus everything that is fixed at mint:
 *
 *   * `{ permissions }` — a CHOSEN grant, for a token BOUND to a project. Each
 *     key is validated against what the owner can confer there NOW, exactly as
 *     `create` validates it.
 *   * `{ fixedGrant }` — the device credential's product-chosen set, for a
 *     token bound to NO project. Only `motir auth refresh`'s approval sends it
 *     (MOTIR-10189), with `CLI_TOKEN_GRANT`.
 *
 * Which one is legal is decided by the TOKEN's binding, not by the caller: a
 * chosen grant on a device credential (or a fixed one on a bound token) is the
 * same {@link InvalidTokenBindingError} the create path raises.
 */
export type UpdateApiTokenPermissionsInput =
  | { permissions: string[]; fixedGrant?: never }
  | { fixedGrant: readonly PermissionKey[]; permissions?: never };

function normalizeLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LABEL_LENGTH) {
    throw new InvalidApiTokenLabelError();
  }
  return trimmed;
}

/**
 * Enforce the TWO legal call shapes (ADR Amendment 1 §A.5) before anything else.
 *
 *   * `{ permissions, projectId }` — a chosen grant, bound to a project.
 *   * `{ }` — the device path: the fixed `CLI_TOKEN_GRANT`, no project.
 *
 * Checked FIRST so the other two combinations never reach a DB round-trip, and
 * so the rule reads in one place rather than as two scattered guards.
 */
function assertLegalBinding(input: CreateApiTokenInput): void {
  // The rule, in one line: `fixedGrant` XOR `projectId`.
  //
  // A CHOSEN grant is identified by its PROJECT, not by whether the caller
  // typed the permissions out — the modal legitimately omits them to mean "the
  // default for this project", which is still a choice made against that
  // project's offer. A FIXED grant chooses nothing and so binds to nothing.
  const fixed = input.fixedGrant !== undefined;
  const bound = input.projectId !== undefined;

  if (fixed && bound) {
    throw new InvalidTokenBindingError(
      'A fixed grant chooses nothing, so it binds to no project — it is workspace-scoped.',
    );
  }
  if (!fixed && !bound) {
    throw new InvalidTokenBindingError(
      'A token needs a grant: name the project it applies to, or supply the fixed device grant.',
    );
  }
  if (input.permissions !== undefined && fixed) {
    throw new InvalidTokenBindingError(
      'A grant is either CHOSEN by a person or FIXED by the product — never both.',
    );
  }
}

/**
 * Resolve the GRANT a `create` call persists.
 *
 * The device path (no `permissions`) takes {@link DEFAULT_TOKEN_GRANT}. A CHOSEN
 * grant is validated against `conferrable` — what the CALLER holds in the bound
 * project ∩ the grantable set — not against the static set. That is the whole
 * point of MOTIR-2606: before it, a project VIEWER could mint `work_item:delete`
 * and hold a grant they cannot exercise anywhere, which is a token whose stated
 * authority is a fiction.
 *
 * An EMPTY explicit list is allowed through and yields a token that can do
 * nothing. That is a legitimate thing to mint (and the surface refuses it with
 * its own copy first); refusing it here would make "grant nothing"
 * un-expressible for no safety gain — the failure direction is already harmless.
 */
function resolveGrant(
  input: CreateApiTokenInput,
  conferrable: readonly PermissionKey[],
): PermissionKey[] {
  if (input.fixedGrant !== undefined) return [...input.fixedGrant];
  // Omitted with a project = "the default for THIS project": everything the
  // caller can confer there, minus the irreversible key. Resolved server-side
  // rather than defaulted to the static `DEFAULT_TOKEN_GRANT`, so the default
  // can never exceed the offer the picker would have shown them.
  if (input.permissions === undefined) {
    return conferrable.filter((key) => !IRREVERSIBLE_PERMISSIONS.includes(key));
  }
  const requested = input.permissions;
  const allowed = new Set<string>(conferrable);
  const invalid = requested.filter((key) => !allowed.has(key));
  if (invalid.length > 0) throw new InvalidTokenGrantError(invalid);
  // Validated above, so every entry is a grantable PermissionKey.
  return [...new Set(requested as PermissionKey[])];
}

export const apiTokensService = {
  /**
   * Mint a token for `userId`. Generates the secret, persists ONLY its
   * sha-256 hash + display prefix in a transaction, and returns the plaintext
   * ONCE (never persisted, never logged) alongside the display-safe DTO. The
   * caller shows the plaintext once with a copy affordance; after that it is
   * irretrievable.
   */
  async create(
    userId: string,
    workspaceId: string,
    input: CreateApiTokenInput,
  ): Promise<CreateApiTokenResult> {
    // Never a credential minted as the customer inside a staff "View as"
    // session (MOTIR-749) — it would outlive the time-box.
    await assertNoStaffSessionCookie();
    const label = normalizeLabel(input.label);
    // The SHAPE first, so an illegal combination never reaches the DB.
    assertLegalBinding(input);
    // The token BINDS to `workspaceId` (bug 7.21), so the user must be a member
    // of it — the create UI only offers the user's own workspaces, but the
    // server is the authority (a forged id throws NotAMemberError → 403).
    await workspacesService.assertMembership(userId, workspaceId);
    // What the CALLER may confer in the bound project. `getPermissions` resolves
    // the actor's real set there (level + workspace role + project role + custom
    // role). A project they cannot browse throws `ProjectNotFoundError`, which
    // propagates to a 404 — never a 403 that would confirm the project exists.
    const conferrable = input.projectId
      ? grantableFor(
          await projectAccessService.getPermissions(input.projectId, { userId, workspaceId }),
        )
      : [];
    const permissions = resolveGrant(input, conferrable);
    const token = generateToken();
    const row = await withUserContext(userId, (tx) =>
      apiTokenRepository.create(
        {
          userId,
          workspaceId,
          label,
          tokenHash: hashToken(token),
          tokenPrefix: tokenPrefixOf(token),
          expiresAt: input.expiresAt ?? null,
          // The column's name is historical; it stores the grant. See its
          // schema doc-comment and `docs/decisions/token-permissions.md` §5.
          // The marker records that this grant was chosen from an offer that
          // held the room view keys, so it is read exactly as stored (MOTIR-6329,
          // AMENDMENT 2).
          scopes: [...permissions, GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER],
          projectId: input.projectId ?? null,
        },
        tx,
      ),
    );
    return { token, dto: toApiTokenDto(row) };
  },

  /** A user's tokens across all their workspaces, newest first — the
   * account-level settings list. Each DTO carries the workspace + org it is
   * bound to (bug 7.21) so the list labels its scope. Display-safe (never the
   * hash). */
  async listForUser(userId: string): Promise<ApiTokenDto[]> {
    const rows = await withUserContext(userId, (tx) => apiTokenRepository.findByUser(userId, tx));
    return rows.map(toApiTokenDto);
  },

  /**
   * The org → workspace tree the create modal scopes a token within (bug 7.21):
   * every organization the user belongs to, each with the workspaces of it they
   * are a member of (an org with zero accessible workspaces is omitted). The
   * modal pre-selects the active workspace; the user can pick any of these.
   * Composes the same reads the shell switcher uses — no new persistence.
   */
  async listScopeOptions(userId: string): Promise<TokenScopeOrgDTO[]> {
    const [orgs, workspaces] = await Promise.all([
      organizationsService.listUserOrganizations(userId),
      workspacesService.listUserWorkspaces(userId),
    ]);
    const workspacesByOrg = new Map<string, TokenScopeWorkspaceDTO[]>();
    for (const w of workspaces) {
      // Each project carries the OFFER for this actor (MOTIR-2580), resolved
      // through the same read `create` validates against — so the picker can
      // never show a switch the create call would refuse.
      const projects = await projectsService.listProjects(w.id, userId);
      const withGrants: TokenScopeProjectDTO[] = await Promise.all(
        projects.map(async (p) => ({
          id: p.id,
          key: p.identifier,
          name: p.name,
          grantable: await apiTokensService.listGrantablePermissions(userId, w.id, p.id),
        })),
      );
      const list = workspacesByOrg.get(w.organizationId) ?? [];
      list.push({ id: w.id, name: w.name, projects: withGrants });
      workspacesByOrg.set(w.organizationId, list);
    }
    return orgs
      .map((org) => ({ id: org.id, name: org.name, workspaces: workspacesByOrg.get(org.id) ?? [] }))
      .filter((org) => org.workspaces.length > 0);
  },

  /**
   * What this actor may confer on a token bound to `projectId` (MOTIR-2606).
   *
   * The ONE read both the create-token modal's OFFER and {@link create}'s
   * VALIDATION consult. Two implementations of "what may this person grant"
   * would agree the day they were written and drift the first time an access
   * level changed — and the drift is invisible from either side: a switch the
   * create call rejects, or one it should have.
   *
   * A project the actor cannot browse throws `ProjectNotFoundError` from
   * `getPermissions` and it is allowed to PROPAGATE — the route maps it to a
   * 404. That is the 404-not-403 contract itself rather than an imitation of
   * it: swallowing the error to return an empty set would answer "you may
   * confer nothing", which is a different sentence and a slightly worse one
   * (it confirms the request was well-formed).
   */
  async listGrantablePermissions(
    userId: string,
    workspaceId: string,
    projectId: string,
  ): Promise<PermissionKey[]> {
    return grantableFor(
      await projectAccessService.getPermissions(projectId, { userId, workspaceId }),
    );
  },

  /**
   * Replace the GRANT of one of the caller's own tokens (MOTIR-10188) — the
   * permissions change, the credential does not. The hash (so the secret every
   * agent already holds), the prefix, the label, the workspace and project
   * binding and the expiry are left exactly as minted, so nothing has to be
   * copied again: `verify` reads the grant per call, and the next call made
   * with the token is answered under the new one.
   *
   * The checks are `create`'s, in `create`'s order, so the two doors cannot
   * drift:
   *   1. never inside a staff "View as" session (MOTIR-749) — widening a
   *      credential's authority is minting authority as the customer;
   *   2. the token must be one of the caller's own — a missing id, another
   *      user's id (null under RLS), an OAuth connection or a dispatch-run
   *      token all read as {@link ApiTokenNotFoundError} (404-not-403);
   *   3. the grant's SHAPE must match the token's binding (see
   *      {@link UpdateApiTokenPermissionsInput});
   *   4. a chosen grant is validated against what the owner can confer in the
   *      bound project TODAY (`grantableFor` over `getPermissions`, then
   *      `resolveGrant`) — a key they can no longer grant is refused with
   *      {@link InvalidTokenGrantError} and nothing is written.
   *
   * The new grant is stored with the same marker `create` writes
   * (`GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER`), because it was chosen from an offer
   * that held the room view keys and must be read exactly as stored.
   */
  async updatePermissions(
    userId: string,
    tokenId: string,
    input: UpdateApiTokenPermissionsInput,
  ): Promise<ApiTokenDto> {
    await assertNoStaffSessionCookie();
    // Ownership first, in its own read: the validation below calls services that
    // open their own contexts, so it cannot run inside the write transaction.
    const existing = await withUserContext(userId, (tx) =>
      apiTokenRepository.findByIdForUser(tokenId, userId, tx),
    );
    // A RUN token (MOTIR-688) is the run's, not the person's — it is never listed
    // and it is not theirs to widen.
    // A row carrying `revokedAt` (stamped by the pre-delete revoke, see `verify`) is
    // as dead as a deleted one, and the list never shows it: not-found too.
    if (!existing || existing.dispatchRunId !== null || existing.revokedAt !== null) {
      throw new ApiTokenNotFoundError(tokenId);
    }

    let permissions: PermissionKey[];
    if (input.fixedGrant !== undefined) {
      if (existing.projectId !== null) {
        throw new InvalidTokenBindingError(
          'A fixed grant chooses nothing, so it binds to no project — this token is bound to one.',
        );
      }
      permissions = resolveGrant({ label: existing.label, fixedGrant: input.fixedGrant }, []);
    } else {
      if (existing.projectId === null) {
        throw new InvalidTokenBindingError(
          'This token is a device credential with the CLI’s fixed grant — run `motir auth refresh` to update it.',
        );
      }
      // The token BINDS to its workspace; an owner who has left it confers nothing
      // there, and the create path refuses the same way.
      await workspacesService.assertMembership(userId, existing.workspaceId);
      const conferrable = await apiTokensService.listGrantablePermissions(
        userId,
        existing.workspaceId,
        existing.projectId,
      );
      permissions = resolveGrant(
        { label: existing.label, projectId: existing.projectId, permissions: input.permissions },
        conferrable,
      );
    }

    const row = await withUserContext(userId, async (tx) => {
      // Re-probed inside the write: a revoke that committed since the read above
      // leaves nothing to update, and that is the same not-found, never a P2025.
      const live = await apiTokenRepository.findByIdForUser(tokenId, userId, tx);
      if (!live) throw new ApiTokenNotFoundError(tokenId);
      return apiTokenRepository.updateScopes(
        tokenId,
        [...permissions, GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER],
        tx,
      );
    });
    return toApiTokenDto(row);
  },

  /**
   * Revoke one of the user's own tokens — DELETES the row (MOTIR-3546).
   *
   * Revoking a token id that is missing OR owned by another user is an
   * ApiTokenNotFoundError (404-not-403): the ownership probe runs first and a
   * cross-user id reads as null under RLS, so the no-existence-leak contract is
   * exactly what it was. Re-revoking an already-deleted id is now that same 404
   * rather than the old idempotent no-op — there is no row left to return, and
   * "this token is gone" is the true answer to both.
   *
   * Returns nothing: the row no longer exists, so there is no DTO to map. The
   * caller REMOVES the row from its own state (the page-state-after-mutation
   * contract — the list is a client island that owns its state).
   */
  async deleteToken(userId: string, tokenId: string): Promise<void> {
    await withUserContext(userId, async (tx) => {
      const existing = await apiTokenRepository.findByIdForUser(tokenId, userId, tx);
      if (!existing) throw new ApiTokenNotFoundError(tokenId);
      await apiTokenRepository.remove(tokenId, tx);
    });
  },

  /**
   * Resolve a presented plaintext secret to its owning user — the MCP bearer
   * gate's only auth job. Re-hashes the input and probes the unique hash index
   * (constant work regardless of validity), then rejects each failure mode
   * with a DISTINCT typed error: unknown/malformed → InvalidApiTokenError,
   * past-expiry → ApiTokenExpiredError. `ApiTokenRevokedError` survives as a
   * TRANSITION GUARD only — see the `revokedAt` check in the body.
   * On success, touches `lastUsedAt` (throttled to once per 5-minute window)
   * and returns the owning User PLUS the workspace the token is BOUND to
   * (bug 7.21) — the MCP bearer gate resolves the request workspace from this
   * `workspaceId`, NOT the owner's default workspace, so a token minted in
   * workspace A always acts on A — AND the token's resolved GRANT
   * (MOTIR-2572), so each dispatch seam can narrow the owner's role to the
   * operations the grant permits.
   *
   * ⚠️ The grant is the EXPANDED one. A row minted before MOTIR-2572 holds
   * legacy scope strings, and `expandStoredGrant` maps them forward here — once,
   * at the single seam every caller comes through — so no gate ever sees a
   * legacy string. An unrecognised stored value is DROPPED and logged rather
   * than throwing: a malformed row must degrade to LESS access, never to a
   * default grant nobody chose.
   *
   * Returns the raw Prisma User (not a DTO) deliberately: the only caller is
   * internal infrastructure (the 7.8.4 transport gate building the request
   * actor), the same internal-caller exception `usersService.findOrCreateOAuthUser`
   * documents — there is no public-API shape for "the authenticated principal".
   */
  async verify(plaintext: string): Promise<{
    user: User;
    workspaceId: string;
    grant: PermissionKey[];
    /** The PROJECT this token is bound to, or null (MOTIR-2607). Null is the
     * DEVICE-CREDENTIAL SHAPE and means "every project the holder's roles
     * reach" — it is the specification of how `motir login` works, not a
     * compatibility arm to tighten later. */
    projectId: string | null;
    /** The DISPATCH RUN this token is bound to, or null (MOTIR-688). Non-null
     * makes it a RUN token, which every bearer door refuses unless the route
     * opted in (`authenticateApiToken`'s `acceptsRunToken`, `verifyMcpToken`). */
    dispatchRunId: string | null;
    /** The token row's id (MOTIR-7673) — what an audit row names as the
     * credential. Never the secret. Every caller before the ideas gate ignores it. */
    tokenId: string;
    /** @deprecated SCAFFOLDING — the raw column, for the two gates that have
     * not moved yet. Removed by MOTIR-2576 (MCP) / MOTIR-2577 (`/api/v1`). */
    scopes: string[];
  }> {
    const tokenHash = hashToken(plaintext);
    return withSystemContext(async (tx) => {
      const row = await apiTokenRepository.findByTokenHash(tokenHash, tx);
      if (!row) throw new InvalidApiTokenError();
      // ⚠️ TRANSITION GUARD, and it is not dead code yet (MOTIR-3546).
      // Revocation now DELETES the row, so no code path writes `revoked_at` any
      // more and the migration cleared every row that carried one. What keeps
      // this line here is the DEPLOY WINDOW: `fly.toml`'s `release_command`
      // runs the migration BEFORE any new machine takes traffic, so for the
      // length of a rolling release the OLD image is still serving — and the
      // old image still stamps `revoked_at` on a revoke. A token revoked in
      // that window would otherwise come back VALID once the new image is
      // everywhere. This line costs one null check and closes that window.
      // It goes when the column does — see `prisma/schema.prisma`.
      if (row.revokedAt) throw new ApiTokenRevokedError();
      // An OAuth CONNECTION (MOTIR-6983) is not a bearer credential: its hash is
      // of bytes nobody holds, so no presented secret can match it. Refused here
      // anyway, so the PAT door can never become a way into a connected app's
      // grant — the connection's own tokens resolve through
      // `oauthConnectionsService.resolveAccessToken`.
      if (row.oauthClientId !== null) throw new InvalidApiTokenError();
      const now = new Date();
      if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) {
        throw new ApiTokenExpiredError();
      }
      // A SUSPENDED organization's tokens are refused (MOTIR-748) — every PAT,
      // device credential (`motir login`) and run token bound to a workspace
      // under it. Checked AFTER the credential is proven valid, so an invalid
      // token stays a plain 401 and the dedicated 403 reaches only a holder of
      // a real credential. Not a revocation: reactivating restores every token.
      const org = row.workspace.organization;
      if (org.suspendedAt) throw new OrganizationSuspendedError(org.id, org.name);
      // Throttle the last-used touch: skip the write inside the window.
      const lastUsed = row.lastUsedAt?.getTime();
      if (lastUsed === undefined || now.getTime() - lastUsed >= LAST_USED_THROTTLE_MS) {
        // A revoke deletes the row, so one that commits between the lookup above and
        // this touch leaves nothing to stamp: the token is gone, which is a 401 — not
        // the P2025 an unmapped 500 would be (the CLI's close racing a Cancel,
        // MOTIR-8885).
        if ((await apiTokenRepository.touchLastUsed(row.id, now, tx)) === 0) {
          throw new InvalidApiTokenError();
        }
      }
      const { grant, unrecognised } = expandStoredGrant(row.scopes, { projectId: row.projectId });
      if (unrecognised.length > 0) {
        console.warn(
          `[apiTokens] token ${row.id} carries ${unrecognised.length} unrecognised grant value(s); ignoring them: ${unrecognised.map((u) => JSON.stringify(u.value)).join(', ')}`,
        );
      }
      return {
        user: row.user,
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        dispatchRunId: row.dispatchRunId,
        tokenId: row.id,
        grant,
        // The raw stored values, less the mint path's marker (MOTIR-6329), which is
        // bookkeeping for `expandStoredGrant` and never a value a caller acts on.
        scopes: row.scopes.filter((value) => value !== GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER),
      };
    });
  },
};
