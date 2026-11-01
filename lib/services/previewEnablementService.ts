import type { DeployCredential } from '@motir/orchestrator';
import { getHostingDeployPort } from '@/lib/orchestrator/hosting';
import { actionsVariableClient } from '@/lib/github/actionsVariables';
import type { GithubOrgTarget } from '@/lib/github/orgTarget';
import {
  repositoryActionsConfigClient,
  type RepositoryCoordinates,
} from '@/lib/github/repositoryActionsConfig';
import {
  NEON_PREVIEW_TARGETS,
  PREVIEW_BUILD_ON,
  PREVIEW_CREDENTIAL_RENEW_MS,
  PREVIEW_BUILD_ORG_VARIABLE,
  PREVIEW_IMAGE_VARIABLE,
  PREVIEW_PUSH_TOKEN_SECRET,
  PREVIEW_REPOSITORY_VARIABLES,
  PREVIEW_ROLE_VARIABLE,
  PREVIEW_STARTER_SEED_SOURCES,
  PREVIEW_TARGET_VARIABLE,
  mayHoldPreviewCredential,
  previewCredentialDue,
  previewIneligibility,
  type PreviewIneligibleReason,
} from '@/lib/preview/enablement';
import { PreviewDisableError, type PreviewDisableStep } from '@/lib/preview/errors';
import { ensurePreviewDatabase } from '@/lib/preview/previewDatabase';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { withSystemContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// SWITCHING PREVIEWS ON AND OFF for a Motir-hosted repository (Story MOTIR-5766 ·
// MOTIR-5775, decision MOTIR-5769 §4 and §11). This is the ONLY code that writes
// what the starter's `preview-image` workflow reads, and the only code that
// withdraws it.
//
// ON — at establishment (`projectRepoProvisioningService`), and by the daily
// sweep (`previewEnablementSweep`), which is also the backfill for every
// repository established before this existed and the re-mint of a credential
// close to expiry:
//
//   1. the repository's preview PUSH NAMESPACE, through the deploy port of its
//      hosting target (`ensurePushNamespace` — no release unit: a preview's own
//      app is the lifecycle's, made per pull request);
//   2. a push credential for that namespace — a static deploy token, written as
//      the repository secret `MOTIR_FLY_PREVIEW_PUSH_TOKEN`, sealed to the
//      repository's public key; or a federated role, written as the variable
//      `MOTIR_HOSTING_AWS_PREVIEW_ROLE_ARN`;
//   3. the repository variables `MOTIR_HOSTING_TARGET` and
//      `MOTIR_HOSTING_IMAGE_PREVIEW`;
//   4. the ORG variable `MOTIR_HOSTING_BUILD=on` in the repository's org — an org
//      variable, so a repository transferred out stops resolving it by itself;
//   5. on Fly and serverless, the repository's Neon preview project (§6);
//   6. the record on the repository row.
//
// OFF — the takeover saga's step before the transfer, while Motir's App still
// reaches the repository: revoke the namespace's static credentials, delete the
// secret, delete the repository variables, clear the record. Each failure is
// thrown as `PreviewDisableError` naming its step, for the saga to fail on.
//
// SCOPE EDGE. The credential is this service's; the RESOURCES are not. Machines,
// per-PR apps, Neon branches, and destroying the namespace and the preview
// project at takeover belong to the preview lifecycle, which runs after this in
// the same saga. Nothing here touches the org variable on the way out: it serves
// every hosted repository in the org.
//
// ⚠️ NO TRANSACTION SPANS A HOST CALL. The row is read in a system context, the
// host calls run outside any transaction, and the record is written in a short
// workspace-service transaction. The namespace is recorded BEFORE a credential is
// minted for it, so a crash between the two leaves a row that `disable` can still
// clean and the sweep still re-enables.
//
// ⚠️ A CREDENTIAL VALUE NEVER LEAVES `enable`. It goes from the port straight into
// the sealed secret write; no log line, result or error here carries it.

/** What one `enable` call did. */
export type PreviewEnableOutcome =
  /** Switched on for the first time. */
  | 'enabled'
  /** Already on, with a static credential close to expiry: re-minted. */
  | 'renewed'
  /** Already on and current: nothing was called. */
  | 'already_enabled'
  /** Not a repository previews are for; nothing was called. */
  | 'ineligible'
  /** No such row. */
  | 'not_found';

export interface PreviewEnableResult {
  readonly repositoryId: string;
  readonly outcome: PreviewEnableOutcome;
  readonly reason?: PreviewIneligibleReason;
}

/** One row of a sweep: what `enable` did, or that it failed and why. */
export interface PreviewSweepRow {
  readonly repositoryId: string;
  readonly outcome: PreviewEnableOutcome | 'failed';
  /** The failure's error code, for `failed` only — never its message, which may
   *  quote a provider's answer. */
  readonly errorCode?: string;
}

export interface PreviewSweepResult {
  readonly rows: readonly PreviewSweepRow[];
}

export type PreviewDisableOutcome = 'disabled' | 'nothing_to_disable' | 'not_found';

export interface PreviewEnablementOptions {
  /** The clock renewal is judged by. */
  readonly now?: () => Date;
}

/** The sweep visits at most this many rows per run; the next run takes the rest. */
const SWEEP_BATCH = 200;

async function readSubject(repositoryId: string) {
  return withSystemContext((tx) => projectRepoRepository.findPreviewSubjectInTx(repositoryId, tx));
}

type Subject = NonNullable<Awaited<ReturnType<typeof readSubject>>>;
type RealizedSubject = Subject & { githubRepo: NonNullable<Subject['githubRepo']> };

function coordinatesOf(subject: RealizedSubject): RepositoryCoordinates {
  return {
    installationId: subject.githubRepo.installation.installationId,
    owner: subject.githubRepo.owner,
    repo: subject.githubRepo.name,
  };
}

/** The org the repository lives in, through the installation that holds it —
 *  so the org variable is written where this repository resolves it. */
function orgTargetOf(subject: RealizedSubject): GithubOrgTarget {
  return {
    org: subject.githubRepo.owner,
    installationId: subject.githubRepo.installation.installationId,
    role: 'provisioning',
  };
}

async function writeRecord(
  subject: Subject,
  data: {
    previewPushNamespace: string | null;
    previewEnabledAt: Date | null;
    previewCredentialExpiresAt: Date | null;
  },
): Promise<void> {
  await withWorkspaceServiceContext(subject.workspaceId, (tx) =>
    projectRepoRepository.setPreviewEnablement(subject.id, data, tx),
  );
}

/** Put the credential where the workflow reads it. */
async function writeCredential(
  coordinates: RepositoryCoordinates,
  credential: DeployCredential,
): Promise<void> {
  if (credential.kind === 'secret') {
    await repositoryActionsConfigClient.putSecret(
      coordinates,
      PREVIEW_PUSH_TOKEN_SECRET,
      credential.value,
    );
    return;
  }
  await repositoryActionsConfigClient.ensureVariable(
    coordinates,
    PREVIEW_ROLE_VARIABLE,
    credential.subject,
  );
}

async function step<T>(name: PreviewDisableStep, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw new PreviewDisableError(name, messageOf(err));
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

function errorCodeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : err instanceof Error ? err.name : 'UNKNOWN';
}

export const previewEnablementService = {
  /**
   * Switch previews on for one repository row. Idempotent: a row already on, with
   * a credential that is not due, is answered with no call at all; a row whose
   * static credential has under 14 days left is re-minted. Throws what a host
   * call throws — {@link enableQuietly} is the caller-safe form.
   */
  async enable(
    repositoryId: string,
    options: PreviewEnablementOptions = {},
  ): Promise<PreviewEnableResult> {
    const now = options.now ?? (() => new Date());
    const subject = await readSubject(repositoryId);
    if (!subject) return { repositoryId, outcome: 'not_found' };
    const reason = previewIneligibility(subject);
    if (reason) return { repositoryId, outcome: 'ineligible', reason };
    const realized = subject as RealizedSubject;
    const target = subject.hostingTarget!;
    const renewing = subject.previewEnabledAt !== null;
    if (renewing && !previewCredentialDue(subject.previewCredentialExpiresAt, now())) {
      return { repositoryId, outcome: 'already_enabled' };
    }

    const port = getHostingDeployPort(target);
    const namespace = await port.ensurePushNamespace({ repositoryId, kind: 'preview' });
    if (subject.previewPushNamespace !== namespace.pushNamespace) {
      await writeRecord(subject, {
        previewPushNamespace: namespace.pushNamespace,
        previewEnabledAt: subject.previewEnabledAt,
        previewCredentialExpiresAt: subject.previewCredentialExpiresAt,
      });
    }
    const credential = await port.mintDeployCredential({ pushNamespace: namespace.pushNamespace });
    const coordinates = coordinatesOf(realized);
    await writeCredential(coordinates, credential);
    await repositoryActionsConfigClient.ensureVariable(
      coordinates,
      PREVIEW_TARGET_VARIABLE,
      target,
    );
    await repositoryActionsConfigClient.ensureVariable(
      coordinates,
      PREVIEW_IMAGE_VARIABLE,
      namespace.imageRepository,
    );
    await actionsVariableClient.ensureOrgVariable(
      PREVIEW_BUILD_ORG_VARIABLE,
      PREVIEW_BUILD_ON,
      orgTargetOf(realized),
    );
    if (NEON_PREVIEW_TARGETS.includes(target)) await ensurePreviewDatabase(repositoryId);

    await writeRecord(subject, {
      previewPushNamespace: namespace.pushNamespace,
      previewEnabledAt: subject.previewEnabledAt ?? now(),
      previewCredentialExpiresAt: credential.kind === 'secret' ? credential.expiresAt : null,
    });
    return { repositoryId, outcome: renewing ? 'renewed' : 'enabled' };
  },

  /**
   * {@link enable}, for a caller that must not fail on it — establishment, where
   * a repository whose previews could not be switched on is still a working
   * repository, and the next sweep retries. Logs the failure's code and message
   * (no credential reaches either) and answers null.
   */
  async enableQuietly(
    repositoryId: string,
    options: PreviewEnablementOptions = {},
  ): Promise<PreviewEnableResult | null> {
    try {
      return await this.enable(repositoryId, options);
    } catch (err) {
      console.warn(
        `[previewEnablementService] previews not switched on for ${repositoryId}; the sweep retries:`,
        errorCodeOf(err),
        messageOf(err),
      );
      return null;
    }
  },

  /**
   * The daily sweep and backfill: every Motir-hosted web repository that is not
   * on yet, or whose credential is due, oldest first. Each row is independent —
   * one failing is reported and the rest carry on. A second run with nothing
   * due visits nothing.
   */
  async sweep(options: PreviewEnablementOptions = {}): Promise<PreviewSweepResult> {
    const now = options.now ?? (() => new Date());
    const due = await withSystemContext((tx) =>
      projectRepoRepository.listPreviewBackfillCandidatesInTx(
        {
          seedSources: PREVIEW_STARTER_SEED_SOURCES,
          renewBefore: new Date(now().getTime() + PREVIEW_CREDENTIAL_RENEW_MS),
          limit: SWEEP_BATCH,
        },
        tx,
      ),
    );
    const rows: PreviewSweepRow[] = [];
    for (const { id } of due) {
      try {
        const result = await this.enable(id, { now });
        rows.push({ repositoryId: id, outcome: result.outcome });
      } catch (err) {
        console.warn(
          `[previewEnablementService] sweep could not switch previews on for ${id}:`,
          errorCodeOf(err),
          err instanceof Error ? err.message : 'unknown',
        );
        rows.push({ repositoryId: id, outcome: 'failed', errorCode: errorCodeOf(err) });
      }
    }
    return { rows };
  },

  /**
   * Switch previews off for one repository row — the takeover saga's step before
   * its transfer. Withdraws everything `enable` put in the repository, in order,
   * and throws {@link PreviewDisableError} naming the first step that failed; a
   * re-run repeats every step, each of which treats "already gone" as done. A row
   * that could never have been enabled is answered with no call at all.
   */
  async disable(repositoryId: string): Promise<PreviewDisableOutcome> {
    const subject = await readSubject(repositoryId);
    if (!subject) return 'not_found';
    if (!mayHoldPreviewCredential(subject)) return 'nothing_to_disable';
    const realized = subject as RealizedSubject;
    const coordinates = coordinatesOf(realized);

    const namespace = subject.previewPushNamespace;
    if (namespace) {
      await step('revoke_push_credentials', () =>
        getHostingDeployPort(subject.hostingTarget!).revokeDeployCredentials({
          pushNamespace: namespace,
        }),
      );
    }
    await step('delete_push_secret', () =>
      repositoryActionsConfigClient.deleteSecret(coordinates, PREVIEW_PUSH_TOKEN_SECRET),
    );
    await step('delete_variables', async () => {
      for (const name of PREVIEW_REPOSITORY_VARIABLES) {
        await repositoryActionsConfigClient.deleteVariable(coordinates, name);
      }
    });
    await step('clear_record', () =>
      writeRecord(subject, {
        previewPushNamespace: null,
        previewEnabledAt: null,
        previewCredentialExpiresAt: null,
      }),
    );
    return 'disabled';
  },
};
