import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-4353 — the CLASS guard for MOTIR-4318, whose seven sibling sweeps moved
// eleven assets onto the `--el-*` layer. This is the twelfth card: it stops a
// twelfth ASSET being written the way those eleven were.
//
// ── The defect the class is made of ─────────────────────────────────────────
// Eleven `*.mock.html` files opened with a `:root` block that copied the design
// system's values onto PRIVATE names, usually annotating each line with the
// token it stood for:
//
//     :root {
//       --text:  #1a1a1a;   /* --el-text */
//       --muted: #787671;   /* --el-text-muted */
//       --faint: #a4a097;   /* --el-text-faint */
//     }
//
// The values were right, which is what made it look harmless, and the comment
// naming the correct token made it look deliberate. Three things a raw hex
// cannot do: flip with `data-palette`, follow a re-skin, or be MEASURED. Every
// ink guard in the tree keys on `--el-*` read off the declaration AT THE PAINT
// SITE — `design-ink-contrast` (RESTING) and `design-state-ink-contrast`
// (STATE, MOTIR-4255) — so `color: var(--muted)` is not measured leniently, it
// is not measured at all. Those guards' green was a statement about the set
// they could see. `CLAUDE.md` § *NEVER INVENT A COLOUR* already forbade the
// pattern (MOTIR-2455); a rule nothing measures decays at the rate people
// forget it, and eleven assets carried it anyway.
//
// ── TWO limbs, and the second is the one the class is actually about ────────
//   (a) DECLARATION — every `*.mock.html` declares at least one `--el-*`
//       custom property. Necessary, and on its own NOT sufficient.
//   (b) NO PRIVATE COLOUR ALIAS — no `*.mock.html` declares a custom property
//       that is neither `--el-*` nor a name the design system itself declares,
//       whose value is a bare colour literal.
//
// Limb (a) alone is satisfiable by an asset that declares one token and aliases
// everything else — a file that passes the guard and is exactly as unmeasurable
// as the eleven. `design/ai-chat/planning-workspace.mock.html` is that file,
// and this guard found it on its first run (MOTIR-4428, held in
// `UNSWEPT_ASSETS` below).
//
// ── Why it is a spec and not a rule ─────────────────────────────────────────
// Same reason as `design-three-file-set.test.ts` (MOTIR-3069), whose file walk,
// fixture-tree pattern and hold-it-tight table this file reuses: the rule was
// written down twice and violated anyway, because the only thing checking it
// was somebody remembering.

const ROOT = process.cwd();
const DESIGN_DIR = join(ROOT, 'design');
const MOCK_SUFFIX = '.mock.html';

/**
 * The design system's own token file — the source of truth for which custom
 * property names are the SYSTEM's rather than an author's.
 *
 * Deriving the legitimate set from this file rather than from a prefix list is
 * what makes limb (b) a predicate about the CONCEPT instead of about a spelling
 * (`plan-rules` / lessons: *a path-shaped criterion is a proxy — write the
 * predicate against the concept*). A prefix rule saying "`--color-*` is fine"
 * would wave through an INVENTED `--color-orb-lit: #a78bfa`, which is the
 * defect MOTIR-3217 was filed for, in one of the very files this guard reads.
 */
const THEME_PATH = join(ROOT, 'packages/design-system/theme.css');

// ── The pure core ───────────────────────────────────────────────────────────
// Every check below is a function of a LISTING of `{ path, source }`, so the
// negative path is exercised on fixtures rather than only by the real tree
// passing. On a healthy tree every assertion over the real listing compares
// against `[]` — a guard whose failure path never runs is a guard nobody knows
// is running (`inkContrastScan`'s own words, MOTIR-2459).

export type MockSource = { path: string; source: string };

/** CSS with `/* … *\/` comments removed. */
const stripCssComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, ' ');

/**
 * The CSS a document actually DECLARES: every `<style>` block plus every
 * `style="…"` attribute, comments stripped.
 *
 * ⚠️ SCOPING THIS TO STYLE SOURCE IS LOAD-BEARING FOR LIMB (a), and it is the
 * exact trap the defect this guard rules on is built out of. The eleven assets
 * name the correct token in a COMMENT beside each alias
 * (`--muted: #787671; /* --el-text-muted *\/`), and several mocks render a token
 * LEGEND as page content — so a whole-file search for `--el-…` finds an
 * `--el-*` string in a file that declares none. Reading the declaration where
 * the browser reads it is the difference between measuring the token layer and
 * measuring the prose about it. (The lesson: *a search returns a line; the
 * warrant lives in the lines around it* — a criterion searching a whole file
 * for a string that also appears in that file's own comments can never mean
 * what it says.)
 */
