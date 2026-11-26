// The hosting vocabulary (Story MOTIR-9791): where a Motir repo's app runs, what
// it is for and how big it is. Decision of record: MOTIR-5769 (page
// cmvrcywwc00jkhpr1zvvnike8, version 1) fixes the targets; the requirement's D3
// (page cmvpt02mh02q3hmu1nc159ofq) names the use cases; MOTIR-9808 fixes the size
// scale, whose per-target machine sizes the adapters define. The Prisma enums
// `HostingTarget` / `HostingUseCase` / `HostingSize` carry the same values — a
// test pins the two lists together.

/** The three targets a Motir repo runs on (D3): serverless for small apps and
 *  internal tools, Fly for a long-running process, AWS for enterprise. */
export const HOSTING_TARGETS = ['serverless', 'fly', 'aws'] as const;
export type HostingTarget = (typeof HOSTING_TARGETS)[number];

/** What the app is for (R3, D4): a build-directly internal tool or MVP, or a
 *  planned product. */
export const HOSTING_USE_CASES = ['internal_tool', 'mvp', 'planned_product'] as const;
export type HostingUseCase = (typeof HOSTING_USE_CASES)[number];

/** The size the planner reads into a target and each adapter maps to machine
 *  sizes (MOTIR-5769 §4: production "by the row's size"). */
export const HOSTING_SIZES = ['small', 'medium', 'large'] as const;
export type HostingSize = (typeof HOSTING_SIZES)[number];

/** Which AWS shape the app takes (MOTIR-5769 §4, MOTIR-12093): a Lambda
 *  `function` for a small app, an ECS Fargate `container` for a long-running
 *  one. Recorded with the rest of the hosting decision and passed to the deploy
 *  port as an input — the AWS adapter refuses a release without one, and nothing
 *  infers it. Only an `aws` row carries one. The orchestrator's `ReleaseShape`
 *  carries the same values; a test pins the lists together. */
export const HOSTING_SHAPES = ['function', 'container'] as const;
export type HostingShape = (typeof HOSTING_SHAPES)[number];

/** The one target whose releases take a shape. */
export const SHAPED_HOSTING_TARGET = 'aws' satisfies HostingTarget;

export function isHostingTarget(value: string): value is HostingTarget {
  return (HOSTING_TARGETS as readonly string[]).includes(value);
}

export function isHostingUseCase(value: string): value is HostingUseCase {
  return (HOSTING_USE_CASES as readonly string[]).includes(value);
}

export function isHostingSize(value: string): value is HostingSize {
  return (HOSTING_SIZES as readonly string[]).includes(value);
}

export function isHostingShape(value: string): value is HostingShape {
  return (HOSTING_SHAPES as readonly string[]).includes(value);
}

// ── The application's takeover handover (Story MOTIR-9800 · MOTIR-12126) ─────
// The Prisma enum `HostedApplicationState` carries the same values; a test pins
// the lists together.

/**
 * Where a hosted application stands at takeover: `live` (Motir serves and
 * deploys it), `handing_over` (a takeover removed its deploy credentials and is
 * moving it), `grace` (a serverless or Fly app Motir still serves until its
 * `stopsAt`) and `handed_over` (Motir no longer serves it; the record is kept).
 */
export const HOSTED_APPLICATION_STATES = ['live', 'handing_over', 'grace', 'handed_over'] as const;
export type HostedApplicationState = (typeof HOSTED_APPLICATION_STATES)[number];

/** The application states a takeover handover owns: nothing Motir runs deploys
 *  an application in one of them (MOTIR-12127). */
export const HANDOVER_APPLICATION_STATES = [
  'handing_over',
  'grace',
  'handed_over',
] as const satisfies readonly HostedApplicationState[];

/** How long a serverless or Fly application keeps running after its repository
 *  is transferred (decision MOTIR-9802): `stopsAt` is the transfer time plus
 *  these days (MOTIR-12132). */
export const HOSTED_APPLICATION_GRACE_DAYS = 30;

/** The notices a grace window sends: at the transfer, seven and one day before
 *  the stop, and at the stop (MOTIR-12132 enqueues `transferred`). */
export const GRACE_NOTICE_KINDS = ['transferred', 'seven_days', 'one_day', 'stopped'] as const;
export type GraceNoticeKind = (typeof GRACE_NOTICE_KINDS)[number];

/** An application database export: an admin's `on_demand` download during the
 *  grace window, or the `final` one the stop takes before deleting the
 *  database. */
export const HOSTED_APPLICATION_EXPORT_KINDS = ['on_demand', 'final'] as const;
export type HostedApplicationExportKind = (typeof HOSTED_APPLICATION_EXPORT_KINDS)[number];

export function isHostedApplicationState(value: string): value is HostedApplicationState {
  return (HOSTED_APPLICATION_STATES as readonly string[]).includes(value);
}

export function isHostedApplicationExportKind(value: string): value is HostedApplicationExportKind {
  return (HOSTED_APPLICATION_EXPORT_KINDS as readonly string[]).includes(value);
}

// ── Production releases (Story MOTIR-9797 · MOTIR-10026) ─────────────────────
// The Prisma enums `HostedReleaseState` / `HostedReleaseCause` carry the same
// values; a test pins the lists together, as it does the targets above.

/**
 * The life of one production release: `building` (the artifact is produced),
 * `releasing` (migrations, then the deploy), `live`, `failed`, `replaced` (a
 * newer release took over) and `rolled_back` (a rollback took it out).
 */
export const HOSTED_RELEASE_STATES = [
  'building',
  'releasing',
  'live',
  'failed',
  'replaced',
  'rolled_back',
] as const;
export type HostedReleaseState = (typeof HOSTED_RELEASE_STATES)[number];

/** Why a release was made: a merge to the default branch, a configuration
 *  change, a person asking for a ref, a rollback, or a change of the
 *  application's idle policy (MOTIR-12107). */
export const HOSTED_RELEASE_CAUSES = [
  'merge',
  'config_change',
  'ref',
  'rollback',
  'idle_policy',
] as const;
export type HostedReleaseCause = (typeof HOSTED_RELEASE_CAUSES)[number];

/**
 * Every legal move, by the state it leaves. `failed` is terminal. A rollback
 * returns a `replaced` OR a `rolled_back` release to `live`: the deploy port's
 * rollback toggles between the two newest releases, so a second rollback revives
 * the release the first one took out.
 */
export const HOSTED_RELEASE_TRANSITIONS: Readonly<
  Record<HostedReleaseState, readonly HostedReleaseState[]>
> = {
  building: ['releasing', 'failed'],
  releasing: ['live', 'failed'],
  live: ['replaced', 'rolled_back'],
  failed: [],
  replaced: ['live'],
  rolled_back: ['live'],
};

export function isLegalReleaseTransition(
  from: HostedReleaseState,
  to: HostedReleaseState,
): boolean {
  return HOSTED_RELEASE_TRANSITIONS[from].includes(to);
}

export function isHostedReleaseState(value: string): value is HostedReleaseState {
  return (HOSTED_RELEASE_STATES as readonly string[]).includes(value);
}
