import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// A DECIDED PLAN TAKES ITS STEPS WITH IT (Bug MOTIR-11833).
//
// A `plan_step` row is a live session's mark, and since MOTIR-11184 one never ages out, so a
// row left on a plan nothing will write again reads its card as being written for good. Every
// write that moves a plan to a TERMINAL status — `declined` (a person's decline, a discard, the
// abandoned sweep, an ended session, an unresumable attempt) or `approved` — therefore deletes
// the plan's steps in the same transaction. This guard finds every such write in
// `lib/services/` and fails one that does not, so a new terminal path cannot forget it.
//
// It walks `lib/services/` with its own `readdirSync` and imports nothing from `lib/` or `app/`
// (the structural-guard lane's rule — `tests/helpers/structuralGuardLane.ts`).

const ROOT = resolve(__dirname, '..', '..');
const SERVICES = join(ROOT, 'lib', 'services');
const TERMINAL_WRITE = /status: '(declined|approved)'/g;
const DELETE_STEPS = 'planStepRepository.deleteForPlan(';
/** How far after a terminal write its delete may sit: the rest of the `update(…)` call
 *  (its other fields and `tx`) plus a comment line. */
const WITHIN_LINES = 30;

interface TerminalWrite {
  file: string;
  line: number;
  status: string;
}

/** Every `planRepository.update(…)` writing a terminal status in `source`. */
export function terminalWritesIn(file: string, source: string): TerminalWrite[] {
  const lines = source.split('\n');
  const out: TerminalWrite[] = [];
  lines.forEach((text, i) => {
    for (const m of text.matchAll(TERMINAL_WRITE)) {
      // The NEAREST `update(` opened at or above the write is the call it belongs to.
      const before = lines.slice(Math.max(0, i - 8), i + 1).join('\n');
      const callee = [...before.matchAll(/(\w+)\.update\(/g)].pop()?.[1];
      if (callee !== 'planRepository') continue;
      out.push({ file, line: i + 1, status: m[1]! });
    }
  });
  return out;
}

/** Whether the steps are deleted within {@link WITHIN_LINES} of the write. */
export function deletesStepsAfter(source: string, line: number): boolean {
  return source
    .split('\n')
    .slice(line, line + WITHIN_LINES)
    .some((text) => text.includes(DELETE_STEPS));
}

function serviceFiles(): string[] {
  return readdirSync(SERVICES, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(SERVICES, f));
}

describe('the terminal-write scanner', () => {
  const FIXTURE = [
    'const a = await planRepository.update(',
    '  planId,',
    "  { status: 'declined', decidedAt: now },",
    '  tx,',
    ');',
    'await planStepRepository.deleteForPlan(planId, tx);',
    "if (plan.status === 'declined') return;",
    "await gateRepository.update(id, { status: 'approved' }, tx);",
    'await planRepository.update(',
    '  planId,',
    "  { status: 'approved' },",
    '  tx,',
    ');',
  ].join('\n');

  it('finds a plan write, and only a plan write', () => {
    expect(terminalWritesIn('f.ts', FIXTURE)).toEqual([
      { file: 'f.ts', line: 3, status: 'declined' },
      { file: 'f.ts', line: 11, status: 'approved' },
    ]);
  });

  it('sees the delete after the first and its absence after the second', () => {
    expect(deletesStepsAfter(FIXTURE, 3)).toBe(true);
    expect(deletesStepsAfter(FIXTURE, 11)).toBe(false);
  });
});

describe('every terminal plan write deletes the plan’s steps', () => {
  const writes = serviceFiles().flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return terminalWritesIn(file, source).map((w) => ({ ...w, source }));
  });

  it('finds the terminal writes at all — the scan is not vacuous', () => {
    expect(writes.filter((w) => w.status === 'declined').length).toBeGreaterThanOrEqual(7);
    expect(writes.filter((w) => w.status === 'approved').length).toBeGreaterThanOrEqual(1);
  });

  it('none leaves its steps behind', () => {
    const missing = writes
      .filter((w) => !deletesStepsAfter(w.source, w.line))
      .map((w) => `${w.file.slice(ROOT.length + 1)}:${w.line} (${w.status})`);
    expect(missing).toEqual([]);
  });
});