export function styleSourceOf(html: string): string {
  const blocks: string[] = [];
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) blocks.push(match[1]!);
  for (const match of html.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)) blocks.push(match[1]!);
  for (const match of html.matchAll(/\sstyle\s*=\s*'([^']*)'/gi)) blocks.push(match[1]!);
  return stripCssComments(blocks.join('\n'));
}

/** A custom-property DECLARATION — the name and its value, never a `var()` use. */
const DECLARATION = /(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]*)/g;

export type Declaration = { name: string; value: string };

/** Every custom property DECLARED in a stylesheet, in source order. */
export function declarationsOf(css: string): Declaration[] {
  return [...css.matchAll(DECLARATION)].map((match) => ({
    name: match[1]!,
    value: match[2]!.trim(),
  }));
}

/**
 * A value that is NOTHING BUT a colour literal.
 *
 * "Bare" is the whole predicate: `--shadow-card: 0 1px 2px rgba(0,0,0,.1)` is a
 * SHADOW that contains a colour, not a colour alias, and `--ring:
 * color-mix(in srgb, var(--el-accent) 30%, transparent)` is a derivation whose
 * inputs are tokens. Neither copies a palette value onto a private name, which
 * is the class this rules on, so neither matches. The named forms cover the
 * four hex lengths CSS allows and the functional notations in use; a value that
 * is a bare colour in a notation not listed here is a finding this guard misses
 * rather than one it wrongly clears, so widening the list is safe and narrowing
 * it is not.
 */
const COLOUR_LITERAL =
  /^(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\([^()]*\))$/i;

/**
 * Tailwind's own private custom-property namespace, emitted by the COMPILER
 * into every mock that embeds a Tailwind build (`--tw-ring-offset-color: #fff`,
 * `--tw-gradient-from: #0000`, `--tw-shadow-color: …`).
 *
 * These are machine output, not authored aliases: nobody chose the name, no
 * sweep can rewrite them without hand-editing generated CSS, and they stand in
 * for no design-system token. Excluding the namespace with a written reason is
 * honest; twenty-odd allowlist rows carrying one reason between them would be
 * the mute button the allowlist exists to prevent. It is asserted NON-VACUOUS
 * below, so if Tailwind ever stops emitting them this exclusion fails rather
 * than lingering as dead permission.
 */
const GENERATED_PREFIX = '--tw-';

/** The area an asset lives in: `design/boards/board.mock.html` → `design/boards`. */
export const areaOf = (path: string): string => path.slice(0, path.lastIndexOf('/'));

/** Every custom-property NAME the design system itself declares. */
export function systemTokenNames(themeCss: string): Set<string> {
  return new Set(declarationsOf(stripCssComments(themeCss)).map((declaration) => declaration.name));
}

/**
 * LIMB (a): every mock that declares no `--el-*` custom property at all,
 * reported with the remedy. Sorted, and EVERY failing file — not just the
 * first, because the population this guard was written for was eleven.
 */
export function missingElementLayer(mocks: MockSource[]): string[] {
  return mocks
    .filter(
      ({ source }) =>
        !declarationsOf(styleSourceOf(source)).some(({ name }) => name.startsWith('--el-')),
    )
    .map(
      ({ path }) =>
        `${path} declares no \`--el-*\` custom property — re-point it at the token layer: ` +
        `declare the \`--el-*\` block (copy of record: design/ai-planning/plan-revision.mock.html) ` +
        `and paint from \`var(--el-…)\` at every site, or no ink guard in the tree can see this asset`,
    )
    .sort();
}

/**
 * LIMB (b): every custom property a mock declares that is neither `--el-*` nor
 * a name the design system declares nor a compiler's own, whose value is a bare
 * colour literal.
 *
 * Reported as one finding per (file, property) so a row can be dispositioned
 * individually, sorted, and all of them — same reason as limb (a).
 */
