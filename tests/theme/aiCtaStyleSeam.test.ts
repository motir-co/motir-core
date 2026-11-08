// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STYLE_IDS } from '@/lib/theme/styles';

// MOTIR-4743 — the hero AI control's STYLE SEAM, and the closure rule that keeps
// a design-named surface from existing only on paper.
//
// ── The defect ──────────────────────────────────────────────────────────────
// `design/ai-chat/design-notes.md` § *The hero control is STYLE-AWARE* promised a
// per-style treatment for the "Plan with AI" pill and the floating M orb, and
// prescribed the mechanism: `[data-style='id'] [data-surface='ai-cta'] { … }`.
// Three independent things made that unreachable:
//
//   1. NO element emitted `data-surface="ai-cta"` — the string existed only
//      inside `design/`, so the prescribed selector had nothing to select;
//   2. the FILL was an INLINE `background-image`, which beats every stylesheet
//      rule, so a rule written after fixing (1) would still have been inert;
//   3. the one seam that did exist (`--plan-hero-shadow` / `--plan-orb-shadow`,
//      MOTIR-3522) covered `box-shadow` and one style.
//
// So under all eleven registered styles the pill was the same violet gradient
// with the same pink halo and only its RADIUS moved.
//
// ── Why a SOURCE guard, and what goes to the browser instead ────────────────
// The same split `immersiveShellChrome.test.ts` and `styleShellCanvas.test.ts`
// make, and it binds here for the same reason: the properties under test are
// `var()`-bearing fills inside `@scope` blocks, and no DOM implementation
// available to the unit lane resolves either — a `var()` colour reads back as
// `rgba(0, 0, 0, 0)` and `@scope` is not implemented at all — so a
// computed-style assertion here is green on the broken source AND on the fixed
// one. This lane asserts the WIRING: the hook, the seam, the derived style set,
// and the closure rule. The RENDERED half — every style's measured fill, border,
// shadow and type against the base style's own computed values — lives in
// `tests/e2e/hero-ai-control-styles.spec.ts`, where a real browser resolves both.
//
// ── The CLOSURE RULE this file adds (the `specified → emitted` direction) ────
// MOTIR-4252 §4b and MOTIR-4406's guard close `emitted → classified`: they
// derive the `data-surface` population the app EMITS and fail on any member the
// plane ladder leaves unclassified. That guard is structurally blind to THIS
// defect — `ai-cta` was named in a design and emitted nowhere, so the population
// it reads had no member to classify. The test below closes the other direction,
// which is what stops the next design-named surface from quietly never existing.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const LAUNCHER = read('components/planning/PlanWithAILauncher.tsx');
const FAB = read('components/planning/PlanWithAIFab.tsx');
const THEME = read('packages/design-system/theme.css');
const GLOBALS = read('app/globals.css');

