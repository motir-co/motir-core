import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, stripComments } from '../helpers/importGraph';

// MOTIR-10582 — the standing gate on the DatePicker's move into
// `@motir/design-system` (Story MOTIR-10551), motir-core side.
//
// The app-bound `components/ui/DatePicker.tsx` was deleted with NO re-export
// shim: every picker in motir-core comes from the package. This file fails if a
// later change re-adds the file, imports or path-reads it again, or renders a
// `<DatePicker>` imported from anywhere else.
//
// ── How the sweep decides ──────────────────────────────────────────────────
// The package file `packages/design-system/src/components/ui/DatePicker.tsx`
// CONTAINS the old path as a substring, and `tests/theme/iconTextSurfaceTokens
// .test.ts` legitimately reads it — so a substring grep would flag the right
// answer. The sweep instead collects every STRING LITERAL in comment-stripped
// code that ends in `/DatePicker`, `/DatePicker.tsx` or `/DatePicker.ts`, and
// exempts the ones naming `packages/design-system`. A string literal is what an
// import, a `require`, a dynamic `import()` and a path read (`read('…')`) all
// share, so one rule covers all four; a mention in a comment is not code.

const SCAN_ROOTS = ['app', 'components', 'lib', 'tests'] as const;
const SELF = 'tests/theme/datePickerMoveGate.test.ts';

/** Every scannable source file under `dir`, repo-relative with `/` separators. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|mjs|cjs|js)$/.test(entry)) {
      const rel = relative(REPO_ROOT, full).split(sep).join('/');
      if (rel !== SELF) out.push(rel);
    }
  }
  return out;
}

const SOURCE_FILES = SCAN_ROOTS.flatMap((root) => walk(join(REPO_ROOT, root)));

/** A quoted literal whose value ends in /DatePicker(.ts|.tsx). */
const OLD_PATH_LITERAL = /(['"`])([^'"`\n]*\/DatePicker(?:\.tsx?)?)\1/g;

/** The old-path literals in one source text, comments ignored. A text with no
 *  `/DatePicker` substring cannot hold one, so it skips the comment strip — the
 *  strip over ~9,000 files is what made the sweep slow enough to time out on a
 *  loaded CI leg. */
function oldPathLiterals(source: string): string[] {
  if (!source.includes('/DatePicker')) return [];
  return [...stripComments(source).matchAll(OLD_PATH_LITERAL)]
    .map((m) => m[2]!)
    .filter((literal) => !literal.includes('packages/design-system'));
}

const read = (file: string) => readFileSync(join(REPO_ROOT, file), 'utf8');

describe('the app-bound DatePicker is gone', () => {
  it('components/ui/DatePicker.tsx does not exist (no shim, no re-export)', () => {
    expect(existsSync(join(REPO_ROOT, 'components/ui/DatePicker.tsx'))).toBe(false);
  });

  it('no import or path read of it remains under app/, components/, lib/ or tests/', () => {
    const offenders = SOURCE_FILES.flatMap((file) =>
      oldPathLiterals(read(file)).map((literal) => `${file}: '${literal}'`),
    );
    expect(offenders).toEqual([]);
  });

  it('every file that renders <DatePicker> imports it from @motir/design-system', () => {
    const renderers = SOURCE_FILES.filter(
      (f) =>
        !f.startsWith('lib/') &&
        f.endsWith('.tsx') &&
        read(f).includes('<DatePicker') &&
        /<DatePicker[\s/>]/.test(stripComments(read(f))),
    );
    expect(renderers.length).toBeGreaterThan(0);
    const wrongSource = renderers.filter(
      (f) =>
        !/import\s*\{[^}]*\bDatePicker\b[^}]*\}\s*from\s*['"]@motir\/design-system['"]/.test(
          stripComments(read(f)),
        ),
    );
    expect(wrongSource).toEqual([]);
    expect(renderers).toContain('app/tokens/date-picker/page.tsx');
  });
});

describe('the sweep is live', () => {
  it('flags an alias import, a relative import and a path read of the old file', () => {
    expect(oldPathLiterals("import { DatePicker } from '@/components/ui/DatePicker';")).toEqual([
      '@/components/ui/DatePicker',
    ]);
    expect(oldPathLiterals("import { DatePicker } from './DatePicker';")).toEqual(['./DatePicker']);
    expect(oldPathLiterals("const src = read('components/ui/DatePicker.tsx');")).toEqual([
      'components/ui/DatePicker.tsx',
    ]);
    expect(oldPathLiterals("const m = await import('@/components/ui/DatePicker');")).toEqual([
      '@/components/ui/DatePicker',
    ]);
  });

  it('does not flag the package path or a comment-only mention', () => {
    expect(
      oldPathLiterals("read('packages/design-system/src/components/ui/DatePicker.tsx');"),
    ).toEqual([]);
    expect(oldPathLiterals("// was '@/components/ui/DatePicker' before MOTIR-10551")).toEqual([]);
    expect(oldPathLiterals("/* import from '@/components/ui/DatePicker' */")).toEqual([]);
  });

  it('walks a real population', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(400);
    expect(SOURCE_FILES).toContain('tests/components/date-picker.test.tsx');
  });
});
