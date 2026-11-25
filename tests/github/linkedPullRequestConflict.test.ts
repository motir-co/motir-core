import { describe, expect, it } from 'vitest';
import { toLinkedPullRequestDto } from '@/lib/mappers/githubMappers';

// THE ROW'S CONFLICT FACTS (MOTIR-5916; design/github § 30's producer table). The Development
// row draws *Conflicts with {base}* from `conflicted` + `baseRef`, and `conflicted` is the ONE
// rule `lib/github/mergeability.ts` holds: `dirty` AT THE CURRENT HEAD, and only while open.

const HEAD = 'a'.repeat(40);

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'pr-1',
    title: 'A change',
    headRef: 'subtask/x',
    baseRef: 'main',
    number: 7,
    state: 'open',
    merged: false,
    mergeOutcomeRef: null,
    mergeableState: null,
    mergeableStateHeadSha: null,
    repo: { owner: 'acme', name: 'web' },
    checkRuns: [
      {
        id: 'c1',
        pullRequestId: 'pr-1',
        commitSha: HEAD,
        checkName: 'ci',
        conclusion: 'success',
        status: 'completed',
        createdAt: new Date(),
        updatedAt: new Date(),
        checkSuiteId: null,
      },
    ],
    ...over,
  } as unknown as Parameters<typeof toLinkedPullRequestDto>[0];
}

describe('LinkedPullRequestDto.conflicted / baseRef (MOTIR-5916)', () => {
  it('`dirty` at the current head is conflicted, and the base is carried', () => {
    const dto = toLinkedPullRequestDto(
      row({ mergeableState: 'dirty', mergeableStateHeadSha: HEAD }),
    );
    expect([dto.conflicted, dto.baseRef]).toEqual([true, 'main']);
  });

  it('`null`, `clean`, and `dirty` at an OLDER head are not', () => {
    expect(toLinkedPullRequestDto(row()).conflicted).toBe(false);
    expect(
      toLinkedPullRequestDto(row({ mergeableState: 'clean', mergeableStateHeadSha: HEAD }))
        .conflicted,
    ).toBe(false);
    expect(
      toLinkedPullRequestDto(
        row({ mergeableState: 'dirty', mergeableStateHeadSha: 'b'.repeat(40) }),
      ).conflicted,
    ).toBe(false);
  });

  it('a merged or closed pull request is never conflicted, and a missing base is null', () => {
    expect(
      toLinkedPullRequestDto(
        row({ merged: true, mergeableState: 'dirty', mergeableStateHeadSha: HEAD }),
      ).conflicted,
    ).toBe(false);
    expect(toLinkedPullRequestDto(row({ baseRef: null })).baseRef).toBeNull();
  });
});
