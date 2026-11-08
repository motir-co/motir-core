import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-4234 — the SHELL-CANVAS guard for EVERY style that paints a canvas.
//
// ── The defect ──────────────────────────────────────────────────────────────
// MOTIR-4230 fixed one instance of a general defect. Six of the eleven
// registered styles express part of their identity as a `body`-level CANVAS —
// glassmorphism's vibrant wash, cybercore's tech grid, aurora's drifting
// ribbons, 3D / Immersive's atmosphere, neumorphism's moulded field and
// retrofuturism's synthwave sky. On a SIGNED-IN route the shell root
// (`components/ui/AppLayout.tsx`, and the platform-admin `AdminShell`) is a
// `h-dvh overflow-hidden` box carrying `bg-(--el-page-bg)`, an OPAQUE fill over
// the whole viewport, so every one of those canvases was painted and then
// covered. Only 3D / Immersive had been paired to the shell; the other five went
// flat on every screen a user actually works on.
//
// ── Why this guard is DERIVED, not a list ───────────────────────────────────
// A guard listing the five styles it was written for is a guard that says
// nothing about the sixth. The population here is not "the styles somebody
// remembered" — it is "every style-scoped rule in the stylesheet that paints a
// canvas on `body`", read off the stylesheet itself. A style added later joins
// this guard by existing, which is the same derivation, and the same reason for
// it, as `immersiveShellAtmosphere.test.ts`'s derived shell set.
//
// ── Why a SOURCE guard ──────────────────────────────────────────────────────
// The properties under test are `background-image: <a var()-bearing gradient
// stack>` and `background-color: var(--el-surface)` inside `@scope` blocks, and
// the DOM implementations available to a unit lane resolve neither — a
// `background: var(--x)` reads back as `rgba(0, 0, 0, 0)` and `@scope` is not
// implemented at all. A computed-style assertion here would be green on the
// broken source AND on the fixed one, which is worse than no test. So the unit
// lane asserts the WIRING and the rendered half lives in
// `tests/e2e/shell-immersive-atmosphere.spec.ts`, where a real browser resolves
// the cascade and the assertion can actually fail.

const ROOT = resolve(__dirname, '..', '..');
const THEME_CSS_PATH = 'packages/design-system/theme.css';
const HOOK_SELECTOR = '[data-app-shell]';

