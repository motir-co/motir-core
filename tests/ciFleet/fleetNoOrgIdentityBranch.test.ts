import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// THE ORG-IDENTITY GUARD (Story MOTIR-8699 · MOTIR-8716) — "no fleet code
// branches on Motir's org".
//
// The story moved Motir's OWN private repositories' CI onto the shared runner
// fleet through the SAME pipeline tenants use. That claim holds only while the
// pipeline cannot tell Motir's org from anybody else's: the org arrives as DATA
// (an intent's `repoOwner`, a delivery's installation id, a `project_runner_group`
// row) and nothing below the platform switch asks "is this the meta org?". A
// branch on `isMeta`, `internalBilling` or a hardcoded login would make the fleet
// do something for Motir it does not do for a tenant — the exact drift a
// per-card suite with its neighbours faked cannot see.
//
// Two rules, both over SOURCE rather than a module graph (an org login in a
// string is not an import), in the shape `orchestratorPortBoundary.test.ts`
// already uses — comment-stripped, file and line named, and a mutation check so
// a green run means "nothing found" rather than "nothing scanned":
//
//   C1  No literal Motir org (`moooon`, case-insensitive) in the CODE of
//       `lib/**` / `app/**`, listed by `git ls-files`, never `find`.
//   C2  No org-identity predicate in the FLEET PIPELINE: no `isMeta`, no
//       `internalBilling`, no string literal naming Motir's org or the
//       provisioning org. The provisioning org is reached only through
//       `provisioningOrgLogin()`.
//
// ⚠️ THE POPULATION IS DEFINED BY FILE PATH, NOT BY SYMBOL. `isMeta` reads that
// predate this story — `fleetCeilingService`, the credit check
// (`ciAllowanceService`), the AI-plan gate — are outside it because their FILES
// are, not because a symbol list forgives them. They are the shipped admission
// paths the story deliberately left alone: Motir's org passes them the same way
// any internally billed org always has.
//
// ⚠️ TWO PLACES WHERE THE CARD'S PREMISE DID NOT HOLD, both measured, both kept
// visible rather than silently widened:
//
//   * C1 tree-wide is NOT empty at the story's base. Eight files carried the
//     literal in code before this story (a sandbox image path, a docs URL, the
//     starter template's owner, a reserved-name list, GDPR export copy, a
//     credential hint, an e2e mock account). They are pinned in
//     `PRE_STORY_LITERAL_DEBT`, asserted TIGHT in both directions: a new file
//     fails, and an entry that stops matching fails until it is deleted — the
//     list only shrinks. Comments are not scanned (a comment explaining the
//     rule is not a violation of it), and neither is JSON data: the fleet job
//     inventory (`lib/ciFleet/fleetJobInventory.json`) is a measured manifest
//     keyed by the inventoried repositories' full names, which readiness looks
//     up by repository — it names Motir's repos, it branches on nothing.
//   * `lib/ciFleet/indexAllowance.ts` sits under `lib/ciFleet/` and carries
//     `isMeta` in code: it is the code-graph INDEX allowance's wire vocabulary
//     (Story MOTIR-4335 · MOTIR-4593), which parses motir-ai's `isMeta` field
//     into a typed record and branches on nothing. It predates this story and is
//     not a CI-runner path, so it is outside the population by path — named in
//     `OUT_OF_POPULATION`, which is asserted to hold exactly that one file and to
//     still match, so it can never quietly excuse something else.

const root = process.cwd();

/** Comment-stripped source — the `orchestratorPortBoundary` stripper. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const CODE_FILE = /\.(m|c)?[jt]sx?$/;

/** Tracked files under the given roots — the index, never the working tree's
 *  untracked debris. */
function trackedFiles(...roots: string[]): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', ...roots], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .filter((file) => existsSync(`${root}/${file}`));
}

// ── C1 ─────────────────────────────────────────────────────────────────────

const MOTIR_ORG_LITERAL = /moooon/i;

/** Lines of `source` (already comment-stripped) that name Motir's org. */
function motirOrgLiteralHits(source: string): string[] {
  return stripComments(source)
    .split('\n')
    .filter((line) => MOTIR_ORG_LITERAL.test(line))
    .map((line) => line.trim().slice(0, 120));
}

/**
 * Files that named Motir's org in CODE before this story (measured at the
 * story's base, `origin/main` before MOTIR-8702). Tight both ways — see the
 * header. None is a fleet file; deleting the literal deletes the entry.
 */
