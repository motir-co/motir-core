import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isCloud, isCloudBilling } from '@/lib/billing/availability';
import { stripSourceComments } from '../helpers/stripSourceComments';

// MOTIR-4033 — TWO QUESTIONS, TWO FUNCTIONS, and the guard that keeps them apart.
//
// `docs/decisions/billing-tiering.md` §6 rules that "is this a billing build?"
// and "is this a cloud build?" get their own predicates even though both read
// `MOTIR_CLOUD`. Story MOTIR-3908 is the first thing to need the second one: the
// public-projects capability is CLOUD-only and has nothing to do with billing.
//
// Left as a comment, that rule lasts until the first person who needs a cloud
// check finds `isCloudBilling()` already imported two files away. So it is a
// MEASUREMENT, taken over the shipped tree, in BOTH directions:
//
//   1. `MOTIR_CLOUD` is read in exactly ONE module — the same single-reader
//      shape `tests/hosting/appUrlSeam.test.ts` holds `MOTIR_BASE_URL` and
//      `MOTIR_PUBLIC_SITE_URL` to, and for the same reason: a second reader is a
//      second answer to a question one module exists to answer once.
//   2. The two predicates PARTITION their callers. Every `isCloudBilling()`
//      caller is a declared billing surface, and no billing surface reaches for
//      the generic predicate instead. Both halves are asserted as SET EQUALITY
//      rather than as containment, so the declaration cannot outlive a caller
//      either — the converse `tests/api/public/contract-coverage.test.ts` uses.
//
// ⚠️ THE DECLARED LIST IS COMPARED, NEVER TRUSTED. A remembered list is wrong
// the first time somebody adds a caller; what makes this one safe is that the
// derived set is computed from the tree on every run and the two are asserted
// equal, so adding a caller fails here until somebody writes down which question
// it is asking.

const REPO_ROOT = process.cwd();

/** The shipped tree. Tests are excluded on purpose: a test may call either. */
const ROOTS = ['app', 'lib', 'components', 'packages'];

/**
 * Every billing surface that legitimately asks "is this a BILLING build?", with
 * the reason it is one. A surface NOT in this list may not call
 * `isCloudBilling()`; a surface IN it may not call `isCloud()` instead.
 */
const BILLING_SURFACES: ReadonlyArray<readonly [file: string, why: string]> = [
  ['app/(authed)/layout.tsx', 'gates the org menu’s "Billing & plans" row'],
  ['app/(authed)/settings/organization/page.tsx', 'renders the BillingCard only on cloud'],
  [
    'app/(authed)/my-agents/page.tsx',
    'whether an agent’s storage is charged, for the price line and the empty state (agent-instance-storage.md §2, MOTIR-6918) — a self-hosted build charges none',
  ],
  [
    'app/(authed)/settings/organization/billing/page.tsx',
    'the billing page itself — 404s off-cloud',
  ],
  [
    'app/(authed)/settings/organization/fleet/page.tsx',
    'Settings › Organization › Fleet (MOTIR-10369) — the org’s fleet work and its stops; there is no fleet meter off-cloud, so it 404s there',
  ],
  [
    'app/(authed)/settings/organization/ai-models/page.tsx',
    'Settings › Organization › AI models (MOTIR-10846) — whether an org may choose its models depends on its plan tier, which exists only on a billing build, so it 404s off it',
  ],
  ['lib/billing/seatSync.ts', 'pushes seat counts to the billing provider'],
  ['lib/ciMetering/config.ts', 'the CI cost-metering configuration'],
  ['lib/services/billingService.ts', 'checkout, portal, subscriptions'],
  ['lib/services/ciFleetCostMeterService.ts', 'meters CI fleet cost against the plan'],
  [
    'lib/services/platformMeterReportEnqueue.ts',
    'reports the fleet meter (settled containers, charged storage days) to the platform usage rollup (MOTIR-5286, MOTIR-7294) — only a billing build runs the meter it reports',
  ],
  [
    'lib/services/platformOrgBillingService.ts',
    "the operator's read-only Billing & plans tab (MOTIR-7289) — the tenant billing page's own reads, which exist only on a billing build",
  ],
  [
    'lib/services/orgPlanReader.ts',
    'the one plan read behind the paid-AI-plan gate (MOTIR-6909) and the per-plan caps (MOTIR-9372) — off a billing build there is no plan to hold, so every org is exempt',
  ],
  ['lib/services/entitlementsService.ts', 'the §4 entitlement caps'],
  [
    'lib/services/platformIndexAllowanceService.ts',
    'Monitoring · Index allowance (MOTIR-4595) — the internal allowance and the fleet meter it reads exist only on a billing build, the same switch ciFleetCostMeterService writes under',
  ],
  [
    'lib/services/hostedRunChargeService.ts',
    'charges a hosted run its machine time in credits (MOTIR-6514, hosted-agent-machine-charge.md) — the same billing-build switch the CI fleet meter charges under',
  ],
  [
    'lib/services/agentInstanceChargeService.ts',
    'charges an agent instance each running interval in credits (MOTIR-6873, agent-instances.md §5) — the hosted run charge’s billing-build switch',
  ],
  [
    'lib/services/agentInstanceLifecycleService.ts',
    'the credit pre-flight before an instance starts or wakes (MOTIR-6872, agent-instances.md §5) — no credits to ask about off a billing build',
  ],
  [
    'lib/services/agentInstanceSweepService.ts',
    'hibernates a running instance its organisation’s credits now refuse (MOTIR-6873, agent-instances.md §2) — the same pre-flight, asked by the sweep',
  ],
  [
    'lib/services/agentInstanceStorageChargeService.ts',
    'charges every agent instance its storage once per UTC day in credits (MOTIR-6919, agent-instance-storage.md §2) — the interval charge’s billing-build switch; a self-hosted build charges nothing',
  ],
  [
    'lib/services/platformFleetMonitorService.ts',
    'Monitoring · Fleet and the tenant Fleet card (MOTIR-6905) — compares running containers with the credits the fleet meter debits, which exist only on a billing build; off it the read answers `{ meter: "disabled" }`',
  ],
  [
    'lib/services/platformOrgIndexCostService.ts',
    'the org page’s Index & fleet cost card (MOTIR-5341) — the same billing-build switch as the fleet meter it reads',
  ],
];