/** Comment-stripped stylesheet — a comment must never read as a declaration. */
const THEME_CSS = THEME.replace(/\/\*[\s\S]*?\*\//g, '');

// ── The hero rules, hand-scanned out of their `@scope` wrappers ─────────────
// Brace MATCHING rather than a `([^}]*)` body, for the reason
// `styleRegistry.test.ts` states: a `@scope` block nests one rule inside it, so
// a lazy body stops at the inner rule's own closing brace and under-counts.
const SCOPE_OPEN = /@scope\s*\(\[data-style='([^']+)'\]\)\s*to\s*\(\[data-style\]\)\s*\{/g;

interface ScopedRule {
  style: string;
  selector: string;
  body: string;
}

/** Every `<selector> { <declarations> }` pair at the top level of a block. */
function innerRules(block: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  let cursor = 0;
  while (cursor < block.length) {
    const open = block.indexOf('{', cursor);
    if (open === -1) break;
    let depth = 1;
    let i = open + 1;
    for (; i < block.length && depth > 0; i += 1) {
      if (block[i] === '{') depth += 1;
      else if (block[i] === '}') depth -= 1;
    }
    out.push({ selector: block.slice(cursor, open).trim(), body: block.slice(open + 1, i - 1) });
    cursor = i;
  }
  return out;
}

function scopedRules(css: string): ScopedRule[] {
  const out: ScopedRule[] = [];
  SCOPE_OPEN.lastIndex = 0;
  let open: RegExpExecArray | null;
  while ((open = SCOPE_OPEN.exec(css)) !== null) {
    let depth = 1;
    let i = open.index + open[0].length;
    for (; i < css.length && depth > 0; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
    }
    const inner = css.slice(open.index + open[0].length, i - 1);
    // A `@scope` block may hold SEVERAL rules — the design's own transcription
    // groups the shared declarations and the two per-control fills in one block,
    // where this stylesheet gives each selector its own. Walking every inner rule
    // rather than taking the first is what lets the two be compared: a parser
    // that stopped at the first `{` attributed the pill's and the orb's
    // declarations to the SHARED selector and reported every one of them missing.
    for (const rule of innerRules(inner)) {
      out.push({ style: open[1] ?? '', selector: rule.selector, body: rule.body });
    }
    SCOPE_OPEN.lastIndex = i;
  }
  return out;
}

const HERO_RULES = scopedRules(THEME_CSS).filter((r) =>
  r.selector.includes("data-surface='ai-cta'"),
);

/**
 * The styles that MUST carry a hero treatment, DERIVED from the registry rather
 * than listed. Two exemptions, both decided in
 * `design/ai-chat/design-notes.md` § *The eleven rows* and neither a gap:
 *
 *   • `warm-editorial` is the Tier-0 BASE — the components' own `var()`
 *     fallbacks ARE its treatment, and a block repeating them would be a second
 *     copy to drift from;
 *   • `3d-immersive` owns this control's depth through `--plan-hero-shadow` /
 *     `--plan-orb-shadow` already, and a rule here would either lose to the
 *     inline declaration or take a `data-depth="key"` control off the plane
 *     ladder it is declared on (docs/styles/3d-immersive.md §4 / §4b).
 *
 * A twelfth style added to the registry with no hero rule fails HERE.
 */
const BASE_STYLE = 'warm-editorial';
const DEPTH_ONLY_STYLE = '3d-immersive';
const STYLES_OWING_A_TREATMENT = STYLE_IDS.filter(
  (id) => id !== BASE_STYLE && id !== DEPTH_ONLY_STYLE,
);

describe('the hero AI control emits the material hook (MOTIR-4743 AC 1)', () => {
  it('the header pill carries `data-surface="ai-cta"` and `data-ai-cta="pill"`', () => {
    expect(LAUNCHER).toContain('data-surface="ai-cta"');
    expect(LAUNCHER).toContain('data-ai-cta="pill"');
    // The plane hook MOTIR-3522 gave it is not replaced by the material one:
    // `data-depth` declares the 3D plane, `data-ai-cta` declares which of the
    // two hero controls this is. Both ship.
    expect(LAUNCHER).toContain('data-depth="key"');
  });

  it('the floating orb carries `data-surface="ai-cta"` and `data-ai-cta="orb"`', () => {
    expect(FAB).toContain('data-surface="ai-cta"');
    expect(FAB).toContain('data-ai-cta="orb"');
    expect(FAB).toContain('data-depth="key"');
  });

  it('the two controls do NOT share a `data-ai-cta` value', () => {
    // The whole reason the second attribute exists. A shared value would let one
    // `background-image` rule cover both and silently overwrite the orb's
    // `--orb-lit-mix` recipe (MOTIR-3207) with the pill's gradient.
    const pill = /data-ai-cta="([a-z]+)"/.exec(LAUNCHER)?.[1];
    const orb = /data-ai-cta="([a-z]+)"/.exec(FAB)?.[1];
    expect(pill).toBe('pill');
    expect(orb).toBe('orb');
  });
});

describe('neither control paints its own fill inline (MOTIR-4743 AC 2)', () => {
  /** The single-quoted `backgroundImage` a hero component declares. */
  function declaredFill(source: string, component: string): string {
    const match = /backgroundImage:\s*\n?\s*'([^']+)'/.exec(source);
    expect(match, `${component} must declare a single-quoted backgroundImage`).toBeTruthy();
    return match![1]!;
  }

  it('the pill reads `--plan-hero-fill` with the base recipe as its FALLBACK', () => {
    const fill = declaredFill(LAUNCHER, 'PlanWithAILauncher');
    expect(fill.startsWith('var(--plan-hero-fill, ')).toBe(true);
    expect(fill.endsWith(')')).toBe(true);
    // The fallback is the base treatment, so a style that sets nothing renders
    // exactly as before — which is what makes the seam safe to add to all eleven
    // styles in one change.
    expect(fill).toContain('linear-gradient(135deg, var(--el-accent)');
  });

  it('the orb reads `--plan-orb-fill` with the lit-sphere recipe as its FALLBACK', () => {
    const fill = declaredFill(FAB, 'PlanWithAIFab');
    expect(fill.startsWith('var(--plan-orb-fill, ')).toBe(true);
    expect(fill.endsWith(')')).toBe(true);
    expect(fill).toContain('radial-gradient(circle at 33% 27%');
    // `--orb-lit-mix` is the guarded contrast knob, and it stays inside the
    // FALLBACK: a style that sets nothing keeps the measured recipe.
    expect(fill).toContain('var(--orb-lit-mix)');
  });

  it('the pill gradient is ACCENT-DOMINANT at its far stop (MOTIR-4742 finding A)', () => {
    // The label spans the whole pill, so it also sits on the FAR stop. At 55%
    // that stop is 45% brand pink and measured 3.98:1 in dark — under the 4.5:1
    // bar, on the product's headline control, and contradicting the design's own
    // "the brand pink lives only in the glow/aura, never under text". 86%
    // measures 5.97:1 / 4.64:1. 80% is the first PASSING value, so this
    // assertion is a floor with the margin the design specified, not the bar.
    const stop = /--el-accent\)\s*(\d+)%,\s*var\(--el-highlight\)/.exec(LAUNCHER);
    expect(stop, 'the far stop must be a literal percentage of --el-accent').toBeTruthy();
    expect(Number(stop![1])).toBeGreaterThanOrEqual(86);
  });
});

