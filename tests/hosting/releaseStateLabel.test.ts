// MOTIR-10037 — the Production panel's words for a release: total over the stored
// states (a state added to the vocabulary without a mapping fails here as well as
// at compile time), each shown state its own tone, the trigger line by cause and
// restore, and a failed release's reason by its step — never the provider's text.
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import { HOSTED_RELEASE_CAUSES, HOSTED_RELEASE_STATES } from '@/lib/hosting/vocabulary';
import {
  releaseFailureLabel,
  releaseStateLabel,
  releaseTriggerLabel,
  shortCommit,
} from '@/lib/hosting/releaseStateLabel';
import { IN_PROGRESS_GAVE_UP_REASON } from '@/lib/services/productionMergeReleaseService';

const copy = en.settings.production as unknown as Record<string, unknown>;

/** The English for a key under `settings.production`, or undefined. */
function english(key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], copy);
}

describe('releaseStateLabel', () => {
  it('maps every stored state to a word with English copy', () => {
    for (const state of HOSTED_RELEASE_STATES) {
      const label = releaseStateLabel(state);
      expect(label, state).toBeDefined();
      expect(typeof english(label.labelKey), state).toBe('string');
    }
  });

  it('reads both in-flight states as Building, and gives each shown word its own tone', () => {
    expect(releaseStateLabel('building').word).toBe('building');
    expect(releaseStateLabel('releasing').word).toBe('building');
    expect(releaseStateLabel('live').tone).toEqual({ severity: 'success' });
    expect(releaseStateLabel('failed').tone).toEqual({ severity: 'danger' });
    expect(releaseStateLabel('replaced').tone).toEqual({ tone: 'neutral' });
    expect(releaseStateLabel('rolled_back')).toEqual({
      word: 'rolledBack',
      labelKey: 'state.rolledBack',
      tone: { severity: 'warning' },
    });
    expect(releaseStateLabel('building').tone).toEqual({ status: 'in-progress' });

    const words = new Set(HOSTED_RELEASE_STATES.map((s) => releaseStateLabel(s).word));
    const tones = new Set(
      [...words].map((w) =>
        JSON.stringify(
          releaseStateLabel(HOSTED_RELEASE_STATES.find((s) => releaseStateLabel(s).word === w)!)
            .tone,
        ),
      ),
    );
    expect(words.size).toBe(5);
    expect(tones.size).toBe(5);
  });
});

/** A release that knows neither its pull request nor who asked for it — one
 *  made before MOTIR-10103 stored them. */
const UNNAMED = { pullRequestNumber: null, requestedBy: null } as const;

describe('releaseTriggerLabel', () => {
  it('says each cause, with copy for every key', () => {
    for (const cause of HOSTED_RELEASE_CAUSES) {
      const label = releaseTriggerLabel({ cause, ref: 'v1.4.0', restoredBy: null, ...UNNAMED });
      expect(typeof english(label.labelKey), cause).toBe('string');
    }
    expect(
      releaseTriggerLabel({ cause: 'merge', ref: null, restoredBy: null, ...UNNAMED }),
    ).toEqual({
      kind: 'merge',
      labelKey: 'trigger.mergeDefault',
      values: {},
    });
    expect(
      releaseTriggerLabel({ cause: 'config_change', ref: null, restoredBy: null, ...UNNAMED }).kind,
    ).toBe('redeploy');
    expect(
      releaseTriggerLabel({ cause: 'ref', ref: 'v1.4.0', restoredBy: null, ...UNNAMED }),
    ).toEqual({
      kind: 'ref',
      labelKey: 'trigger.refUnnamed',
      values: { ref: 'v1.4.0' },
    });
    expect(
      releaseTriggerLabel({ cause: 'ref', ref: null, restoredBy: null, ...UNNAMED }).values,
    ).toEqual({
      ref: '',
    });
    expect(
      releaseTriggerLabel({ cause: 'rollback', ref: null, restoredBy: null, ...UNNAMED }).labelKey,
    ).toBe('trigger.rollbackUnnamed');
  });

  it('says the pull request a merge came from and who asked for a ref (MOTIR-10103)', () => {
    const merge = releaseTriggerLabel({
      cause: 'merge',
      ref: null,
      restoredBy: null,
      pullRequestNumber: 48,
      requestedBy: null,
    });
    expect(merge).toEqual({ kind: 'merge', labelKey: 'trigger.merge', values: { number: '48' } });
    expect(english(merge.labelKey)).toBe('Merge of #{number}');

    const ref = releaseTriggerLabel({
      cause: 'ref',
      ref: 'v1.4.0',
      restoredBy: null,
      pullRequestNumber: null,
      requestedBy: { id: 'u2', name: 'Sam Lee' },
    });
    expect(ref).toEqual({
      kind: 'ref',
      labelKey: 'trigger.ref',
      values: { ref: 'v1.4.0', name: 'Sam Lee' },
    });
    expect(english(ref.labelKey)).toBe('Deploy of {ref} · {name}');
  });

  it('names who restored a release, whatever first made it', () => {
    expect(
      releaseTriggerLabel({
        cause: 'merge',
        ref: null,
        restoredBy: { id: 'u1', name: 'Dana Ito' },
        pullRequestNumber: 48,
        requestedBy: null,
      }),
    ).toEqual({ kind: 'rollback', labelKey: 'trigger.rollback', values: { name: 'Dana Ito' } });
  });
});

describe('releaseFailureLabel', () => {
  it('reads the step a release failed in, never the words after it', () => {
    expect(releaseFailureLabel(null)).toBeNull();
    expect(releaseFailureLabel('')).toBeNull();
    expect(releaseFailureLabel('build failure')?.labelKey).toBe('reason.build');
    expect(releaseFailureLabel('build timed_out')?.labelKey).toBe('reason.build');
    expect(releaseFailureLabel('migrate: timed out')?.labelKey).toBe('reason.migrationTimedOut');
    expect(releaseFailureLabel('migrate: exit 3')).toEqual({
      labelKey: 'reason.migrationExit',
      values: { code: '3' },
    });
    expect(releaseFailureLabel('migrate: exit unknown')?.labelKey).toBe('reason.migration');
    expect(releaseFailureLabel(IN_PROGRESS_GAVE_UP_REASON)?.labelKey).toBe('reason.superseded');
    const deploy = releaseFailureLabel('deploy: provider_error (HTTP 502) postgres://secret');
    expect(deploy).toEqual({ labelKey: 'reason.deploy', values: {} });
    expect(releaseFailureLabel('environment: missing')?.labelKey).toBe('reason.deploy');
  });

  it('has English copy for every reason it can answer', () => {
    for (const reason of [
      'build failure',
      'migrate: timed out',
      'migrate: exit 1',
      'migrate: odd',
      IN_PROGRESS_GAVE_UP_REASON,
      'deploy: x',
    ]) {
      expect(typeof english(releaseFailureLabel(reason)!.labelKey), reason).toBe('string');
    }
  });
});

describe('shortCommit', () => {
  it('is the first seven characters', () => {
    expect(shortCommit('9c41e2a5d7f0')).toBe('9c41e2a');
  });
});