const BILLING_FILES = BILLING_SURFACES.map(([file]) => file).sort();

/** Every `.ts` / `.tsx` under `dir`, repo-relative and POSIX-separated. */
function sourceFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFilesUnder(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(relative(REPO_ROOT, full).split(sep).join('/'));
  }
  return out;
}

const SHIPPED_FILES = ROOTS.flatMap((root) => sourceFilesUnder(join(REPO_ROOT, root)));

/** Each file's source, read ONCE — this walk is the whole app tree. */
const SOURCE = new Map(
  SHIPPED_FILES.map((file) => [file, readFileSync(join(REPO_ROOT, file), 'utf8')] as const),
);

// Source with comments stripped. Three of these predicates' most careful
// mentions are comments explaining why the file does NOT call them
// (`lib/legal/reconsentGate.ts`, `lib/billing/entitlements.ts`,
// `app/(authed)/settings/organization/_components/BillingCard.tsx`) — counting
// prose as a call would report the opposite of what those files do.
//
// ⚠️ `stripSourceComments` rather than the one-liner the rest of this tree
// inlines: that one removes BLOCK comments first, so a `//` line containing an
// opening block-comment sequence starts a block that runs to the next closing
// one and eats the code below it. This guard was the first thing to hit it —
// see that module's header. (These lines are `//` and not a JSDoc block for the
// same reason: a block comment cannot quote the sequences it is about.)
const stripComments = stripSourceComments;

const CODE = new Map([...SOURCE].map(([file, src]) => [file, stripComments(src)] as const));

/** The files whose CODE calls `name()`, excluding the module that defines it. */
function callersOf(name: 'isCloud' | 'isCloudBilling'): string[] {
  const call = new RegExp(`\\b${name}\\s*\\(`);
  return SHIPPED_FILES.filter(
    (file) => file !== 'lib/billing/availability.ts' && call.test(CODE.get(file) ?? ''),
  ).sort();
}

describe('the cloud-build flag has exactly one reader', () => {
  it('finds source files at all — a walk that returned nothing would pass everything below', () => {
    // The vacuous-pass trap of any discovery-based check, asserted first.
    expect(SHIPPED_FILES.length).toBeGreaterThan(500);
  });

  it('MOTIR_CLOUD is read in `lib/billing/availability.ts` and nowhere else', () => {
    // ⚠️ COMMENT-STRIPPED, for the same reason `contract-coverage.test.ts`
    // strips: a verb named in prose is not an export, and a flag named in prose
    // is not a read. This tree documents its own mechanisms at length —
    // `lib/legal/reconsentGate.ts` spends a paragraph on which question it is
    // asking and why it is not the billing one — so a guard that cannot tell a
    // paragraph from a read goes red on exactly the files that explain
    // themselves, and is then "fixed" by deleting the explanation.
    const readers = SHIPPED_FILES.filter((file) =>
      /process\.env\[.MOTIR_CLOUD.\]/.test(CODE.get(file) ?? ''),
    );
    expect(
      readers,
      `second readers of MOTIR_CLOUD: ${readers.join(', ')} — call isCloud() ` +
        'or isCloudBilling() instead; a private env read is a second answer to a ' +
        'question this module exists to answer once',
    ).toEqual(['lib/billing/availability.ts']);
  });

  it('the reader sweep can SEE a read — the counterfactual, run rather than asserted in prose', () => {
    // A comment-stripping check that stripped too much would pass this suite
    // unconditionally, and would look identical from here. So the predicate is
    // driven over both a real read and a described one.
    const reads = (source: string) => /process\.env\[.MOTIR_CLOUD.\]/.test(stripComments(source));
    expect(reads("const on = process.env['MOTIR_CLOUD'] === 'true';")).toBe(true);
    expect(reads("// it used to inline process.env['MOTIR_CLOUD'] === 'true'")).toBe(false);
    expect(reads("/** reads process.env['MOTIR_CLOUD'] */")).toBe(false);
    // ⚠️ …and the ordering hazard itself: a `//` line carrying `/*` must not
    // swallow the code beneath it. This assertion is the one that was FAILING
    // silently — as a false negative, which is the direction a guard passes in.
    expect(
      reads(
        "// the routes under `app/api/public/*` are gated\nconst on = process.env['MOTIR_CLOUD'];",
      ),
    ).toBe(true);
  });
});

