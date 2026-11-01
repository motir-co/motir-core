import type {
  HostingTarget,
  ProjectRepoState,
  ProjectRepoTakeoverState,
} from '@/generated/prisma/client';
import {
  SEED_SOURCE_AWS_STARTER,
  SEED_SOURCE_FLY_STARTER,
  SEED_SOURCE_LEGACY_PLATFORM_STARTER,
  SEED_SOURCE_PLATFORM_STARTER,
} from '@/lib/projectRepos/vocabulary';

// WHICH REPOSITORIES GET PREVIEWS, and the names of what switching them on
// writes (Story MOTIR-5766 · MOTIR-5775). Every name is the decision's
// (MOTIR-5769 §11, page cmvrcywwc00jkhpr1zvvnike8 v1) and is read by the
// starter's `.github/workflows/preview-image.yml`, so a rename here is a rename
// there. Pure: no database, no network.

/** The ORG variable that switches every hosted repository's build workflow on. */
export const PREVIEW_BUILD_ORG_VARIABLE = 'MOTIR_HOSTING_BUILD';
export const PREVIEW_BUILD_ON = 'on';
/** Repository variables: the row's target, and where a preview image is pushed. */
export const PREVIEW_TARGET_VARIABLE = 'MOTIR_HOSTING_TARGET';
export const PREVIEW_IMAGE_VARIABLE = 'MOTIR_HOSTING_IMAGE_PREVIEW';
/** A federated target's preview push role (serverless, AWS). */
export const PREVIEW_ROLE_VARIABLE = 'MOTIR_HOSTING_AWS_PREVIEW_ROLE_ARN';
/** A static push credential's repository secret (Fly's app-scoped deploy token). */
export const PREVIEW_PUSH_TOKEN_SECRET = 'MOTIR_FLY_PREVIEW_PUSH_TOKEN';
/** Every repository variable enablement may write, which disable deletes. */
export const PREVIEW_REPOSITORY_VARIABLES = [
  PREVIEW_TARGET_VARIABLE,
  PREVIEW_IMAGE_VARIABLE,
  PREVIEW_ROLE_VARIABLE,
] as const;

/**
 * The seeds whose repositories are web apps Motir can host: the platform starter
 * (under its current and legacy key) and the Fly and AWS starters, each of which
 * ships a `Dockerfile`, a health route and `motir.hosting.json` (MOTIR-5769 §12,
 * MOTIR-704). A non-web foundation, an initialised repository and a customer's
 * own repository are never enabled.
 */
export const PREVIEW_STARTER_SEED_SOURCES: readonly string[] = [
  SEED_SOURCE_PLATFORM_STARTER,
  SEED_SOURCE_LEGACY_PLATFORM_STARTER,
  SEED_SOURCE_FLY_STARTER,
  SEED_SOURCE_AWS_STARTER,
];

/** Targets whose previews run on a branch of the repository's Neon preview
 *  project (MOTIR-5769 D-6). AWS previews use a database in the tenant's RDS
 *  instance, made per preview by the AWS adapter itself. */
export const NEON_PREVIEW_TARGETS: readonly HostingTarget[] = ['fly', 'serverless'];

/** A static push credential is re-minted when fewer than this many ms remain
 *  (MOTIR-5769 §4: 90-day tokens, re-minted under 14 days). */
export const PREVIEW_CREDENTIAL_RENEW_MS = 14 * 86_400_000;

/** What eligibility reads of a row. */
export interface PreviewSubject {
  readonly seedSource: string;
  readonly state: ProjectRepoState;
  readonly hostingTarget: HostingTarget | null;
  readonly takeoverState: ProjectRepoTakeoverState | null;
  readonly githubRepo: unknown;
}

export type PreviewIneligibleReason =
  | 'not_motir_created'
  | 'not_a_web_starter'
  | 'no_hosting_target'
  | 'not_realized'
  | 'takeover_started';

/**
 * Whether a row's repository may have previews switched on, and when not, why.
 * `created` is the state only a repository MOTIR made reaches — a connected one
 * is `connected` — so a repository a user brought is never enabled (the story's
 * scope edge). A takeover in any state means the repository is leaving.
 */
export function previewIneligibility(subject: PreviewSubject): PreviewIneligibleReason | null {
  if (subject.state !== 'created') return 'not_motir_created';
  if (!PREVIEW_STARTER_SEED_SOURCES.includes(subject.seedSource)) return 'not_a_web_starter';
  if (!subject.hostingTarget) return 'no_hosting_target';
  if (!subject.githubRepo) return 'not_realized';
  if (subject.takeoverState !== null) return 'takeover_started';
  return null;
}

/**
 * Whether switching previews OFF has anything to withdraw: the same test as
 * {@link previewIneligibility} minus the takeover arm — the takeover saga is
 * exactly who asks. A row that could never have been enabled has nothing on
 * GitHub to delete, so disable makes no call for it.
 */
export function mayHoldPreviewCredential(subject: PreviewSubject): boolean {
  const reason = previewIneligibility(subject);
  return reason === null || reason === 'takeover_started';
}

/** Whether an enabled row's static credential is due to be re-minted. A null
 *  expiry (a federated credential) never is. */
export function previewCredentialDue(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && expiresAt.getTime() - now.getTime() < PREVIEW_CREDENTIAL_RENEW_MS;
}
