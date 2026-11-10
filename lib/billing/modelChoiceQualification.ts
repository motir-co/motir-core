// WHO MAY CHOOSE THEIR OWN AI MODELS (story MOTIR-10838 · MOTIR-10843): the meta
// organisation whatever its tier, and any other organisation on a plan above
// Standard — Pro, Max, Max ×2, a larger pool or Host. Pure, and evaluated at
// every resolution: an org that drops to Standard keeps its stored choices, which
// simply stop being read, and they apply again when it returns.
//
// The tier key is motir-ai's (`fetchOrgTiers`); `null` means no tier, or one that
// could not be read — both resolve as not qualifying, so a run falls to the
// platform default rather than being refused. motir-ai holds the same rule for
// the planning-side functions (`orgQualifiesForModelChoice`).

/** The tiers that do NOT include the organisation's own model choices. */
const BELOW_MODEL_CHOICE: ReadonlySet<string> = new Set(['free', 'standard']);

export function orgQualifiesForHostedModelChoice(input: {
  isMeta: boolean;
  tierKey: string | null;
}): boolean {
  if (input.isMeta) return true;
  return input.tierKey !== null && input.tierKey !== '' && !BELOW_MODEL_CHOICE.has(input.tierKey);
}