describe('the style layer reaches the hero control, for every style that owes one', () => {
  it('every registered style but the base and the depth-only one carries a rule', () => {
    // DERIVED from STYLE_IDS, never a list — a list is the enumeration this card
    // exists to close (docs/styles/3d-immersive.md §4b's closure rule, applied to
    // the surface that was missing from the ladder entirely).
    const treated = new Set(HERO_RULES.map((r) => r.style));
    for (const id of STYLES_OWING_A_TREATMENT) {
      expect(treated.has(id), `[data-style='${id}'] gives the hero control no treatment`).toBe(
        true,
      );
    }
  });

  it('the BASE style has no hero rule — its treatment is the components’ fallback', () => {
    expect(HERO_RULES.filter((r) => r.style === BASE_STYLE)).toHaveLength(0);
  });

  it('`3d-immersive` sets the two SHADOW variables and no hero rule at all', () => {
    // AC 8. Its depth already ships and is what its identity is; a fill rule here
    // would take a `data-depth="key"` control off the plane ladder.
    expect(HERO_RULES.filter((r) => r.style === DEPTH_ONLY_STYLE)).toHaveLength(0);
    expect(THEME_CSS).toMatch(/--plan-hero-shadow:/);
    expect(THEME_CSS).toMatch(/--plan-orb-shadow:/);
    expect(THEME_CSS).not.toMatch(/--plan-hero-fill:[^;]*var\(--plan-hero-shadow/);
  });

  it('NEITHER inline-declared property is written literally in a hero rule', () => {
    // The mechanism check, and the one that catches the trap MOTIR-3522
    // documented and this card walked into TWICE: an inline declaration beats
    // every stylesheet rule, so a hero rule that wrote `background-image` or
    // `box-shadow` would land, review cleanly, pass its own tests and change
    // nothing on screen.
    //
    // ⚠️ THE SHADOW HALF IS HERE BECAUSE A RENDER FOUND IT, NOT A READING. With
    // the design's `box-shadow` declarations transcribed literally, the browser
    // spec reported exactly ONE control identical to the base — the AURORA ORB,
    // the only one whose row sets nothing but a shadow. Every other style also
    // moves a fill, a border or the type, so its rule "worked" while its shadow
    // silently did not.
    //
    // A pseudo-element is exempt: `::after` is not the control, so nothing
    // inline reaches it.
    for (const rule of HERO_RULES) {
      if (rule.selector.includes('::')) continue;
      for (const property of ['background-image', 'box-shadow'] as const) {
        expect(
          rule.body,
          `[data-style='${rule.style}'] ${rule.selector} writes ${property}, which the ` +
            'components’ inline declaration beats — write the --plan-{hero,orb}-{fill,shadow} seam',
        ).not.toMatch(new RegExp(`(^|[;{\\s])${property}\\s*:`));
      }
    }
  });

  it('every hero fill is palette-DERIVED and names no raw hue', () => {
    // AC 6. `styleRegistry.test.ts`'s material check keys on the PROPERTY name
    // (`background`/`color`), so a rule whose only colour-bearing declaration is
    // `--plan-hero-fill` falls outside its membership test. This is that
    // assertion, on the property this card introduced.
    const fills = HERO_RULES.flatMap((rule) =>
      [...rule.body.matchAll(/--plan-(?:hero|orb)-(?:fill|shadow)\s*:\s*([\s\S]*?);/g)].map(
        (m) => ({ style: rule.style, value: m[1]!.trim() }),
      ),
    );
    expect(fills.length, 'the fills must be found at all').toBeGreaterThanOrEqual(4);
    for (const fill of fills) {
      expect(fill.value).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      if (fill.value === 'none') continue;
      expect(fill.value, `[data-style='${fill.style}'] pins a hue of its own`).toMatch(
        /var\(--el-|var\(--glass-|var\(--aurora-|var\(--retro-|var\(--neu-|currentColor/,
      );
    }
  });

  it('no hero rule introduces motion (AC 10)', () => {
    // The shimmer and the FAB pulse are `globals.css` classes already gated
    // behind prefers-reduced-motion. A style-layer `animation` would not be, and
    // would survive the gate for every motion-sensitive user.
    for (const rule of HERO_RULES) {
      expect(rule.body, `[data-style='${rule.style}'] animates the hero control`).not.toMatch(
        /(^|[;{\s])animation(-name)?\s*:/,
      );
    }
    // …and the two shipped animations stay gated.
    for (const cls of ['plan-with-ai-shimmer', 'plan-with-ai-fab-pulse']) {
      const at = GLOBALS.indexOf(`.${cls} {`);
      expect(at, `${cls} must still be declared`).toBeGreaterThan(-1);
      expect(GLOBALS.slice(0, at)).toMatch(
        /@media \(prefers-reduced-motion: no-preference\) \{[^@]*$/,
      );
    }
  });
});

// ── AC 7 — the CLOSURE RULE, in the `specified → emitted` direction ──────────

const SPEC_DIRS = ['docs/styles'];
const SPEC_FILES = ['design'];
const EMIT_DIRS = ['app', 'components', 'packages/design-system/src'];
const SKIP = new Set(['node_modules', '.next', 'dist', 'tests', '__tests__']);

function walk(dir: string, keep: (f: string) => boolean, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, keep, out);
    else if (keep(entry)) out.push(full);
  }
  return out;
}

/**
 * Every `data-surface` value in a set of files.
 *
 * ⚠️ THE TWO SIDES READ DIFFERENT FORMS, and that asymmetry is the point. A
 * SPECIFICATION names the surface in a CSS selector (`[data-surface='card']`) or
 * in a markup sketch, so both quote styles count. An EMISSION is a JSX
 * attribute, which is always double-quoted here — and matching a single-quoted
 * occurrence in a `.tsx` would let PROSE about a surface (a specimen heading, a
 * comment) register as an element that emits it. That is not hypothetical: it
 * silently turned this guard green on the very defect it was written for, when a
 * specimen section title mentioned the attribute in passing.
 */
function surfacesIn(files: string[], form: 'specified' | 'emitted'): Set<string> {
  const pattern =
    form === 'emitted' ? /data-surface="([a-z0-9-]+)"/g : /data-surface=['"]([a-z0-9-]+)['"]/g;
  const found = new Set<string>();
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(pattern)) found.add(m[1]!);
  }
  return found;
}

describe('a `data-surface` a specification NAMES is a surface the app EMITS (AC 7)', () => {
  it('fails on any surface class specified in a doc or a design and emitted nowhere', () => {
    // ⚠️ THE SETS ARE DERIVED ON BOTH SIDES. A hard-coded list of expected values
    // re-creates the enumeration this guard exists to close: the failure it
    // catches is precisely a value somebody wrote into a specification and
    // nobody added to the app, which is invisible to a check that reads a list
    // somebody maintains by hand.
    const specified = surfacesIn(
      [
        ...SPEC_DIRS.flatMap((d) => walk(join(ROOT, d), (f) => f.endsWith('.md'))),
        ...SPEC_FILES.flatMap((d) => walk(join(ROOT, d), (f) => f === 'design-notes.md')),
      ],
      'specified',
    );
    const emitted = surfacesIn(
      EMIT_DIRS.flatMap((d) => walk(join(ROOT, d), (f) => /\.(tsx|ts)$/.test(f))),
      'emitted',
    );

    // Guard the machinery: an empty `specified` set would make this test vacuous
    // and green forever, which is the failure mode of the check rather than of
    // the codebase.
    expect(specified.size, 'the specifications must name some surfaces at all').toBeGreaterThan(4);
    expect(emitted.size, 'the app must emit some surfaces at all').toBeGreaterThan(4);

    const promisedButUnbuilt = [...specified].filter((s) => !emitted.has(s)).sort();
    expect(
      promisedButUnbuilt,
      'a design or a style doc prescribes `[data-surface=…]` rules against these values and no ' +
        'element in app/, components/ or the design-system package emits them — so every rule ' +
        'written for them is inert and no existing guard can see it (MOTIR-4406 derives the ' +
        'EMITTED population, which by construction has no member to classify here)',
    ).toEqual([]);
  });

  it('scans the design-system package too, where three of the emitters live', () => {
    // Recorded on the record rather than silently widened: AC 7 as authored named
    // `app/` and `components/`, and `input`, `page` and `popover` are emitted by
    // `packages/design-system/src` alone (MOTIR-1527 moved the primitives there;
    // `components/ui/*` are re-export shims). Scanning only the two directories
    // the criterion names would report three false positives against surfaces
    // that ship and work.
    const dsOnly = surfacesIn(
      walk(join(ROOT, 'packages/design-system/src'), (f) => /\.(tsx|ts)$/.test(f)),
      'emitted',
    );
    const appAndComponents = surfacesIn(
      ['app', 'components'].flatMap((d) => walk(join(ROOT, d), (f) => /\.(tsx|ts)$/.test(f))),
      'emitted',
    );
    const onlyInPackage = [...dsOnly].filter((s) => !appAndComponents.has(s));
    expect(onlyInPackage.length).toBeGreaterThan(0);
  });
});

// ── AC 6 — the shipped rules ARE the design's rules, declaration for declaration

/**
 * The design's own copyable CSS block (`design/ai-chat/design-notes.md`
 * § *The CSS, verbatim*), parsed the same way the stylesheet is.
 *
 * ⚠️ THIS IS WHAT DISCHARGES THE AA CRITERION (AC 9) WITHOUT RE-MEASURING IT.
 * Every ratio in the design's table was computed by resolving the tokens through
 * a real CSS engine and reading the PAINTED pixel — twenty-two label figures plus
 * the orb's glyph box, with four places the measurement CHANGED the design
 * (findings A–D). Re-deriving them here would be a second, weaker measurement of
 * a number the design already owns. What this card can be held to instead is
 * that it ships EXACTLY the declarations that were measured, and that is a
 * comparison a test can make exactly. A treatment tuned in the stylesheet
 * without re-measuring the design fails here.
 */
const DESIGN_NOTES = read('design/ai-chat/design-notes.md');

/**
 * The documented translation between the two, and it covers BOTH properties the
 * components declare inline. The design writes each treatment as plain
 * `background-image` / `box-shadow`; each is transcribed onto the custom
 * property the components read through, because an inline declaration beats
 * every stylesheet rule and either written literally would be INERT. See the
 * section header in `theme.css` for why the alternative — painting the base in a
 * `warm-editorial` block — is worse.
 *
 * A rule on the SHARED selector maps a shadow onto BOTH names: the design gives
 * the pill and the orb one shadow, and each control reads only its own.
 */
function seamProperties(selector: string, property: string): string[] {
  const pill = selector.includes("data-ai-cta='pill'");
  const orb = selector.includes("data-ai-cta='orb'");
  const pseudo = selector.includes('::');
  if (property === 'background-image' && !pseudo) {
    if (pill) return ['--plan-hero-fill'];
    if (orb) return ['--plan-orb-fill'];
  }
  if (property === 'box-shadow' && !pseudo) {
    if (pill) return ['--plan-hero-shadow'];
    if (orb) return ['--plan-orb-shadow'];
    return ['--plan-hero-shadow', '--plan-orb-shadow'];
  }
  return [property];
}

/** `<style>|<selector>|<property>` → value, whitespace-collapsed. */
function declarationMap(rules: ScopedRule[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const rule of rules) {
    // `:not(...)` guards are a placement concern, not a declaration — the
    // hand-drawn `position: relative` carries one here that the design's
    // transcription omits (the orb is `.fixed`, and re-declaring it `relative`
    // would drop it out of fixed positioning; this style's own `.border` rule
    // carries the identical guard for the identical reason).
    // A comma-separated selector LIST is one rule and several subjects — the
    // design writes neumorphism's flat fill once for the pill and the orb, where
    // this stylesheet gives each its own rule (they set different custom
    // properties). Expanding it is what makes the two comparable at all.
    const selectors = rule.selector
      .replace(/:not\([^)]*\)/g, '')
      .replace(/\s+/g, '')
      .split(',')
      .filter(Boolean);
    for (const selector of selectors) {
      for (const m of rule.body.matchAll(/([-\w]+)\s*:\s*([\s\S]*?);/g)) {
        const property = m[1]!;
        const value = m[2]!.replace(/\s+/g, ' ').trim();
        for (const translated of seamProperties(selector, property)) {
          out.set(`${rule.style}|${selector}|${translated}`, value);
        }
      }
    }
  }
  return out;
}

describe('the shipped treatment is the DESIGN’s treatment (MOTIR-4743 AC 6)', () => {
  it('transcribes every declaration of the design’s verbatim CSS block', () => {
    const fence = /```css\n([\s\S]*?)```/g;
    const blocks = [...DESIGN_NOTES.matchAll(fence)].map((m) => m[1]!);
    // The first copyable block is § *The CSS, verbatim*. Every later block that
    // names the hook is a dated AMENDMENT section (MOTIR-10708 re-tuned the
    // retrofuturism pill's bevel), applied in document order: a declaration it
    // names replaces the one before it, and nothing it omits changes.
    const heroBlocks = blocks.filter((b) => b.includes("data-surface='ai-cta'"));
    const heroBlock = heroBlocks[0];
    expect(heroBlock, 'the design must still carry its copyable hero CSS block').toBeTruthy();

    const declarationsOf = (block: string) =>
      declarationMap(
        scopedRules(block.replace(/\/\*[\s\S]*?\*\//g, '')).filter((r) =>
          r.selector.includes("data-surface='ai-cta'"),
        ),
      );
    const specified = declarationsOf(heroBlock!);
    const amended: string[] = [];
    for (const block of heroBlocks.slice(1)) {
      for (const [key, value] of declarationsOf(block)) {
        expect(
          specified.has(key),
          `an amendment may only re-specify a declared value: ${key}`,
        ).toBe(true);
        specified.set(key, value);
        amended.push(key);
      }
    }
    expect(amended).toEqual([
      "retrofuturism|[data-surface='ai-cta'][data-ai-cta='pill']|--plan-hero-fill",
    ]);
    const shipped = declarationMap(HERO_RULES);

    expect(specified.size, 'the design block must yield declarations at all').toBeGreaterThan(20);

    const missing: string[] = [];
    const changed: string[] = [];
    for (const [key, value] of specified) {
      if (!shipped.has(key)) missing.push(key);
      else if (shipped.get(key) !== value)
        changed.push(`${key}\n  design:  ${value}\n  shipped: ${shipped.get(key)}`);
    }
    expect(
      missing,
      'the design specifies these declarations for the hero control and the stylesheet ships none',
    ).toEqual([]);
    expect(
      changed,
      'these shipped declarations differ from the design’s measured values — every AA ratio in ' +
        '`design/ai-chat/design-notes.md` § *The eleven rows* was measured on THESE declarations, ' +
        'so a change here needs a re-measurement in the design, not an edit here',
    ).toEqual([]);
  });

  it('adds or changes no `--color-*` / `--el-*` token', () => {
    // AC 6's second half. A treatment that reached for a new token would move the
    // COLOUR axis to fix a STYLE-axis problem, and the two axes are disjoint by
    // construction — a `data-palette` swap must re-tint all eleven treatments.
    for (const rule of HERO_RULES) {
      expect(rule.body, `[data-style='${rule.style}'] declares a token of its own`).not.toMatch(
        /(^|[;{\s])--(?:color|el)-[\w-]+\s*:/,
      );
    }
  });
});