export function privateColourAliases(mocks: MockSource[], systemTokens: Set<string>): string[] {
  const findings: string[] = [];
  for (const { path, source } of mocks) {
    for (const { name, value } of declarationsOf(styleSourceOf(source))) {
      if (name.startsWith('--el-')) continue;
      if (name.startsWith(GENERATED_PREFIX)) continue;
      if (systemTokens.has(name)) continue;
      if (!COLOUR_LITERAL.test(value)) continue;
      findings.push(
        `${path} declares ${name}: ${value} — a private colour alias. ` +
          `Use the \`--el-*\` token that carries this role, or express it as a ` +
          `\`color-mix()\` of tokens; a raw hex on a private name cannot follow a ` +
          `\`data-palette\` swap and is invisible to every ink guard.`,
      );
    }
  }
  return [...new Set(findings)].sort();
}

/** The (file, property) pair a finding is about, for matching against a table. */
export const pairOf = (finding: string): string => {
  const [path, , property] = finding.split(' ');
  return `${path} ${property!.replace(/:$/, '')}`;
};

/** The file a finding is about. */
export const fileOf = (finding: string): string => finding.split(' ')[0]!;

// ── The hue allowlist — the card's escape hatch, and it is NOT for debt ──────
// A row here says: THIS colour cannot be expressed in the token layer. It is
// held TIGHT in both directions below — a row that no longer fires FAILS — so
// the list shrinks and can never quietly grow stale, the same treatment
// `design-three-file-set.test.ts` gives `KNOWN_MISSING_NOTES`.
//
// MOTIR-4318 predicted the roadmap's work-type palette would need rows here. It
// does not: `packages/design-system/theme.css` declares `--el-type-epic` /
// `-story` / `-task` / `-bug` / `-subtask`, and MOTIR-4350's swept
// `design/roadmap/roadmap.mock.html` declares exactly those names inline. So
// the hue list ships with no hue in it, which is the intended resting state.
//
// ⚠️ A DEFECT DOES NOT GO HERE. An asset carrying the MOTIR-4318 pattern is
// debt with a card, and it goes in `UNSWEPT_ASSETS` below, where it is COUNTED.
// The difference between the two tables is the difference between an exemption
// and a countdown.
// Every mock in the style area — one per registered-or-proposed style, each
// rendered the same way (see design/styles/design-notes.md).
const STYLE_MOCKS = readdirSync(join(process.cwd(), 'design', 'styles'))
  .filter((name) => name.endsWith('.mock.html'))
  .map((name) => `design/styles/${name}`);

const KNOWN_PRIVATE_COLOURS: { file: string; property: string; why: string }[] = [
  {
    file: 'design/shell/context-row.mock.html',
    property: '--color-white',
    why:
      "Tailwind v4's generated default `@theme` layer, emitted into this compiled mock's `:host` " +
      'block beside `--font-sans` / `--font-mono`. Machine output, not an authored alias, and it ' +
      "stands in for no design-system token — it is CSS's own achromatic extreme.",
  },
  {
    file: 'design/shell/context-row.mock.html',
    property: '--color-black',
    why:
      "Tailwind v4's generated default `@theme` layer, same block and same reason as " +
      '`--color-white` above: the compiler writes it, `bg-black/10` utilities read it, and no ' +
      'sweep can remove it without hand-editing generated CSS.',
  },
  // The style mocks (MOTIR-10549) are `renderMock` output over the REAL
  // `StyleVignette`, whose modal scrim is `bg-black/10`: the compiler writes
  // `--color-black` for it, the same machine output as context-row's row above.
  ...STYLE_MOCKS.map((file) => ({
    file,
    property: '--color-black',
    why:
      "Tailwind v4's generated default `@theme` layer, written for the shipped `StyleVignette` " +
      "scrim's `bg-black/10`. Machine output, not an authored alias.",
  })),
];

// ── Inherited debt — a COUNT that has to reach zero, with a card ─────────────
// An asset already carrying the MOTIR-4318 pattern when this guard shipped. Not
// an exemption: the count is asserted EXACT in both directions below, so the
// file cannot absorb a thirty-first alias, and the row cannot outlive the sweep
// — it must be deleted in the same diff that fixes the file.
//
// EMPTY IS THE INTENDED RESTING STATE. Adding a row is a deliberate act with a
// card that removes it again — never a way to land a new asset outside the
// token layer.
const UNSWEPT_ASSETS: { file: string; count: number; card: string; why: string }[] = [
  // EMPTY, and it got here the way the table above says it has to: the sweep and
  // the row's deletion in ONE diff (MOTIR-4428, 2026-09-04).
  //
  // The row it held was `design/ai-chat/planning-workspace.mock.html`, count 30 —
  // the TWELFTH asset, found by this guard on its first run, declaring three
  // `--el-*` for MOTIR-3217's floating orb against thirty private aliases. All
  // thirty are now `--el-*` at their points of use, the private `:root` block is
  // gone, and the two ink scanners see the asset for the first time.
];

