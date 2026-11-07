import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// MOTIR-10582 — the standing gate on the DatePicker's move into the package
// (Story MOTIR-10551), held against the BUILT output a consumer loads: the thin
// barrel re-exports the picker and its date-format injection, the picker chunk
// stays a client boundary, nothing the barrel reaches pulls in next-intl, next
// or an app `@/` path, and the README documents the default and precedence.
// Behaviour is tested elsewhere (DatePicker.test.tsx, datePickerFormat.test.tsx);
// this file fails if a later change drops an export, a directive or a doc.

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = path.join(PKG_ROOT, 'dist');
const DIST_INDEX = path.join(DIST, 'index.js');

const PICKER_CHUNKS = [
  'components/ui/DatePicker.js',
  'components/ui/datePickerFormat.js',
  'components/ui/DatePickerFormatContext.js',
] as const;
const PICKER_SOURCES = [
  'src/components/ui/DatePicker.tsx',
  'src/components/ui/datePickerFormat.ts',
  'src/components/ui/DatePickerFormatContext.tsx',
] as const;

/** A specifier that would tie the package to a framework or to motir-core. */
const isAppBound = (spec: string) =>
  spec === 'next-intl' ||
  spec.startsWith('next-intl/') ||
  spec === 'next' ||
  spec.startsWith('next/') ||
  spec.startsWith('@/');

const SPECIFIER = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g;
const stripJsComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const specifiers = (code: string) =>
  [...stripJsComments(code).matchAll(SPECIFIER)].map((m) => (m[1] ?? m[2])!);

let barrel: string;

beforeAll(() => {
  // Build once when the barrel is absent OR predates the picker, so a stale
  // local dist is not a confusing failure (CI builds before the suite).
  const stale =
    !existsSync(DIST_INDEX) ||
    !readFileSync(DIST_INDEX, 'utf8').includes("'./components/ui/DatePicker.js'");
  if (stale) execSync('pnpm run build', { cwd: PKG_ROOT, stdio: 'inherit' });
  barrel = readFileSync(DIST_INDEX, 'utf8');
}, 120_000);

describe('the built barrel exports the DatePicker', () => {
  it('re-exports the picker chunk and both injection chunks, and only re-exports', () => {
    for (const chunk of PICKER_CHUNKS) {
      expect(barrel).toContain(`export * from './${chunk}';`);
    }
    const codeLines = barrel
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('//'));
    for (const line of codeLines) {
      expect(line).toMatch(/^export\b.*\bfrom\s*['"]\.[^'"]*['"]\s*;?$/);
    }
  });

  it('yields the picker, provider, hook and resolver as functions, and the en default', async () => {
    const dist = (await import(DIST_INDEX)) as Record<string, unknown>;
    for (const name of [
      'DatePicker',
      'DatePickerFormatProvider',
      'useDatePickerFormat',
      'resolveDatePickerFormat',
      'defaultDatePickerFormatter',
    ]) {
      expect(typeof dist[name], name).toBe('function');
    }
    expect(dist.DEFAULT_DATE_PICKER_LOCALE).toBe('en');
    const format = dist.defaultDatePickerFormatter as (iso: string, locale: string) => string;
    expect(format('2026-06-03', 'en')).toBe('Jun 3, 2026');
  });

  it('the picker chunk starts with the use-client directive', () => {
    const firstCode = readFileSync(path.join(DIST, 'components/ui/DatePicker.js'), 'utf8')
      .split('\n')
      .find((l) => l.trim() !== '' && !l.trim().startsWith('//'));
    expect(firstCode?.trim()).toMatch(/^['"]use client['"];?$/);
  });
});

describe('nothing the barrel reaches is app-bound', () => {
  function reachable(): { files: Set<string>; bare: Map<string, string> } {
    const files = new Set<string>();
    const bare = new Map<string, string>();
    const queue = [DIST_INDEX];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (files.has(file)) continue;
      files.add(file);
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.')) {
          const target = path.resolve(path.dirname(file), spec);
          queue.push(target.endsWith('.js') ? target : `${target}.js`);
        } else if (!bare.has(spec)) {
          bare.set(spec, path.relative(DIST, file));
        }
      }
    }
    return { files, bare };
  }

  it('walks the picker chunk and both injection chunks', () => {
    const { files } = reachable();
    for (const chunk of PICKER_CHUNKS) expect(files.has(path.join(DIST, chunk)), chunk).toBe(true);
  });

  it('imports no next-intl, no next and no @/ path', () => {
    const offenders = [...reachable().bare].filter(([spec]) => isAppBound(spec));
    expect(offenders, JSON.stringify(offenders)).toEqual([]);
  });

  it('the three picker sources import none of them either', () => {
    for (const file of PICKER_SOURCES) {
      const specs = specifiers(readFileSync(path.join(PKG_ROOT, file), 'utf8'));
      expect(specs.filter(isAppBound), file).toEqual([]);
    }
    // Not vacuous: the picker's own import list is read (datePickerFormat.ts
    // legitimately imports nothing).
    const picker = specifiers(readFileSync(path.join(PKG_ROOT, PICKER_SOURCES[0]), 'utf8'));
    expect(picker).toContain('./Popover');
  });

  it('the guard is live: an app-bound specifier is flagged', () => {
    expect(
      specifiers("import { useLocale } from 'next-intl';\nimport x from '@/lib/x';").filter(
        isAppBound,
      ),
    ).toEqual(['next-intl', '@/lib/x']);
    expect(isAppBound('next/link')).toBe(true);
    expect(isAppBound('react')).toBe(false);
  });
});

describe('the README documents the picker', () => {
  const readme = readFileSync(path.join(PKG_ROOT, 'README.md'), 'utf8');

  it('has the DatePicker section with its default and precedence sub-sections', () => {
    expect(readme).toMatch(/^## DatePicker$/m);
    expect(readme).toMatch(/^### The default$/m);
    expect(readme).toMatch(/^### Precedence$/m);
    expect(readme).toContain('Jun 3, 2026');
  });

  it('no longer places the DatePicker outside the package', () => {
    expect(readme).not.toContain('is **excluded** from this extraction');
    expect(readme).not.toContain('follow-up for the consume/port work');
  });
});
