import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STYLE_IDS } from '@/lib/theme/styles';

// MOTIR-8910 — the story integration gate for the density axis of the shape swap.
//
// Three pieces each have a test of their own: the 21 derived steps in
// `packages/design-system/theme.css` (densityScale.test.ts), the own-box check
// (shapeSwapLint.test.ts) and the style registry (styleRegistry.test.ts). Each
// reads ONE piece. This file reads all three over the whole swept tree and asserts
// they AGREE: the check is on for every root, every token a source names exists,
// the scale is actually used, the allowlist still describes the tree, and every
// registered style resolves every step. It reads the lint test as TEXT rather than
// importing it, so a rename there fails here instead of silently passing.

const REPO = process.cwd();
const THEME = readFileSync(join(REPO, 'packages/design-system/theme.css'), 'utf8');
const LINT = readFileSync(join(REPO, 'tests/theme/shapeSwapLint.test.ts'), 'utf8');

const ROOTS = ['components/', 'app/', 'packages/design-system/src/'] as const;

/** base token → [reference px, the derived step sizes] — the story's approved vocabulary. */
const SCALE = {
  '--spacing-card-padding': [24, [16, 12, 8, 4]],
  '--spacing-control-x': [10, [16, 12, 8, 6, 4, 2]],
  '--spacing-control-y': [6, [8, 4, 2]],
  '--spacing-chip-x': [10, [8, 6, 4, 2]],
  '--height-control': [36, [28, 32, 40, 48]],
} as const satisfies Record<string, readonly [number, readonly number[]]>;

const STEP_NAMES = Object.entries(SCALE).flatMap(([base, [, steps]]) =>
  steps.map((n) => `${base}-${n}`),
);

/**
 * Steps no source references, each with the reason that is accepted. None today: the
 * last one, `--spacing-chip-x-2`, is the compact `CommandChip`'s padding since Bug
 * MOTIR-11982. A step added here needs a reason a reviewer can weigh.
 */
const UNUSED_STEPS_ACCEPTED: Record<string, string> = {};

// ── source scan ──────────────────────────────────────────────────────────────

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const TRACKED = execFileSync(
  'git',
  [
    'ls-files',
    'components/*.tsx',
    'components/**/*.tsx',
    'components/**/*.ts',
    'app/**/*.tsx',
    'app/**/*.ts',
    'packages/design-system/src/**/*.tsx',
    'packages/design-system/src/**/*.ts',
  ],
  { cwd: REPO, encoding: 'utf8' },
)
  .split('\n')
  .filter((f) => f && !f.startsWith('app/tokens/'));

const SOURCES = new Map<string, string>(
  TRACKED.map((f) => [f, stripComments(readFileSync(join(REPO, f), 'utf8'))]),
);

// ── pure checks (each is fed a mutation below) ───────────────────────────────

/** Every declared custom property name in the stylesheet. */
function declaredNames(css: string): Set<string> {
  return new Set([...stripComments(css).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
}

/** `--spacing-*` / `--height-*` names a source writes in token form or `var()`. */
function tokenReferences(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/(?:\w+-\(|var\()\s*(--(?:spacing|height)-[a-z0-9-]+)/g))
    out.push(m[1]!);
  return out;
}

/** Referenced names that the stylesheet does not declare. */
function danglingTokens(source: string, declared: ReadonlySet<string>): string[] {
  return tokenReferences(source).filter((n) => !declared.has(n));
}

const PADDING_UTIL = /(?<![\w-])(?:[a-z0-9-]+:)*(p[xytblr]?)-\((--[a-z0-9-]+)\)/g;
const HEIGHT_UTIL = /(?<![\w-])(?:[a-z0-9-]+:)*h-\((--[a-z0-9-]+)\)/g;

/** A padding utility on a `--height-*` token, or `h-` on a `--spacing-*` token. */
function wrongFamily(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(PADDING_UTIL))
    if (m[2]!.startsWith('--height-')) out.push(`${m[1]}-(${m[2]})`);
  for (const m of source.matchAll(HEIGHT_UTIL))
    if (m[1]!.startsWith('--spacing-')) out.push(`h-(${m[1]})`);
  return out;
}

/** Every top-level `selector { body }` block, brace-balanced. */
function topLevelBlocks(css: string): Array<{ selector: string; body: string }> {
  const blocks: Array<{ selector: string; body: string }> = [];
  let depth = 0;
  let selectorStart = 0;
  let bodyStart = 0;
  let selector = '';
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') {
      if (depth === 0) {
        selector = css.slice(selectorStart, i).trim();
        bodyStart = i + 1;
      }
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        blocks.push({ selector, body: css.slice(bodyStart, i) });
        selectorStart = i + 1;
      }
    } else if (ch === ';' && depth === 0) {
      selectorStart = i + 1;
    }
  }
  return blocks;
}

