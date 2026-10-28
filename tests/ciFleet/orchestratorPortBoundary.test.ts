import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// THE DEPENDENCY GUARD (Story MOTIR-1916 · MOTIR-1921) —
// `docs/decisions/ci-runner-fleet.md` §4, rule 1:
//
//   > No `fly` types, imports or ids above `lib/orchestrator/adapters/fly/`. The
//   > webhook handler (MOTIR-1920), the gate (MOTIR-1922), the provisioner
//   > (MOTIR-1921) and the meter (MOTIR-1924) see `ContainerHandle` and
//   > `ContainerUsage` only.
//
// ⚠️ ASSERTED, NOT LEFT TO CONVENTION — which is the card's acceptance criterion
// ("asserted by an import/dependency guard, not by convention") and the only
// thing that makes §3's reversibility claim worth anything. A port whose
// boundary is a comment erodes the first time someone needs one more field, and
// the erosion is invisible until the day a second adapter is actually needed —
// by which point "swap the adapter" has quietly become "re-plan the fleet".
//
// It scans SOURCE rather than a module graph on purpose: a graph tells you what
// is imported, and half the ways Fly can leak (a hardcoded API host, an env var,
// a `state === 'started'` string) are not imports at all.

/**
 * Where Fly may be named. Everything else in `lib/` must not know it exists.
 *
 * ⚠️ TWO directories since MOTIR-4210, and the second is a DIFFERENT PORT rather
 * than a widening of this one. `lib/publicAddresses/adapters/fly/` speaks to
 * Fly's CERTIFICATES resource on the `motir-marketing` app, with its own token
 * (`FLY_CERTS_TOKEN`), for the customer-domain lifecycle — it boots no
 * container, meters nothing, and imports nothing from `lib/orchestrator/`.
 *
 * It is listed here rather than exempted per-file because this guard's REACH is
 * deliberately all of `lib/` (a boundary narrowed to the directory it protects
 * is one you evade by moving a file), so a second legitimate adapter has to be
 * named somewhere. Its own boundary — that the certificate port's callers never
 * name Fly — is asserted by `tests/publicAddresses/certificatePortBoundary.test.ts`,
 * which is the same rule one port over. Neither guard covers the other, and
 * that is why there are two.
 */
const ADAPTER_DIRS = [
  join('packages', 'orchestrator', 'src', 'adapters', 'fly'),
  join('lib', 'publicAddresses', 'adapters', 'fly'),
  // ⚠️ A THIRD PORT, NOT A WIDENING OF EITHER (MOTIR-7332). The DEPLOYMENT-STATUS
  // port's adapter reads motir-core's OWN machines for the operator console's
  // Hosting card, with its own read-only token (`FLY_DEPLOYMENT_READ_TOKEN`), and
  // that token is read only there. It boots nothing and imports nothing from
  // `lib/orchestrator/`; its callers see `DeploymentStatus` only.
  join('lib', 'deployment', 'adapters', 'fly'),
];

/**
 * The COMPOSITION ROOT — the one file outside the adapter that must name it.
 *
 * `getOrchestrator()` chooses between adapters, so it imports them; a selector
 * that cannot name what it selects is not a selector. Exempting it is not a
 * weakening of the rule, it is where the rule POINTS: §4's claim is that
 * swapping Fly for §3's migration target is "a new file under `adapters/` plus
 * one branch here", and that claim is only true if here is exactly one place.
 * The guard therefore proves the leak set is {adapter, selector} — nothing else.
 */
const COMPOSITION_ROOT = join('lib', 'orchestrator', 'index.ts');
/**
 * The HOSTING deploy port's half of the same composition root (MOTIR-9805). It
 * was split out of `index.ts` only because that file loads the database and the
 * operator deploy check runs from a laptop with a Fly token and nothing else;
 * `index.ts` re-exports it, so it is still "one branch here", in a file of its
 * own. It is registered by name like `index.ts`, never by directory.
 */
