import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-10730 — under Neumorphism an invalid Input must keep its danger border.
//
// `Input` draws its edge with a UTILITY on the wrapper div that carries
// `data-surface="input"`: `border-(--el-danger)` when invalid,
// `border-(--el-input-disabled-border)` when disabled, `border-(--el-input-border)`
// otherwise. Tailwind v4 puts that utility in `@layer utilities`, and theme.css is
// imported UNLAYERED (`app/globals.css`), so an unlayered `border-color` inside
// the neumorphism material rule wins in EVERY state — the field kept the 45%
// hairline instead of turning red. The disabled field's softer edge was lost the
// same way.
//
// The fix is the one claymorphism / art-deco / memphis already use: the base
// material rule paints only the fill + inset shadow, and the softened edge is
// scoped to `:not(:has([aria-invalid='true']), [data-state='disabled'])`. This
// suite reads the stylesheet as data — like the other token-layer suites — and
// fails if an unconditional neumorphism input rule ever repaints `border-color`
// over the primitive's state again.

const CSS = readFileSync(join(process.cwd(), 'packages/design-system/theme.css'), 'utf8');

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the block whose `{` sits at `openBrace`, plus the index after it. */
function matchBlock(css: string, openBrace: number): { inner: string; end: number } {
  let depth = 0;
  for (let i = openBrace; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return { inner: css.slice(openBrace + 1, i), end: i + 1 };
    }
  }
  throw new Error(`unbalanced braces from index ${openBrace}`);
}

/** Remove every `@media … { … }` block, leaving the unconditional rules behind. */
function withoutMedia(css: string): string {
  let out = '';
  let cursor = 0;
  while (cursor < css.length) {
    const at = css.indexOf('@media', cursor);
    if (at === -1) {
      out += css.slice(cursor);
      break;
    }
    out += css.slice(cursor, at);
    cursor = matchBlock(css, css.indexOf('{', at)).end;
  }
  return out;
}

/** Every `@media (prefers-contrast: more)` body, concatenated. */
function prefersContrastBodies(css: string): string {
  const re = /@media\s*\(prefers-contrast:\s*more\)\s*\{/g;
  let out = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const { inner, end } = matchBlock(css, css.indexOf('{', m.index));
    out += inner;
    re.lastIndex = end;
  }
  return out;
}

interface ScopedRule {
  selector: string;
  body: string;
}

/** Every rule inside a neumorphism `@scope (…) to ([data-style])` block. */
function neumorphismRules(css: string): ScopedRule[] {
  const scope = /@scope\s*\(\[data-style='neumorphism'\]\)\s*to\s*\(\[data-style\]\)\s*\{/g;
  const out: ScopedRule[] = [];
  let m: RegExpExecArray | null;
  while ((m = scope.exec(css)) !== null) {
    const { inner, end } = matchBlock(css, css.indexOf('{', m.index));
    let cursor = 0;
    while (cursor < inner.length) {
      const brace = inner.indexOf('{', cursor);
      if (brace === -1) break;
      const rule = matchBlock(inner, brace);
      out.push({
        selector: inner.slice(cursor, brace).trim().replace(/\s+/g, ' '),
        body: rule.inner,
      });
      cursor = rule.end;
    }
    scope.lastIndex = end;
  }
  return out;
}

const SOFT_EDGE = 'color-mix(in srgb, var(--el-border) 45%, transparent)';
const INVALID_GUARD = "[aria-invalid='true']";
const DISABLED_GUARD = "[data-state='disabled']";
const INPUT = "[data-surface='input']";

/** Split a selector list on its TOP-LEVEL commas — not the ones inside `:not(…)`. */
function splitSelectors(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const char = selector[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(' || char === '[') {
      depth += 1;
    } else if (char === ')' || char === ']') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      parts.push(selector.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(selector.slice(start).trim());
  return parts;
}

/**
 * Assert that every neumorphism rule painting `border-color` on `data-surface`
 * input is state-guarded. `data-surface` is on the Input's WRAPPER, so the guards
 * read the descendant `<input aria-invalid>` and the wrapper's own `data-state`.
 */
function expectGuarded(rules: ScopedRule[], where: string): void {
  for (const rule of rules) {
    if (!/(?:^|[;{\s])border-color\s*:/.test(rule.body)) continue;
    for (const selector of splitSelectors(rule.selector)) {
      if (!selector.includes(INPUT)) continue;
      expect(
        selector,
        `${where}: "${selector}" repaints border-color over the Input's state edge`,
      ).toContain(INVALID_GUARD);
      expect(selector, `${where}: "${selector}" repaints the disabled edge too`).toContain(
        DISABLED_GUARD,
      );
    }
  }
}

describe('neumorphism input material (MOTIR-10730)', () => {
  const normal = neumorphismRules(withoutMedia(stripComments(CSS)));

  it('keeps the fill and the inset shadow on the unconditional base rule', () => {
    const base = normal.find((rule) => rule.selector === INPUT);
    expect(base, 'no unconditional [data-surface=input] material rule').toBeDefined();
    expect(base!.body).toContain('background-color: var(--el-surface)');
    expect(base!.body).toContain('box-shadow:');
  });

  it('does NOT set border-color on the unconditional base rule', () => {
    const base = normal.find((rule) => rule.selector === INPUT);
    expect(base!.body).not.toMatch(/border-color\s*:/);
  });

  it('paints the softened edge only when the field is valid and editable', () => {
    const soft = normal.filter(
      (rule) =>
        rule.body.includes('border-color') &&
        splitSelectors(rule.selector).some((part) => part.includes(INPUT)),
    );
    expect(soft).toHaveLength(1);
    expect(soft[0]!.selector).toContain(INVALID_GUARD);
    expect(soft[0]!.selector).toContain(DISABLED_GUARD);
    expect(soft[0]!.body).toContain(SOFT_EDGE);
  });

  it('guards every unconditional neumorphism border rule for the input', () => {
    expectGuarded(normal, 'normal mode');
  });

  it('guards the prefers-contrast fallback so the danger edge survives it', () => {
    const contrast = neumorphismRules(prefersContrastBodies(stripComments(CSS)));
    expect(contrast.length).toBeGreaterThan(0);
    expectGuarded(contrast, 'prefers-contrast: more');
  });
});
