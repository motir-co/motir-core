import { withSystemContext } from '@/lib/workspaces/context';
import { workspacesService } from '@/lib/services/workspacesService';
import { apiTokenRepository } from '@/lib/repositories/apiTokenRepository';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { generateToken, hashToken, tokenPrefixOf } from '@/lib/apiTokens/token';
import { GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER } from '@/lib/tokens/grant';
import { HOSTED_RUN_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { latestRunCredentialExpiry } from '@/lib/hostedRuns/limits';
import {
  DispatchRunNotFoundError,
  RunCredentialExpiryTooLateError,
  RunCredentialRunNotLiveError,
} from '@/lib/dispatchRuns/errors';

// The HOSTED RUN's own Motir credential (Story 9.1 · MOTIR-688,
// `docs/decisions/hosted-agent-run.md` §3).
//
// A hosted run's container reports through the shared ingest and reads its
// card's dispatch prompt, and both need a credential. This mints ONE `ApiToken`
// per run that:
//
//   * acts AS THE DISPATCHER — its row is theirs, so every write it makes is
//     attributed to the person who pressed Run hosted;
//   * is BOUND to the run (`ApiToken.dispatchRunId`) — every bearer door refuses
//     it (`authenticateApiToken`, `verifyMcpToken`) except the routes the CLI's
//     `motir run` calls (`lib/hostedRuns/runTokenRoutes.ts`, MOTIR-6557), and
//     those check the binding against the run and the cards they are asked for;
//   * carries `HOSTED_RUN_TOKEN_GRANT` and is bound to the run's PROJECT, so even
//     the doors that admit it narrow it to that project;
//   * EXPIRES no later than the run's timeout plus the settle margin, and is
//     DELETED at close by the end path (`revokeRunCredential`). Deletion is
//     revocation, as for every PAT (MOTIR-3546): a revoked run token cannot be
//     revived.
//
// It is NOT a second token system. The hashing, the expiry check and the grant
// check are `ApiToken`'s own; a run token differs by one column and one grant.
// The reference is GitHub Actions' per-job `GITHUB_TOKEN`.
//
// Both calls run under `withSystemContext`: they are made by the server's own
// start and end paths, which hold no user context for the dispatcher, and
// `api_token_owner_or_system` / `dispatch_run_system_read` admit the system
// binding.

export interface MintRunCredentialInput {
  /** The run this credential reports for — `DispatchRun.id` (§1). */
  dispatchRunId: string;
  /** The person who dispatched it; the token acts as them. */
  dispatcherUserId: string;
  /** When it dies on its own. No later than {@link latestRunCredentialExpiry}. */
  expiresAt: Date;
}

export interface RunCredential {
  /** The plaintext secret. Returned ONCE — only its hash is stored. */
  token: string;
  /** The `ApiToken` row id. */
  tokenId: string;
  expiresAt: Date;
}

export const runCredentialService = {
  /**
   * Mint the run's credential. Refuses a run that is not `running`
   * (`RUN_CREDENTIAL_RUN_NOT_LIVE`) and an expiry past the run's timeout plus
   * the settle margin, measured from now — boot is no earlier than the mint
   * (`RUN_CREDENTIAL_EXPIRY_TOO_LATE`). Refused, never clamped: a caller asking
   * for a longer life has a timeout arithmetic bug worth hearing about.
   *
   * `now` is injectable for the expiry bound's tests only.
   */
  async mintRunCredential(
    input: MintRunCredentialInput,
    now: Date = new Date(),
  ): Promise<RunCredential> {
    const latest = latestRunCredentialExpiry(now);
    if (input.expiresAt.getTime() > latest.getTime()) {
      throw new RunCredentialExpiryTooLateError(input.expiresAt, latest);
    }

    const run = await withSystemContext((tx) =>
      dispatchRunRepository.findById(input.dispatchRunId, tx),
    );
    if (!run) throw new DispatchRunNotFoundError(input.dispatchRunId);
    if (run.status !== 'running') {
      throw new RunCredentialRunNotLiveError(run.id, run.status);
    }
    // The token acts as the dispatcher in the run's workspace, so they must be a
    // member of it — the same check `apiTokensService.create` makes.
    await workspacesService.assertMembership(input.dispatcherUserId, run.workspaceId);

    const token = generateToken();
    const row = await withSystemContext((tx) =>
      apiTokenRepository.create(
        {
          userId: input.dispatcherUserId,
          workspaceId: run.workspaceId,
          label: `Motir agent run ${run.id}`,
          tokenHash: hashToken(token),
          tokenPrefix: tokenPrefixOf(token),
          expiresAt: input.expiresAt,
          // The marker makes the grant read EXACTLY as stored: without it,
          // `expandStoredGrant` reads the room view keys forward from
          // `project:browse`, and this credential needs neither room.
          scopes: [...HOSTED_RUN_TOKEN_GRANT, GRANT_OFFERED_ROOM_VIEW_KEYS_MARKER],
          projectId: run.projectId,
          dispatchRunId: run.id,
        },
        tx,
      ),
    );
    return { token, tokenId: row.id, expiresAt: input.expiresAt };
  },

  /**
   * Revoke the run's credential — delete every token bound to the run.
   * IDEMPOTENT: a second call, or a call for a run that never had one, revokes
   * nothing and returns `{ revoked: 0 }`. Called by the end path on every
   * terminal state; the expiry is the backstop if it never runs.
   */
  async revokeRunCredential(dispatchRunId: string): Promise<{ revoked: number }> {
    const revoked = await withSystemContext((tx) =>
      apiTokenRepository.deleteByDispatchRunId(dispatchRunId, tx),
    );
    return { revoked };
  },
};