const HOSTING_COMPOSITION_ROOT = join('lib', 'orchestrator', 'hosting.ts');
const COMPOSITION_ROOTS = [COMPOSITION_ROOT, HOSTING_COMPOSITION_ROOT];
// ⚠️ IT IS STILL THIS FILE AFTER THE EXTRACTION (MOTIR-4299), and that is the
// point rather than an accident: the port moved to `@motir/orchestrator` and the
// SELECTOR did not, because choosing an adapter reads this deployment's
// environment. `docs/decisions/app-shell-over-packages.md` §1 keeps composition
// in the app for exactly that reason, so §4's "a new file under `adapters/` plus
// one branch here" still names one file, and it is still this one.

/**
 * Roots that must stay provider-agnostic.
 *
 * ⚠️ `packages/orchestrator/src` JOINED THIS LIST WHEN THE PORT LEFT `lib/`
 * (MOTIR-4299), and adding it is the whole reason the move did not silently
 * retire this guard. The adapter is now under `packages/`, so a scan of
 * `lib` + `app` + `components` alone would have gone green by having nothing
 * left to look at — the loudest possible way for a boundary guard to stop
 * meaning anything. The leak set it proves is still {adapter, selector, the
 * package's own barrel}, and the barrel is registered below rather than
 * exempted by path.
 */
const SCANNED_ROOTS = ['lib', 'app', 'components', join('packages', 'orchestrator', 'src')];

/**
 * The tells, each one a way Fly leaks that is NOT an import statement.
 *
 * Deliberately narrow — `/fly/i` alone would match `flyout`, `butterfly` and
 * `overflying`, and a guard that cries wolf gets deleted. These match things
 * only the adapter can legitimately say.
 */
const FLY_TELLS: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /adapters\/fly/, what: 'an import from the Fly adapter directory' },
  { pattern: /api\.machines\.dev/, what: "Fly's Machines API host" },
  { pattern: /\bFLY_[A-Z_]+\b/, what: 'a FLY_* environment variable' },
  { pattern: /\bfly(Machines|Orchestrator|FleetConfig|Machine)\b/, what: 'a Fly-named symbol' },
  { pattern: /\bFlyMachine\b/, what: 'the FlyMachine type' },
  { pattern: /\bauto_destroy\b/, what: "Fly's machine-config key" },
  { pattern: /\bcpu_kind\b/, what: "Fly's guest-config key" },
  // The HOSTING deploy port's Fly lane (MOTIR-5773) has its own token and org
  // variables; like `FLY_*`, only its adapter and the composition root read them.
  { pattern: /\bMOTIR_HOSTING_FLY_[A-Z_]+\b/, what: "the hosting lane's Fly variable" },
  // …and its adapter's own names (MOTIR-9806): the factory, its config and the
  // app provisioning it reuses. Only the hosting composition root may say them.
  {
    pattern:
      /\b(createFlyHostingDeployPort|flyHostingConfig|FlyHostingConfig|flyAppProvisioning)\b/,
    what: 'a Fly hosting adapter symbol',
  },
];