const PRE_STORY_LITERAL_DEBT = [
  'lib/apiDocs/mcp.ts',
  'lib/export/personalDataSections.ts',
  'lib/health/credentialRegistry.ts',
  'lib/publicAddresses/reservedNames.ts',
  'lib/test-github-accounts-mock.ts',
] as const;

function c1Offenders(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of trackedFiles('lib', 'app')) {
    if (!CODE_FILE.test(file)) continue;
    const hits = motirOrgLiteralHits(readFileSync(`${root}/${file}`, 'utf8'));
    if (hits.length > 0) found.set(file, hits);
  }
  return found;
}

// ── C2 ─────────────────────────────────────────────────────────────────────

/**
 * THE ONE DELIBERATE EXCEPTION, by name. The setting card's reason, quoted from
 * the file's own header: "`listTargets` IS THE ONE PLACE IN THE STORY THAT READS
 * ORG IDENTITY, on purpose: the platform decides WHOSE CI the console may move
 * (projects of the meta organisation, orgs other than the provisioning org).
 * Every fleet path below it receives only `{ projectId, org, installationId }`."
 *
 * Asserted to be exactly one entry: a second exception is an edit to this list
 * that a reviewer has to read.
 */
const EXCLUDED = ['lib/services/fleetOrgCiSettingService.ts'] as const;

/** Under `lib/ciFleet/` by path, outside the population by provenance — see the
 *  header. Exactly one entry, and it must still match. */
const OUT_OF_POPULATION = ['lib/ciFleet/indexAllowance.ts'] as const;

/** The service, repository and GitHub-client files the card's coverage list
 *  names, plus the admin action — the pipeline the switch feeds. */
const NAMED_PIPELINE_FILES = [
  'lib/github/orgTarget.ts',
  'lib/github/orgInstallation.ts',
  'lib/github/actionsVariables.ts',
  'lib/github/runnerGroups.ts',
  'lib/github/runnerJitConfig.ts',
  'lib/services/projectRunnerGroupService.ts',
  'lib/repositories/projectRunnerGroupRepository.ts',
  'lib/services/fleetReadinessService.ts',
  'lib/services/fleetOrgCiSettingService.ts',
  'lib/repositories/platformFleetOrgCiRepository.ts',
  'lib/services/ciRunnerProvisioningService.ts',
  'lib/services/ciRunnerBootService.ts',
  'lib/services/fleetStopService.ts',
  'app/(admin)/admin/fleet-settings/actions.ts',
] as const;

/** Every code file the guard reads, by path. */
function c2Population(): string[] {
  const underFleet = trackedFiles('lib/ciFleet').filter((file) => CODE_FILE.test(file));
  const all = new Set<string>([...underFleet, ...NAMED_PIPELINE_FILES]);
  for (const file of [...EXCLUDED, ...OUT_OF_POPULATION]) all.delete(file);
  return [...all].sort();
}

interface Tell {
  pattern: RegExp;
  what: string;
}