/** Comments stripped — a guard that reads prose as code proves nothing. */
const CSS = readFileSync(join(ROOT, THEME_CSS_PATH), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

interface ScopedRule {
  /** The style id in the `@scope` prelude. */
  style: string;
  /** The rule's own selector list, trimmed. */
  selector: string;
  /** The rule's declaration block. */
  body: string;
  /** Whether this rule sits inside a `prefers-reduced-motion: reduce` query. */
  reducedMotion: boolean;
}

/**
 * Every rule inside a `@scope ([data-style='…']) to ([data-style])` block, with
 * the style it is scoped to. Located by STRUCTURE rather than by comment text,
 * so re-wording the prose above a rule cannot silently empty this guard.
 */
function scopedRules(): ScopedRule[] {
  const open = /@scope\s*\(\[data-style='([a-z0-9-]+)'\]\)\s*to\s*\(\[data-style\]\)\s*\{/g;
  const out: ScopedRule[] = [];
  let m: RegExpExecArray | null;
  while ((m = open.exec(CSS)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < CSS.length && depth > 0; i += 1) {
      if (CSS[i] === '{') depth += 1;
      else if (CSS[i] === '}') depth -= 1;
    }
    const inner = CSS.slice(m.index + m[0].length, i - 1);
    open.lastIndex = i;

    // Is this `@scope` block itself nested inside a reduced-motion query? The
    // query opens before it and has not closed, so the text between the last
    // `@media (prefers-reduced-motion: reduce) {` and here is brace-balanced.
    const before = CSS.slice(0, m.index);
    const lastReduce = before.lastIndexOf('@media (prefers-reduced-motion: reduce)');
    const reducedMotion =
      lastReduce !== -1 &&
      before.slice(lastReduce).split('{').length - before.slice(lastReduce).split('}').length > 0;

    // Split the block into its own rules (one level of nesting, which is all
    // this stylesheet uses inside `@scope`).
    let rest = inner;
    while (rest.includes('{')) {
      const brace = rest.indexOf('{');
      let d = 1;
      let j = brace + 1;
      for (; j < rest.length && d > 0; j += 1) {
        if (rest[j] === '{') d += 1;
        else if (rest[j] === '}') d -= 1;
      }
      out.push({
        style: m[1]!,
        selector: rest.slice(0, brace).trim(),
        body: rest.slice(brace + 1, j - 1),
        reducedMotion,
      });
      rest = rest.slice(j);
    }
  }
  return out;
}

const RULES = scopedRules();

/** The selector list, split into members. */
const members = (r: ScopedRule): string[] => r.selector.split(',').map((p) => p.trim());

/**
 * A CANVAS rule: a style-scoped rule that paints the page's own background —
 * whether as an image stack (`glassmorphism`, `cybercore-y2k`, `aurora`,
 * `3d-immersive`, `retrofuturism`) or as a flat field (`neumorphism`) — plus
 * retrofuturism's `body::after` grid floor, which is a canvas LAYER of the same
 * kind. Keyed on what the rule DOES, so a style that starts painting one is
 * caught without editing this predicate.
 */
const CANVAS_RULES = RULES.filter(
  (r) =>
    !r.reducedMotion &&
    members(r).some((sel) => sel === 'body' || sel === 'body::after') &&
    /background-(?:image|color)\s*:/.test(r.body),
);

/** The styles the stylesheet is currently observed to give a canvas. */
const CANVAS_STYLES = [...new Set(CANVAS_RULES.map((r) => r.style))].sort();

/**
 * The styles with NO canvas of their own — the control set for the fifth
 * acceptance criterion. Derived by subtraction from the registry's own ids, so
 * a style that gains a canvas leaves this set by itself.
 */
const REGISTERED_STYLES = [
  ...new Set([...CSS.matchAll(/\[data-style='([a-z0-9-]+)'\]/g)].map((m) => m[1]!)),
].sort();
const FLAT_STYLES = REGISTERED_STYLES.filter((id) => !CANVAS_STYLES.includes(id));

describe('every style canvas reaches the signed-in shell (MOTIR-4234)', () => {
  it('finds the canvas rules at all — the scan is not vacuous', () => {
    // Without this every assertion below passes on an empty set, which is how a
    // totality test dies quietly. The six are named as a FLOOR, not as the
    // population: the assertions run over whatever the stylesheet actually has.
    expect(RULES.length, 'style-scoped rules in theme.css').toBeGreaterThan(50);
    expect(CANVAS_STYLES, 'the styles observed to paint a page canvas').toEqual(
      expect.arrayContaining([
        '3d-immersive',
        'aurora',
        'cybercore-y2k',
        'glassmorphism',
        'neumorphism',
        'retrofuturism',
      ]),
    );
  });

  it('paints `body` and the shell canvas from ONE rule, for every style that has one', () => {
    // The pairing, stated over the DERIVED population rather than over a list.
    // `body` ⇒ `[data-app-shell]`, and `body::after` ⇒ `[data-app-shell]::after`
    // — the pseudo-element carries the same obligation as the element.
    const offenders = CANVAS_RULES.filter((r) => {
      const sel = members(r);
      const wanted = sel.includes('body::after') ? `${HOOK_SELECTOR}::after` : HOOK_SELECTOR;
      return !sel.includes(wanted);
    }).map(
      (r) =>
        `[data-style='${r.style}'] { ${r.selector} } — paints a canvas on the page ` +
        `but not on ${HOOK_SELECTOR}`,
    );

    expect(
      offenders,
      'A full-viewport shell root paints an opaque `--el-page-bg` over the whole ' +
        'viewport, so a style canvas painted only on `body` is invisible on every ' +
        'signed-in route — the style delivers panel treatment inside a flat frame. ' +
        'Add the hook to the SAME rule; a second rule restating the canvas is a ' +
        'copy that drifts on the first tune.',
    ).toEqual([]);
  });

  it('never splits one style canvas across two rules', () => {
    // A drifting copy looks exactly like this: the frame and the canvas each
    // painting their own version, agreeing on the day it is written and never
    // again. `body::after` is a distinct layer, so it is counted separately.
    const byLayer = new Map<string, ScopedRule[]>();
    for (const r of CANVAS_RULES) {
      const layer = members(r).includes('body::after') ? 'floor' : 'canvas';
      const key = `${r.style}/${layer}`;
      byLayer.set(key, [...(byLayer.get(key) ?? []), r]);
    }
    const duplicated = [...byLayer.entries()]
      .filter(([, rs]) => rs.length > 1)
      .map(([key, rs]) => `${key} — ${rs.length} rules paint it`);
    expect(duplicated, 'one canvas, one rule').toEqual([]);
  });

  it('stills the shell for a reduced-motion user wherever it stills the page', () => {
    // Aurora is the only animated canvas today, and the arm is derived rather
    // than named: any style that gates its canvas motion behind
    // `prefers-reduced-motion: reduce` owes BOTH members. An arm that stilled
    // only `body` would leave a reduced-motion user with a drifting frame around
    // a still page — the defect inverted rather than fixed.
    const animated = CANVAS_RULES.filter((r) => /\banimation\s*:/.test(r.body));
    expect(
      animated.map((r) => r.style),
      'at least one style animates its canvas, or this assertion is vacuous',
    ).toContain('aurora');

    const offenders: string[] = [];
    for (const canvas of animated) {
      const arms = RULES.filter(
        (r) => r.reducedMotion && r.style === canvas.style && /\banimation\s*:\s*none/.test(r.body),
      );
      if (arms.length === 0) {
        offenders.push(
          `[data-style='${canvas.style}'] animates its canvas with no reduced-motion arm`,
        );
        continue;
      }
      for (const arm of arms) {
        const sel = members(arm);
        if (!sel.includes('body') || !sel.includes(HOOK_SELECTOR)) {
          offenders.push(
            `[data-style='${canvas.style}'] reduced-motion arm { ${arm.selector} } — ` +
              `stills only part of what it animates`,
          );
        }
      }
    }
    expect(offenders, 'the reduced-motion arm covers the same members as the canvas').toEqual([]);
  });

  it('makes the shell a stacking context wherever a canvas LAYER sits below content', () => {
    // Retrofuturism's grid floor is `position: fixed; z-index: -1`. Both shell
    // roots are `relative` with `z-index: auto`, so they establish no stacking
    // context of their own and a negative-z-index descendant would paint into
    // the ROOT context — behind the shell's own background, which is precisely
    // where `body::after` already was. Pairing the selector is NOT enough here;
    // the shell also needs `isolation: isolate`.
    const floors = CANVAS_RULES.filter((r) => members(r).includes('body::after'));
    expect(
      floors.map((r) => r.style),
      'the styles painting a floor layer',
    ).toEqual(['retrofuturism']);

    for (const floor of floors) {
      expect(floor.body, `[data-style='${floor.style}'] floor is a negative layer`).toMatch(
        /z-index\s*:\s*-1/,
      );
      const isolated = RULES.some(
        (r) =>
          r.style === floor.style &&
          members(r).includes(HOOK_SELECTOR) &&
          /isolation\s*:\s*isolate/.test(r.body),
      );
      expect(
        isolated,
        `[data-style='${floor.style}'] paints a z-index: -1 layer under the shell canvas, ` +
          `so ${HOOK_SELECTOR} must be its own stacking context (isolation: isolate) or the ` +
          `layer resolves behind the shell's background and is invisible on every signed-in route`,
      ).toBe(true);
    }
  });

  it('leaves a style with no canvas of its own untouched', () => {
    // The fifth acceptance criterion, and the reason the hook is a hook rather
    // than a style: these five paint no page canvas, so nothing in the change
    // reaches them and the shell keeps the `--el-page-bg` fill it always had.
    expect(FLAT_STYLES, 'the styles that paint no canvas').toEqual([
      'claymorphism',
      'dense-pro',
      'hand-drawn-indie',
      'high-contrast-accessible',
      'neo-brutalism',
      'soft-playful',
      'swiss-minimal-flat',
      'tonal-elevated',
      'warm-editorial',
    ]);

    const offenders = RULES.filter(
      (r) =>
        FLAT_STYLES.includes(r.style) &&
        members(r).includes(HOOK_SELECTOR) &&
        /background-(?:image|color)\s*:/.test(r.body),
    ).map((r) => `[data-style='${r.style}'] { ${r.selector} } — repaints the shell canvas`);
    expect(offenders, 'a style with no canvas does not touch the shell canvas').toEqual([]);
  });

  it('keeps every shell canvas palette-derived — light and dark, never a raw hue', () => {
    // The style axis stays disjoint from the palette axis: hues come from the
    // `--el-*` element roles, which `data-palette` overrides. A hex literal in
    // one of these rules is a hue the palette cannot move.
    const offenders = CANVAS_RULES.filter((r) => /#[0-9a-fA-F]{3,8}\b/.test(r.body)).map(
      (r) => `[data-style='${r.style}'] { ${r.selector} } — carries a hex literal`,
    );
    expect(offenders, 'the palette axis owns the hue').toEqual([]);
  });
});
