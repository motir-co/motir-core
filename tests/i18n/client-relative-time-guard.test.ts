import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// CLIENT RELATIVE TIMES GO THROUGH THE LIVE CLOCK (MOTIR-11970).
//
// `i18n/request.ts` pins next-intl's `now` once per request (finding #89). A
// client component that calls `format.relativeTime(date)` with ONE argument
// measures against that pin for as long as the page stays open: a row the
// browser fetches or appends after load reads "in 3 minutes", and every older
// row stays as old as it was at load. `useRelativeTime()`
// (`lib/hooks/useRelativeTime.ts`) is the door that measures against a live
// clock instead, so this guard holds every `'use client'` module under `app/`,
// `components/` and `lib/` to it: no one-argument `.relativeTime(…)` call.
//
// A two-argument call passes: it measures against an instant the component
// chose on purpose (DeviceApproval's `describedAt`, a ticking
// `useNow({ updateInterval })`, `useLiveNow()`) — UNLESS that instant is the pin
// itself (MOTIR-11993): `.relativeTime(x, now)` where `now` is bound from a bare
// next-intl `useNow()` in the same module, or `.relativeTime(x, useNow())`. With
// no `updateInterval`, `useNow()` returns the provider's pinned request instant,
// so the call is the one-argument defect in two-argument form.
// Server components pass too — they render once per request, and the pin is
// exactly right for them.

const ROOT = join(__dirname, '..', '..');
/** Source files under the scanned roots that mention the directive at all. */
function candidateModules(): { file: string; source: string }[] {
  return execFileSync('git', ['ls-files', '--', 'app', 'components', 'lib'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f) && !/\.d\.ts$/.test(f))
    .map((file) => ({ file, source: readFileSync(join(ROOT, file), 'utf8') }))
    .filter(({ source }) => source.includes('use client'));
}

/** The module's first statement is the `'use client'` directive (comments before it allowed). */
function isClientModule(sf: ts.SourceFile): boolean {
  const first = sf.statements[0];
  return (
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === 'use client'
  );
}

/** `file:line` of every one-argument `<x>.relativeTime(…)` call in `source`. */
function oneArgumentRelativeTimeCalls(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (!isClientModule(sf)) return [];
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'relativeTime' &&
      node.arguments.length < 2
    ) {
      found.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** The local names next-intl's `useNow` is imported under in `sf`. */
function nextIntlUseNowNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (
      !ts.isImportDeclaration(st) ||
      !ts.isStringLiteral(st.moduleSpecifier) ||
      st.moduleSpecifier.text !== 'next-intl'
    ) {
      continue;
    }
    const bindings = st.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      if ((el.propertyName ?? el.name).text === 'useNow') names.add(el.name.text);
    }
  }
  return names;
}

/** `file:line` of every `.relativeTime(x, n)` call whose `n` is the PINNED
 * instant: a bare next-intl `useNow()` (no options), inline or bound to a name
 * in the same module. */
function pinnedNowRelativeTimeCalls(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (!isClientModule(sf)) return [];
  const useNowNames = nextIntlUseNowNames(sf);
  if (useNowNames.size === 0) return [];
  const isBareUseNow = (node: ts.Node): boolean =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    useNowNames.has(node.expression.text) &&
    node.arguments.length === 0;
  const pinned = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isBareUseNow(node.initializer)
    ) {
      pinned.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'relativeTime' &&
      node.arguments.length >= 2
    ) {
      const n = node.arguments[1]!;
      if (isBareUseNow(n) || (ts.isIdentifier(n) && pinned.has(n.text))) {
        found.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('client relative times measure against the live clock (MOTIR-11970)', () => {
  it('the scanner finds a one-argument call and passes a two-argument one', () => {
    const src = [
      "'use client';",
      'const a = format.relativeTime(new Date(x));',
      'const b = format.relativeTime(new Date(x), now);',
      'const c = relativeTime(x);',
    ].join('\n');
    expect(oneArgumentRelativeTimeCalls('f.tsx', src)).toEqual(['f.tsx:2']);
  });

  it('a server module, or a comment before the directive, is read correctly', () => {
    const server = 'const a = format.relativeTime(new Date(x));';
    expect(oneArgumentRelativeTimeCalls('s.tsx', server)).toEqual([]);
    const commented = ['// header', '/* note */', "'use client';", 'format.relativeTime(x);'];
    expect(oneArgumentRelativeTimeCalls('c.tsx', commented.join('\n'))).toEqual(['c.tsx:4']);
  });

  it('the scanner finds a two-argument call measured against a bare `useNow()` (MOTIR-11993)', () => {
    const src = [
      "'use client';",
      "import { useFormatter, useNow as useIntlNow } from 'next-intl';",
      'const pin = useIntlNow();',
      'const ticking = useIntlNow({ updateInterval: 60_000 });',
      'const a = format.relativeTime(date, pin);',
      'const b = format.relativeTime(date, useIntlNow());',
      'const c = format.relativeTime(date, ticking);',
      'const d = format.relativeTime(date, describedAt);',
    ].join('\n');
    expect(pinnedNowRelativeTimeCalls('f.tsx', src)).toEqual(['f.tsx:5', 'f.tsx:6']);
    // A local hook that happens to be called `useNow` is not next-intl's pin.
    const local = ["'use client';", 'const now = useNow();', 'format.relativeTime(d, now);'];
    expect(pinnedNowRelativeTimeCalls('l.tsx', local.join('\n'))).toEqual([]);
    const server = ["import { useNow } from 'next-intl';", 'format.relativeTime(d, useNow());'];
    expect(pinnedNowRelativeTimeCalls('s.tsx', server.join('\n'))).toEqual([]);
  });

  it('no client module measures `.relativeTime(date, now)` against the pinned `useNow()`', () => {
    const offenders = candidateModules()
      .filter(({ source }) => source.includes('relativeTime') && source.includes('useNow'))
      .flatMap(({ file, source }) => pinnedNowRelativeTimeCalls(file, source));
    expect(
      offenders,
      'Use `useRelativeTime()` or `useLiveNow()` from `@/lib/hooks/useRelativeTime`',
    ).toEqual([]);
  });

  it('no client module calls `.relativeTime(date)` with one argument', () => {
    const files = candidateModules();
    // The scan is over the real tree: an empty file list would pass vacuously.
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .filter(({ source }) => source.includes('relativeTime'))
      .flatMap(({ file, source }) => oneArgumentRelativeTimeCalls(file, source));
    expect(
      offenders,
      'Use `useRelativeTime()` from `@/lib/hooks/useRelativeTime` in a client component',
    ).toEqual([]);
  });
});