/**
 * The THREE sanctioned exceptions, worth naming rather than hiding.
 *
 * Each is scoped to ONE file AND ONE tell, so the exemption covers the line it
 * was argued for and nothing else: a second kind of leak in an excused file
 * still fails. That is the property that keeps this list from becoming the place
 * violations go to be forgotten.
 *
 * 1. `ciRunnerBootService` reads the fleet's IMAGE and REGION through
 *    `flyFleetConfig()` to fill a provider-neutral `ContainerSpec`. Those two
 *    values are deployment configuration that has to come from somewhere, and
 *    today the only deployment is Fly's. It is a leak of the CONFIG accessor,
 *    not of a Fly type: no `FlyMachine`, no machine id, no API call. When a
 *    second adapter lands, the fix is a `defaultSpecDefaults()` on the port —
 *    which is a five-line change precisely because this is the only place to
 *    change.
 *
 * 2. `lib/deployment/identity.ts` answers "where is THIS PROCESS running?" for
 *    the operator console's hosting card (MOTIR-1167), whose acceptance
 *    criterion is a link-out to the app's own dashboard — and a link nobody can
 *    construct is not a link.
 *
 *    ⚠️ IT IS A DIFFERENT KIND OF EXCEPTION FROM THE FIRST, and the difference
 *    is the reason it is admitted rather than refused. This rule's SUBJECT is
 *    the CI-runner orchestrator PORT — that a second container provider is "a
 *    new file under `adapters/` plus one branch in the selector". That file is
 *    not part of that port: it boots no container, tears none down, meters
 *    nothing, and imports nothing from `lib/orchestrator/`. It is about the WEB
 *    PROCESS, which the fleet has no opinion about.
 *
 *    The rule's REACH is nevertheless all of `lib/`, deliberately and correctly
 *    — a boundary guard narrowed to the directory it protects is one you evade
 *    by moving a file. So the answer is a REGISTERED exception in the shape the
 *    first one takes: one file, one narrow tell naming the four variables it
 *    was argued for (the fourth, `FLY_PROCESS_GROUP`, for the monitoring
 *    `instance.*` tags of MOTIR-8549, which read the host through this file), and the provider knowledge concentrated where a second
 *    deployment target is one more branch.
 *
 *    The tell deliberately does NOT match `FLY_*` in general. A future
 *    `FLY_API_TOKEN` read in that file — the thing that would turn a passive
 *    identity accessor into a Fly API client — fails this guard, which is the
 *    whole point of scoping an exemption to a pattern instead of to a path.
 *
 * 3. `lib/publicAddresses/providers.ts` is the CERTIFICATE port's composition
 *    root (MOTIR-4216) — the selector between `adapters/fly/` and the E2E fake,
 *    which is to that port exactly what `lib/orchestrator/index.ts` is to this
 *    one. It is registered here rather than as a second `COMPOSITION_ROOT`
 *    because it is not THIS port's selector: it boots no container and imports
 *    nothing from `lib/orchestrator/`, so it earns one narrow tell — the
 *    certificate adapter's path — and nothing wider. A fleet import or a
 *    `FLY_*` read in that file still fails here. Its own guard,
 *    `tests/publicAddresses/certificatePortBoundary.test.ts`, is where it is
 *    argued for as a selector; this entry only stops the two guards from
 *    contradicting each other on the one file both must name.
 */
const ALLOWED: ReadonlyArray<{ file: string; tell: RegExp; why: string }> = [
  {
    file: join('lib', 'deployment', 'identity.ts'),
    tell: /\bFLY_(APP_NAME|REGION|MACHINE_ID|PROCESS_GROUP)\b/,
    why: "answers where the WEB PROCESS runs, for the console's hosting card — not the fleet's port",
  },
  {
    file: join('lib', 'publicAddresses', 'providers.ts'),
    tell: /publicAddresses\/adapters\/fly/,
    why: "the CERTIFICATE port's composition root — it selects that adapter, not the fleet's",
  },
  {
    // The daily health check's credential registry (MOTIR-1933) DECLARES the
    // read token by name so its expiry is watched (MOTIR-7332). It reads the
    // variable's presence through the probe, never its value, and calls no API.
    file: join('lib', 'health', 'credentialRegistry.ts'),
    tell: /\bFLY_DEPLOYMENT_READ_TOKEN\b/,
    why: "declares the deployment read token's expiry for the daily health check — a name, not a client",
  },
  {
    file: join('lib', 'deployment', 'providers.ts'),
    tell: /deployment\/adapters\/fly/,
    why: "the DEPLOYMENT-STATUS port's composition root — it selects that adapter, not the fleet's (MOTIR-7332)",
  },
  {
    file: join('packages', 'orchestrator', 'src', 'index.ts'),
    tell: /adapters\/fly/,
    why: "the package's BARREL — it re-exports the adapter the app's composition root selects, and a package whose surface cannot name what it exports has no surface (MOTIR-4299)",
  },
];

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
    } else if (/\.tsx?$/.test(full)) {
      files.push(full);
    }
  }
  return files;
}

