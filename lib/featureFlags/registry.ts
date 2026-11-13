/**
 * THE CLOSED SET of per-organization kill-switches (Story 10.3 · MOTIR-750;
 * design `platform-admin/design-notes.md` § AMENDMENT 2026-10-03, `ops.switch.*`).
 *
 * Durable OPS flags, not experiment flags — the LaunchDarkly / Unleash /
 * ConfigCat kill-switch shape: permanent, a SAFE default, evaluated with no
 * remote round trip, scoped to one tenant, flipped through an audited surface.
 * A key that is not here is refused on write (`PlatformUnknownFeatureFlagError`)
 * and ignored on read — flags are a closed set, never free-form.
 *
 * Every default is ON: absence of an override means the org has the feature,
 * which is what every existing org had before this table existed. A switch OFF
 * disables that feature for that org only.
 *
 * ⚠️ NOT the internal-billing classification (MOTIR-4337) — that is a billing
 * flag with its own column and its own audit actions, never one of these.
 */
export const ORG_FEATURE_FLAG_KEYS = ['ai_planning', 'hosted_runs', 'web_search'] as const;

export type OrgFeatureFlagKey = (typeof ORG_FEATURE_FLAG_KEYS)[number];

export interface OrgFeatureFlagDefinition {
  /** The platform default — what an org with no override row gets. */
  readonly defaultEnabled: boolean;
  /** What turning it OFF does — the design's "When OFF" line, for the record. */
  readonly whenOff: string;
}

export const ORG_FEATURE_FLAG_REGISTRY: Readonly<
  Record<OrgFeatureFlagKey, OrgFeatureFlagDefinition>
> = Object.freeze({
  ai_planning: {
    defaultEnabled: true,
    whenOff: 'New planning jobs are refused. Jobs already running finish.',
  },
  hosted_runs: {
    defaultEnabled: true,
    whenOff: 'New Motir agent runs and agent instances are refused.',
  },
  web_search: {
    defaultEnabled: true,
    whenOff: 'Planning jobs are submitted with web search disabled.',
  },
});

export function isOrgFeatureFlagKey(key: string): key is OrgFeatureFlagKey {
  return (ORG_FEATURE_FLAG_KEYS as readonly string[]).includes(key);
}

/** Every switch at its platform default — the answer for an org with no rows. */
export function defaultOrgFeatureFlags(): Record<OrgFeatureFlagKey, boolean> {
  return {
    ai_planning: ORG_FEATURE_FLAG_REGISTRY.ai_planning.defaultEnabled,
    hosted_runs: ORG_FEATURE_FLAG_REGISTRY.hosted_runs.defaultEnabled,
    web_search: ORG_FEATURE_FLAG_REGISTRY.web_search.defaultEnabled,
  };
}