const ORG_IDENTITY_TELLS: Tell[] = [
  { pattern: /\bisMeta\b/, what: 'reads `isMeta`' },
  { pattern: /\binternalBilling\b/, what: 'reads `internalBilling`' },
  {
    pattern: /(['"`])[^'"`\n]*(moooon|\bmotir-projects\b)[^'"`\n]*\1/i,
    what: "names Motir's org or the provisioning org as a literal (use provisioningOrgLogin())",
  },
];

/** Every org-identity tell in `source`, comment-stripped, as `what: line`. */
function orgIdentityHits(source: string): string[] {
  const hits: string[] = [];
  for (const line of stripComments(source).split('\n')) {
    for (const { pattern, what } of ORG_IDENTITY_TELLS) {
      if (pattern.test(line)) hits.push(`${what}: ${line.trim().slice(0, 120)}`);
    }
  }
  return hits;
}

function read(file: string): string {
  return readFileSync(`${root}/${file}`, 'utf8');
}

describe('C1 — no literal Motir org in the code of lib/** and app/**', () => {
  it('only the pinned pre-story files name it, and each of them still does', () => {
    const offenders = c1Offenders();
    const unexpected = [...offenders.entries()].filter(
      ([file]) => !(PRE_STORY_LITERAL_DEBT as readonly string[]).includes(file),
    );
    expect(
      unexpected,
      unexpected.map(([file, lines]) => `${file}\n    ${lines.join('\n    ')}`).join('\n'),
    ).toEqual([]);
    // Tight in the other direction: a fixed file leaves the list.
    const stale = PRE_STORY_LITERAL_DEBT.filter((file) => !offenders.has(file));
    expect(stale, 'no longer names the org — delete it from PRE_STORY_LITERAL_DEBT').toEqual([]);
  });

  it('no fleet file is in the debt list', () => {
    const population = new Set([...c2Population(), ...EXCLUDED]);
    expect(PRE_STORY_LITERAL_DEBT.filter((file) => population.has(file))).toEqual([]);
  });
});

describe('C2 — no org-identity predicate in the fleet pipeline', () => {
  it('the population is real: every named file exists and lib/ciFleet/ contributes', () => {
    for (const file of NAMED_PIPELINE_FILES) expect(existsSync(`${root}/${file}`), file).toBe(true);
    const population = c2Population();
    expect(population).toContain('lib/ciFleet/runnerTarget.ts');
    expect(population).toContain('lib/ciFleet/config.ts');
    expect(population.length).toBeGreaterThanOrEqual(NAMED_PIPELINE_FILES.length);
  });

  it('no file in the population reads isMeta / internalBilling or names an org literally', () => {
    const found = c2Population().flatMap((file) =>
      orgIdentityHits(read(file)).map((hit) => `${file}: ${hit}`),
    );
    expect(found, found.join('\n')).toEqual([]);
  });

  it('the provisioning org is reached through provisioningOrgLogin()', () => {
    // The path the rule POINTS at: the runner target and the group read decide
    // "is this the provisioning org?" from the configured login, never a literal.
    expect(stripComments(read('lib/ciFleet/runnerTarget.ts'))).toMatch(/provisioningOrgLogin\(\)/);
    expect(stripComments(read('lib/services/projectRunnerGroupService.ts'))).toMatch(
      /provisioningOrgLogin\(\)/,
    );
  });
});

describe('C2 — the exception is singular and named', () => {
  it('the exclusion list is exactly the setting service', () => {
    expect([...EXCLUDED]).toEqual(['lib/services/fleetOrgCiSettingService.ts']);
  });

  it('the exclusion is still needed: the setting service reads org identity (listTargets)', () => {
    // An exception that no longer excuses anything is a hole that will excuse
    // whatever moves into that file next.
    const source = read(EXCLUDED[0]);
    expect(stripComments(source)).toMatch(/listInMetaOrganizations|isMeta/);
    expect(source).toMatch(/`listTargets` IS THE ONE PLACE IN THE STORY THAT READS/);
  });

  it('the out-of-population file is exactly indexAllowance.ts, and it still matches', () => {
    expect([...OUT_OF_POPULATION]).toEqual(['lib/ciFleet/indexAllowance.ts']);
    expect(orgIdentityHits(read(OUT_OF_POPULATION[0])).length).toBeGreaterThan(0);
  });
});

describe('mutation check — the matchers fire on what they exist to catch', () => {
  it('reports an isMeta branch, an internalBilling read and a hardcoded org', () => {
    const fabricated = [
      'export function bootFor(org: { isMeta: boolean }) {',
      '  if (org.isMeta) return provisionInMotirOrg();',
      '  if (organization.internalBilling) skipMeter();',
      "  const owner = 'moooon-B-V';",
      '  return mint(`/orgs/motir-projects/actions/runners`);',
      '}',
    ].join('\n');
    const hits = orgIdentityHits(fabricated);
    expect(hits.some((h) => h.includes('if (org.isMeta)'))).toBe(true);
    expect(hits.some((h) => h.includes('internalBilling'))).toBe(true);
    expect(hits.some((h) => h.includes("'moooon-B-V'"))).toBe(true);
    expect(hits.some((h) => h.includes('/orgs/motir-projects/'))).toBe(true);
  });

  it("C1 reports a file naming 'moooon-B-V' in any case", () => {
    expect(motirOrgLiteralHits("const ORG = 'moooon-B-V';")).toEqual(["const ORG = 'moooon-B-V';"]);
    expect(motirOrgLiteralHits('fetch(`https://api.github.com/orgs/MOOOON-b-v/x`)')).toHaveLength(
      1,
    );
  });

  it('does not fire on a comment explaining the rule, or on innocent words', () => {
    const innocent = [
      '// never branch on `isMeta` or on moooon-B-V here',
      '/* the meta org (moooon B.V.) passes admission as bypassed */',
      'const provisioning = provisioningOrgLogin();',
      'const metadata = { isMetadata: true };',
    ].join('\n');
    expect(orgIdentityHits(innocent)).toEqual([]);
    expect(motirOrgLiteralHits(innocent)).toEqual([]);
  });
});