// ── The real tree ───────────────────────────────────────────────────────────

/** Every file under `design/`, as a repo-relative POSIX path. */
function designTree(dir: string = DESIGN_DIR, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) designTree(path, out);
    else out.push(relative(ROOT, path).split(sep).join('/'));
  }
  return out;
}

const MOCKS: MockSource[] = designTree()
  .filter((path) => path.endsWith(MOCK_SUFFIX))
  .map((path) => ({ path, source: readFileSync(join(ROOT, path), 'utf8') }));

const SYSTEM_TOKENS = systemTokenNames(readFileSync(THEME_PATH, 'utf8'));

describe('every design mock consumes the `--el-*` token layer (MOTIR-4353)', () => {
  it('walks a design tree that actually has mocks in it', () => {
    // Without this every assertion below passes vacuously if the walk breaks or
    // the folder moves — the failure mode a tree-walk guard is most exposed to.
    expect(MOCKS.length).toBeGreaterThan(50);
    expect(MOCKS.every(({ source }) => source.includes('<style'))).toBe(true);
  });

  it("derives the design system's own token names from `theme.css`", () => {
    // The other vacuity risk, and the more dangerous one: an empty or tiny
    // SYSTEM_TOKENS turns limb (b) into a flood, and a *huge* one — a parse
    // that swallowed the file — would turn it silent. Both named tokens are
    // load-bearing elsewhere in this lane, so neither disappears quietly.
    expect(SYSTEM_TOKENS.size).toBeGreaterThan(200);
    expect(SYSTEM_TOKENS.has('--el-text-muted')).toBe(true);
    expect(SYSTEM_TOKENS.has('--color-primary')).toBe(true);
    // And it must NOT be so wide that limb (b) can never fire: the private
    // names the eleven assets used are exactly what the system does not declare.
    expect(SYSTEM_TOKENS.has('--muted')).toBe(false);
    expect(SYSTEM_TOKENS.has('--faint')).toBe(false);
  });

  it('limb (a) — declares an `--el-*` custom property in every mock', () => {
    // MOTIR-4318's own population predicate, now enforced instead of measured
    // once. Eleven assets failed this on 2026-09-03; the seven sweep children
    // took it to zero, and this is what stops it climbing again.
    expect(missingElementLayer(MOCKS)).toEqual([]);
  });

  it('limb (b) — names no private colour alias outside the two tables', () => {
    // The limb the class is actually about: limb (a) is satisfiable by an asset
    // that declares one token and aliases the rest.
    const excused = new Set([...KNOWN_PRIVATE_COLOURS.map((row) => `${row.file} ${row.property}`)]);
    const unswept = new Set(UNSWEPT_ASSETS.map((row) => row.file));
    const unlisted = privateColourAliases(MOCKS, SYSTEM_TOKENS).filter(
      (finding) => !excused.has(pairOf(finding)) && !unswept.has(fileOf(finding)),
    );
    expect(
      unlisted,
      'use the `--el-*` token for these, or add a row to KNOWN_PRIVATE_COLOURS with a reason',
    ).toEqual([]);
  });

  it('holds `KNOWN_PRIVATE_COLOURS` tight — a row that no longer fires fails', () => {
    // The half that stops the table becoming a mute button: a property that
    // gains its token must lose its row in the same diff.
    const firing = new Set(privateColourAliases(MOCKS, SYSTEM_TOKENS).map(pairOf));
    for (const row of KNOWN_PRIVATE_COLOURS) {
      const pair = `${row.file} ${row.property}`;
      expect(firing.has(pair), `${pair} is no longer a private colour alias — drop its row`).toBe(
        true,
      );
      expect(row.why.length, pair).toBeGreaterThan(20);
    }
  });

  it('holds `UNSWEPT_ASSETS` tight — the count is EXACT in both directions', () => {
    // An exemption would let the file rot; a COUNT cannot. One more alias in a
    // listed file fails here, one fewer fails here, and zero fails here — so
    // the row has to be deleted by the diff that sweeps the asset rather than
    // remembered by whoever writes it.
    const byFile = new Map<string, number>();
    for (const finding of privateColourAliases(MOCKS, SYSTEM_TOKENS)) {
      byFile.set(fileOf(finding), (byFile.get(fileOf(finding)) ?? 0) + 1);
    }
    for (const row of UNSWEPT_ASSETS) {
      expect(
        byFile.get(row.file) ?? 0,
        `${row.file} now carries a different number of private colour aliases — ` +
          `if it is 0, ${row.card} has landed and this row must go; otherwise the count moved ` +
          `without the row being updated`,
      ).toBe(row.count);
      expect(row.card, row.file).toMatch(/^MOTIR-\d+$/);
      expect(row.why.length, row.file).toBeGreaterThan(20);
    }
  });

  it('keeps the `--tw-*` exclusion non-vacuous — it still excludes something', () => {
    // The exclusion is a namespace rather than a table, so nothing else would
    // notice it going dead. If Tailwind stops emitting these — or no mock
    // embeds a Tailwind build any more — this fails and the exclusion is
    // deleted rather than left as permission with no subject.
    const generated = MOCKS.flatMap(({ source }) =>
      declarationsOf(styleSourceOf(source)).filter(
        ({ name, value }) => name.startsWith(GENERATED_PREFIX) && COLOUR_LITERAL.test(value),
      ),
    );
    expect(generated.length).toBeGreaterThan(0);
  });
});

