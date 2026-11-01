// The environment-configuration vocabulary (Story MOTIR-9795 · MOTIR-9960): the
// environments a Motir repository's app is configured for, and what a change to
// one of its entries did. The Prisma enums `AppEnvironment` /
// `EnvironmentConfigAction` carry the same values — a test pins the lists together.

/** The three environments an entry belongs to: the long-lived production app,
 *  every pull request's preview, and the release a live project's train builds. */
export const ENVIRONMENTS = ['production', 'preview', 'release'] as const;
export type EnvironmentName = (typeof ENVIRONMENTS)[number];

/** What one change did to an entry — the change record's `action`. */
export const ENVIRONMENT_CONFIG_ACTIONS = ['added', 'replaced', 'deleted'] as const;
export type EnvironmentConfigActionName = (typeof ENVIRONMENT_CONFIG_ACTIONS)[number];

export function isEnvironmentName(value: string): value is EnvironmentName {
  return (ENVIRONMENTS as readonly string[]).includes(value);
}
