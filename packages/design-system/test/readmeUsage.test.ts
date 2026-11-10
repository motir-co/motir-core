import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// MOTIR-10835 — the README's `## Usage` block is the recipe every consumer
// copies into its `globals.css`. Tailwind v4's automatic source detection skips
// `node_modules`, so a consumer that imports only `tailwindcss` and `theme.css`
// gets the token utilities but never the ones used only inside the package's
// compiled components. Three starters shipped that gap by following the old
// two-line recipe. This guard keeps the `@source` line in the recipe and keeps
// it pointing at the directory the package actually publishes.

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(join(PKG_ROOT, 'README.md'), 'utf8');
const pkgJson = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
  name: string;
  files: string[];
  exports: Record<string, { import?: string } | string>;
};

function usageSection(): string {
  const start = readme.indexOf('\n## Usage\n');
  expect(start, 'README has a `## Usage` section').toBeGreaterThan(-1);
  const next = readme.indexOf('\n## ', start + 1);
  return readme.slice(start, next === -1 ? undefined : next);
}

function firstCssBlock(section: string): string {
  const match = /```css\n([\s\S]*?)```/.exec(section);
  expect(match, 'the Usage section has a css code block').not.toBeNull();
  return match?.[1] ?? '';
}

describe('@motir/design-system README — Usage recipe', () => {
  it('tells the consumer to scan the published dist with an @source line', () => {
    const css = firstCssBlock(usageSection());
    const sourceLine = css.split('\n').find((line) => line.trim().startsWith('@source'));
    expect(sourceLine, 'the globals.css recipe carries an @source line').toBeDefined();
    expect(sourceLine).toContain(`node_modules/${pkgJson.name}/dist`);
  });

  it('keeps the @source line after both imports, where CSS allows it', () => {
    const lines = firstCssBlock(usageSection())
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('@'));
    expect(lines.slice(0, 2)).toEqual([
      "@import 'tailwindcss';",
      `@import '${pkgJson.name}/theme.css';`,
    ]);
    expect(lines[2]).toMatch(/^@source /);
  });

  it('points at a directory the package publishes and builds its components into', () => {
    expect(pkgJson.files).toContain('dist');
    const dot = pkgJson.exports['.'] as { import?: string };
    expect(dot.import?.startsWith('./dist/')).toBe(true);
  });

  it('no longer claims the imports alone need no extra config', () => {
    expect(usageSection()).not.toMatch(/no extra config/i);
  });
});
