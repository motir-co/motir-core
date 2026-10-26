import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DOCS_REDIRECTS,
  LANDING_REDIRECTS,
  REQUESTED_FEATURES_REDIRECTS,
  SETTINGS_REDIRECTS,
} from '../next.config';

// MOTIR-2316 — a design asset is a REFERRER to the app's addresses, and it is
// the only referrer no other check can see.
//
// ── The defect this guards ──────────────────────────────────────────────────
// ADR `public-api-conventions.md` Amendment 9 Q1 renamed `/api-docs*` to
// `/docs*`, and it enumerated its own cost by grep rather than estimating it:
// the route directory, four in-product link sites, three ADR self-references,
// `lib/apiDocs/guide.ts`, ~14 vitest assertions across four files, eight URL
// waits in the E2E spec, the redirect map. Every one of those was updated.
// `design/api-docs/` was not on the list, and stayed two generations stale
// (Amendment 11 then moved the same pages again, to `/docs/api*`) until the
// next card to trust it as the layout source of truth noticed.
//
// Nothing failed, and nothing could have: a design asset is Markdown and HTML
// that no build resolves and no test opens, so its addresses live only in prose
// and in `href`s. A referrer sweep finds callers by grepping for the OLD name,
// which is precisely the string an asset still contains — the sweep's own
// method is what hides it.
//
// ── Why a test, and not the other two options ───────────────────────────────
// The card weighed three fixes:
//
//   1. THIS ONE — grep `design/**` for addresses that no longer resolve,
//      sourcing "what resolves" from the `app/**` route tree plus
//      `next.config.ts`'s `DOCS_REDIRECTS`.
//   2. A checklist line in the migration-card template. REJECTED: it is the
//      option that already failed. Amendment 9's cost table WAS the checklist,
//      written with more care than a template would get, and the asset still
//      was not on it.
//   3. Widening `plan-rules.md`'s migration limb so a referrer sweep names
//      `design/<area>/` alongside its call sites. REJECTED as the primary fix:
//      a rule has two homes (`plan-rules.md` and motir-ai's
//      `SHARED_PLANNING_RULES`), so it is a two-repo deliverable, and it still
//      depends on a human remembering to apply it at the moment of the rename.
//      `plan-rules.md`'s THIRD TIER prefers the mechanised check wherever the
//      check needs no judgement, and this one does not: an address either
//      resolves or it does not.
//
// ── What "no judgement" costs, and where the judgement went ─────────────────
// One place, deliberately: `KNOWN` below. A design asset is often drawn BEFORE
// the surface exists, so "this address resolves to nothing" is a legitimate
// state for a forward-looking asset — and assets also quote addresses in prose
// that are not links at all (a counterfactual the design rejected, a container
// filesystem path, a historical note about the very rename this guards). Each
// such pair is listed once, with a reason, by a human. The table is asserted
// TIGHT in both directions: an unlisted finding fails, and a listed entry that
// no longer fires fails too, so the list cannot rot into a mute button.

const ROOT = process.cwd();

// ── The address inventory: what the app actually serves ─────────────────────

