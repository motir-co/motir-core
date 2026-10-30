// WHAT A MERGE RELEASE WAS (MOTIR-10103): the released commit's subject line and
// the pull request it came from, read from the `production-image` run's own
// delivery. Pure, so the webhook parser and its tests share one reading.
//
// GitHub reports no pull request on a `workflow_run` started by a push — its
// `pull_requests` is empty for a merge to the default branch — so the number
// comes from the head commit's message, in the two forms GitHub writes it:
//   * a merge commit: `Merge pull request #48 from owner/branch`, a blank line,
//     then the pull request's title — the subject shown is that title;
//   * a squash: `Show the estimate (#48)` — the subject shown drops the suffix,
//     which the trigger line already says.
// A message in neither form names no pull request: its first line is the
// subject, and the panel says the merge without a number.

/** The longest subject a release stores; a longer one is cut. */
export const COMMIT_SUBJECT_MAX = 300;

const MERGE_COMMIT = /^Merge pull request #(\d+)\b/;
const SQUASH_SUFFIX = /\s*\(#(\d+)\)\s*$/;

export interface MergeCommitFacts {
  /** The line the panel shows for the commit; null for an empty message. */
  subject: string | null;
  /** The pull request the merge came from, when the message names one. */
  pullRequestNumber: number | null;
}

function cap(line: string): string {
  return line.length > COMMIT_SUBJECT_MAX ? line.slice(0, COMMIT_SUBJECT_MAX) : line;
}

function prNumber(digits: string): number | null {
  const n = Number(digits);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The subject and pull request number of a head commit's message. */
export function mergeCommitFacts(message: unknown): MergeCommitFacts {
  if (typeof message !== 'string') return { subject: null, pullRequestNumber: null };
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const first = lines[0];
  if (!first) return { subject: null, pullRequestNumber: null };

  const merge = MERGE_COMMIT.exec(first);
  if (merge) {
    return { subject: cap(lines[1] ?? first), pullRequestNumber: prNumber(merge[1]!) };
  }
  const squash = SQUASH_SUFFIX.exec(first);
  if (squash) {
    const title = first.slice(0, squash.index).trim();
    return { subject: cap(title || first), pullRequestNumber: prNumber(squash[1]!) };
  }
  return { subject: cap(first), pullRequestNumber: null };
}
