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
// chose on purpose (DeviceApproval's `describedAt`, a hook's own `useNow`).
// Server components pass too — they render once per request, and the pin is
// exactly right for them.

const ROOT = join(__dirname, '..', '..');
/** The directive, after any leading comments. */
const USE_CLIENT = /^(?:\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/))*\s*['"]use client['"]/;

function clientModules(): string[] {
  return execFileSync('git', ['ls-files', '--', 'app', 'components', 'lib'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f) && !/\.d\.ts$/.test(f))
    .filter((f) => USE_CLIENT.test(readFileSync(join(ROOT, f), 'utf8')));
}

/** `file:line` of every one-argument `<x>.relativeTime(…)` call in `source`. */
function oneArgumentRelativeTimeCalls(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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

  it('no client module calls `.relativeTime(date)` with one argument', () => {
    const files = clientModules();
    // The scan is over the real tree: an empty file list would pass vacuously.
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.flatMap((f) =>
      oneArgumentRelativeTimeCalls(f, readFileSync(join(ROOT, f), 'utf8')),
    );
    expect(
      offenders,
      'Use `useRelativeTime()` from `@/lib/hooks/useRelativeTime` in a client component',
    ).toEqual([]);
  });
});