// Next's routable special files, in the two shapes they take. A directory
// holding a PAGE file serves the directory's own path; everything else under
// `app/` (`_components`, `layout.tsx`, `loading.tsx`) serves nothing.
const PAGE_FILES = new Set(['page.tsx', 'page.ts', 'route.ts', 'route.tsx']);
// A metadata file serves the directory's path plus its OWN name — `explore/`
// with an `opengraph-image.tsx` serves `/explore/opengraph-image`.
const METADATA_FILES = new Set([
  'opengraph-image.tsx',
  'twitter-image.tsx',
  'icon.tsx',
  'apple-icon.tsx',
  'sitemap.ts',
  'robots.ts',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** Every address `app/**` serves, as a segment pattern (`['items', '[key]']`). */
function appRoutePatterns(): string[][] {
  const seen = new Set<string>();
  for (const file of walk(join(ROOT, 'app'))) {
    const rel = relative(join(ROOT, 'app'), file).split(sep).join('/');
    const parts = rel.split('/');
    const leaf = parts.pop();
    if (!leaf) continue;
    if (METADATA_FILES.has(leaf)) parts.push(leaf.replace(/\.[a-z]+$/, ''));
    else if (!PAGE_FILES.has(leaf)) continue;
    // Route groups — `(authed)`, `(public)` — organise the tree without
    // appearing in the URL. Parallel/intercepting segments (`@slot`, `(.)x`)
    // are not used in this app.
    seen.add(parts.filter((segment) => !/^\(.*\)$/.test(segment)).join('/'));
  }
  return [...seen].map((path) => (path === '' ? [] : path.split('/')));
}

const APP_ROUTES = appRoutePatterns();
// EVERY redirect map `next.config.ts` composes into `redirects()`, not just the
// docs one — a redirect source is an address the app answers on, whichever map
// declares it, and a map this list forgets makes the guard report a live
// address as resolving to nothing. (MOTIR-2534 added the second map.)
// (MOTIR-4782 added the third, `/home` → `/workbench`; MOTIR-6772 the fourth,
// which MOTIR-7043 reversed to `/requested-features` → `/triage`.)
const REDIRECT_SOURCES = [
  ...DOCS_REDIRECTS,
  ...SETTINGS_REDIRECTS,
  ...LANDING_REDIRECTS,
  ...REQUESTED_FEATURES_REDIRECTS,
].map((rule) => rule.source.replace(/^\//, '').split('/'));

const isDynamic = (segment: string) => /^\[.+\]$/.test(segment) || /^:.+/.test(segment);
const isCatchAll = (segment: string) => /^\[\.\.\..+\]$/.test(segment) || /^:.+\*$/.test(segment);

/**
 * Does `candidate` (an address written in an asset, already split into
 * segments) match `pattern` (a route or redirect source)?
 *
 * A dynamic segment on EITHER side matches: the app writes `[key]` and an
 * asset may write either the placeholder (`/items/[key]`) or a concrete
 * example (`/items/MOTIR-2285`), and both address the same page.
 */
function matchesPattern(pattern: string[], candidate: string[]): boolean {
  let p = 0;
  while (p < pattern.length) {
    const segment = pattern[p]!;
    if (isCatchAll(segment)) return candidate.length > p;
    if (p >= candidate.length) return false;
    if (!isDynamic(segment) && !isDynamic(candidate[p]!) && segment !== candidate[p]) return false;
    p += 1;
  }
  return candidate.length === pattern.length;
}

// ── Reading addresses out of an asset ───────────────────────────────────────

// The four syntaxes an asset writes an address in. Restricting to these is
// what keeps the sweep quiet: bare slashes in prose are overwhelmingly
// alternatives ("green/mint", "a `Card`/`Pill`"), not addresses.
const ADDRESS_SYNTAXES = [
  /(?:href|action|src)=["'](\/[^"'\s]*)/g, // a link in a .mock.html
  /\]\((\/[^)\s]*)/g, //                      a Markdown link in design-notes.md
  /`(\/[^`\s]*)`/g, //                        an address quoted in prose
  /"(\/[a-z0-9][^"\s]*)"/g, //                a JSON string value in a .pen source
];

interface RawAddress {
  raw: string;
  line: number;
}

/** Every address-shaped string in one asset's source, with its line number. */
function addressesIn(source: string): RawAddress[] {
  const found: RawAddress[] = [];
  for (const syntax of ADDRESS_SYNTAXES) {
    for (const match of source.matchAll(syntax)) {
      const line = source.slice(0, match.index).split('\n').length;
      found.push({ raw: match[1]!, line });
    }
  }
  return found;
}

/**
 * Reduce a raw match to the in-product page address it names, or `null` when
 * it is not one. Three exclusions, each mechanical:
 */
function toPageAddress(raw: string): string | null {
  // (1) A placeholder or a regex literal — `/plans/{id}`, `/items/<key>`,
  //     `/https?:\/\/[^\s)]+/`. Tested BEFORE the query strip, so a `?` inside
  //     a regex cannot truncate it into something that looks like an address.
  if (/[<>{}…\\^$|]/.test(raw)) return null;

  let address = raw.split('?')[0]!.split('#')[0]!;
  // A prose glob. With a slash before the star — `/settings/*` — it names a
  // page UNDER the path, so the star becomes a dynamic segment (`[*]`, which
  // `isDynamic` matches): `/settings/*` resolves when any child page exists,
  // whether or not `/settings` itself does (MOTIR-5447). Without the slash —
  // `/docs*`, `/settings/project*` — it names the family by prefix, so check
  // the prefix.
  address = address.replace(/\/\*+$/, '/[*]').replace(/\*+$/, '');
  if (address.length > 1) address = address.replace(/\/+$/, '');
  if (address === '') return null;

  // (2) A file, not a route: `/favicon.ico`, `/api/openapi/v1.json`.
  if (/\.[a-z0-9]+$/i.test(address.split('/').pop()!)) return null;
  // (3) An HTTP endpoint rather than a page. `/api/*` is this app's but is not
  //     in the page tree, and `/v1/*` is motir-ai's — a different service whose
  //     routes this repo cannot inventory.
  if (/^\/(api|v1)(\/|$)/.test(address)) return null;

  return address;
}

type Verdict = 'redirects-away' | 'resolves-to-nothing';

function classify(address: string): Verdict | null {
  const segments = address === '/' ? [] : address.replace(/^\//, '').split('/');
  const serves = APP_ROUTES.some((pattern) => matchesPattern(pattern, segments));
  // A glob (`/settings/workspace/[*]`) claims only that SOME page under the
  // path serves, so one live member is enough — even where a sibling member
  // (`/settings/workspace/github`) is a redirect source (MOTIR-5447).
  if (segments.includes('[*]') && serves) return null;
  // Otherwise a redirect source is checked FIRST: the address resolves, but
  // only by 308ing somewhere else, which is exactly the drift this guards.
  if (REDIRECT_SOURCES.some((pattern) => matchesPattern(pattern, segments)))
    return 'redirects-away';
  if (serves) return null;
  return 'resolves-to-nothing';
}

interface Finding {
  file: string;
  address: string;
  verdict: Verdict;
  line: number;
}

function sweep(): Finding[] {
  const assets = walk(join(ROOT, 'design')).filter((path) => /\.(md|html|pen)$/.test(path));
  const findings = new Map<string, Finding>();
  for (const path of assets) {
    const file = relative(ROOT, path).split(sep).join('/');
    for (const { raw, line } of addressesIn(readFileSync(path, 'utf8'))) {
      const address = toPageAddress(raw);
      if (address === null) continue;
      const verdict = classify(address);
      if (verdict === null) continue;
      const id = `${file} ${address}`;
      // First occurrence wins, so the reported line is the one to open.
      if (!findings.has(id)) findings.set(id, { file, address, verdict, line });
    }
  }
  return [...findings.values()].sort((a, b) =>
    `${a.file} ${a.address}`.localeCompare(`${b.file} ${b.address}`),
  );
}

// ── The judgement, in one table ─────────────────────────────────────────────
//
// Every (asset, address) pair the sweep finds today, with why it is allowed to
// stay. Adding a row is a deliberate act with a written reason; the tightness
// test below deletes the row for you the moment it stops applying.
//
// Genuinely-stale addresses are NOT silenced here on the merits. This guard's
// first run found 17 of them; they were parked as STALE rows naming MOTIR-2340
// (per MOTIR-2316's scope boundary — running the guard IS the audit, and what
// it finds is its own card), and MOTIR-2340 then corrected the assets and
// deleted the rows. A stale address belongs in a fix, never in this table.
const KNOWN: { file: string; address: string; why: string }[] = [
  // ── ✅ RETIRED 2026-09-11 (MOTIR-5170, under Bug MOTIR-4925) ──────────────
  //  Three FORWARD-LOOKING rows stood here for `/settings/project/approvals` —
  //  MOTIR-4942's design named the room's address in `design/projects/`,
  //  `design/work-items/acceptance-panel.mock.html` (panel G4) and its notes,
  //  before MOTIR-4925 built the route. They said of themselves that they would
  //  DELETE THEMSELVES when `app/(authed)/settings/project/approvals/page.tsx`
  //  landed, and that is exactly what happened: the page shipped with MOTIR-5170
  //  and the `carries no KNOWN entry that has stopped applying` arm below went
  //  red on all three, in the CI of the very pull request that added the page.
  //  The mechanism worked as designed — an exemption that stops applying becomes
  //  a failing test rather than a silent row nobody re-reads — so this note is
  //  kept only as the evidence that it fired once, and is itself deletable.
  //  It fired a second time for the Approval records room: MOTIR-5300 drew
  //  `/approvals` before MOTIR-5302 built the page, and that card removed the row.
  //  And a third time for the Planning lessons console: MOTIR-1409 drew
  //  `/admin/planning-lessons` before MOTIR-1411 built it, and that card removed the rows.
  // ── An address named as HISTORY, by the asset that retires it ─────────────
  // `design/code-context/design-notes.md` (MOTIR-1764) documents a collapse:
  // Code health, the code index and Git were three things in two rail sections
  // with opposite gating, and they become one `Code` row. Its "where it was"
  // table and its §3 argument name `/settings/workspace/github` because that is
  // the address the collapse REMOVES — MOTIR-4669 moved the surface to
  // `/settings/organization/git`.
  //
  // ⚠️ Correcting the asset to the live address would DESTROY its meaning: the
  // table's whole content is where these rows used to be, and rewriting the row
  // to point at the new home would make it claim the collapse never happened.
  // The guard's premise — "an address it names will be believed by the next
  // card that reads it" — does not hold for prose that is explicitly about the
  // past, and this is the sanctioned door for that case.
  {
    file: 'design/code-context/design-notes.md',
    address: '/settings/workspace/github',
    why: 'Named as the PRE-collapse address, in a table of where things used to be and in the §3 argument for removing the row. MOTIR-4669 retired it in favour of `/settings/organization/git`. Pointing the prose at the live address would make the asset claim the collapse it documents never happened.',
  },
  // ── A console REMOVED with its feature (MOTIR-9386, story MOTIR-9385) ─────
  //  Motir has no Enterprise plan, so the Contact-sales Enterprise-requests
  //  console and its routes were deleted. The assets that drew it (MOTIR-7602)
  //  stay as the record of what was built; there is no live surface to point
  //  them at, and redrawing a deleted console would invent one.
  {
    file: 'design/platform-admin/console--enterprise-requests.mock.html',
    address: '/admin/enterprise-requests',
    why: 'The mock of the Enterprise-requests console, deleted with the feature by MOTIR-9386 (Motir has no Enterprise plan). Kept as the record of the surface MOTIR-7602 built; no live address replaces it.',
  },
  {
    file: 'design/platform-admin/design-notes.md',
    address: '/admin/enterprise-requests',
    why: 'The notes section that specified the Enterprise-requests console, deleted with the feature by MOTIR-9386. A record of the removed surface; no live address replaces it.',
  },
  {
    file: 'design/platform-admin/design-notes.md',
    address: '/admin/enterprise-requests/[id]',
    why: 'The detail page of the same removed console, named in the same notes section. Deleted by MOTIR-9386; no live address replaces it.',
  },
  // ── The RETIRED landing, which the app still answers on ──────────────────
  //  MOTIR-4782 moved the signed-in landing from `/home` to `/workbench` and
  //  kept the old address alive as a permanent 308 (`LANDING_REDIRECTS`), so
  //  `/home` classifies as `redirects-away` rather than `resolves-to-nothing`.
  //
  //  ⚠️ THE TEN SHELL / AUTH / PROJECTS / SETTINGS ASSETS THAT NAMED IT ARE
  //  CORRECTED, NOT PARKED (MOTIR-4783). They were parked here for exactly one
  //  card — the sweep that owns the design assets' address lines — and that card
  //  discharged them: nine mock sources had `href="/home"` re-pointed, thirteen
  //  visible rail labels now read `Workbench`, four prose lines in the auth and
  //  ai-chat assets name the new address, and seven PNGs were re-exported for
  //  the ones where the change is visible. What is left below is the pair that
  //  names the old address ON PURPOSE.
  //
  //  The two Workbench assets name `/home` DELIBERATELY and permanently — the
  //  asset's job is to record what the surface was renamed FROM, the same way
  //  the `KNOWN_PATHS` rename rows below record the old `design/home/` path. A
  //  reader arriving from an old citation has to be able to tell "this moved"
  //  from "this is gone".
  {
    file: 'design/workbench/design-notes.md',
    address: '/home',
    why: 'The rename record — the address the surface moved FROM, and the 308 that keeps it landing. Permanent.',
  },
  {
    file: 'design/workbench/workbench.mock.html',
    address: '/home',
    why: "The mock's header carries the same rename record as the notes, for a reader who opens the asset rather than the spec. Permanent.",
  },
  // (MOTIR-6772 moved the members' inbox to `/requested-features` and carried
  // three KNOWN rows for the assets that drew `/triage`; MOTIR-7043 moved it back,
  // so those assets name a served address again and the rows are gone.)
  // ── A route on a DIFFERENT host, kept in the unified chrome's nav ─────────
  // `design/public-site/` (MOTIR-3880) draws the ONE chrome every motir.co
  // surface wears, and the shipped `Design` showcase nav item resolves on
  // motir.co — it is a motir-marketing route (MOTIR-3861), not one this repo's
  // `app/**` tree serves. The chrome keeps the item as shipped; the address is
  // real on the brand host and absent here, so this repo's route inventory
  // cannot resolve it. Permanent rather than forward-looking: the route already
  // ships, in the other repository.
  {
    file: 'design/public-site/public-site.mock.html',
    address: '/design',
    why: 'The `Design` showcase nav item, a motir-marketing route (MOTIR-3861) that does not live in motir-core. The unified chrome keeps the shipped nav item; the address resolves on motir.co, not in this repo, so the route inventory cannot resolve it.',
  },
  {
    file: 'design/public-site/not-found.mock.html',
    address: '/design',
    why: "The same `Design` showcase nav item, in the same chrome — the not-found room is drawn INSIDE that bar (MOTIR-4245), so it carries the bar's three nav items verbatim. Permanent for the same reason as the row above: the route ships, in the other repository.",
  },
  // ── The AI-settings PROMISE links out to the provider table (MOTIR-3666) ──
  // `/legal/model-providers` is motir-marketing's, exactly as the `/legal/*`
  // rows below are: MOTIR-4103 moved `content/legal/` and `app/(public)/legal/`
  // out of this repository, so this repo's route inventory cannot resolve it.
  //
  // The link is the POINT of the amendment rather than decoration, which is why
  // it is a KNOWN row and not a correction. The Planner card states Motir's own
  // position and deliberately restates NO provider fact — no retention window,
  // no training answer, no provider names — so the link is the whole mechanism
  // by which a reader reaches the per-provider answers. Removing the address
  // would remove the mechanism.
  //
  // ⚠️ It is drawn as a bare `/legal/model-providers` in the asset. The
  // IMPLEMENTING card (MOTIR-3670) resolves it through motir-core's existing
  // public-site origin — MOTIR-3910 set one and MOTIR-3884's sweep names every
  // absolute-URL reader — rather than hard-coding a host in a component. The
  // mock draws the destination; the implementation owns how the href is built.
  {
    file: 'design/ai-settings/ai-planning-settings.mock.html',
    address: '/legal/model-providers',
    why: "The provider table the Planner card's data-practice promise links out to, so no provider fact is restated in the component. A motir.co route (MOTIR-4009); MOTIR-4103 removed `app/(public)/legal/` from this repository, so this repo's route inventory cannot resolve it.",
  },
  {
    file: 'design/ai-settings/design-notes.md',
    address: '/legal/model-providers',
    why: 'The same address, named in the notes that specify the link and its copy (§D3 / §D9). Resolves on the brand host; MOTIR-4103 removed the route from this one.',
  },
  // ── `/legal*` LEFT THIS HOST ENTIRELY (MOTIR-4103) ────────────────────────
  // Two different reasons wearing one address, and the split matters because
  // only one of them is history.
  //
  //  * `design/public-site/` draws MOTIR.CO. `/legal` and `/legal/*` are that
  //    host's own routes (MOTIR-4009) and the asset is CORRECT — this repo's
  //    `app/**` inventory simply cannot see another repository's route tree,
  //    exactly as it cannot see `/design` above. Permanent, and not a defect
  //    in either direction.
  //  * `design/auth/legal-agreement.mock.html` is a POINT-IN-TIME record. Its
  //    BEFORE panels draw the sign-up notice as it shipped, when `/legal/terms`
  //    was a page this application served — the asset says so in its own words
  //    ("Panel 2's links are same-origin: `/legal/terms` is a page this
  //    application serves"). Its AFTER panels already draw the absolute
  //    `https://motir.co/legal/*` links the manifest publishes (MOTIR-4010), so
  //    the asset is not stale; it is a drawing of the change, and a drawing of a
  //    change has to contain the old state. Correcting it would delete the half
  //    that makes the panel pair legible.
  {
    file: 'design/public-site/design-notes.md',
    address: '/legal',
    why: "A motir.co route (MOTIR-4009) in the asset that draws motir.co. MOTIR-4103 deleted `app/(public)/legal/` from this repository, so this repo's route inventory cannot resolve it — the address is real on the brand host, as `/design` above is.",
  },
  {
    file: 'design/public-site/design-notes.md',
    address: '/legal/privacy',
    why: 'The same: a document served by motir.co, named in the route table the asset draws for that host. Not an address motir-core serves any more (MOTIR-4103).',
  },
  {
    file: 'design/public-site/design-notes.md',
    address: '/legal/terms',
    why: 'The same: a document served by motir.co, named in the route table the asset draws for that host. Not an address motir-core serves any more (MOTIR-4103).',
  },
  {
    file: 'design/public-site/public-site.mock.html',
    address: '/legal',
    why: 'The mock beside those notes, drawing the same motir.co chrome and its footer legal rows. Resolves on the brand host; MOTIR-4103 removed the route from this one.',
  },
  {
    file: 'design/public-site/public-site.mock.html',
    address: '/legal/privacy',
    why: 'A footer link in the motir.co chrome the asset draws. Resolves on the brand host; MOTIR-4103 removed the route from this one.',
  },
  {
    file: 'design/public-site/public-site.mock.html',
    address: '/legal/terms',
    why: 'A footer link in the motir.co chrome the asset draws. Resolves on the brand host; MOTIR-4103 removed the route from this one.',
  },
  // The SAME three footer rows, in the not-found room (MOTIR-4245). It draws
  // the identical motir.co chrome around a 404, so it inherits the chrome's
  // Legal column verbatim — and the room's own argument leans on that column:
  // an unknown `/legal/<slug>` is one of the four arrivals, and the footer is
  // what answers it, which is why it earns no door of its own.
  {
    file: 'design/public-site/not-found.mock.html',
    address: '/legal',
    why: 'A footer link in the motir.co chrome the not-found room is drawn inside. Resolves on the brand host; MOTIR-4103 removed the route from this one.',
  },
  {
    file: 'design/public-site/not-found.mock.html',
    address: '/legal/privacy',
    why: 'A footer link in the motir.co chrome the not-found room is drawn inside. Resolves on the brand host; MOTIR-4103 removed the route from this one.',
  },
  {
    file: 'design/public-site/not-found.mock.html',
    address: '/legal/terms',
    why: 'A footer link in the motir.co chrome the not-found room is drawn inside. Resolves on the brand host; MOTIR-4103 removed the route from this one.',
  },
  {
    file: 'design/auth/legal-agreement.mock.html',
    address: '/legal/terms',
    why: "A point-in-time record: the BEFORE panels draw the sign-up notice as it shipped, when this application served `/legal/terms`. The asset's AFTER panels already draw the absolute `https://motir.co/legal/terms` the manifest publishes (MOTIR-4010), so the pair IS the design; deleting the old half would remove what the panels are contrasting.",
  },
  {
    file: 'design/auth/legal-agreement.mock.html',
    address: '/legal/privacy',
    why: 'The same panel pair, other document. The BEFORE half is the shipped state the design replaced; the AFTER half already carries the absolute motir.co link.',
  },
  // ── Prose that names an address without using it ──────────────────────────
  {
    file: 'design/agent-sandbox/design-notes.md',
    address: '/api-docs',
    why: 'A historical note ABOUT this very rename ("the `/api-docs` → `/docs` route move"), not an address the design uses.',
  },
  {
    file: 'design/api-docs/design-notes.md',
    address: '/api-docs',
    why: "The asset's own ⚠️ block recording that these addresses moved twice — the correction MOTIR-2316 was filed about, so it must name the old address.",
  },
  // ── An address a design asset RECORDED, which the app has since moved ──────
  // A DIFFERENT KIND of row from every other entry in this table, and the
  // difference is worth reading once. Every row above is prose that never was
  // an address — a historical note, a counterfactual, a filesystem path. These
  // two are addresses that were LIVE AND CORRECT on the day the asset was
  // drawn, and moved afterwards — and the asset is deliberately NOT corrected.
  //
  // A design asset is a RECORD OF THE MOMENT IT WAS DRAWN, not a spec that
  // tracks the product (Yue, 2026-08-10). MOTIR-2532 renamed the pane's
  // reader-facing address; MOTIR-2533, the card that would have swept these
  // assets, was archived unbuilt on that call. So these two keep saying
  // `/settings/account/api-tokens`, which now 308s to `/settings/account/tokens`
  // via `SETTINGS_REDIRECTS` — a reader following it still lands on the page.
  //
  // ⚠️ These rows carry NO "delete me in card X" instruction, and that is the
  // distinction to preserve. A FORWARD-LOOKING row — an asset drawn before its
  // route exists — is temporary and must name the card that removes it; the
  // `docs-index.mock.html` → `/docs` row was exactly that, and MOTIR-2523
  // deleted it on schedule when `/docs` became a real page. These two are the
  // opposite: the asset is finished history, so the row is permanent and there
  // is nothing to come back for.
  {
    file: 'design/cli-connect/cli-connect.mock.html',
    address: '/settings/account/api-tokens',
    why: 'A point-in-time record: the CLI-connect mock drew the tokens pane at this address, which was live when MOTIR-1866 drew it. MOTIR-2534 moved the route to `/settings/account/tokens` and left a permanent redirect, so the asset now names an address that redirects away — correctly, and permanently.',
  },
  {
    file: 'design/cli-connect/design-notes.md',
    address: '/settings/account/api-tokens',
    why: 'The same point-in-time record in the notes beside that mock — specifically its RENDERED-first section, which states which URL was screenshotted. Re-pointing it would falsify the record of what was actually rendered.',
  },
  {
    file: 'design/roadmap/design-notes.md',
    address: '/roadmap/sprint',
    why: 'A counterfactual the design REJECTED ("a query param on one route, not a distinct /roadmap/sprint path").',
  },
  {
    file: 'design/mcp-server/design-notes.md',
    address: '/API/MCP',
    why: 'Not an address: the line specifies how the header row RENDERS the route name, "`/api/mcp` as `/API/MCP`" — a typographic instruction about small-caps display. The lower-case /api/mcp it names does resolve.',
  },
  // ── Slash-prefixed paths that are not addresses ───────────────────────────
  {
    file: 'design/agent-sandbox/agent-sandbox.mock.html',
    address: '/workspace',
    why: 'The devcontainer `workspaceFolder` / bind-mount target in a quoted JSON config — a container filesystem path.',
  },
  {
    file: 'design/agent-sandbox/design-notes.md',
    address: '/workspace',
    why: 'The container working directory a `docker run` drops the reader into — the same filesystem path, in prose.',
  },
  {
    file: 'design/projects/design-notes.md',
    address: '/design/workspaces',
    why: 'The repo folder design/workspaces/, cited as a precedent for a two-state PNG export — a path in this repo, not an address.',
  },
  // ── Forward-looking: the asset is drawn before the surface exists ─────────
  // (`design/platform-admin/design-notes.md` cited `/admin` as forward-looking.
  //  MOTIR-2896 built the route group, so the row expired and is gone — the
  //  mechanism working exactly as its sibling comment below describes.)
  {
    file: 'design/roadmap/design-notes.md',
    address: '/projects/[key]/direction/[tier]',
    why: 'Forward-looking, and the asset says so inline ("NEW — no shipped route yet"). The tier doc shipped at /direction/[tier].',
  },
  {
    file: 'design/project-square/project-square.mock.html',
    address: '/explore/doooo/taq',
    why: 'Forward-looking: the per-project square page (/explore/<org>/<project>) is unbuilt; the shipped project page is /p/[identifier].',
  },
  {
    file: 'design/project-square/project-square.mock.html',
    address: '/explore/lumen-labs/aperture-sdk',
    why: 'Forward-looking: same unbuilt /explore/<org>/<project> page.',
  },
  {
    file: 'design/project-square/project-square.mock.html',
    address: '/explore/moooon/motir',
    why: 'Forward-looking: same unbuilt /explore/<org>/<project> page.',
  },
  {
    file: 'design/project-square/project-square.mock.html',
    address: '/explore/northwind/atlas-design-system',
    why: 'Forward-looking: same unbuilt /explore/<org>/<project> page.',
  },
  {
    file: 'design/project-square/project-square.mock.html',
    address: '/explore/seedling/grove-cms',
    why: 'Forward-looking: same unbuilt /explore/<org>/<project> page.',
  },
  {
    file: 'design/project-square/project-square.mock.html',
    address: '/explore/vantage/pulse-analytics',
    why: 'Forward-looking: same unbuilt /explore/<org>/<project> page.',
  },
  // ── Forward-looking: the MCP + CLI documentation assets — ALL CLEARED ────
  //    `design/mcp-server/` (#1906, MOTIR-2323) and `design/cli-guide/`
  //    (#1905, MOTIR-2326) both merged AFTER this guard, so neither could add
  //    its rows and this table could not name assets that did not yet exist.
  //    The three PRs were in flight together, so each was green against a base
  //    that did not contain the other, and their composition is what turned
  //    `main` red — the same shape as two fixes that each pass alone.
  //
  //    That shape then repeated one level up: MOTIR-2348 (#1913) and
  //    MOTIR-2370 (#1916) diagnosed the same red `main` in parallel and both
  //    merged, so this table carried TWO rows for each of the eight pairs until
  //    MOTIR-2372 deduped them. The uniqueness test further down is what stops
  //    that recurring; read it before adding a row.
  //
  //    Every one of those eight rows is now GONE, and each left the same way:
  //    the card that BUILDS the route deleted its own rows in the commit that
  //    added the route — `/docs/cli` by MOTIR-2308 (#1910), `/docs/mcp` and
  //    `/docs/mcp/tools` by MOTIR-2309 (#1911). `expired()` below is what made
  //    that the only way out: a row survives exactly as long as the gap it
  //    describes, so it cannot quietly outlive the thing it excuses.
  //
  //    (MOTIR-2316's first run also parked 17 STALE pairs here — 13 assets
  //    addressing `/issues*` and `/login`. MOTIR-2340 corrected every one of
  //    them in the assets, so those rows are gone too.)

  // ── Forward-looking: the RUN VIEW (Story MOTIR-1789 · MOTIR-3895) ─────────
  //    `design/runs/` (MOTIR-1795) draws two surfaces that LINK to a run's own
  //    page, and that page does not exist yet: `app/(authed)/` holds no `runs`
  //    segment at all. MOTIR-3895 builds `/runs/[id]` and — per the pattern
  //    above — is the card that deletes these rows in the commit that adds the
  //    route, which `expired()` below enforces.
  //
  //    The link is the whole point of both surfaces rather than decoration: a
  //    ready-row strip that named a run without reaching it, and a card that
  //    said "4 of 11" without letting the reader see the other ten, would each
  //    be drawing the half of the answer that is already on the page.
  {
    file: 'design/runs/design-notes.md',
    address: '/runs/[id]',
    why: 'Forward-looking: the run view MOTIR-3895 builds. Named in the surface table as the third surface of this area, whose asset is MOTIR-3893’s.',
  },
  // ── Forward-looking: the two run PAGES (MOTIR-3893's asset) ──────────────
  //    The design draws the surfaces; MOTIR-3895 builds `/runs/[id]` and
  //    MOTIR-3923 builds `/runs` and its rail row. Each of these four rows
  //    DELETES ITSELF when its route lands — the `carries no KNOWN entry that
  //    has stopped applying` check above is what turns a stale exemption into a
  //    red build rather than a quiet one.
  {
    file: 'design/runs/run-modal.mock.html',
    address: '/runs/[id]',
    why: 'The route this asset says does NOT exist — cited only to record the withdrawal ("There is no /runs/[id] — the deep link is /runs?run=<id>"). It is the one address here that must NEVER resolve, so this row is PERMANENT and carries no delete-me instruction: if `app/(authed)/runs/[id]/page.tsx` ever lands, the asset is wrong rather than the row.',
  },

  //    ⚠️ TWO ROWS FOR `design/runs/ready-strip.mock.html` STOOD HERE AND ARE
  //    GONE WITH THE ASSET (MOTIR-3914). The strip drew a live-run indicator on
  //    a `/ready` row; that row cannot occur, because `/ready` lists only `todo`
  //    leaves and claiming a card flips it to `in_progress` before the first
  //    agent starts. The `carries no KNOWN entry that has stopped applying`
  //    check above is what caught them the moment the file was deleted — which
  //    is the whole reason these rows carry a deletion condition in their `why`.

  // ── Forward-looking: the Roles & permissions settings page (MOTIR-2263) ───
  //    The asset (MOTIR-2259, #1889) draws a settings page that does not exist
  //    yet: `app/(authed)/settings/project/` holds `members`, `board`,
  //    `automation`, `workflow` and the rest, but no `roles`. MOTIR-2263 builds
  //    the route and the registry entry, and — per the pattern above — is the
  //    card that deletes these three rows, in the commit that adds the route.
  //
  //    ⚠️ These rows exist because this guard did NOT run on the PR that made
  //    them necessary. `ci.yml` skips the Vitest job on `design/*`, so the one
  //    PR class that changes design assets is the one class that never runs the
  //    assets' own guards; #1889 merged green and `main` went red for the next
  //    `subtask/*` PR to run a full suite. That is the composition-red shape the
  //    MCP/CLI note above describes, arriving through a different door — not two
  //    PRs racing, but a gate that made one of them invisible. MOTIR-2442 closes
  //    it; MOTIR-2441 is this repair.
  // MOTIR-2263 SHIPPED THE ROUTES, so the three roles rows are gone — deleted by
  // the card that built them, exactly as their own `why` said they would be.
  // `/settings/project/roles` and `/settings/project/roles/[roleKey]` are real
  // pages now.
  //
  // ⚠️ And `/settings/project/roles/new` went with them, for a reason worth
  // stating: MOTIR-2257 has NOT built the create page, but `[roleKey]` is a
  // dynamic segment, so `new` matches it and the address resolves. It resolves
  // to a deliberate `notFound()` — `roles/[roleKey]/page.tsx` looks the segment
  // up in the catalog the service returns and 404s on a miss — which is the
  // right behaviour and is why the row's author pre-authorised this deletion
  // ("the route lands no earlier than MOTIR-2263"). The guard reads the ROUTE
  // TABLE, so a 404 rendered BY a matching route is invisible to it; that is a
  // known limit of the sweep, not something this deletion introduces.
  // MOTIR-2653 SHIPPED THE ROUTE, so the two `/home` rows are gone — deleted by
  // the card that built them, in the same commit, exactly as their own `why`
  // said they would be. `app/(authed)/home/page.tsx` is a real page now and both
  // assets' `/home` links resolve, so the pair is guarded again rather than
  // excused. (Contrast the point-in-time rows above, which are permanent: those
  // record an address that WAS live when the asset was drawn and has since moved
  // away, and nothing is ever coming back to change them.)

  // ── The public reading surface moved to motir-marketing (MOTIR-3932) ──
  {
    file: 'design/agent-sandbox/agent-sandbox.mock.html',
    address: '/docs/api',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/agent-sandbox/agent-sandbox.mock.html',
    address: '/docs/sandbox',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/agent-sandbox/agent-sandbox.mock.html',
    address: '/explore',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/agent-sandbox/design-notes.md',
    address: '/docs',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/agent-sandbox/design-notes.md',
    address: '/docs/api',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/agent-sandbox/design-notes.md',
    address: '/docs/sandbox',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/api-docs/api-docs.mock.html',
    address: '/docs/api',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/api-docs/api-docs.mock.html',
    address: '/docs/api/getting-started',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/api-docs/api-docs.mock.html',
    address: '/docs/api/stability',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/api-docs/api-docs.mock.html',
    address: '/docs/sandbox',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/api-docs/api-docs.mock.html',
    address: '/explore',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/api-docs/design-notes.md',
    address: '/docs',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/api-docs/design-notes.md',
    address: '/docs/api',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/api-docs/design-notes.md',
    address: '/docs/api/getting-started',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/api-docs/design-notes.md',
    address: '/docs/api/stability',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/api-docs/design-notes.md',
    address: '/docs/cli',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/api-docs/design-notes.md',
    address: '/docs/sandbox',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/api-docs/docs-index.mock.html',
    address: '/docs',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/api-docs/docs-index.mock.html',
    address: '/docs/api',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/api-docs/docs-index.mock.html',
    address: '/docs/cli',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/api-docs/docs-index.mock.html',
    address: '/docs/mcp',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/api-docs/docs-index.mock.html',
    address: '/docs/sandbox',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/api-docs/docs-index.mock.html',
    address: '/explore',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/cli-guide/cli-guide.mock.html',
    address: '/docs/api',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/cli-guide/cli-guide.mock.html',
    address: '/docs/api/getting-started',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/cli-guide/cli-guide.mock.html',
    address: '/docs/api/stability',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/cli-guide/cli-guide.mock.html',
    address: '/docs/cli',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/cli-guide/cli-guide.mock.html',
    address: '/docs/sandbox',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/cli-guide/cli-guide.mock.html',
    address: '/explore',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/cli-guide/design-notes.md',
    address: '/docs/cli',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/cli-guide/design-notes.md',
    address: '/docs/cli/[*]',
    why: 'The `/docs/cli/*` prefix the notes say a second CLI page would create. The public reading surface moved to motir-marketing (MOTIR-3932), so no page under it serves here — read as a family since MOTIR-5447, where it used to borrow the `/docs/cli` row above.',
  },
  {
    file: 'design/workbench/workbench.mock.html',
    address: '/docs',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/mcp-server/design-notes.md',
    address: '/docs',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/mcp-server/design-notes.md',
    address: '/docs/api',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/mcp-server/design-notes.md',
    address: '/docs/mcp',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/mcp-server/design-notes.md',
    address: '/docs/mcp/tools',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/mcp-server/design-notes.md',
    address: '/docs/sandbox',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/mcp-server/design-notes.md',
    address: '/docs/mcp/[*]',
    why: 'The MCP sub-area the tier-2 rail is drawn inside. The public reading surface moved to motir-marketing (MOTIR-3932), so no page under it serves here — read as a family since MOTIR-5447, where it used to borrow the `/docs/mcp` row.',
  },
  {
    file: 'design/mcp-server/mcp-server.mock.html',
    address: '/docs/api',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/mcp-server/mcp-server.mock.html',
    address: '/docs/mcp',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/mcp-server/mcp-server.mock.html',
    address: '/docs/mcp/tools',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/mcp-server/mcp-server.mock.html',
    address: '/docs/sandbox',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/mcp-server/mcp-server.mock.html',
    address: '/explore',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/project-square/design-notes.md',
    address: '/explore',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/project-square/design-notes.md',
    address: '/explore/opengraph-image',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/project-square/project-square.mock.html',
    address: '/explore',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/project-square/project-square.mock.html',
    address: '/explore/opengraph-image',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/project-square/project-square.mock.html',
    address: '/explore/topic/ai',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/project-square/project-square.mock.html',
    address: '/explore/topic/content',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/project-square/project-square.mock.html',
    address: '/explore/topic/design',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/project-square/project-square.mock.html',
    address: '/explore/topic/developer-tools',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/project-square/project-square.mock.html',
    address: '/explore/topic/open-source',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/project-square/project-square.mock.html',
    address: '/explore/topic/productivity',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/public-projects/public-projects.mock.html',
    address: '/p/moooon-motir/opengraph-image',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/public-site/design-notes.md',
    address: '/docs',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/public-site/design-notes.md',
    address: '/explore',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/public-site/design-notes.md',
    address: '/explore/topic/[slug]',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/public-site/design-notes.md',
    address: '/p/[identifier]',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/public-site/public-site.mock.html',
    address: '/docs',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/public-site/public-site.mock.html',
    address: '/legal/[*]',
    why: "The footer's legal rows, named as a family in a comment on the motir.co chrome. Resolves on the brand host; MOTIR-4103 removed `app/(public)/legal/` from this one — read as a family since MOTIR-5447, where it used to borrow the `/legal` row.",
  },
  {
    file: 'design/public-site/public-site.mock.html',
    address: '/explore',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/public-site/not-found.mock.html',
    address: '/docs',
    why: "The public reading surface lives on motir-marketing (MOTIR-3932). The not-found room (MOTIR-4245) draws the shipped motir.co bar and footer around it, so it names that host's addresses; motir-core serves neither.",
  },
  {
    file: 'design/public-site/not-found.mock.html',
    address: '/explore',
    why: "The public reading surface lives on motir-marketing (MOTIR-3932). `/explore` is this room's PRIMARY door as well as a nav and footer row (MOTIR-4245) — the destination the asset argues for — and it resolves on motir.co, not in this repo.",
  },
  {
    file: 'design/roadmap/root-non-epic-rows.mock.html',
    address: '/explore/topic/[slug]',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/shell/design-notes.md',
    address: '/explore',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  {
    file: 'design/shell/navigation-pending.mock.html',
    address: '/docs',
    why: 'The public reading surface moved to motir-marketing (MOTIR-3932); this asset is a point-in-time record of the route as it was on app.motir.co.',
  },
  // ── Historical: the app-host public path the retargets REMOVE ─────────────
  // The same section names `/p/<key>` (and `/p/<key>?edit=1`) as the dead
  // addresses the three Members-room links pointed at until MOTIR-4171 retargets
  // them — quoted as history, never as a destination. Permanent: `app/(public)/p/`
  // was deleted by MOTIR-3951 and is not coming back to this repo.
  {
    file: 'design/projects/design-notes.md',
    address: '/p',
    why: 'Historical: the app-hosted /p/<key> path MOTIR-3951 deleted, quoted as the address the retargets replace. Permanent.',
  },

  // (The two FORWARD-LOOKING rows for `/settings/workspace/roles` that MOTIR-6456
  // added are gone — deleted by MOTIR-6466, which built the route.)
  // ── The git surface MOVED A TIER (Story MOTIR-4669 · MOTIR-4680) ─────────
  //    Twelve assets draw the old address; ALL of them are point-in-time records
  //    of a surface that shipped, and the address still resolves — as a 308.
  //    ⚠️ These rows do NOT delete themselves: the redirect is PERMANENT, so the
  //    condition that made them necessary never ends. That is the difference from
  //    the forward-looking rows below, which each name the card that removes them.
  {
    file: 'design/github/design-notes.md',
    address: '/settings/workspace/github',
    why: "MOTIR-4680 moved the git connect surface a TIER — a repository is connected once, to the ORGANISATION — so `/settings/workspace/github` is a PERMANENT redirect to `/settings/organization/git`. Every asset here draws the rail row, the room's footer or the connect hand-off as it stood, and each is a point-in-time record of a surface that shipped: the address resolves (308) rather than 404s, and correcting a drawing to a destination it never depicted would rewrite what the panel recorded. ENUMERATED from a run of this lane, per MOTIR-4680's own acceptance criterion — never guessed.",
  },
  {
    file: 'design/gitlab/design-notes.md',
    address: '/settings/workspace/github',
    why: "MOTIR-4680 moved the git connect surface a TIER — a repository is connected once, to the ORGANISATION — so `/settings/workspace/github` is a PERMANENT redirect to `/settings/organization/git`. Every asset here draws the rail row, the room's footer or the connect hand-off as it stood, and each is a point-in-time record of a surface that shipped: the address resolves (308) rather than 404s, and correcting a drawing to a destination it never depicted would rewrite what the panel recorded. ENUMERATED from a run of this lane, per MOTIR-4680's own acceptance criterion — never guessed.",
  },
  {
    // ⚠️ RE-KEYED by MOTIR-4779, which renamed `design/home/` to
    // `design/workbench/` with the surface. MOTIR-4680 enumerated this row from
    // a lane run against the old path, and the two landed in the same window —
    // a merge adjacency, not a disagreement. The exemption is unchanged in
    // substance; only the file it names moved.
    file: 'design/workbench/workbench.mock.html',
    address: '/settings/workspace/github',
    why: "MOTIR-4680 moved the git connect surface a TIER — a repository is connected once, to the ORGANISATION — so `/settings/workspace/github` is a PERMANENT redirect to `/settings/organization/git`. Every asset here draws the rail row, the room's footer or the connect hand-off as it stood, and each is a point-in-time record of a surface that shipped: the address resolves (308) rather than 404s, and correcting a drawing to a destination it never depicted would rewrite what the panel recorded. ENUMERATED from a run of this lane, per MOTIR-4680's own acceptance criterion — never guessed.",
  },
  {
    file: 'design/org-admin/design-notes.md',
    address: '/settings/workspace/github',
    why: "MOTIR-4680 moved the git connect surface a TIER — a repository is connected once, to the ORGANISATION — so `/settings/workspace/github` is a PERMANENT redirect to `/settings/organization/git`. Every asset here draws the rail row, the room's footer or the connect hand-off as it stood, and each is a point-in-time record of a surface that shipped: the address resolves (308) rather than 404s, and correcting a drawing to a destination it never depicted would rewrite what the panel recorded. ENUMERATED from a run of this lane, per MOTIR-4680's own acceptance criterion — never guessed.",
  },
  {
    file: 'design/repository-set/design-notes.md',
    address: '/settings/workspace/github',
    why: "MOTIR-4680 moved the git connect surface a TIER — a repository is connected once, to the ORGANISATION — so `/settings/workspace/github` is a PERMANENT redirect to `/settings/organization/git`. Every asset here draws the rail row, the room's footer or the connect hand-off as it stood, and each is a point-in-time record of a surface that shipped: the address resolves (308) rather than 404s, and correcting a drawing to a destination it never depicted would rewrite what the panel recorded. ENUMERATED from a run of this lane, per MOTIR-4680's own acceptance criterion — never guessed.",
  },
  {
    file: 'design/repository-set/repositories-room.mock.html',
    address: '/settings/workspace/github',
    why: "MOTIR-4680 moved the git connect surface a TIER — a repository is connected once, to the ORGANISATION — so `/settings/workspace/github` is a PERMANENT redirect to `/settings/organization/git`. Every asset here draws the rail row, the room's footer or the connect hand-off as it stood, and each is a point-in-time record of a surface that shipped: the address resolves (308) rather than 404s, and correcting a drawing to a destination it never depicted would rewrite what the panel recorded. ENUMERATED from a run of this lane, per MOTIR-4680's own acceptance criterion — never guessed.",
  },
  {
    file: 'design/shell/3d-immersive-shell.mock.html',
    address: '/settings/workspace/github',
    why: "MOTIR-4680 moved the git connect surface a TIER — a repository is connected once, to the ORGANISATION — so `/settings/workspace/github` is a PERMANENT redirect to `/settings/organization/git`. Every asset here draws the rail row, the room's footer or the connect hand-off as it stood, and each is a point-in-time record of a surface that shipped: the address resolves (308) rather than 404s, and correcting a drawing to a destination it never depicted would rewrite what the panel recorded. ENUMERATED from a run of this lane, per MOTIR-4680's own acceptance criterion — never guessed.",
  },
  {
    file: 'design/shell/design-notes.md',
    address: '/settings/workspace/github',
    why: "MOTIR-4680 moved the git connect surface a TIER — a repository is connected once, to the ORGANISATION — so `/settings/workspace/github` is a PERMANENT redirect to `/settings/organization/git`. Every asset here draws the rail row, the room's footer or the connect hand-off as it stood, and each is a point-in-time record of a surface that shipped: the address resolves (308) rather than 404s, and correcting a drawing to a destination it never depicted would rewrite what the panel recorded. ENUMERATED from a run of this lane, per MOTIR-4680's own acceptance criterion — never guessed.",
  },
  {
    file: 'design/shell/help-menu.mock.html',
    address: '/settings/workspace/github',
    why: "MOTIR-4680 moved the git connect surface a TIER — a repository is connected once, to the ORGANISATION — so `/settings/workspace/github` is a PERMANENT redirect to `/settings/organization/git`. Every asset here draws the rail row, the room's footer or the connect hand-off as it stood, and each is a point-in-time record of a surface that shipped: the address resolves (308) rather than 404s, and correcting a drawing to a destination it never depicted would rewrite what the panel recorded. ENUMERATED from a run of this lane, per MOTIR-4680's own acceptance criterion — never guessed.",
  },
  {
    file: 'design/shell/navigation-pending.mock.html',
    address: '/settings/workspace/github',
    why: "MOTIR-4680 moved the git connect surface a TIER — a repository is connected once, to the ORGANISATION — so `/settings/workspace/github` is a PERMANENT redirect to `/settings/organization/git`. Every asset here draws the rail row, the room's footer or the connect hand-off as it stood, and each is a point-in-time record of a surface that shipped: the address resolves (308) rather than 404s, and correcting a drawing to a destination it never depicted would rewrite what the panel recorded. ENUMERATED from a run of this lane, per MOTIR-4680's own acceptance criterion — never guessed.",
  },
  {
    file: 'design/shell/top-bar.mock.html',
    address: '/settings/workspace/github',
    why: "MOTIR-4680 moved the git connect surface a TIER — a repository is connected once, to the ORGANISATION — so `/settings/workspace/github` is a PERMANENT redirect to `/settings/organization/git`. Every asset here draws the rail row, the room's footer or the connect hand-off as it stood, and each is a point-in-time record of a surface that shipped: the address resolves (308) rather than 404s, and correcting a drawing to a destination it never depicted would rewrite what the panel recorded. ENUMERATED from a run of this lane, per MOTIR-4680's own acceptance criterion — never guessed.",
  },
  // ── The ORG level of the console (Story MOTIR-4337) ──────────────────────
  //    ⚠️ TWO FORWARD-LOOKING ROWS STOOD HERE AND ARE GONE, deleted by the card
  //    they were waiting for. MOTIR-4566 built `/admin/tenants` and
  //    `/admin/tenants/[orgId]`, so the routes resolve and the exemptions no
  //    longer apply — which is exactly what `carries no KNOWN entry that has
  //    stopped applying` would have turned red about. The row below is the
  //    PERMANENT one, and it is the opposite kind.
  {
    file: 'design/platform-admin/design-notes.md',
    address: '/admin/orgs',
    why: 'The route this asset says must NOT exist — cited only to record the choice against it (the rail already reserves `/admin/tenants`, so a sibling `orgs` route would leave the reserved row pointing at nothing). PERMANENT, with no delete-me instruction: if `app/(admin)/admin/orgs/` ever lands, the asset is wrong rather than this row.',
  }, // ── My agents (Story MOTIR-6860 · MOTIR-6868, and MOTIR-6861 · MOTIR-6937) ──
  {
    file: 'design/my-agents/design-notes.md',
    address: '/instances',
    why: 'HISTORY: the revision table records that the page was first drawn at `/instances` and renamed to `/my-agents` (revision 2, after changes were requested on the word). The row says what the address WAS, never where to go. PERMANENT: if `/instances` ever becomes a page, the table is still right about revision 1.',
  },
  {
    file: 'design/my-agents/design-notes.md',
    address: '/login',
    why: "Not an address: Claude Code's own `/login` slash command, typed in the agent's terminal to sign in (docs/decisions/agent-terminal.md Q9: the sign-in completes through the vendor's own flow). The panel's not-signed-in line quotes it verbatim. PERMANENT.",
  },
];

type Entry = { file: string; address: string; why: string };
const idOf = (x: { file: string; address: string }) => `${x.file} ${x.address}`;

// Two sweeps live in this file — addresses, and the source paths below — and
// they reconcile against their allowlist identically. So the two-direction
// check is written once, over a finding reduced to an `id` (the asset plus the
// thing it cites) and the `report` line to print when nothing allows for it.
interface Reconcilable {
  id: string;
  report: string;
}

/** An address finding, as the reconciler sees it. */
const reconcilable = (finding: Finding): Reconcilable => ({
  id: idOf(finding),
  // The file, the line to open, the address, and what is wrong with it —
  // enough to fix without re-running the sweep by hand.
  report: `${finding.file}:${finding.line} — ${finding.address} (${finding.verdict})`,
});

/** Findings no allowlist row covers — an asset went stale, or a new one shipped stale. */
function unlisted(findings: Reconcilable[], allowed: string[]): string[] {
  const covered = new Set(allowed);
  return findings.filter((finding) => !covered.has(finding.id)).map((finding) => finding.report);
}

/** Allowlist rows that match nothing — the asset was corrected, so the row must go. */
function expired(findings: Reconcilable[], allowed: string[]): string[] {
  const live = new Set(findings.map((finding) => finding.id));
  return allowed.filter((id) => !live.has(id));
}

/**
 * `KNOWN` pairs listed more than once. Neither test above can see a duplicate:
 * `unlisted()` matches findings against a `Set`, so the second row is a no-op,
 * and `expired()` only reports a row matching NOTHING, which a duplicate still
 * does. Uniqueness is the third axis, and it is the one a parallel merge
 * attacks — reported once per pair however many copies exist.
 */
function duplicated(known: Entry[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const id of known.map(idOf)) {
    if (seen.has(id)) twice.add(id);
    seen.add(id);
  }
  return [...twice].sort();
}

describe('a design asset addresses pages that still exist', () => {
  it('finds no address the app no longer serves', () => {
    expect(
      unlisted(sweep().map(reconcilable), KNOWN.map(idOf)),
      'A design asset is the layout source of truth for its surface; an address it names that ' +
        'redirects away or resolves to nothing will be believed by the next card that reads it. ' +
        'Correct the asset, or add the pair to KNOWN with a reason if the address is deliberate.',
    ).toEqual([]);
  });

  it('carries no KNOWN entry that has stopped applying', () => {
    // Without this the table would only ever grow, and a row left behind after
    // its asset was corrected would silently pre-approve the SAME address
    // going stale again — an allowlist one edit away from being a mute button.
    expect(
      expired(sweep().map(reconcilable), KNOWN.map(idOf)),
      'These KNOWN entries no longer match anything — delete them.',
    ).toEqual([]);
  });

  it('lists each (asset, address) pair exactly once', () => {
    // MOTIR-2372. MOTIR-2348 (#1913) and MOTIR-2370 (#1916) diagnosed the same
    // red `main` in parallel and both merged, so the SAME eight pairs were
    // listed twice — invisible to both tests above, and green. Every one of
    // these rows exists to be DELETED by the card that builds its route, so a
    // second copy is a trap laid for that card: it removes the pair it finds,
    // the survivor stops matching, and `expired()` reddens `main` naming rows
    // that author believes they already removed.
    expect(
      duplicated(KNOWN),
      'These pairs are listed more than once — delete the extra copies, keeping the ' +
        'reason that reads best. A duplicate silences nothing today and reddens `main` ' +
        'the day the pair is cleared.',
    ).toEqual([]);
  });

  it('lists every KNOWN entry with a reason', () => {
    expect(KNOWN.filter((entry) => entry.why.trim().length < 20)).toEqual([]);
  });

  it('parks no finding as STALE without naming the card that clears it', () => {
    // MOTIR-2316 parked its own first-run findings here rather than fixing
    // them, and asserted each named where it WAS fixed — or "parked" quietly
    // becomes "accepted". MOTIR-2340 cleared all 17, so the table holds none
    // today; the rule outlives them, because parking the NEXT batch is the
    // same temptation. It no longer requires a STALE row to exist (that would
    // oblige the table to keep one forever) — only that any row calling itself
    // STALE cites a card.
    const stale = KNOWN.filter((entry) => entry.why.startsWith('STALE'));
    expect(stale.filter((entry) => !/MOTIR-\d+/.test(entry.why))).toEqual([]);
  });
});

describe('the allowlist is checked in both directions, and for uniqueness', () => {
  const finding = (file: string, address: string): Reconcilable =>
    reconcilable({ file, address, verdict: 'resolves-to-nothing', line: 7 });
  const allow = (file: string, address: string): string => idOf({ file, address });
  const entry = (file: string, address: string): Entry => ({ file, address, why: 'because' });

  it('reports a finding no row covers, with its file, line and verdict', () => {
    expect(unlisted([finding('design/a/notes.md', '/gone')], [])).toEqual([
      'design/a/notes.md:7 — /gone (resolves-to-nothing)',
    ]);
  });

  it('reports a row that matches nothing, so a corrected asset cannot keep its exemption', () => {
    expect(expired([], [allow('design/a/notes.md', '/gone')])).toEqual(['design/a/notes.md /gone']);
  });

  it('scopes a row to ONE asset — the same address going stale elsewhere still fails', () => {
    const rows = [allow('design/a/notes.md', '/gone')];
    expect(unlisted([finding('design/a/notes.md', '/gone')], rows)).toEqual([]);
    expect(unlisted([finding('design/b/notes.md', '/gone')], rows)).toEqual([
      'design/b/notes.md:7 — /gone (resolves-to-nothing)',
    ]);
  });

  it('names a pair listed twice, so a parallel merge cannot double a row unseen', () => {
    const a = entry('design/a/notes.md', '/gone');
    expect(duplicated([a, a])).toEqual(['design/a/notes.md /gone']);
    // Reported ONCE per pair however many copies there are, and the reported
    // string is the pair itself — the same id `expired()` prints, so both
    // failures read the same way.
    expect(duplicated([a, a, a])).toEqual(['design/a/notes.md /gone']);
  });

  it('stays silent on rows that share only the file, or only the address', () => {
    const rows = [
      entry('design/a/notes.md', '/gone'),
      entry('design/a/notes.md', '/other'),
      entry('design/b/notes.md', '/gone'),
    ];
    expect(duplicated(rows)).toEqual([]);
    // Uniqueness is per PAIR, not per file or per address: one asset naming two
    // dead addresses, and two assets naming the same one, are both legitimate —
    // the second is exactly what the four /docs/mcp[/tools] rows are.
    expect(duplicated([])).toEqual([]);
  });

  it('the duplicate axis is the one the two tightness tests cannot see', () => {
    // The regression MOTIR-2372 cleaned up, in miniature: two rows for one
    // pair, matched by a single live finding. `unlisted()` is satisfied (the
    // finding is covered) and `expired()` is satisfied (both rows match), so
    // the table is green — while carrying a row that will outlive its pair.
    const a = entry('design/a/notes.md', '/gone');
    const findings = [finding('design/a/notes.md', '/gone')];
    const id = allow('design/a/notes.md', '/gone');
    expect(unlisted(findings, [id, id])).toEqual([]);
    expect(expired(findings, [id, id])).toEqual([]);
    expect(duplicated([a, a])).toEqual(['design/a/notes.md /gone']);
  });
});

// ── The guard, seen failing ─────────────────────────────────────────────────
//
// A guard that has never been observed to fail is not evidence. These run the
// real extractor and the real classifier over the design asset's own pre-fix
// content — the `href`s and the route table `design/api-docs/` carried between
// Amendment 9 (2026-08-06) and its correction in MOTIR-2311 — and assert the
// sweep would have named them.
describe('the sweep catches the drift it was written for', () => {
  // Verbatim from `git show cfda1e99:design/api-docs/api-docs.mock.html` and
  // `:design/api-docs/design-notes.md`, the last revision before the fix.
  const STALE_MOCK_HTML = [
    '<a class="nav-current" href="/api-docs" aria-current="page">Docs</a>',
    '<a class="navrow is-active" href="/api-docs">API reference</a>',
    '<a class="navrow" href="/api-docs/getting-started">Getting started</a>',
    '<a class="navrow" href="/api-docs/stability">Stability &amp; deprecation</a>',
    '<a class="btn btn-sm btn-primary" href="/docs">API reference</a>',
  ].join('\n');

  const STALE_DESIGN_NOTES = [
    '| `/api-docs`                 | The API reference (catalogue + operation) | none (public) |',
    '| `/api-docs/getting-started` | The five-step guide                       | none (public) |',
    '| `/api-docs/stability`       | The stability & deprecation policy        | none (public) |',
    '',
    '### Panel 1 — `/api-docs`, the default view',
  ].join('\n');

  const verdicts = (source: string) =>
    [
      ...new Set(
        addressesIn(source)
          .map(({ raw }) => toPageAddress(raw))
          .filter((address): address is string => address !== null)
          .map((address) => `${address} ${classify(address) ?? 'ok'}`),
      ),
    ].sort();

  it('reports every address in the pre-fix mockup as redirecting away', () => {
    expect(verdicts(STALE_MOCK_HTML)).toEqual([
      '/api-docs redirects-away',
      '/api-docs/getting-started redirects-away',
      '/api-docs/stability redirects-away',
      // ⚠️ `/docs` resolves-to-nothing since MOTIR-3951: the docs surface moved
      // to motir-marketing, so the redirect TARGET no longer resolves on this
      // host. The three `/api-docs*` verdicts — the drift this fixture was
      // written to prove the sweep catches — are unchanged.
      '/docs resolves-to-nothing',
    ]);
  });

  it('reports the pre-fix route table in the design notes too', () => {
    expect(verdicts(STALE_DESIGN_NOTES)).toEqual([
      '/api-docs redirects-away',
      '/api-docs/getting-started redirects-away',
      '/api-docs/stability redirects-away',
    ]);
  });

  // MOTIR-5447. A glob written with a slash — `/settings/*`, "a page under
  // /settings" — used to lose its star and then its slash, and was ruled on as
  // the PARENT page `/settings`, which does not exist. Eight families in `app/`
  // have child pages and no parent page (`/settings`, `/sprints`,
  // `/sprints/[id]`, `/invite`, `/follow`, `/unsubscribe`, `/direction`,
  // `/onboarding/direction`), and an asset globbing any of them went red.
  describe('a trailing `/*` names a page UNDER the path, not the path itself', () => {
    it('resolves a family with child pages and no parent page', () => {
      expect(verdicts('`/settings/*`')).toEqual(['/settings/[*] ok']);
      expect(verdicts('`/sprints/[id]/*`')).toEqual(['/sprints/[id]/[*] ok']);
    });

    it('resolves a family some of whose members redirect, while others still serve', () => {
      // `/settings/workspace/github` and `/gitlab` are redirect sources, and
      // `/settings/workspace/security` is a page. The glob claims a live page
      // exists under the path — which is true — so a member that redirects
      // does not turn the whole family into `redirects-away`.
      expect(verdicts('`/settings/workspace/*`')).toEqual(['/settings/workspace/[*] ok']);
    });

    it('still reports a family with no page at any depth', () => {
      // The fixture that stops the glob arm becoming a pass-everything: a
      // dynamic segment only matches where a route has a segment to match.
      expect(verdicts('`/no-such-family/*`')).toEqual(['/no-such-family/[*] resolves-to-nothing']);
      expect(verdicts('`/settings/no-such-tier/*`')).toEqual([
        '/settings/no-such-tier/[*] resolves-to-nothing',
      ]);
    });

    it('reports a glob over a family that only redirects away', () => {
      expect(verdicts('`/api-docs/*`')).toEqual(['/api-docs/[*] redirects-away']);
    });

    it('keeps reading a star with no slash before it as a prefix', () => {
      expect(toPageAddress('/settings/project*')).toBe('/settings/project');
      expect(toPageAddress('/docs*')).toBe('/docs');
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The SOURCE-PATH sweep — MOTIR-2364
// ════════════════════════════════════════════════════════════════════════════
//
// An asset names two kinds of thing, and everything above guards only one of
// them. It names ADDRESSES — where a surface lives for a user — and it names
// SOURCE PATHS: the shipped file the next agent is told to open, in lines that
// literally read "mirrors `app/(authed)/items/page.tsx`".
//
// ── The defect this guards ──────────────────────────────────────────────────
// The work-item rename moved `app/(authed)/issues/` to `app/(authed)/items/`
// and KEPT the component filenames, so `app/(authed)/issues/_components/
// issueCellPrimitives.tsx` was wrong in its first half and right in its
// second. Nineteen such citations across fourteen assets survived the rename,
// a referrer sweep (`issues` is still everywhere, legitimately, in
// `components/issues/` and `lib/issues/`), and the guard above.
//
// That guard could not have found them: a source path is not an address, and
// `toPageAddress` discards one twice over — exclusion (2) rejects anything
// whose last segment has a file extension (`page.tsx`), and `(authed)` is
// stripped from every route pattern, so `app/(authed)/…` can never match one.
// Invisible by construction, not by omission — hence a second sweep rather
// than a `KNOWN` row.
//
// ── Why this half is the load-bearing one ───────────────────────────────────
// An asset's addresses are read by a human orienting themselves. Its source
// paths are read by an agent about to write code. A dead address briefly
// confuses a reader; a dead source path sends a coding agent to open a file
// that does not exist — and what it does then is improvise the layout, which
// is the exact outcome the design-reference rule exists to prevent.

/**
 * The repo's own top-level directories. Anchoring a citation on one of these
 * is what keeps the sweep quiet: an unanchored `word/word` matches every
 * alternative in English prose ("a Card/Pill split", "green/mint").
 */
const SOURCE_ROOTS = readdirSync(ROOT, { withFileTypes: true })
  .filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules',
  )
  .map((entry) => entry.name)
  .sort();

// A path segment is a route group `(authed)`, a dynamic segment `[key]`, or a
// plain name. The trailing capture is the character that ENDED the token —
// only a brace matters, and only as an exclusion below.
const PATH_SEGMENT = String.raw`(?:\([a-z][\w-]*\)|\[[^\]/\s]+\]|[\w.@+-]+)`;
const PATH_TOKEN = new RegExp(
  String.raw`(?:^|[^\w./-])((?:${SOURCE_ROOTS.join('|')})(?:/${PATH_SEGMENT})+)([{]?)`,
  'g',
);

interface RawPath {
  raw: string;
  brace: boolean;
  line: number;
}

/** Every path-shaped token in one asset's source, with its line number. */
function pathsIn(source: string): RawPath[] {
  const found: RawPath[] = [];
  for (const match of source.matchAll(PATH_TOKEN)) {
    found.push({
      raw: match[1]!,
      brace: match[2] === '{',
      line: source.slice(0, match.index).split('\n').length,
    });
  }
  return found;
}

/**
 * Reduce a raw match to the repo path it names, or `null` when it is not one.
 * Two exclusions, both the source-path analogue of `toPageAddress`'s
 * placeholder rule — a token that names a FAMILY rather than a file.
 */
function toRepoPath({ raw, brace }: RawPath): string | null {
  // (1) A brace expansion — `ExpansionNudge{Banner,Review}.tsx` truncates to a
  //     stem that is neither of the two files it means.
  if (brace) return null;
  // (2) An elided path — `app/(authed)/org/.../OrgUsageClient.tsx`.
  if (raw.includes('…') || /(^|\/)\.\.\.(\/|$)/.test(raw)) return null;
  // Sentence punctuation the token swallowed: "… in app/…/page.tsx."
  return raw.replace(/\.+$/, '') || null;
}

// A citation often drops the extension — `components/ui/Card` is an import
// specifier, not a filename. Resolve it the way an editor's go-to-file would.
const CITED_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.md',
  '.mock.html',
  '.html',
  '.json',
  '.css',
  '.png',
  '.svg',
  '.pen',
];

function resolvesInRepo(path: string): boolean {
  if (existsSync(join(ROOT, path))) return true;
  // It already carries an extension and did not resolve — nothing to try.
  if (/\.[a-z0-9]+$/i.test(path.split('/').pop()!)) return false;
  return CITED_EXTENSIONS.some((extension) => existsSync(join(ROOT, path + extension)));
}

interface PathFinding {
  file: string;
  path: string;
  line: number;
}

// ── The files a design asset MIRRORS are swept too (MOTIR-4344) ────────────
//
// The sweep below reads `design/**`, which is where a stale citation is CAUGHT
// and not where it is WRITTEN. MOTIR-4344's defect was a dead path in a
// `theme.css` comment above the `--el-avatar-*` ramp: it went dead on
// 2026-08-11 with MOTIR-2680 and nothing saw it until MOTIR-4252 lifted the
// block into a mock — at which point this guard fired on the COPY, inside a
// card that had nothing to do with it, while the original stayed dead in its
// own home. Correcting the copy is what makes the guard green again, so the
// mechanism actively hides the source.
//
// `packages/design-system/theme.css` is the file design assets mirror: a
// `*.mock.html` opens by copying its token block, comments and all, so the
// next agent reads those comments either way and the guard's own rationale —
// a path that does not exist sends that agent looking for nothing — applies
// to the source at least as strongly as to the copy.
//
// SCOPE is the MEASURED one rather than the widest available. Sweeping every
// `.css` outside `node_modules` (five files) finds exactly the same population
// as sweeping this one, so the extra four buy nothing; sweeping `**/*.ts`
// would fold in every import specifier and turn this into a different check
// with a different failure mode. Add a file here when a design asset starts
// mirroring it.
const MIRRORED_SOURCES = ['packages/design-system/theme.css'];

/** Every file the source-path sweep opens: the design assets, then the sources they mirror. */
function sweptSources(): string[] {
  return [
    ...walk(join(ROOT, 'design')).filter((path) => /\.(md|html|pen)$/.test(path)),
    ...MIRRORED_SOURCES.map((path) => join(ROOT, path)),
  ];
}

function sweepPaths(): PathFinding[] {
  const assets = sweptSources();
  const findings = new Map<string, PathFinding>();
  for (const asset of assets) {
    const file = relative(ROOT, asset).split(sep).join('/');
    for (const rawPath of pathsIn(readFileSync(asset, 'utf8'))) {
      const path = toRepoPath(rawPath);
      if (path === null || resolvesInRepo(path)) continue;
      const id = `${file} ${path}`;
      // First occurrence wins, so the reported line is the one to open.
      if (!findings.has(id)) findings.set(id, { file, path, line: rawPath.line });
    }
  }
  return [...findings.values()].sort((a, b) =>
    `${a.file} ${a.path}`.localeCompare(`${b.file} ${b.path}`),
  );
}

const pathIdOf = (x: { file: string; path: string }) => `${x.file} ${x.path}`;

/** A source-path finding, as the shared reconciler sees it. */
const reconcilablePath = (finding: PathFinding): Reconcilable => ({
  id: pathIdOf(finding),
  report: `${finding.file}:${finding.line} — ${finding.path} (does not exist)`,
});

// ── The judgement, in one table ─────────────────────────────────────────────
//
// Same contract as `KNOWN` above: every pair the sweep finds today, with why
// it is allowed to stay, asserted TIGHT in both directions so the list cannot
// rot into a mute button. Four families, and the reason says which.
//
// This sweep's own first-run findings were parked here as `STALE` rather than
// fixed in the run that found them — the boundary MOTIR-2316 set and MOTIR-2340
// inherited: the run that finds a class is not the run that clears it.
// MOTIR-2369 cleared all six, so the table holds no STALE row today.
const KNOWN_PATHS: { file: string; path: string; why: string }[] = [
  // ── A DRAWN DOCUMENT'S PATH, not a citation (Story MOTIR-4907 · MOTIR-5673) ──
  //  The decision port draws an agent's decision document as a pull request carries
  //  it, and its meta line and the To-approve row NAME that file. The path is the
  //  CONTENT of the thing being drawn — a fixture ADR in a fixture pull request — not a
  //  file the asset tells the next agent to mirror, exactly as the run modal's sample
  //  log lines above. `page-body.md` was chosen because no card plans a record of that
  //  name, so these rows are permanent rather than waiting on a file to land.
  {
    file: 'design/github/approve-and-merge--decision.mock.html',
    path: 'docs/decisions/page-body.md',
    why: 'the fixture decision document the port DRAWS (MOTIR-5673) — drawn content, not a citation',
  },
  {
    file: 'design/workbench/approvals-row--decision.mock.html',
    path: 'docs/decisions/page-body.md',
    why: 'the fixture decision document the row NAMES (MOTIR-5673) — drawn content, not a citation',
  },
  // ── A PUBLISHED ASSET NOT MIRRORED IN THE TREE (MOTIR-6190) ──────────────────
  //  A design result is the source of truth and committing its files is optional
  //  (`docs/decisions/design-result.md` AMENDMENT 5 Q1). MOTIR-6190 landed MOTIR-6033's
  //  note as Part XXII of the ai-planning notes so a reader of the tree can find the
  //  spec at all, and that Part names its own mocks and a mock it amends, none of
  //  which is committed. Each is reached through `get_design` on the card named.
  //  These rows are FORWARD-LOOKING: a pull request that mirrors the mock turns the
  //  tight arm red, which is the signal to delete the row.
  {
    file: 'design/ai-planning/design-notes.md',
    path: 'design/ai-planning/plan-review--decide.mock.html',
    why: "Part XXII's own decision-surface mock, published on MOTIR-6033 (evidence cmueg6bue00kghwoikl5e6bxp) and not mirrored in the tree",
  },
  {
    file: 'design/ai-planning/design-notes.md',
    path: 'design/workbench/approvals-row--plan.mock.html',
    why: "Part XXII's To-approve row mock, published on MOTIR-6033 (evidence cmueg6bue00kghwoikl5e6bxp) and not mirrored in the tree",
  },
  {
    file: 'design/ai-planning/design-notes.md',
    path: 'design/ai-chat/planning-workspace--resume.mock.html',
    why: "the resume mock Part XXII amends, published on MOTIR-6019's design result and not mirrored in the tree",
  },
  //  MOTIR-6214 landed the workbench area's two sections the same way: § 28 from
  //  MOTIR-5997's result and § 29, the pointer to Part XXII, from MOTIR-6033's. Each
  //  names a delta mock that result carries and the tree does not.
  {
    file: 'design/workbench/design-notes.md',
    path: 'design/workbench/approvals-row--plain-words.mock.html',
    why: "§ 28's To-approve row mock, published on MOTIR-5997 (evidence cmucp2cd00019hwoi9dvnqzpe) and not mirrored in the tree",
  },
  {
    file: 'design/workbench/design-notes.md',
    path: 'design/workbench/approval-overlay--quick-view.mock.html',
    why: "§ 28's overlay exit-row mock, published on MOTIR-5997 (evidence cmucp2cd00019hwoi9dvnqzpe) and not mirrored in the tree",
  },
  {
    file: 'design/workbench/design-notes.md',
    path: 'design/workbench/approvals-row--plan.mock.html',
    why: "§ 29's To-approve row mock, published on MOTIR-6033 (evidence cmueg6bue00kghwoikl5e6bxp) and not mirrored in the tree",
  },
  // ── ✅ RETIRED 2026-09-11 (MOTIR-5170, under Bug MOTIR-4925) ──────────────
  //  One FORWARD-LOOKING row stood here: `design/projects/design-notes.md` names
  //  `app/(authed)/settings/project/approvals/page.tsx`, the file MOTIR-4942's
  //  notes told MOTIR-4925 to create. It said it would DELETE ITSELF when the
  //  page landed, and it did — the `carries no KNOWN_PATHS entry that has stopped
  //  applying` arm went red in the CI of the pull request that added the file,
  //  which is the exemption turning into a red test exactly as intended. The
  //  pair is guarded again, and this note is itself deletable.
  // ── SAMPLE AGENT OUTPUT, not a citation (Story MOTIR-1789 · MOTIR-3893) ──
  //  The run modal's LOG pane draws what a coding agent actually prints, and an
  //  agent prints file paths — so the console's sample lines look exactly like
  //  citations to this guard, which cannot tell a drawn transcript from a
  //  reference. They are not paths the asset is telling the next agent to
  //  mirror; they are the CONTENT of the thing being drawn.
  //
  //  All three are files THIS STORY builds, and they exist today on the
  //  unmerged `parent/MOTIR-1789-agent-runs` branch — the design branch is cut
  //  from `main`, which is why they do not resolve here. Each row DELETES
  //  ITSELF when the parent lands; `carries no KNOWN_PATHS entry that has
  //  stopped applying` is what turns a stale one red rather than quiet.
  // ── An area a design asset RECORDS ITSELF as having been RENAMED FROM ─────
  //  MOTIR-4779 renamed `design/home/` to `design/workbench/` with the surface
  //  it draws, and both files say so on purpose: a reader who arrives from an
  //  old citation has to be able to tell "this was moved" from "this is gone".
  //  The old path is therefore written deliberately, and these rows are
  //  permanent — unlike the point-in-time rows below, the asset is not history,
  //  it is the CURRENT asset naming where it used to live.
  {
    file: 'design/workbench/design-notes.md',
    path: 'design/home',
    why: 'The rename record — `design/home/` no longer exists BY THIS CARD, and the section that says so has to name it.',
  },
  {
    file: 'design/workbench/design-notes.md',
    path: 'design/home/home.mock.html',
    why: 'Same enumeration — the old mock path, named so the re-key is checkable.',
  },
  {
    file: 'design/workbench/workbench.mock.html',
    path: 'design/home',
    why: "The mock's own header comment carries the same rename record as the notes, for a reader who opens the asset rather than the spec.",
  },
  // ── A source path a design asset RECORDED, which the app has since moved ──
  // The `KNOWN` table's point-in-time rows, one axis over: the same MOTIR-2534
  // route move renamed the DIRECTORY, so an asset citing the pane's `page.tsx`
  // by its old path no longer resolves. The asset is history and stays as
  // drawn; these rows are permanent and carry no delete-me instruction.
  {
    file: 'design/api-docs/api-docs.mock.html',
    path: 'app/(authed)/settings/account/api-tokens/page.tsx',
    why: 'A point-in-time record: Panel 8 cites the file it places a link row into, at the path that file had when MOTIR-2183 drew it. MOTIR-2534 moved the directory to `settings/account/tokens/`.',
  },
  {
    file: 'design/api-docs/design-notes.md',
    path: 'app/(authed)/settings/account/api-tokens/page.tsx',
    why: 'The same citation in the notes beside that mock — the ownership table naming where the in-app door is placed. Same move, same reason it stays.',
  },
  {
    file: 'design/brand/brand-mark.mock.html',
    path: 'app/(public)/explore/opengraph-image.tsx',
    why: "Two point-in-time citations (the read-but-not-re-rendered list, and Panel 6's section-card label) naming the file MOTIR-1150 lifted the ad-hoc M-tile's inline hexes from, at the path it had when that card drew the asset. MOTIR-3491 moved it into `app/(public)/explore/(square)/` — a metadata image file is resolved for the page in its OWN segment, so when the square's page moved into the route group that scopes its `loading.tsx`, leaving this behind silently dropped every og:image tag from /explore. The asset is history and stays as drawn; correcting it from that bug's branch would also have published the brand mark's design result onto the bug (MOTIR-3130).",
  },
  // ── A source path this repository no longer has at all (MOTIR-4103) ───────
  // Not a MOVE like the rows above — a deletion. `app/(public)/legal/` was the
  // last thing left under `app/(public)`, and it went with `content/legal/`
  // when the seven documents became motir.co's. TWO assets cite it, from
  // opposite sides of the same move: one draws the motir.co chrome and names,
  // for a reader comparing the two hosts, where the equivalent used to live in
  // this repository; the other (MOTIR-3666) stays in motir-core and names what
  // left, because a link it draws can no longer be a same-origin path. Both
  // sentences are about history and both are still true; the directory is not
  // coming back.
  {
    file: 'design/public-site/design-notes.md',
    path: 'app/(public)/legal',
    why: 'The chrome-comparison table names where each surface was served in motir-core before the move. MOTIR-4103 deleted `app/(public)/legal/` — and with it the whole `(public)` route group — so the citation is a point-in-time record of the host this asset exists to move those pages OFF.',
  },
  {
    file: 'design/ai-settings/design-notes.md',
    path: 'app/(public)/legal',
    why: "The same deletion, cited from the other side (MOTIR-3666 §D3). The Planner card's promise links to `/legal/model-providers`, and the note names BOTH halves of what left — `content/legal/` and the route that served it — because the implementing card has to resolve that href through motir-core's public-site origin rather than as a same-origin path. Naming the absent directory is the point of the sentence, so the citation is deliberate and permanent.",
  },
  // ── The org-tier ACCEPTANCE-VIDEO card, deleted (MOTIR-5172) ────────────
  // A deletion, the same shape as the rows above. The switch moved to
  // `Project settings ▸ Approvals`, and MOTIR-5172 deleted the org-tier control.
  // The approvals mock's header says the room was drawn against SHIPPED REALITY —
  // that the old card was rendered from its own source first — and that sentence
  // is history that stays true. The file is not coming back; the row is permanent.
  {
    file: 'design/projects/approvals.mock.html',
    path: 'app/(authed)/settings/organization/_components/AcceptanceVideoCard.tsx',
    why: "A point-in-time record in the mock's header comment: the org-tier control MOTIR-4942 rendered from its own source before drawing the room that replaces it. MOTIR-5172 deleted that card when the switch left the organisation tier; the sentence is about what was rendered, and it is still true.",
  },
  // ── The `(planning)` ROUTE GROUP, deleted (MOTIR-4732, under MOTIR-4725) ──
  // The same shape as the `app/(public)/legal` rows above — a deletion, not a
  // move — and the largest one this table has held, because the group these
  // eight cite was a surface six areas had reason to name.
  //
  // The planning workspace is an OVERLAY now: `PlanningWorkspaceOverlay` mounts
  // once in `app/(authed)/layout.tsx`, opened by four namespaced query
  // parameters on whatever page the reader is already on, and the one path left
  // at `/planning` is a forward for old links inside `(authed)`. So
  // `app/(planning)/layout.tsx`, `.../loading.tsx` and `.../planning/page.tsx`
  // are gone, and none of them is coming back.
  //
  // Every one of these citations is a sentence about HISTORY that is still
  // TRUE — *what the frame used to be*, *where the nudge used to render*, *which
  // `loading.tsx` this story did not touch* — and correcting them would mean
  // rewriting six assets to un-say things they correctly said when they were
  // drawn. `design/ai-chat/design-notes.md` is the one asset that already
  // re-states it: its sheet 6 was redrawn for the overlay (MOTIR-4726) and both
  // its citations sit inside the AMENDED block explaining what the route WAS.
  // These rows are permanent and carry no delete-me instruction.
  {
    file: 'design/ai-chat/design-notes.md',
    path: 'app/(planning)/layout.tsx',
    why: "Sheet 6's `⚠️ AMENDED 2026-09-06` block, naming the route the overlay replaced so a reader can see what changed. The sentence is in the past tense already; the path is what it is about.",
  },
  {
    file: 'design/ai-chat/design-notes.md',
    path: 'app/(planning)/loading.tsx',
    why: "The overlay's state table: the Opening row says the in-dialog `PlanningWorkspaceSkeleton` *is the frame `app/(planning)/loading.tsx` used to be*. Naming the retired file is the whole content of that row.",
  },
  {
    file: 'design/audit-coverage/design-notes.md',
    path: 'app/(planning)/planning/page.tsx',
    why: 'Records where the audit-coverage nudge rendered — the page that hosted `PlanningWorkspaceHost` when MOTIR-2250 placed it. The nudge still renders on the workspace; the workspace is no longer a page.',
  },
  {
    file: 'design/roadmap/design-notes.md',
    path: 'app/(planning)/planning/page.tsx',
    why: "The silent-fallback rule cites `/planning`'s own `?item=` handling as the precedent the roadmap mirrors. The precedent is still the precedent; its file moved into `PlanningWorkspaceOverlay` and the parameter is `planItem` now.",
  },
  {
    file: 'design/roadmap/roadmap-arrival.mock.html',
    path: 'app/(planning)/planning/page.tsx',
    why: 'The same sentence, in the mock the notes above describe. Assets and their notes carry the citation identically by design.',
  },
  {
    file: 'design/settings/arrival.mock.html',
    path: 'app/(planning)/loading.tsx',
    why: 'The *nothing else under `app/` is touched* scope line, naming the two `loading.tsx` files that story deliberately left alone. A scope boundary is a point-in-time statement about the tree it was drawn against.',
  },
  {
    file: 'design/settings/design-notes.md',
    path: 'app/(planning)/loading.tsx',
    why: 'The same scope line in the notes beside that mock.',
  },
  {
    file: 'design/shell/design-notes.md',
    path: 'app/(planning)/loading.tsx',
    why: "The navigation-pending grammar's rule 5, naming the pre-existing boundaries it declares out of scope. MOTIR-3492's argument is unaffected — one of the files it set aside has since been deleted, which is a smaller tree, not a different rule.",
  },
  // ── A path the design says must NEVER exist (MOTIR-3492) ──────────────────
  // The inverse of every other row here: these are not paths an asset expects
  // to find, they are the files the design forbids. A `loading.tsx` fallback
  // renders once its ancestor layouts resolve — before the page function runs —
  // which flushes the response head and fixes the status at 200, so a
  // `notFound()` reached later renders the not-found BODY under a 200. Eleven
  // `app/(authed)` pages call `notFound()`, five of them under `settings/`.
  // `motir-core/CLAUDE.md` § *A `loading.tsx` may NOT sit above a route that
  // decides existence* carries the rule and the A/B;
  // `tests/navigation/loading-boundary-guard.test.ts` is the guard on the shape.
  //
  // These rows are asserted TIGHT like every other, and here that cuts the
  // useful way round: the day one of these files is created, its finding stops
  // firing, the row goes stale and THIS suite goes red. The exemption is also
  // an alarm.
  {
    file: 'design/shell/design-notes.md',
    path: 'app/(authed)/settings/loading.tsx',
    why: 'MOTIR-3492 — named as the file the settings family may NOT have, because five of the eleven existence-deciding authed routes sit under `settings/`. Its absence is the design.',
  },
  {
    file: 'design/work-items/design-notes.md',
    path: 'app/(authed)/items/[key]/loading.tsx',
    why: 'MOTIR-3492 — the boundary MOTIR-3435 shipped and that was reverted, named in the amendment that explains why the frame moved in-page. `/items/[key]` calls `notFound()` as a documented no-existence-leak contract.',
  },
  {
    file: 'design/work-items/detail-arrival.mock.html',
    path: 'app/(authed)/items/[key]/loading.tsx',
    why: 'The same reverted file, named in the mock header comment so a reader of the asset alone learns why the frame is not a route file. Same reason it must stay absent.',
  },
  // ── A slash in prose that is not a path ───────────────────────────────────
  {
    file: 'design/epic-privacy/design-notes.md',
    path: 'public/non-member',
    why: 'Prose alternation — "a public/non-member viewer" — not a path. `public/` being a real root is the whole reason it matches.',
  },
  {
    file: 'design/public-projects/design-notes.md',
    path: 'public/non-member',
    why: 'The same alternation in the sibling asset — "a public/non-member viewer lands on".',
  },
  {
    file: 'design/onboarding-migrate/design-notes.md',
    path: 'design/build',
    why: 'A verb pair — "Nothing to design/build here for the plan screen itself" — not the `design/` folder.',
  },
  {
    file: 'design/work-items/attachments.mock.html',
    path: 'docs/text/markdown',
    why: "The attachment-icon legend's docs group and its MIME type (`text/markdown`), read as one token because `docs/` is a real root.",
  },
  {
    file: 'design/work-items/design-notes.md',
    path: 'docs/text',
    why: 'The same legend in the design notes — the row label "docs/text (`msword`, docx, `text/plain`, `text/markdown`)".',
  },
  // ── Sample data, not this repo's tree ─────────────────────────────────────
  {
    file: 'design/coding-convention/convention.mock.html',
    path: 'app/api/auth/route.ts',
    why: "A fabricated code-review finding's `coderef`, paired with `src/repositories/userRepo.ts` — a `src/` root this repo does not have. The mock shows the report, not this codebase.",
  },
  // ── The asset asserts the path does NOT exist ─────────────────────────────
  {
    file: 'design/brand/design-notes.md',
    path: 'design/brand/brand-mark.design-notes.md',
    why: "The asset's own File-name note, recording the filename the card asked for and why it ships as `design/brand/design-notes.md` instead. It has to name the path it did not use.",
  },
  // ── Forward-looking: the asset proposes the file ──────────────────────────
  {
    file: 'design/shell/design-notes.md',
    path: 'app/(authed)/loading.tsx',
    why: 'NOT BUILT, and deliberately. The navigation-pending grammar (MOTIR-3431) designs a group-level pending frame; MOTIR-3492 records the A/B that established that a `loading.tsx` there flushes a 200 response head before the page runs, destroying the `notFound()` 404 on all 11 authed routes that decide existence — including a no-existence-leak contract. Hoisting the gate into a layout was built and measured and does not recover it. The asset stands as the design of record for a frame that must be re-shaped as an in-page <Suspense> below each gate; see the coding convention § *A `loading.tsx` may NOT sit above a route that decides existence*.',
  },
  {
    file: 'design/shell/navigation-pending.mock.html',
    path: 'app/(authed)/loading.tsx',
    why: 'The same reference in the mock beside those notes — Panel D names the file the group frame was to live in. Same reason it does not exist: a boundary at the group root cannot coexist with the 404 contracts beneath it.',
  },
  {
    file: 'design/ai-usage/usage.mock.html',
    path: 'components/ui/Skeleton',
    why: 'Forward-looking: `components/ui/` has no Skeleton primitive; the loading state is proposed here, drawn inline.',
  },
  {
    file: 'design/billing/billing.mock.html',
    path: 'components/ui/Skeleton',
    why: 'Forward-looking: the same unbuilt Skeleton primitive.',
  },
  {
    file: 'design/billing/ci-line.mock.html',
    path: 'components/ui/Skeleton',
    why: 'Forward-looking: the same unbuilt Skeleton primitive.',
  },
  {
    file: 'design/org-admin/members-billing.mock.html',
    path: 'components/ui/Skeleton',
    why: 'Forward-looking: the same unbuilt Skeleton primitive.',
  },
  {
    file: 'design/org-admin/org-admin.mock.html',
    path: 'components/ui/Skeleton',
    why: 'Forward-looking: the same unbuilt Skeleton primitive.',
  },
  {
    file: 'design/import/design-notes.md',
    path: 'components/ui/Progress',
    why: 'Forward-looking, and the asset says so inline — "if reused elsewhere it becomes a `components/ui/Progress` primitive (per-component growth)".',
  },
  // (`design/platform-admin/design-notes.md` cited `app/(admin)/admin` as
  //  forward-looking. MOTIR-2896 created the route group and its directory, so
  //  this row expired too, together with its address half above.)
  // (`design/cli-guide/`'s two assets cited `packages/cli/src/commandCatalog.ts`
  //  as forward-looking. MOTIR-2324 built it, so both rows expired and are
  //  gone — the same mechanism, one sweep down, as the address table above.)
  // (`design/mcp-server/design-notes.md` cited `lib/apiDocs/mcp.ts` as
  //  forward-looking. MOTIR-2309 built it, so the row expired and is gone —
  //  the same mechanism the address table above records, one sweep down.)
  // (§5's favicon set — `app/icon.svg`, `app/apple-icon.png`, `app/manifest.ts`,
  //  cited by both brand assets — was parked here as forward-looking. MOTIR-1150
  //  shipped all three, so the six rows are gone: `expired()` is what turned
  //  "that card merged" into a failing test rather than a silent exemption.)
  // (The six STALE rows this sweep parked on its first run — `app/(authed)/board`
  //  ×2, `components/plans`, `components/automation`,
  //  `app/_components/PublicFrontDoor.tsx`, `scripts/plan-seed/data/story-6.16.ts`
  //  — are gone: MOTIR-2369 corrected all six assets, so `expired()` below is what
  //  turned "that card landed" into a failing test rather than a stale exemption.
  //  Two were claim corrections, not repoints: the marketing hero left this repo
  //  with MOTIR-1457, and Story 6.16 never had a seed file to name.)
  {
    file: 'design/brand/design-notes.md',
    path: 'app/icon-192.png',
    why: "Not a citation: §5's ⚠️ blockquote names the path the maskable icons did NOT take, and says why — Next's static-metadata matcher is `icon\\d?`, so `app/icon-<size>.png` is served at no URL and the manifest entry would 404. MOTIR-1150 put them in `public/`; the asset records the rejected path so the next reader does not re-propose it.",
  },
  {
    file: 'design/brand/design-notes.md',
    path: 'app/icon1.png',
    why: "Not a citation: the same blockquote's second rejected option — `icon1.png` DOES match the matcher, and is worse, because Next would then inject the full-bleed maskable renders as browser favicons from a content-hashed URL a static manifest cannot name.",
  },

  // ── Forward-looking: the DISPATCH RUN decision record (MOTIR-1790) ────────
  //    Exactly the shape the note below records, one story later, and the same
  //    two rows for the same reason: `design/runs/` (MOTIR-1795) cites the ADR
  //    it is built to, the ADR is MOTIR-1790's deliverable, and the two reach
  //    `main` through DIFFERENT pull requests — the design ships alone because
  //    it is a STOPPER that needs sign-off before its dependents build on it,
  //    while the record rides the story's parent branch.
  //
  //    ⚠️ THESE TWO ROWS DELETE THEMSELVES when the parent pull request brings
  //    `docs/decisions/dispatch-run-record.md` into the tree. `carries no
  //    KNOWN_PATHS entry that has stopped applying` below is what turns that
  //    into a red build rather than a stale exemption — nobody has to remember.

  // (The two FORWARD-LOOKING rows for `docs/decisions/work-item-todo-list.md`
  //  lived here for exactly as long as their own `why` said they would. The
  //  asset cites the ADR, the ADR is MOTIR-3811's deliverable, and the two
  //  reached `main` through different pull requests — so for the length of the
  //  design PR the citation named a file that branch did not carry. Both rows
  //  expired the moment the parent branch brought the record into the tree, and
  //  `carries no KNOWN_PATHS entry that has stopped applying` is what turned
  //  that into a red build rather than a stale exemption. The citations are
  //  guarded like any other from here.)

  // (Three rows sat here and all three deleted themselves with this branch,
  //  exactly as their own `why` instructed:
  //    * `components/ui/Checkbox.tsx`  — created by MOTIR-2465;
  //    * `lib/permissions/limits.ts` x2 — created by MOTIR-2472, exempted while
  //      the DESIGN STOPPER merged ahead of this code branch.
  //  All three paths now resolve, so each is a real citation again and is
  //  guarded like any other. An exemption cannot outlive its reason — and the
  //  `carries no KNOWN_PATHS entry that has stopped applying` test below is
  //  what made sure nobody had to remember.)
  // MOTIR-2653 CREATED `app/(authed)/home/page.tsx`, so its forward-looking row
  // is gone — deleted by the card that built the file, in the same commit.
  // (Story 8.9's two rows lived here for one commit and deleted themselves the
  //  moment 8.9.1's decision record joined this branch — which is what their own
  //  `why` said would happen, enforced by the tight test below rather than by
  //  anyone remembering.)
  // MOTIR-1136 CREATED `app/(authed)/settings/account/data/page.tsx`, so
  // MOTIR-3680's forward-looking row is gone — deleted by the card that built
  // the file, in the same commit that landed it beside its `ACCOUNT_SETTINGS_NAV`
  // entry, exactly as that row's own `why` instructed.

  // ── The public rendering files were deleted (MOTIR-3951) ──
  {
    file: 'design/agent-sandbox/agent-sandbox.mock.html',
    path: 'app/(public)/explore/_components/ExploreTopBar.tsx',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/agent-sandbox/design-notes.md',
    path: 'app/(public)/docs/_components/OperationSection.tsx',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/api-docs/api-docs.mock.html',
    path: 'app/(public)/explore/_components/ExploreTopBar.tsx',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/api-docs/design-notes.md',
    path: 'app/(public)/docs',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/api-docs/design-notes.md',
    path: 'app/(public)/docs/_components/CatalogueNav.tsx',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/api-docs/design-notes.md',
    path: 'app/(public)/explore',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/api-docs/design-notes.md',
    path: 'app/(public)/explore/_components/ExploreTopBar.tsx',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/api-docs/design-notes.md',
    path: 'tests/api-docs',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/api-docs/docs-index.mock.html',
    path: 'app/(public)/docs/layout.tsx',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/api-docs/docs-index.mock.html',
    path: 'app/(public)/explore/_components/ExploreTopBar.tsx',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/brand/brand-mark.mock.html',
    path: 'app/(public)/_components/PublicTopBar.tsx',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/brand/brand-mark.mock.html',
    path: 'app/(public)/explore/_components/ExploreTopBar.tsx',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/brand/brand-mark.mock.html',
    path: 'app/(public)/p/[identifier]/opengraph-image.tsx',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/brand/design-notes.md',
    path: 'app/(public)/_components/PublicTopBar.tsx',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/brand/design-notes.md',
    path: 'app/(public)/explore/_components/ExploreTopBar.tsx',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/cli-guide/cli-guide.mock.html',
    path: 'app/(public)/explore/_components/ExploreTopBar.tsx',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/design-system/design-notes.md',
    path: 'app/(public)/_components/PublicRoadmapVote.tsx',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    // ⚠️ RE-KEYED, not added (MOTIR-4779): `design/home/` was renamed to
    // `design/workbench/` with the surface. An exemption left on the old path
    // is a stale claim about a file that does not exist, and the asset it
    // covers loses its exemption in the same commit.
    file: 'design/workbench/design-notes.md',
    path: 'app/(public)/_components/PublicTabNav.tsx',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/mcp-server/mcp-server.mock.html',
    path: 'app/(public)/explore/_components/ExploreTopBar.tsx',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/public-projects/design-notes.md',
    path: 'app/(public)/_components/PublicOverviewHero.tsx',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/public-projects/design-notes.md',
    path: 'app/(public)/_components/PublicTopBar.tsx',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/public-projects/public-changelog.mock.html',
    path: 'app/(public)/_components/PublicTabNav.tsx',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/public-projects/public-signin-modal.mock.html',
    path: 'app/(public)/_components',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/public-site/design-notes.md',
    path: 'app/(public)/explore/_components',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/public-site/design-notes.md',
    path: 'app/(public)/explore/_components/ExploreTopBar.tsx',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/settings/arrival.mock.html',
    path: 'app/(public)/explore/(square)/loading.tsx',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/settings/design-notes.md',
    path: 'app/(public)/explore/(square)/loading.tsx',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/shell/design-notes.md',
    path: 'app/(public)/explore/(square)/loading.tsx',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/shell/navigation-pending.mock.html',
    path: 'app/(public)/explore/(square)/loading.tsx',
    why: 'The public rendering surface moved to motir-marketing (MOTIR-3951); this asset is a point-in-time record of the file before it was deleted.',
  },
  {
    file: 'design/github/design-notes.md',
    path: 'app/(authed)/settings/workspace/github',
    why: 'MOTIR-4680 moved the git connect surface to the ORGANISATION tier and DELETED this route; `/settings/workspace/github` is now a permanent redirect. The assets cite the file as the surface they were drawn against, which is what a point-in-time record is for. Enumerated from a run of this lane.',
  },
  {
    file: 'design/repository-set/design-notes.md',
    path: 'app/(authed)/settings/workspace/github',
    why: 'MOTIR-4680 moved the git connect surface to the ORGANISATION tier and DELETED this route; `/settings/workspace/github` is now a permanent redirect. The assets cite the file as the surface they were drawn against, which is what a point-in-time record is for. Enumerated from a run of this lane.',
  },
  {
    file: 'design/repository-set/design-notes.md',
    path: 'app/(authed)/settings/workspace/github/page.tsx',
    why: 'MOTIR-4680 moved the git connect surface to the ORGANISATION tier and DELETED this route; `/settings/workspace/github` is now a permanent redirect. The assets cite the file as the surface they were drawn against, which is what a point-in-time record is for. Enumerated from a run of this lane.',
  },
  {
    file: 'design/repository-set/repositories-room.mock.html',
    path: 'app/(authed)/settings/workspace/github/page.tsx',
    why: 'MOTIR-4680 moved the git connect surface to the ORGANISATION tier and DELETED this route; `/settings/workspace/github` is now a permanent redirect. The assets cite the file as the surface they were drawn against, which is what a point-in-time record is for. Enumerated from a run of this lane.',
  },
  {
    file: 'design/repository-set/repository-set.mock.html',
    path: 'app/(authed)/settings/workspace/github/page.tsx',
    why: 'MOTIR-4680 moved the git connect surface to the ORGANISATION tier and DELETED this route; `/settings/workspace/github` is now a permanent redirect. The assets cite the file as the surface they were drawn against, which is what a point-in-time record is for. Enumerated from a run of this lane.',
  },
  {
    file: 'design/repository-set/takeover.mock.html',
    path: 'app/(authed)/settings/workspace/github/page.tsx',
    why: 'MOTIR-4680 moved the git connect surface to the ORGANISATION tier and DELETED this route; `/settings/workspace/github` is now a permanent redirect. The assets cite the file as the surface they were drawn against, which is what a point-in-time record is for. Enumerated from a run of this lane.',
  },
  // ── ⚠️ FOUR ROWS FOR `docs/decisions/internal-billing-classification.md`
  //    STOOD HERE AND ARE GONE (Story MOTIR-4337). They exempted four assets
  //    that cite MOTIR-4563's ADR while it sat on an unmerged parent branch, and
  //    they carried a delete-me instruction for the moment the parent landed.
  //    The design merged first, so the assets and the ADR now sit on ONE branch
  //    and the citations resolve — `carries no KNOWN_PATHS entry that has
  //    stopped applying` is what said so, on the run that merged them.  // ── The My agents list mock is PUBLISHED, not committed (MOTIR-6868) ─────
  //  MOTIR-6868's design result was published from `f953bda2b` on
  //  `parent/MOTIR-6860-agent-instances` and its two files never landed on a
  //  branch; `docs/decisions/design-result.md` AMENDMENT 5 Q1 makes the published
  //  result the source of truth and committing optional. MOTIR-6937's delta
  //  amends it and must cite it BY PATH (CLAUDE.md: a delta cites the mock it
  //  amends), and the read door (`get_design MOTIR-6868`, or `list_designs` with
  //  `pathPrefix: design/my-agents/`) resolves that path. DELETE-ME: if the base
  //  mock is ever committed, `carries no KNOWN_PATHS entry that has stopped
  //  applying` turns red and these two rows go.
  {
    file: 'design/my-agents/design-notes.md',
    path: 'design/my-agents/my-agents.mock.html',
    why: "MOTIR-6868's published (never committed) list mock, which the panel delta amends and cites by path — resolved through the design-result read door, not the tree.",
  },
  {
    file: 'design/my-agents/my-agents--panel.mock.html',
    path: 'design/my-agents/my-agents.mock.html',
    why: "MOTIR-6868's published (never committed) list mock, which the panel delta amends and cites by path — resolved through the design-result read door, not the tree.",
  },
];

describe('a design asset — and the sources it mirrors — cite source paths that still exist', () => {
  it('finds no cited repo path that resolves to nothing', () => {
    expect(
      unlisted(sweepPaths().map(reconcilablePath), KNOWN_PATHS.map(pathIdOf)),
      'A design asset tells the next agent which shipped file to mirror; a path it names that ' +
        'does not exist sends that agent looking for nothing, and what it does next is improvise. ' +
        'The same holds for a MIRRORED_SOURCES file, whose comments are copied into assets ' +
        'verbatim. Correct the file, or add the pair to KNOWN_PATHS with a reason if the path ' +
        'is deliberate.',
    ).toEqual([]);
  });

  it('carries no KNOWN_PATHS entry that has stopped applying', () => {
    expect(
      expired(sweepPaths().map(reconcilablePath), KNOWN_PATHS.map(pathIdOf)),
      'These KNOWN_PATHS entries no longer match anything — the asset was corrected or the file ' +
        'now exists. Delete them, so the pair is guarded again.',
    ).toEqual([]);
  });

  it('lists every KNOWN_PATHS entry with a reason', () => {
    expect(KNOWN_PATHS.filter((entry) => entry.why.trim().length < 20)).toEqual([]);
  });

  it('parks no finding as STALE without naming the card that clears it', () => {
    // The same rule the address table above carries, and it reached the same
    // place one sweep later: this table parked six of its own first-run
    // findings rather than fixing them, MOTIR-2369 cleared all six, and none
    // remains. The rule outlives them, because parking the NEXT batch is the
    // same temptation — so it no longer requires a STALE row to exist (that
    // would oblige the table to keep one forever), only that any row calling
    // itself STALE cites the card that clears it.
    const stale = KNOWN_PATHS.filter((entry) => entry.why.startsWith('STALE'));
    expect(stale.filter((entry) => !/MOTIR-\d+/.test(entry.why))).toEqual([]);
  });
});

// ── The sweep, seen failing ─────────────────────────────────────────────────
//
// A guard that has never been observed to fail is not evidence. These run the
// real extractor and the real resolver over the assets' own pre-fix content —
// verbatim from `git show 44e55eff`, the last revision before this card's
// correction — and assert the sweep would have named them.
describe('the source-path sweep catches the drift it was written for', () => {
  const missing = (source: string) =>
    [
      ...new Set(
        pathsIn(source)
          .map(toRepoPath)
          .filter((path): path is string => path !== null)
          .filter((path) => !resolvesInRepo(path)),
      ),
    ].sort();

  it('names the stale directory in a design-notes citation', () => {
    // `design/work-items/design-notes.md` L3349 and L3356, and `design/ready/
    // design-notes.md` L217 — the "which file to open" lines.
    expect(
      missing(
        [
          '- **`app/(authed)/issues/[key]/_components/IssueExplanation.tsx`** — the detail',
          '- **`app/(authed)/issues/[key]/edit/_components/EditIssueForm.tsx`** — an',
          '| row peek               | `app/(authed)/issues/_components/IssueQuickView.tsx`      |',
        ].join('\n'),
      ),
    ).toEqual([
      'app/(authed)/issues/[key]/_components/IssueExplanation.tsx',
      'app/(authed)/issues/[key]/edit/_components/EditIssueForm.tsx',
      'app/(authed)/issues/_components/IssueQuickView.tsx',
    ]);
  });

  it('names it inside a mockup comment, where no backtick marks it as code', () => {
    // `design/work-items/list.mock.html` L193 and `design/boards/board.mock.html`
    // L19 — a CSS comment and an HTML one. Ten of the nineteen citations looked
    // like this, which is why the extractor cannot require a code span.
    expect(
      missing(
        [
          '      /* ── Page shell — header + toolbar (mirrors app/(authed)/issues/page.tsx) ─ */',
          '      primitives from app/(authed)/issues/_components/issueCellPrimitives.tsx —',
        ].join('\n'),
      ),
    ).toEqual([
      'app/(authed)/issues/_components/issueCellPrimitives.tsx',
      'app/(authed)/issues/page.tsx',
    ]);
  });

  it('passes the corrected citations that shipped in their place', () => {
    expect(
      missing(
        [
          '- **`app/(authed)/items/[key]/_components/IssueExplanation.tsx`** — the detail',
          '      /* ── Page shell — header + toolbar (mirrors app/(authed)/items/page.tsx) ─ */',
          '      primitives from app/(authed)/items/_components/issueCellPrimitives.tsx —',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('leaves the citations the rename did NOT touch alone', () => {
    // The reason a referrer sweep for "issues" could not be used: these two
    // directories still exist, and their citations are correct.
    expect(
      missing(
        'the SHIPPED `components/issues/WorkItemTypeChip.tsx` and `lib/issues/issueListFilter.ts`',
      ),
    ).toEqual([]);
  });

  it('ignores a slash in prose that is not anchored on a repo directory', () => {
    expect(missing('a `Card`/`Pill` split, in green/mint, per the and/or rule')).toEqual([]);
  });

  it('resolves an extension-less citation the way an import specifier reads', () => {
    expect(missing('composed from `components/ui/Card` and `components/ui/Pill`')).toEqual([]);
  });
});

// ── The widening, seen failing ─────────────────────────────────────────────
//
// Same contract as the block above: a guard that has never been observed to
// fail is not evidence. These run the real extractor and the real resolver
// over the mirrored file's own pre-fix content.
describe('the sweep reaches the file a design asset mirrors', () => {
  const missing = (source: string) =>
    [
      ...new Set(
        pathsIn(source)
          .map(toRepoPath)
          .filter((path): path is string => path !== null)
          .filter((path) => !resolvesInRepo(path)),
      ),
    ].sort();

  it('opens every MIRRORED_SOURCES entry, and each one still exists', () => {
    // A findings-based assertion cannot see this: the file is swept whether or
    // not it has findings, and a clean file looks identical to one nobody read.
    // So assert the INPUT set, which is the thing a typo silently empties.
    expect(MIRRORED_SOURCES.filter((path) => !existsSync(join(ROOT, path)))).toEqual([]);
    const swept = new Set(sweptSources().map((path) => relative(ROOT, path).split(sep).join('/')));
    expect(MIRRORED_SOURCES.filter((path) => !swept.has(path))).toEqual([]);
  });

  it('names the dead citation design/** could only ever see in a copy', () => {
    // `packages/design-system/theme.css` as it stood above the `--el-avatar-*`
    // ramp until MOTIR-4344 — verbatim, comment marker and all.
    expect(
      missing(
        [
          '  /* Avatar ramp — KEEP the named keys (peach…yellow): lib/projects/avatar.ts persists',
          '     project.avatarColor ∈ these strings, so numbering them would break stored rows',
          '     (spec §7.1, rung-2 migration safety). */',
        ].join('\n'),
      ),
    ).toEqual(['lib/projects/avatar.ts']);
  });

  it('names an extension-less citation of a test file, which reads as resolved and is not', () => {
    // The other two findings the widening surfaced in the same file. A `.test.ts`
    // citation that drops its suffix is NOT an import specifier — nothing imports
    // a spec — so `CITED_EXTENSIONS` cannot rescue it, and the fix is the
    // citation rather than the resolver.
    expect(missing('asserted palette-dependent by tests/theme/paletteTokenCoverage)')).toEqual([
      'tests/theme/paletteTokenCoverage',
    ]);
  });

  it('passes the citations that shipped in their place', () => {
    expect(missing(readFileSync(join(ROOT, 'packages/design-system/theme.css'), 'utf8'))).toEqual(
      [],
    );
  });
});