// ── The negative cases, on fixtures ─────────────────────────────────────────
// The assertions above compare against `[]` and will do so forever if the tree
// stays healthy, which means they never demonstrate that the check can FAIL. A
// check that cannot go red is not evidence, it is a tautology. These are the
// demonstration, on sources small enough to read.

describe('the token-layer check on a fixture tree', () => {
  const SYSTEM = systemTokenNames(`
    :root {
      --color-primary: #5645d4;
      --color-foreground: #1a1a1a;
      --el-text: var(--color-foreground);
      --el-text-muted: #787671;
    }
  `);

  const mock = (path: string, css: string, body = ''): MockSource => ({
    path,
    source: `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`,
  });

  const HEALTHY = mock(
    'design/boards/board.mock.html',
    `:root {
       --color-primary: #5645d4;
       --el-text: #1a1a1a;
       --el-accent: var(--color-primary);
     }
     .card { color: var(--el-text); }`,
  );

  it('passes a compliant asset', () => {
    expect(missingElementLayer([HEALTHY])).toEqual([]);
    expect(privateColourAliases([HEALTHY], SYSTEM)).toEqual([]);
  });

  it('limb (a) names the file that declares no `--el-*`, and the remedy', () => {
    const aliased = mock(
      'design/roadmap/edges.mock.html',
      ':root { --text: #1a1a1a; --muted: #787671; } .row { color: var(--muted); }',
    );
    const findings = missingElementLayer([aliased]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('design/roadmap/edges.mock.html');
    expect(findings[0]).toContain('re-point it at the token layer');
    expect(findings[0]).toContain('plan-revision.mock.html');
  });

  it("limb (a) is NOT satisfied by a token named in a CSS COMMENT — the defect's own shape", () => {
    // The eleven assets annotate each alias with the token it stands for. A
    // whole-file search for `--el-…` finds a match in every one of them; this
    // is the difference between measuring the token layer and measuring the
    // prose about it.
    const commented = mock(
      'design/ai-chat/target-picker.mock.html',
      `:root {
         /* ── inlined --el-* (light) ── */
         --muted: #787671; /* --el-text-muted */
         --faint: #a4a097; /* --el-text-faint */
       }`,
    );
    expect(commented.source).toContain('--el-text-muted');
    expect(missingElementLayer([commented])).toHaveLength(1);
  });

  it('limb (a) is NOT satisfied by a token printed as page CONTENT', () => {
    // A mock that renders its own token legend prints `--el-…` in the body. The
    // browser declares nothing from it, and neither does this guard.
    const legend = mock(
      'design/design-system/element-tokens.mock.html',
      ':root { --ink: #1a1a1a; }',
      '<code>--el-text: #1a1a1a</code>',
    );
    expect(legend.source).toContain('--el-text');
    expect(missingElementLayer([legend])).toHaveLength(1);
  });

  it('limb (b) names the file, the property and the value', () => {
    const aliased = mock(
      'design/projects/inapp-plan-with-ai.mock.html',
      ':root { --el-text: #1a1a1a; --muted: #787671; }',
    );
    const findings = privateColourAliases([aliased], SYSTEM);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('design/projects/inapp-plan-with-ai.mock.html');
    expect(findings[0]).toContain('--muted: #787671');
    expect(findings[0]).toContain('private colour alias');
  });

  it('limb (b) catches the file limb (a) CANNOT — one token, everything else aliased', () => {
    // `planning-workspace.mock.html` in miniature, and the reason this guard has
    // two limbs rather than one (MOTIR-4428).
    const oneToken = mock(
      'design/ai-chat/planning-workspace.mock.html',
      `:root {
         --el-accent: #5645d4;
         --text: #1a1a1a;
         --muted: #787671;
         --faint: #a4a097;
       }`,
    );
    expect(missingElementLayer([oneToken])).toEqual([]);
    expect(privateColourAliases([oneToken], SYSTEM)).toHaveLength(3);
  });

  it('limb (b) leaves a SYSTEM token alone, however it is spelled', () => {
    // A mock must inline Tier-0 to render without importing `theme.css`, so
    // `--color-primary: #5645d4` is the supported form and not a finding. An
    // INVENTED `--color-*` is (MOTIR-3217).
    const tierZero = mock(
      'design/ready/work-type-manual.mock.html',
      ':root { --el-text: #1a1a1a; --color-primary: #5645d4; --color-orb-lit: #a78bfa; }',
    );
    const findings = privateColourAliases([tierZero], SYSTEM);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('--color-orb-lit');
  });

  it('limb (b) leaves a derivation and a composite value alone — "bare" is the predicate', () => {
    const derived = mock(
      'design/shell/top-bar.mock.html',
      `:root {
         --el-text: #1a1a1a;
         --ring: color-mix(in srgb, var(--el-accent) 30%, transparent);
         --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.1);
         --hairline: 1px solid #e5e3df;
         --alias: var(--el-text-muted);
       }`,
    );
    expect(privateColourAliases([derived], SYSTEM)).toEqual([]);
  });

  it('limb (b) reads a `var()` USE as a use, never as a declaration', () => {
    const painted = mock(
      'design/workbench/workbench.mock.html',
      ':root { --el-text: #1a1a1a; } .row { color: var(--muted, #787671); }',
    );
    expect(privateColourAliases([painted], SYSTEM)).toEqual([]);
  });

  it('limb (b) skips a compiler-generated `--tw-*` property', () => {
    const compiled = mock(
      'design/shell/context-row.mock.html',
      ':root { --el-text: #1a1a1a; } .ring-offset-2 { --tw-ring-offset-color: #fff; }',
    );
    expect(privateColourAliases([compiled], SYSTEM)).toEqual([]);
  });

  it('limb (b) reads a `style=` attribute as a declaration site', () => {
    const inline: MockSource = {
      path: 'design/boards/board.mock.html',
      source: '<style>:root { --el-text: #1a1a1a; }</style><div style="--chip: #ff64c8">epic</div>',
    };
    const findings = privateColourAliases([inline], SYSTEM);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('--chip: #ff64c8');
  });

  it('reports EVERY finding, sorted — not just the first', () => {
    const several = [
      mock('design/a/two.mock.html', ':root { --el-text: #1a1a1a; --b: #222222; }'),
      mock('design/a/one.mock.html', ':root { --el-text: #1a1a1a; --a: rgb(1, 2, 3); }'),
      mock('design/a/three.mock.html', ':root { --c: #333; }'),
    ];
    // Sorted by the finding STRING, so `one` … `three` … `two`. `three`
    // declares no `--el-*` AND aliases a colour, so both limbs fire on it.
    expect(privateColourAliases(several, SYSTEM).map(fileOf)).toEqual([
      'design/a/one.mock.html',
      'design/a/three.mock.html',
      'design/a/two.mock.html',
    ]);
    expect(missingElementLayer(several).map(fileOf)).toEqual(['design/a/three.mock.html']);
  });

  it('`pairOf` and `fileOf` read a finding back the way the tables match on it', () => {
    // The two tables above are matched against findings by these helpers, so a
    // change to the message format that broke them would silently stop every
    // row firing — which is the mute button the tightness assertions exist to
    // prevent, arriving by a different door.
    const [finding] = privateColourAliases(
      [mock('design/shell/help-menu.mock.html', ':root { --el-text: #111; --tint: #eee; }')],
      SYSTEM,
    );
    expect(fileOf(finding!)).toBe('design/shell/help-menu.mock.html');
    expect(pairOf(finding!)).toBe('design/shell/help-menu.mock.html --tint');
  });
});
