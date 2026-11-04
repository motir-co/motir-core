import { describe, expect, it } from 'vitest';
import { firstMultiRepoCriterion, type RepoCandidate } from '@/lib/workItems/proseVsGraph';
import { RUNNER_STOP_SEVERITIES } from '@/lib/dto/workItems';

// The MULTI-REPO runner stop (MOTIR-10381): the first criterion naming a path in a
// SECOND repository, whatever the card's repository set carries.

const repos: RepoCandidate[] = [
  { name: 'motir-core', repoRef: 'moooon/motir-core' },
  { name: 'motir-ai', repoRef: 'moooon/motir-ai' },
  { name: 'motir-gateway', repoRef: 'moooon/motir-gateway' },
  { name: 'motir', repoRef: 'moooon/motir' },
];

const body = (...criteria: string[]) =>
  ['Context.', '', '## Acceptance criteria', '', ...criteria.map((c) => `- ${c}`)].join('\n');

const TWO = body('`motir-core/lib/a.ts` emits it', '`motir-ai/src/b.ts` reads it');

describe('firstMultiRepoCriterion', () => {
  it('names the second repository, its first path and the criterion naming it', () => {
    expect(firstMultiRepoCriterion(TWO, [], repos)).toEqual({
      path: 'motir-ai/src/b.ts',
      repo: 'motir-ai',
      criterionIndex: 2,
    });
  });

  it('still fires when the card carries BOTH repositories, and when it carries one', () => {
    expect(firstMultiRepoCriterion(TWO, ['motir-core', 'motir-ai'], repos)?.repo).toBe('motir-ai');
    expect(firstMultiRepoCriterion(TWO, ['motir-core'], repos)?.repo).toBe('motir-ai');
  });

  it('resolves the `owner/name` form too', () => {
    const md = body('`motir-core/lib/a.ts`', '`moooon/motir-ai/src/b.ts`');
    expect(firstMultiRepoCriterion(md, ['motir-core'], repos)).toEqual({
      path: 'moooon/motir-ai/src/b.ts',
      repo: 'motir-ai',
      criterionIndex: 2,
    });
  });

  it('never fires when every resolvable path is in one repository', () => {
    const md = body('`motir-core/lib/a.ts`', '`motir-core/tests/a.test.ts`', '`docs/x.md`');
    expect(firstMultiRepoCriterion(md, ['motir-core', 'motir-ai'], repos)).toBeNull();
  });

  it('declines a bare-name path that is a carried repository’s namespace directory', () => {
    const md = body('`motir-gateway/cmd/main.go`', '`motir/catalog/x.go`');
    expect(firstMultiRepoCriterion(md, ['motir-gateway'], repos)).toBeNull();
    // Not carried: the bare `motir/…` path is read as the `motir` repository.
    expect(firstMultiRepoCriterion(md, [], repos)?.repo).toBe('motir');
    // The `owner/name` form is never declined.
    const owned = body('`motir-gateway/cmd/main.go`', '`moooon/motir/catalog/x.go`');
    expect(firstMultiRepoCriterion(owned, ['motir-gateway'], repos)?.repo).toBe('motir');
  });

  it('returns null for a blank body, a body with no criteria, and no candidates', () => {
    expect(firstMultiRepoCriterion(null, [], repos)).toBeNull();
    expect(firstMultiRepoCriterion('', [], repos)).toBeNull();
    expect(firstMultiRepoCriterion('`motir-core/a.ts` and `motir-ai/b.ts`', [], repos)).toBeNull();
    expect(firstMultiRepoCriterion(TWO, [], [])).toBeNull();
  });

  it('is a member of RUNNER_STOP_SEVERITIES', () => {
    expect(RUNNER_STOP_SEVERITIES).toContain('leaf-multi-repo');
  });
});
