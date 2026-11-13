import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// THE RETIRED REPLAY STAYS RETIRED (Story MOTIR-11190 · Subtask MOTIR-11204).
//
// MOTIR-11201 deleted the quick view's replayed type-in — the component, its
// pure rules, its token, its arming and its tests — and replaced it with the
// card's real text as the model writes it. This guard keeps the word for that
// replay out of every tracked file outside `design/` (the design notes record the
// decision that retired it, and a design record is history, not a surface).
//
// THE WORD IS BUILT FROM PARTS, so this file's own source never contains it and
// the guard cannot match itself. It walks `git ls-files` itself and imports
// nothing from `app/`, `components/` or `lib/` (the structural-guard lane's rule
// — `tests/helpers/structuralGuardLane.ts`).

const ROOT = resolve(__dirname, '..', '..');
const WORD = ['type', 'writer'].join('');

/** Whether `text` mentions the retired word, in any case. */
function mentionsRetiredWord(text: string): boolean {
  return text.toLowerCase().includes(WORD);
}

/** Every tracked file outside `design/`, relative to the repository root. */
function trackedOutsideDesign(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter((path) => path.length > 0 && !path.startsWith('design/'));
}

describe('the retired replay word', () => {
  it('matches in any case, and only the whole word', () => {
    expect(mentionsRetiredWord(`a ${WORD} caret`)).toBe(true);
    expect(mentionsRetiredWord(`--${WORD.toUpperCase()}-char-interval`)).toBe(true);
    expect(mentionsRetiredWord('a type of writer')).toBe(false);
    expect(mentionsRetiredWord('typeIn')).toBe(false);
  });

  it('is in no tracked file outside design/', () => {
    const files = trackedOutsideDesign();
    // The walk reached the tree, and this file is in it without matching itself.
    expect(files).toContain('tests/guards/retired-replay-word.test.ts');
    const offenders = files.filter((path) => {
      const full = join(ROOT, path);
      try {
        statSync(full);
      } catch {
        return false; // tracked but deleted in this worktree
      }
      return mentionsRetiredWord(readFileSync(full).toString('latin1'));
    });
    expect(offenders).toEqual([]);
  });
});
