import { describe, expect, it } from 'vitest';
import { REPO_FILE_MAX_BYTES } from '@/lib/git';
import type { RepoFileReadResult } from '@/lib/git/types';
import { applyWholeFileLimit } from '@/lib/services/repoFileReadService';

// MOTIR-10143 — the 1 MB WHOLE-file limit, applied by the service on every host:
// a text file over it is refused to an unranged read with its line count, and
// served to a ranged one. It is host-independent, which is what makes a GitHub
// and a GitLab repository answer the same way for the same file.

const found = (text: string): RepoFileReadResult => ({
  outcome: 'found',
  path: 'src/big.ts',
  ref: 'main',
  text,
  bytes: Buffer.byteLength(text),
});

describe('applyWholeFileLimit', () => {
  const over = 'a\n'.repeat(REPO_FILE_MAX_BYTES / 2 + 1);

  it('refuses an unranged read of a text file over 1 MB, naming its total lines', () => {
    expect(applyWholeFileLimit(found(over), {})).toEqual({
      outcome: 'too_large',
      path: 'src/big.ts',
      ref: 'main',
      limitBytes: REPO_FILE_MAX_BYTES,
      totalLines: over.split('\n').length,
    });
  });

  it('serves the same file to a ranged read', () => {
    const read = found(over);
    expect(applyWholeFileLimit(read, { ranged: true })).toBe(read);
  });

  it('leaves a file AT the limit, and every other outcome, untouched', () => {
    const atLimit = found('a'.repeat(REPO_FILE_MAX_BYTES));
    expect(applyWholeFileLimit(atLimit, {})).toBe(atLimit);
    const binary: RepoFileReadResult = {
      outcome: 'binary',
      path: 'big.bin',
      ref: 'main',
      bytes: REPO_FILE_MAX_BYTES * 2,
    };
    expect(applyWholeFileLimit(binary, {})).toBe(binary);
  });
});
