import type {
  RunnerAmiFreshnessDTO,
  RunnerImageUnreleasedChangeDTO,
} from '@/lib/dto/runnerImageFreshness';

// THE FLEET STATUS PAGE'S IMAGES SECTION (MOTIR-10886; design MOTIR-10885,
// `design/platform-admin/design-notes.md` § Fleet status; the indexer row
// MOTIR-10986, design MOTIR-10987). One row per image
// Motir boots, each read on its own so one source that does not answer leaves
// only its own row saying so.

/** The four images, in the page's fixed order: the indexer after the runner
 *  (MOTIR-10986, design MOTIR-10987). */
export const FLEET_IMAGE_KEYS = ['hosted', 'runner', 'indexer', 'sandbox'] as const;
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
  | {
      state: 'running';
      startedAt: string;
      /** The indexer pin's two stages (MOTIR-10986): its pull request is open
       *  and queued, or it merged and the deploy is rolling web and worker.
       *  Absent for the other images, whose band has one stage. */
      stage?: 'queued' | 'rolling';
    }
  | { state: 'done'; endedAt: string }
  | { state: 'failed'; endedAt: string; error: string | null };

/** Why Publish latest is off, when it is. */
export type FleetPublishBlock =
  | 'up_to_date'
  | 'release_needed'
  | 'running'
  | 'not_republishable'
  /** A part of the row the target is read from did not answer (the indexer's
   *  pin or newest release, MOTIR-10986). */
  | 'not_read';

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

/** A part of the indexer row a source did not answer for (MOTIR-10986). Its
 *  part never renders as a figure; the rest of the card still does. */
export interface FleetImagePartNotReadDTO {
  state: 'not_read';
  source: FleetImageReadSource;
  /** The read's own words, for the server log. Never rendered. */
  detail: string;
}

/** One part of the indexer row: read, or not. */
export type FleetImagePartDTO<T> = { state: 'read'; value: T } | FleetImagePartNotReadDTO;

/**
 * THE INDEXER ROW (MOTIR-10986; design MOTIR-10987). The runner row's shape,
 * read from ECR and motir-ai: `pinned` is the `MOTIR_INDEXER_IMAGE` digest with
 * the `indexer-<x.y.z>` tag ECR holds for it, `newest` the highest such tag, each
 * built from the commit motir-ai's `indexer-v<x.y.z>` git tag names. Each of
 * the three parts is read on its own, so one source that does not answer leaves
 * only its part saying so.
 */
export interface IndexerImageReadDTO {
  status: 'read';
  /** The pin as deployed; `version` null when no `indexer-*` tag names its bytes. */
  pinned: FleetImagePartDTO<FleetRunnerBuildDTO>;
  newest: FleetImagePartDTO<FleetRunnerBuildDTO & { version: string }>;
  /** False whenever the pin or the newest release is not read. */
  behind: boolean;
  /** Releases newer than the pinned one, oldest first; null when the pinned
   *  version is not known. */
  releasesBetween: string[] | null;
  daysBehind: number | null;
  /** Commits to the indexer's inputs between the two build commits. */
  indexerCommits: number | null;
  /** motir-ai's compare between the two releases. */
  compareUrl: string | null;
  /** motir-ai's commit history, which the gap count and `unreleased` come from. */
  history: { state: 'read' } | FleetImagePartNotReadDTO;
  /** Merged changes to the indexer's inputs after the newest release's commit. */
  unreleased: RunnerImageUnreleasedChangeDTO[];
  /** The tag the next release would take, or null when the newest is not read. */
  nextTag: string | null;
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
export type IndexerImageRowDTO = FleetImageUnsetDTO | FleetImageNotReadDTO | IndexerImageReadDTO;
export type SandboxImageRowDTO = FleetImageUnsetDTO | FleetImageNotReadDTO | SandboxImageReadDTO;

/** What a press of Publish latest did. */
export type FleetImagePublishOutcomeDTO =
  | { outcome: 'dispatched'; runUrl: string; runNumber: number | null }
  | {
      outcome: 'refused';
      reason: FleetPublishBlock | 'unset';
    }
  | { outcome: 'failed'; detail: string };
