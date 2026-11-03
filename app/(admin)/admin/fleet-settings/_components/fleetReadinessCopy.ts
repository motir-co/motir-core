import type { FleetOrgCiStateDTO } from '@/lib/dto/fleetOrgCiSetting';

/**
 * The readiness verdict's copy, from CODES (MOTIR-8715). The service's English
 * `message` is for logs and audit; the page renders `reasonCode` + `params`
 * through the catalogue, and falls back to the message only for a code this
 * file has no sentence for — never to a blank.
 *
 * Pure: no React, no I/O, so the catalogue coverage test can hold the readiness
 * service to `WHY_REASON_CODES` without rendering anything.
 */

export type FleetReadinessCondition = FleetOrgCiStateDTO['readiness']['conditions'][number];

/** The code constants a sentence interpolates. */
export interface FleetCopyConstants {
  killSwitchVariable: string;
}

/** A translator over `platformAdmin.fleetSettings` that takes any key. */
export type FleetTranslate = (key: string, values?: Record<string, string | number>) => string;

/** Formats an ISO date for a sentence. */
export type FleetFormatDate = (iso: string) => string;

const PERMISSION_WORDS: Record<string, string> = {
  organization_self_hosted_runners: 'permission.organization_self_hosted_runners',
  organization_actions_variables: 'permission.organization_actions_variables',
};

export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * The sentence for a condition that is not met, from its `reasonCode` and
 * `params`. A code with no sentence here falls back to the service's English
 * `message` — never to a blank.
 */
export function whyText(
  tt: FleetTranslate,
  formatDate: FleetFormatDate,
  condition: FleetReadinessCondition,
  ctx: { project: string; org: string; constants: FleetCopyConstants },
): string {
  const p = condition.params;
  const org = str(p['org']) || ctx.org;
  const project = str(p['projectKey']) || ctx.project;
  const list = (xs: string[]) => xs.join(', ');
  switch (condition.reasonCode) {
    case 'kill_switch_engaged':
      return tt('why.kill_switch_engaged', { variable: ctx.constants.killSwitchVariable });
    case 'app_not_installed':
      return tt('why.app_not_installed', { org });
    case 'app_suspended': {
      const at = str(p['suspendedAt']);
      return tt('why.app_suspended', {
        org,
        date: at ? formatDate(at) : '—',
      });
    }
    case 'permission_missing':
    case 'permission_insufficient': {
      const raw = str(p['permission']);
      const word = PERMISSION_WORDS[raw];
      return tt(`why.${condition.reasonCode}`, {
        org,
        permission: word ? tt(word) : raw,
        granted: str(p['granted']),
      });
    }
    case 'not_subscribed':
      return tt('why.not_subscribed');
    case 'repositories_not_granted':
      return tt('why.repositories_not_granted', { org, repositories: list(strings(p['missing'])) });
    case 'no_private_repositories':
      return tt('why.no_private_repositories', { project, org });
    case 'not_attributable': {
      const failures = Array.isArray(p['failures']) ? p['failures'] : [];
      const repos = failures
        .map((f) =>
          f && typeof f === 'object' ? str((f as { repository?: unknown }).repository) : '',
        )
        .filter(Boolean);
      return tt('why.not_attributable', { project, repositories: list(repos) });
    }
    case 'no_runner_group':
    case 'sync_pending':
      return tt(`why.${condition.reasonCode}`, {
        org,
        project,
        script: str(p['script']),
      });
    case 'jobs_not_runnable':
      return tt('why.jobs_not_runnable', {
        count: Array.isArray(p['jobs']) ? p['jobs'].length : 0,
      });
    case 'runner_image_unset':
      return tt('why.runner_image_unset', { variable: str(p['variable']) });
    case 'image_tools_unrecorded':
      return tt('why.image_tools_unrecorded', { image: str(p['image']), label: str(p['label']) });
    case 'image_unreadable':
      return tt('why.image_unreadable', { image: str(p['image']) });
    case 'read_failed': {
      const status = p['status'];
      if (typeof status === 'number') return tt('why.read_failed', { status });
      if (status === null) return tt('why.read_unreachable');
      // A read that is not GitHub's (the runner-group or attribution read)
      // carries no status at all.
      return tt('why.read_failedNoStatus');
    }
    case 'app_not_readable':
      return tt('why.app_not_readable', { org });
    default:
      return condition.message;
  }
}

/** Every `reasonCode` `whyText` renders from the catalogue (the coverage test
 *  holds the readiness service to this set). */
export const WHY_REASON_CODES = [
  'kill_switch_engaged',
  'app_not_installed',
  'app_suspended',
  'permission_missing',
  'permission_insufficient',
  'not_subscribed',
  'repositories_not_granted',
  'no_private_repositories',
  'not_attributable',
  'no_runner_group',
  'sync_pending',
  'jobs_not_runnable',
  'runner_image_unset',
  'image_tools_unrecorded',
  'image_unreadable',
  'read_failed',
  'app_not_readable',
] as const;