describe('the two predicates PARTITION their callers (ADR §6)', () => {
  it('every `isCloudBilling()` caller is a declared billing surface', () => {
    const undeclared = callersOf('isCloudBilling').filter((f) => !BILLING_FILES.includes(f));
    expect(
      undeclared,
      `non-billing surfaces calling isCloudBilling(): ${undeclared.join(', ')} — ` +
        'ask "is this a CLOUD build?" with isCloud() instead, or declare it here with its reason',
    ).toEqual([]);
  });

  it('declares NOTHING that is not a caller — so the list cannot outlive a surface', () => {
    const callers = callersOf('isCloudBilling');
    const phantom = BILLING_FILES.filter((f) => !callers.includes(f));
    expect(
      phantom,
      `declared billing surfaces that no longer call it: ${phantom.join(', ')}`,
    ).toEqual([]);
  });

  it('finds the billing callers at all — the floor, so an empty sweep cannot read as green', () => {
    expect(callersOf('isCloudBilling').length).toBeGreaterThanOrEqual(8);
  });

  it('the PUBLIC-PROJECTS gate asks the cloud question, not the billing one', () => {
    // The consumer MOTIR-4033 exists for, asserted by name rather than left to
    // the allowlist's silence: the two arms above would both pass if nothing
    // called `isCloud()` at all.
    const cloudCallers = callersOf('isCloud');
    expect(cloudCallers).toContain('lib/publicProjects/cloudGate.ts');
    expect(cloudCallers).toContain('lib/services/projectMembersService.ts');
    expect(BILLING_FILES).not.toContain('lib/publicProjects/cloudGate.ts');
  });

  // ⚠️ THE CONVERSE ARM WAS REMOVED, and it is worth saying why rather than
  // leaving a one-directional rule looking like an oversight (MOTIR-4035).
  //
  // This suite first asserted the two predicates PARTITION their callers — no
  // billing surface may call `isCloud()` either. That reads as symmetry and is
  // wrong about what a FILE is. `app/(authed)/layout.tsx` is the application
  // SHELL: it gates the billing menu row (`isCloudBilling()`) and the
  // build-in-public header slot (`isCloud()`), and it is right on both counts.
  // A file is not a surface; it can host several.
  //
  // What the ADR actually rules is one-directional — a non-billing QUESTION may
  // not be answered with the billing predicate — and that is the arm above. The
  // allowlist keeps its teeth because it is asserted EQUAL to the derived set,
  // so a new `isCloudBilling()` caller still fails until somebody names the
  // billing thing it gates.
  it('the shell may ask BOTH questions — the case that retired the converse arm', () => {
    expect(callersOf('isCloudBilling')).toContain('app/(authed)/layout.tsx');
    expect(callersOf('isCloud')).toContain('app/(authed)/layout.tsx');
  });
});

describe('both predicates read the EXPLICIT flag, and nothing else', () => {
  it('are true only for the exact string `true`', () => {
    vi.stubEnv('MOTIR_CLOUD', 'true');
    expect(isCloud()).toBe(true);
    expect(isCloudBilling()).toBe(true);
    vi.unstubAllEnvs();
  });

  it('default to FALSE — unset, empty, and every near-miss a deployment produces', () => {
    // The discipline `isCloudBilling()`'s own header states: the flag is
    // EXPLICIT and default false, never inferred. A self-hoster who sets
    // `MOTIR_CLOUD=1` out of habit gets the self-hosted product, which is the
    // safe direction for a capability gate to fail in.
    for (const value of [undefined, '', '  ', '1', 'yes', 'TRUE', 'True', 'false']) {
      vi.stubEnv('MOTIR_CLOUD', value);
      expect(isCloud(), `MOTIR_CLOUD=${String(value)}`).toBe(false);
      expect(isCloudBilling(), `MOTIR_CLOUD=${String(value)}`).toBe(false);
    }
    vi.unstubAllEnvs();
  });

  it('answer the SAME variable — so a build is cloud for both questions or neither, today', () => {
    // Stated as a test rather than left implicit: the two functions exist to be
    // able to DIVERGE, and today they do not. Somebody splitting the variable
    // later should have to change this line deliberately.
    for (const value of ['true', undefined]) {
      vi.stubEnv('MOTIR_CLOUD', value);
      expect(isCloud()).toBe(isCloudBilling());
    }
    vi.unstubAllEnvs();
  });
});