/** Strip line comments and block comments — a comment EXPLAINING the boundary
 *  (this file is full of them, and so are the adapters' headers) is not a
 *  violation of it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const root = process.cwd();

function violations(): Array<{ file: string; what: string; line: string }> {
  const found: Array<{ file: string; what: string; line: string }> = [];
  for (const scanRoot of SCANNED_ROOTS) {
    for (const file of walk(join(root, scanRoot))) {
      const rel = relative(root, file);
      // The adapter itself is where Fly lives; the selector is where it is
      // chosen. Those two, and nothing else.
      if (ADAPTER_DIRS.some((dir) => rel.startsWith(dir + sep))) continue;
      if (COMPOSITION_ROOTS.includes(rel)) continue;
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const { pattern, what } of FLY_TELLS) {
        for (const line of source.split('\n')) {
          if (!pattern.test(line)) continue;
          const excused = ALLOWED.some((a) => a.file === rel && a.tell.test(line));
          if (excused) continue;
          found.push({ file: rel, what, line: line.trim().slice(0, 120) });
        }
      }
    }
  }
  return found;
}

describe('§4 rule 1 — no `fly` escapes the adapter directory', () => {
  it('nothing in lib/, app/ or components/ names Fly outside the adapter', () => {
    const found = violations();
    // The failure message IS the value: it names the file, the line and WHICH
    // tell fired, so a violation is fixed rather than merely reported.
    expect(found, found.map((v) => `${v.file}: ${v.what}\n    ${v.line}`).join('\n')).toEqual([]);
  });

  it('the guard actually detects a leak (mutation check)', () => {
    // ⚠️ A guard nobody has watched FAIL is a guard that may be matching nothing.
    // This proves the tells fire on the strings they exist to catch, so a green
    // run above means "no leak" rather than "no scan".
    const leaks = [
      // A DEEP import past the package's barrel into its Fly adapter — the shape
      // this leak takes now that the adapter lives in `packages/orchestrator`
      // (MOTIR-4299). It is also an import-direction violation, which
      // `tests/packages/importDirection.test.ts` catches from the other side.
      "import { flyMachinesClient } from '@motir/orchestrator/src/adapters/fly/flyMachines';",
      "const url = 'https://api.machines.dev/v1/apps';",
      "const token = process.env['FLY_FLEET_API_TOKEN'];",
      'const m: FlyMachine = await read();',
      'config.auto_destroy = true;',
    ];
    for (const leak of leaks) {
      expect(
        FLY_TELLS.some(({ pattern }) => pattern.test(leak)),
        leak,
      ).toBe(true);
    }
  });

  it('does not fire on innocent words that merely contain "fly"', () => {
    // The guard is narrow on purpose: one that cries wolf gets deleted, and a
    // deleted guard is worse than none because the boundary still reads enforced.
    const innocent = [
      'const butterfly = true;',
      "className='overflow-x-auto'",
      '// the machine will fly through the queue',
      'const flyoutOpen = useState(false);',
    ];
    for (const line of innocent) {
      const stripped = stripComments(line);
      expect(
        FLY_TELLS.some(({ pattern }) => pattern.test(stripped)),
        line,
      ).toBe(false);
    }
  });

  it('the composition root is the ONLY non-adapter file that names Fly', () => {
    // §4's reversibility claim in one assertion: "a new file under `adapters/`
    // plus one branch here". If a second file ever needs to know, this fails and
    // the claim needs re-stating rather than quietly becoming untrue.
    const namingFly = new Set(violations().map((v) => v.file));
    expect([...namingFly]).toEqual([]);
    const selector = stripComments(readFileSync(join(root, COMPOSITION_ROOT), 'utf8'));
    expect(selector).toMatch(/flyOrchestrator/);
    const hosting = stripComments(readFileSync(join(root, HOSTING_COMPOSITION_ROOT), 'utf8'));
    expect(hosting).toMatch(/createFlyHostingDeployPort/);
  });

  it('every sanctioned exception still points at a real file and a live tell', () => {
    // An allow-list entry that no longer matches anything is a hole nobody
    // notices — it silently excuses whatever moves into that file next.
    for (const allowed of ALLOWED) {
      const source = stripComments(readFileSync(join(root, allowed.file), 'utf8'));
      expect(allowed.tell.test(source), `${allowed.file} no longer contains ${allowed.tell}`).toBe(
        true,
      );
    }
  });
});

describe('the HOSTING deploy port is inside the same boundary (MOTIR-5773)', () => {
  const HOSTING_PORT = join('packages', 'orchestrator', 'src', 'hosting');

  it('scans the port directory, and finds no Fly name in it', () => {
    const files = walk(join(root, HOSTING_PORT)).map((f) => relative(root, f));
    expect(files.length).toBeGreaterThan(0);
    expect(SCANNED_ROOTS.some((r) => HOSTING_PORT.startsWith(r + sep))).toBe(true);
    expect(violations().filter((v) => v.file.startsWith(HOSTING_PORT + sep))).toEqual([]);
  });

  it('would fail on a Fly leak in the port (mutation check)', () => {
    const leaks = [
      "import { createFlyHostingDeployPort } from '../adapters/fly/hosting';",
      "const token = process.env['MOTIR_HOSTING_FLY_API_TOKEN'];",
      "const base = 'https://api.machines.dev/v1/apps/mh-x/deploy_token';",
      "const guest = { cpu_kind: 'shared' };",
      'const port = createFlyHostingDeployPort(flyHostingConfig());',
      'const config: FlyHostingConfig = { ...base };',
      'await flyAppProvisioning.ensureApp(config, app);',
    ];
    for (const leak of leaks) {
      expect(
        FLY_TELLS.some(({ pattern }) => pattern.test(stripComments(leak))),
        leak,
      ).toBe(true);
    }
  });
  /** An import (or re-export) whose source path passes through an adapter directory. */
  const ADAPTER_IMPORT = /\bfrom\s+['"][^'"]*\badapters\//;

  it('the port’s own modules import nothing from any adapters/ directory', () => {
    const files = walk(join(root, HOSTING_PORT));
    expect(files.map((f) => relative(root, f))).toContain(join(HOSTING_PORT, 'types.ts'));
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf8'));
      expect(ADAPTER_IMPORT.test(source), relative(root, file)).toBe(false);
    }
  });

  it('would fail on an adapter import in the port (mutation check)', () => {
    for (const leak of [
      "import type { FakeHostedApp } from '../adapters/fake/hosting';",
      "export { releaseStateOf } from '../adapters/fly/hosting';",
    ]) {
      expect(ADAPTER_IMPORT.test(leak), leak).toBe(true);
    }
    expect(ADAPTER_IMPORT.test("import { hostingAppNames } from './names';")).toBe(false);
  });

  it('the operator deploy check reaches the target through the accessor alone (MOTIR-9805)', () => {
    // `scripts/` is not a scanned root (other operator scripts read FLY_* by
    // design), so the check's two files are named here.
    for (const file of [
      join('scripts', 'hosting-deploy-check.ts'),
      join('lib', 'hosting', 'deployCheck.ts'),
    ]) {
      const source = stripComments(readFileSync(join(root, file), 'utf8'));
      for (const { pattern, what } of FLY_TELLS) {
        expect(pattern.test(source), `${file}: ${what}`).toBe(false);
      }
      expect(/@aws-sdk\//.test(source), `${file}: an AWS SDK import`).toBe(false);
    }
  });
});
