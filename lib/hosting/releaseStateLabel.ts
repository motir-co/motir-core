import type { HostedReleaseDto } from '@/lib/dto/hostedApplications';
import type { HostedReleaseState } from '@/lib/hosting/vocabulary';

// The Production panel's WORDS for a release (Story MOTIR-9797 · MOTIR-10037),
// per `design/hosting/design-notes.md` § Release states. Pure: a release in, the
// message key under `settings.production` and the `Pill` variant out. No I/O and
// no React, so the panel and its tests read one mapping.
//
// The stored life of a release has six states; the panel shows five words. Both
// in-flight states (`building`, then `releasing` while migrations and the deploy
// run) read Building — the design's word for "on its way, nothing serving it yet".

/** The one `Pill` variant a state renders with — its own tone each, never grey
 *  plus primary (finding #54). */
export type ReleasePillTone =
  | { status: 'in-progress' }
  | { severity: 'success' | 'danger' | 'warning' }
  | { tone: 'neutral' };

/** The design's five words, as their `state.*` keys. */
export type ReleaseStateWord = 'building' | 'live' | 'failed' | 'replaced' | 'rolledBack';

export interface ReleaseStateLabel {
  word: ReleaseStateWord;
  /** Under `settings.production`. */
  labelKey: `state.${ReleaseStateWord}`;
  tone: ReleasePillTone;
}

const BUILDING: ReleaseStateLabel = {
  word: 'building',
  labelKey: 'state.building',
  tone: { status: 'in-progress' },
};

/** Total over `HOSTED_RELEASE_STATES`: a state added to the vocabulary without a
 *  row here fails to compile. */
const STATE_LABELS: Record<HostedReleaseState, ReleaseStateLabel> = {
  building: BUILDING,
  releasing: BUILDING,
  live: { word: 'live', labelKey: 'state.live', tone: { severity: 'success' } },
  failed: { word: 'failed', labelKey: 'state.failed', tone: { severity: 'danger' } },
  replaced: { word: 'replaced', labelKey: 'state.replaced', tone: { tone: 'neutral' } },
  rolled_back: {
    word: 'rolledBack',
    labelKey: 'state.rolledBack',
    tone: { severity: 'warning' },
  },
};

export function releaseStateLabel(state: HostedReleaseState): ReleaseStateLabel {
  return STATE_LABELS[state];
}

/** Which trigger glyph a release carries. */
export type ReleaseTriggerKind = 'merge' | 'redeploy' | 'rollback' | 'ref';

export interface ReleaseTriggerLabel {
  kind: ReleaseTriggerKind;
  /** Under `settings.production`. */
  labelKey:
    | 'trigger.mergeDefault'
    | 'trigger.redeploy'
    | 'trigger.rollback'
    | 'trigger.rollbackUnnamed'
    | 'trigger.refUnnamed';
  values: Record<string, string>;
}

/**
 * What started a release, as the trigger line says it. A release a rollback
 * restored reads `Restored by rollback · <name>` whatever first made it: the
 * restore is the latest thing that put it live. Otherwise its cause decides.
 *
 * A release stores neither the pull request a merge came from nor who asked for
 * a ref, so the merge and ref lines are the design's sentences without them
 * (MOTIR-10037's recorded deviation).
 */
export function releaseTriggerLabel(
  release: Pick<HostedReleaseDto, 'cause' | 'ref' | 'restoredBy'>,
): ReleaseTriggerLabel {
  if (release.restoredBy) {
    return {
      kind: 'rollback',
      labelKey: 'trigger.rollback',
      values: { name: release.restoredBy.name },
    };
  }
  switch (release.cause) {
    case 'merge':
      return { kind: 'merge', labelKey: 'trigger.mergeDefault', values: {} };
    case 'config_change':
      return { kind: 'redeploy', labelKey: 'trigger.redeploy', values: {} };
    case 'rollback':
      return { kind: 'rollback', labelKey: 'trigger.rollbackUnnamed', values: {} };
    case 'ref':
      return { kind: 'ref', labelKey: 'trigger.refUnnamed', values: { ref: release.ref ?? '' } };
  }
}

export interface ReleaseFailureLabel {
  /** Under `settings.production`. */
  labelKey:
    | 'reason.build'
    | 'reason.migration'
    | 'reason.migrationExit'
    | 'reason.migrationTimedOut'
    | 'reason.superseded'
    | 'reason.deploy';
  values: Record<string, string>;
}

/** The release services' superseded reason (`IN_PROGRESS_GAVE_UP_REASON`). */
const SUPERSEDED_REASON = 'another release was in progress';
const MIGRATE_EXIT = /^migrate: exit (\d+)$/;

/**
 * A failed release's one-line reason, from its stored `failureReason` — the step
 * it failed in, never the provider's words, which the stored value may carry
 * after the step (`deploy: <code> (HTTP 502)`) and which never reach a browser.
 * Null for a release with no reason.
 */
export function releaseFailureLabel(reason: string | null): ReleaseFailureLabel | null {
  if (!reason) return null;
  if (reason.startsWith('build')) return { labelKey: 'reason.build', values: {} };
  if (reason === SUPERSEDED_REASON) return { labelKey: 'reason.superseded', values: {} };
  if (reason.startsWith('migrate')) {
    if (reason === 'migrate: timed out') {
      return { labelKey: 'reason.migrationTimedOut', values: {} };
    }
    const exit = MIGRATE_EXIT.exec(reason);
    return exit
      ? { labelKey: 'reason.migrationExit', values: { code: exit[1]! } }
      : { labelKey: 'reason.migration', values: {} };
  }
  return { labelKey: 'reason.deploy', values: {} };
}

/** The seven-character short form a commit is shown by. */
export function shortCommit(sha: string): string {
  return sha.slice(0, 7);
}
