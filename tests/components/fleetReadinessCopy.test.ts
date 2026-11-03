import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import {
  str,
  strings,
  whyText,
  WHY_REASON_CODES,
  type FleetReadinessCondition,
  type FleetTranslate,
} from '@/app/(admin)/admin/fleet-settings/_components/fleetReadinessCopy';

// THE READINESS VERDICT'S COPY (Story MOTIR-8699 · MOTIR-8715; MOTIR-8716 part B):
// every `reasonCode` `whyText` knows, rendered through the REAL `en` catalogue,
// with the params the readiness service writes AND the malformed params a
// renderer must survive without printing `undefined` or a blank.

const t = createTranslator({
  locale: 'en',
  messages: en,
  namespace: 'platformAdmin.fleetSettings',
}) as unknown as FleetTranslate;
const formatDate = (iso: string) => `<${iso}>`;
const ctx = {
  project: 'MOTIR',
  org: 'acme-connected',
  constants: { killSwitchVariable: 'MOTIR_FLEET_MAX_IN_FLIGHT' },
};

function why(reasonCode: string, params: Record<string, unknown> = {}, message = 'English.') {
  const condition = {
    key: 'runner_group',
    state: 'unmet',
    reasonCode,
    params,
    message,
  } as FleetReadinessCondition;
  return whyText(t, formatDate, condition, ctx);
}

describe('whyText', () => {
  it.each([
    ['kill_switch_engaged', {}, 'engaged (MOTIR_FLEET_MAX_IN_FLIGHT=0)'],
    ['app_not_installed', { org: 'other-org' }, 'not installed on other-org'],
    ['app_not_installed', {}, 'not installed on acme-connected'],
    ['app_suspended', { suspendedAt: '2026-10-01' }, 'suspended since <2026-10-01>'],
    ['app_suspended', {}, 'suspended since —'],
    [
      'permission_missing',
      { permission: 'organization_self_hosted_runners', granted: null },
      'holds Self-hosted runners',
    ],
    [
      'permission_insufficient',
      { permission: 'organization_actions_variables', granted: 'read' },
      ': read, and needs write',
    ],
    [
      'permission_insufficient',
      { permission: 'some_new_permission', granted: 'read' },
      'some_new_permission: read',
    ],
    ['not_subscribed', {}, 'not subscribed to workflow_job events'],
    [
      'repositories_not_granted',
      { missing: ['acme-connected/api', 7, 'acme-connected/web'] },
      'reach acme-connected/api, acme-connected/web.',
    ],
    ['repositories_not_granted', { missing: 'nope' }, 'does not reach .'],
    ['no_private_repositories', { projectKey: 'OTHER' }, 'Project OTHER has no private repository'],
    [
      'not_attributable',
      { failures: [{ repository: 'acme-connected/api' }, null, 'x', { repository: 3 }] },
      'from acme-connected/api would not be attributed to project MOTIR',
    ],
    ['not_attributable', { failures: 'nope' }, 'A queued job from  would not'],
    ['no_runner_group', { script: 'scripts/sync.ts' }, 'runs scripts/sync.ts --project MOTIR'],
    ['sync_pending', { script: 7 }, 'runs  --project MOTIR'],
    ['jobs_not_runnable', { jobs: [{}, {}] }, '2 jobs can'],
    ['jobs_not_runnable', { jobs: 'nope' }, '0 jobs can'],
    [
      'runner_image_unset',
      { variable: 'MOTIR_RUNNER_IMAGE' },
      'pins no runner image (MOTIR_RUNNER_IMAGE is unset)',
    ],
    [
      'image_tools_unrecorded',
      { image: 'ghcr.io/x@sha256:1', label: 'co.motir.ci-runner.tools' },
      'image ghcr.io/x@sha256:1 records no tool list (the co.motir.ci-runner.tools label)',
    ],
    ['image_tools_unrecorded', {}, 'image  records no tool list'],
    ['image_unreadable', { image: 'ghcr.io/x@sha256:1' }, 'runner image ghcr.io/x@sha256:1.'],
    ['read_failed', { status: 503 }, 'GitHub answered HTTP 503'],
    ['read_failed', { status: null }, 'GitHub could not be reached'],
    ['read_failed', {}, "Couldn't check this. Counts as not met"],
    ['app_not_readable', {}, 'installed and readable on acme-connected'],
  ])('%s %j', (code, params, words) => {
    expect(why(code, params)).toContain(words);
  });

  it('a code it has no sentence for falls back to the service message, never a blank', () => {
    expect(why('a_code_from_the_future', {}, 'The service’s English.')).toBe(
      'The service’s English.',
    );
  });

  it('every listed code renders from the catalogue, not from the message', () => {
    for (const code of WHY_REASON_CODES) {
      expect(why(code, {}, 'SENTINEL')).not.toBe('SENTINEL');
    }
  });
});

describe('str / strings', () => {
  it('keep only strings', () => {
    expect(str('a')).toBe('a');
    expect(str(3)).toBe('');
    expect(strings(['a', 1, null, 'b'])).toEqual(['a', 'b']);
    expect(strings('a')).toEqual([]);
  });
});
