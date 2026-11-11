import type {
  RunnerAmiFreshnessDTO,
  RunnerImageUnreleasedChangeDTO,
} from '@/lib/dto/runnerImageFreshness';

// THE FLEET STATUS PAGE'S IMAGES SECTION (MOTIR-10886; design MOTIR-10885,
// `design/platform-admin/design-notes.md` § Fleet status). One row per image
// Motir boots, each read on its own so one source that does not answer leaves
// only its own row saying so.

/** The three images, in the page's fixed order. */
export const FLEET_IMAGE_KEYS = ['hosted', 'runner', 'sandbox'] as const;
export type FleetImageKey = (typeof FLEET_IMAGE_KEYS)[number];

/** The source a row could not read. */
export type FleetImageReadSource = 'ghcr' | 'github' | 'aws';

/** One build of an image, as a compare tile shows it. */
export interface FleetImageBuildDTO {
  /** The digest the reference resolves to (`sha256:<64 hex>`), or null. */
  digest: string | null;
  /** The full commit the image was built from, or null when it records none. */
  commit: string | null;
  /** When the image was built (ISO 8601), or null when its config records none. */
  createdAt: string | null;
}

/** A runner build: a build plus the `runner-v*` release it was published as. */
export interface FleetRunnerBuildDTO extends FleetImageBuildDTO {
  /** `x.y.z`, or null when no release tag resolves to the pinned bytes. */
  version: string | null;
}

/** What Publish latest would dispatch, from the row as read on the server. */
export interface FleetPublishTargetDTO {
  /** The workflow file under `.github/workflows/`. */
  workflow: string;
  /** The ref it is dispatched on. */
  ref: string;
  inputs: Record<string, string>;
  /** What production moves from and to, as the audit row records it. */
  from: string;
  to: string;
  /** What "landed" means: the digest the pin must reach, or the sandbox version. */
  target: string;
}

/** The newest Publish latest pressed for an image, from the audit log. */
export interface FleetPublishRecordDTO {
  actorEmail: string | null;
  /** When the press was recorded (ISO 8601). */
  at: string;
  from: string;
  to: string;
  target: string;
  runId: number | null;
  runUrl: string | null;
  runNumber: number | null;
}

/** Where that press stands. `running` covers the pin pull request's merge and
 *  the deploy after a successful run, until the pin reaches its target. */
export type FleetPublishProgressDTO =
  | { state: 'idle' }
  | { state: 'running'; startedAt: string }
  | { state: 'done'; endedAt: string }
  | { state: 'failed'; endedAt: string; error: string | null };

/** Why Publish latest is off, when it is. */
export type FleetPublishBlock = 'up_to_date' | 'release_needed' | 'running' | 'not_republishable';

/** The publish half every read row carries. */
export interface FleetImagePublishDTO {
  record: FleetPublishRecordDTO | null;
  progress: FleetPublishProgressDTO;
  /** A run of the image's publish workflow is queued or in progress. */
  activeRun: boolean;
  target: FleetPublishTargetDTO | null;
  /** Null when Publish latest is enabled. */
  blocked: FleetPublishBlock | null;
}

/** A row whose image is not configured on this deployment. */
export interface FleetImageUnsetDTO {
  status: 'unset';
  variable: string;
}

/** A row one of its sources did not answer for. Never "up to date". */
export interface FleetImageNotReadDTO {
  status: 'not_read';
  source: FleetImageReadSource;
  /** The read's own words, for the server log. Never rendered. */
  detail: string;
}

export interface HostedImageReadDTO {
  status: 'read';
  pinned: FleetImageBuildDTO;
  newest: FleetImageBuildDTO;
  behind: boolean;
  /** Whole days between the two builds, when both record a build time. */
  daysBehind: number | null;
  /** Commits to `packages/cli` between the two build commits, when both are known. */
  cliCommits: number | null;
  compareUrl: string | null;
  publish: FleetImagePublishDTO;
}

export interface RunnerImageReadDTO {
  status: 'read';
  pinned: FleetRunnerBuildDTO;
  newest: FleetRunnerBuildDTO & { version: string };
  behind: boolean;
  /** Releases newer than the pinned one, oldest first (`runner-v0.2.5`, …);
   *  null when the pinned version is not known. */
  releasesBetween: string[] | null;
  daysBehind: number | null;
  /** Commits to `infra/ci-runner` between the two build commits. */
  runnerCommits: number | null;
  compareUrl: string | null;
  /** Merged runner-image changes the NEWEST release does not contain. */
  unreleased: RunnerImageUnreleasedChangeDTO[];
  /** The tag the next release would take: the newest with its patch + 1. */
  nextTag: string;
  ami: RunnerAmiFreshnessDTO;
  publish: FleetImagePublishDTO;
}

export interface SandboxProfileTagDTO {
  /** `base` or a profile id. */
  id: string;
  tag: string;
  published: boolean;
}

export interface SandboxImageReadDTO {
  status: 'read';
  release: { tag: string; version: string; commit: string; committedAt: string | null };
  profiles: SandboxProfileTagDTO[];
  /** The newest version below `release.version` the missing profiles have, or null. */
  previous: string | null;
  /** Live agents whose recorded image version is older than the release. */
  liveOlder: number;
  /** The release's own workflow can re-run only the missing tags (MOTIR-10884). */
  republishable: boolean;
  publish: FleetImagePublishDTO;
}

export type HostedImageRowDTO = FleetImageUnsetDTO | FleetImageNotReadDTO | HostedImageReadDTO;
export type RunnerImageRowDTO = FleetImageUnsetDTO | FleetImageNotReadDTO | RunnerImageReadDTO;
export type SandboxImageRowDTO = FleetImageUnsetDTO | FleetImageNotReadDTO | SandboxImageReadDTO;

/** What a press of Publish latest did. */
export type FleetImagePublishOutcomeDTO =
  | { outcome: 'dispatched'; runUrl: string; runNumber: number | null }
  | {
      outcome: 'refused';
      reason: FleetPublishBlock | 'not_read' | 'unset';
    }
  | { outcome: 'failed'; detail: string };
