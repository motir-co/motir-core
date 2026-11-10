// THE ORG TIER FIXTURE — one file, two readers (Story MOTIR-10838 · MOTIR-10849).
//
// Whether an organisation may choose its own Motir AI models is a property of its
// motir-ai TIER (`lib/billing/modelChoiceQualification.ts`). In the E2E lanes that
// tier is answered in two places: motir-ai's planning-side org override read
// (`lib/test-planner-model-mock.ts`, its `qualifies`) and motir-core's own tier read
// `POST /v1/admin/orgs/tiers` (`lib/test-hosted-run-mock.ts`), which the run-side
// resolver makes in the webServer AND in the job worker (a hosted review resolves
// its model there). If each seam kept its own tier, the room and the resolver could
// disagree within one test. So both read THIS file, re-read on every request:
// moving an organisation between Standard and Pro is one rewrite of it and nothing
// else.
//
// Shape: `{ "tiers": { "<coreOrganizationId>": "<tierKey>" | null } }`. An org the
// file does not name has no tier, which motir-core reads as not qualifying.

import { readFixtureFileSync } from '@/lib/test-fixture-file';

export interface OrgTierFixture {
  tiers: Record<string, string | null>;
}

/** The env var naming the file, set on the runner, the webServer and the worker. */
export const ORG_TIER_FIXTURE_ENV = 'MOTIR_AI_ORG_TIER_FIXTURE_PATH';

/** Every org's tier as the file holds it; an absent or torn file names none. */
export function readOrgTierFixture(): OrgTierFixture {
  const path = process.env[ORG_TIER_FIXTURE_ENV];
  if (!path) return { tiers: {} };
  try {
    const parsed = JSON.parse(readFixtureFileSync(path)) as Partial<OrgTierFixture>;
    return { tiers: parsed.tiers ?? {} };
  } catch {
    return { tiers: {} };
  }
}

/** One org's tier key, or null when the file names none for it. */
export function orgTierOf(coreOrganizationId: string): string | null {
  return readOrgTierFixture().tiers[coreOrganizationId] ?? null;
}

/** motir-ai's own rule for an org's model choice: any tier but Free and Standard. */
export function tierQualifies(tierKey: string | null): boolean {
  return tierKey !== null && tierKey !== '' && tierKey !== 'free' && tierKey !== 'standard';
}
