import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-11105 — no STYLE may make the modal PANEL a containing block for
// `position: fixed` descendants.
//
// ── The defect ──────────────────────────────────────────────────────────────
// A Combobox inside `Modal.Body` lifts its menu out as a `position: fixed`
// child so it can reach past the dialog panel (MOTIR-11096). That only works
// while the panel is NOT the menu's containing block: a `transform` /
// `translate` / `scale` / `rotate` / `perspective`, a `filter`, a
// `backdrop-filter`, a `contain: paint|layout|strict|content` or a matching
// `will-change` on the panel makes every fixed descendant lay out against the
// PANEL — and the panel's `overflow-hidden` then cuts the menu to the panel's
// height. Glassmorphism frosted the panel with `backdrop-filter` and so kept
// the defect alive in that one style; its frosting now lives on a
// `[data-surface='modal']::before` layer instead.
//
// ── Why DERIVED and a SOURCE guard ──────────────────────────────────────────
// The population is every style-scoped rule whose selector IS the modal panel,
// read off the stylesheet — a style added later joins by existing. The unit
// lane's DOM implements neither `@scope` nor `backdrop-filter`, so a computed
// read here would be green on the broken source too; the guard asserts the
// wiring. A pseudo-element (`::before`) is exempt: it has no fixed descendants.

const ROOT = resolve(__dirname, '..', '..');
const CSS = readFileSync(join(ROOT, 'packages/design-system/theme.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

const SCOPE_OPEN = /@scope\s*\(\[data-style='([^']+)'\]\)\s*to\s*\(\[data-style\]\)\s*\{/g;

/** Every rule inside a style's `@scope` block, as `{ style, selectors, body }`. */
function scopedRules(css: string): { style: string; selectors: string[]; body: string }[] {
  const out: { style: string; selectors: string[]; body: string }[] = [];
  for (const open of css.matchAll(SCOPE_OPEN)) {
    let depth = 1;
    let i = open.index + open[0].length;
    for (; i < css.length && depth > 0; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
    }
    const inner = css.slice(open.index + open[0].length, i - 1);
    for (const [, selector, body] of inner.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      out.push({
        style: open[1] ?? '',
        selectors: (selector ?? '').split(',').map((s) => s.trim().replace(/\s+/g, ' ')),
        body: body ?? '',
      });
    }
  }
  return out;
}

/** A declaration that makes its element the containing block of fixed descendants. */
function containingBlockDeclarations(body: string): string[] {
  const found: string[] = [];
  for (const part of body.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const prop = part.slice(0, colon).trim().toLowerCase();
    const value = part
      .slice(colon + 1)
      .trim()
      .toLowerCase();
    if (value === 'none' || value === 'auto' || value === 'initial' || value === 'unset') continue;
    if (
      /^(-webkit-)?(transform|translate|scale|rotate|perspective|filter|backdrop-filter)$/.test(
        prop,
      ) ||
      (prop === 'contain' && /\b(paint|layout|strict|content)\b/.test(value)) ||
      (prop === 'will-change' &&
        /\b(transform|translate|scale|rotate|perspective|filter|backdrop-filter)\b/.test(value))
    ) {
      found.push(`${prop}: ${value}`);
    }
  }
  return found;
}

const MODAL = "[data-surface='modal']";
const RULES = scopedRules(CSS);
const PANEL_RULES = RULES.filter((r) => r.selectors.includes(MODAL));

describe('the modal panel is never the containing block of a fixed menu (MOTIR-11105)', () => {
  it('finds the style-scoped modal panel rules it guards', () => {
    // Glassmorphism ships one; the floor proves the reader still reaches them.
    expect(PANEL_RULES.some((r) => r.style === 'glassmorphism')).toBe(true);
  });

  it('no style puts a containing-block property on the panel itself', () => {
    const offenders = PANEL_RULES.flatMap((r) =>
      containingBlockDeclarations(r.body).map((d) => `${r.style}: ${MODAL} { ${d} }`),
    );
    expect(offenders).toEqual([]);
  });

  it('glassmorphism keeps its frosting, on a ::before layer behind the content', () => {
    const layer = RULES.find(
      (r) => r.style === 'glassmorphism' && r.selectors.includes(`${MODAL}::before`),
    );
    expect(layer, 'the glass modal frosting layer').toBeDefined();
    const body = layer!.body.replace(/\s+/g, ' ');
    expect(body).toContain(
      'backdrop-filter: blur(var(--glass-blur-strong)) saturate(var(--glass-saturate))',
    );
    expect(body).toContain('position: absolute');
    expect(body).toContain('inset: 0');
    expect(body).toContain('z-index: -1');
    expect(body).toContain('pointer-events: none');
    // The fill, sheen and rim the panel used to paint, in the panel's own order.
    expect(body).toContain('var(--glass-modal-alpha)');
    expect(body).toContain('var(--glass-sheen)');
    expect(body).toContain('var(--glass-rim)');
    // …and the panel is a stacking context, so the -1 layer stays inside it.
    const panel = PANEL_RULES.find((r) => r.style === 'glassmorphism')!;
    expect(panel.body).toMatch(/isolation:\s*isolate/);
    expect(panel.body).toMatch(/background-color:\s*transparent/);
  });

  it('the detector itself flags each containing-block property and passes the rest', () => {
    expect(containingBlockDeclarations('backdrop-filter: blur(4px)')).toHaveLength(1);
    expect(containingBlockDeclarations('-webkit-backdrop-filter: blur(4px)')).toHaveLength(1);
    expect(containingBlockDeclarations('transform: translateY(2px); filter: none')).toHaveLength(1);
    expect(containingBlockDeclarations('contain: paint')).toHaveLength(1);
    expect(containingBlockDeclarations('contain: style')).toHaveLength(0);
    expect(containingBlockDeclarations('will-change: transform')).toHaveLength(1);
    expect(containingBlockDeclarations('will-change: opacity')).toHaveLength(0);
    expect(containingBlockDeclarations('background-color: red; isolation: isolate')).toEqual([]);
    expect(containingBlockDeclarations('no-colon-here')).toEqual([]);
  });
});