/** Selectors of every block that declares a step, so the caller can see where each lives. */
function stepDeclarers(css: string): string[] {
  return topLevelBlocks(stripComments(css))
    .filter((b) => STEP_NAMES.some((n) => new RegExp(`${n}\\s*:`).test(b.body)))
    .map((b) => b.selector);
}

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

// ── parse the lint test's two edit points as text ────────────────────────────

function enforcedPrefixes(): string[] {
  const m = /const OWN_BOX_ENFORCED_PREFIXES: string\[\] = \[([\s\S]*?)\];/.exec(LINT);
  if (!m) throw new Error('OWN_BOX_ENFORCED_PREFIXES not found in shapeSwapLint.test.ts');
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

function allowlistEntries(): Array<{ key: string; reason: string }> {
  const m = /const OWN_BOX_ALLOWED: Record<string, string> = \{([\s\S]*?)\n\};/.exec(LINT);
  if (!m) throw new Error('OWN_BOX_ALLOWED not found in shapeSwapLint.test.ts');
  return [...m[1]!.matchAll(/'([^'\n]+ → [^'\n]+)':\s*(['"])((?:(?!\2)[^\\]|\\.)*)\2/g)].map(
    (x) => ({ key: x[1]!, reason: x[3]! }),
  );
}

// ── the cases ────────────────────────────────────────────────────────────────

describe('density integration — enforcement is total', () => {
  it('enforces exactly the three scanned roots', () => {
    expect(enforcedPrefixes()).toEqual([...ROOTS]);
  });

  it('scans a non-trivial tree under each root', () => {
    for (const root of ROOTS)
      expect(TRACKED.filter((f) => f.startsWith(root)).length).toBeGreaterThan(20);
  });
});

describe('density integration — every token a source names exists, in the right family', () => {
  const declared = declaredNames(THEME);

  it('declares all 21 steps and their five bases', () => {
    for (const n of [...STEP_NAMES, ...Object.keys(SCALE)]) expect(declared.has(n)).toBe(true);
  });

  it('has no dangling --spacing-* / --height-* reference in any scanned source', () => {
    const dangling: string[] = [];
    for (const [file, source] of SOURCES)
      for (const n of danglingTokens(source, declared)) dangling.push(`${file} → ${n}`);
    expect(dangling).toEqual([]);
  });

  it('never puts a height token on a padding utility or a spacing token on h-', () => {
    const wrong: string[] = [];
    for (const [file, source] of SOURCES)
      for (const w of wrongFamily(source)) wrong.push(`${file} → ${w}`);
    expect(wrong).toEqual([]);
  });

  it('control: a misspelt step is reported as dangling', () => {
    expect(danglingTokens('x px-(--spacing-control-x-9) y', declared)).toEqual([
      '--spacing-control-x-9',
    ]);
    expect(
      danglingTokens('x h-(--height-control-40) px-(--spacing-control-x-8)', declared),
    ).toEqual([]);
    expect(danglingTokens('style={{ gap: "var(--spacing-nope)" }}', declared)).toEqual([
      '--spacing-nope',
    ]);
  });

  it('control: a wrong-family token is reported', () => {
    expect(wrongFamily('px-(--height-control-40)')).toEqual(['px-(--height-control-40)']);
    expect(wrongFamily('md:h-(--spacing-control-x-8)')).toEqual(['h-(--spacing-control-x-8)']);
    expect(wrongFamily('px-(--spacing-control-x-8) h-(--height-control-40)')).toEqual([]);
  });
});

describe('density integration — the scale is used, not just defined', () => {
  const used = new Set<string>();
  const usedByRoot = new Map<string, Set<string>>(ROOTS.map((r) => [r, new Set()]));
  for (const [file, source] of SOURCES)
    for (const n of tokenReferences(source)) {
      if (!STEP_NAMES.includes(n)) continue;
      used.add(n);
      for (const root of ROOTS) if (file.startsWith(root)) usedByRoot.get(root)!.add(n);
    }

  it('references at least one step in each of the three roots', () => {
    for (const root of ROOTS) expect([root, usedByRoot.get(root)!.size > 0]).toEqual([root, true]);
  });

  it('references every one of the 21 steps, or lists it with a reason', () => {
    const unused = STEP_NAMES.filter((n) => !used.has(n) && !(n in UNUSED_STEPS_ACCEPTED));
    expect(unused).toEqual([]);
  });

  it('keeps UNUSED_STEPS_ACCEPTED honest: every entry is a real, unused step with a reason', () => {
    for (const [name, reason] of Object.entries(UNUSED_STEPS_ACCEPTED)) {
      expect(STEP_NAMES).toContain(name);
      expect(used.has(name)).toBe(false);
      expect(reason.trim()).not.toBe('');
    }
  });
});

describe('density integration — the allowlist still describes the tree', () => {
  const entries = allowlistEntries();

  it('parses the allowlist', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('has unique keys', () => {
    const keys = entries.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('points every key at a tracked file that still carries the utility, with a reason', () => {
    const problems: string[] = [];
    for (const { key, reason } of entries) {
      const [file, utility] = key.split(' → ') as [string, string];
      const source = SOURCES.get(file);
      if (source === undefined) {
        problems.push(`${key}: file is not a scanned source`);
        continue;
      }
      const esc = utility.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`(?<![\\w-])(?:[a-z0-9-]+:)*${esc}(?![\\w.\\[-])`).test(source))
        problems.push(`${key}: utility no longer appears in the file`);
      if (reason.trim() === '') problems.push(`${key}: empty reason`);
    }
    expect(problems).toEqual([]);
  });
});

describe('density integration — the derivation stays single-sourced', () => {
  it('declares the 21 steps in exactly one rule, whose selector list is `:root, [data-style]`', () => {
    const where = stepDeclarers(THEME);
    expect(where).toHaveLength(1);
    expect(where[0]!.split(',').map((s) => s.trim())).toEqual([':root', '[data-style]']);
  });

  it('declares each step exactly once', () => {
    const code = stripComments(THEME);
    for (const n of STEP_NAMES)
      expect([n, [...code.matchAll(new RegExp(`${n}\\s*:`, 'g'))].length]).toEqual([n, 1]);
  });

  it('control: a step pasted into a style block or @theme is reported', () => {
    const style = `${THEME}\n[data-style='warm-editorial'] { --spacing-control-x-8: 1px; }\n`;
    expect(stepDeclarers(style)).toHaveLength(2);
    const theme = `${THEME}\n@theme { --height-control-40: 1px; }\n`;
    expect(stepDeclarers(theme)).toHaveLength(2);
  });
});

describe('density integration — every registered style resolves every step', () => {
  const blocks = topLevelBlocks(stripComments(THEME));
  const themeBases = declarations(blocks.find((b) => b.selector === '@theme')!.body);

  function basePx(styleDecls: Map<string, string>, base: string): number {
    const raw = styleDecls.get(base) ?? themeBases.get(base);
    const m = /^(\d+(?:\.\d+)?)px$/.exec(raw ?? '');
    if (!m) throw new Error(`${base} is not a px length: ${raw}`);
    return Number(m[1]);
  }

  it('has a [data-style] block for every id in the registry', () => {
    const present = blocks.flatMap((b) => {
      const m = /^\[data-style='([a-z0-9-]+)'\]$/.exec(b.selector);
      return m ? [m[1]!] : [];
    });
    expect(present.sort()).toEqual([...STYLE_IDS].sort());
  });

  it('resolves each step to a positive whole-pixel length in all registered styles', () => {
    const bad: string[] = [];
    for (const id of STYLE_IDS) {
      const block = blocks.find((b) => b.selector === `[data-style='${id}']`);
      const decls = block ? declarations(block.body) : new Map<string, string>();
      for (const [base, [ref, steps]] of Object.entries(SCALE)) {
        const b = basePx(decls, base);
        for (const n of steps) {
          const px = Math.round((b * n) / ref);
          if (!(px > 0 && Number.isInteger(px))) bad.push(`${id} ${base}-${n} = ${px}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
