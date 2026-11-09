import { describe, expect, it } from 'vitest';
import type { ApprovalGate } from '@/generated/prisma/client';
import {
  answeredReviewRefusalFrom,
  headsInVersion,
  provedGreenSince,
} from '@/lib/approvalGates/reviewRefusal';

// THE REVIEW REFUSAL A PUSH ANSWERED (Bug MOTIR-10733), over rows already read. The Fixing
// rule keeps a sent-back card on To fix while CI runs on the pushed fix; when the stored prior
// answer is gone (a quick green at the new head stored nothing to fix), this is where the
// refusal is found again. It must be the card's LATEST review word, about a version the set
// has moved off, and not one a dismissal took back.

const OLD = 'acme/web#1@aaaa';
const NEW = 'acme/web#1@bbbb';

type Row = { commitSha: string; conclusion: string; createdAt: Date };
const row = (commitSha: string, conclusion: string, at = '2026-11-08T19:50:00Z'): Row => ({
  commitSha,
  conclusion,
  createdAt: new Date(at),
});
const deliveriesWith = (rows: Row[] = [], headSha = 'bbbb') =>
  [
    {
      pullRequest: {
        id: 'pr-1',
        number: 1,
        headSha,
        checkRuns: rows.map((r, i) => ({
          checkName: `check-${i}`,
          checkSuiteId: '',
          suiteAggregate: false,
          ...r,
        })),
      },
      repo: { owner: 'acme', name: 'web' },
    },
    {
      pullRequest: { id: 'pr-2', number: 7, headSha: 'cccc', checkRuns: [] },
      repo: { owner: 'acme', name: 'api' },
    },
  ] as unknown as Parameters<typeof headsInVersion>[1];
const deliveries = deliveriesWith();

function gate(over: Partial<ApprovalGate>): ApprovalGate {
  return {
    id: 'g1',
    kind: 'agent_review',
    state: 'changes_requested',
    subjectVersion: OLD,
    noteMd: 'Fix the header',
    decidedById: null,
    decidedByLabel: 'Review agent',
    decidedUnderAuthority: 'review_agent',
    decidedAt: new Date('2026-11-08T19:36:00Z'),
    ...over,
  } as ApprovalGate;
}

const record = (over: { createdAt?: string; subjectVersion?: string } = {}) => ({
  id: 'r1',
  subjectVersion: over.subjectVersion ?? OLD,
  findingsMd: 'The totals row is wrong',
  submittedById: 'u-owner',
  createdAt: new Date(over.createdAt ?? '2026-11-08T19:40:00Z'),
});

const facts = (over: Partial<Parameters<typeof answeredReviewRefusalFrom>[0]>) => ({
  latest: null,
  record: null,
  passAfterRecord: false,
  recordDismissed: false,
  gateDismissed: false,
  currentVersion: NEW,
  deliveries,
  ...over,
});

describe('answeredReviewRefusalFrom', () => {
  it('a decided review gate about an older version is answered, with the heads it named', () => {
    expect(answeredReviewRefusalFrom(facts({ latest: gate({}) }))).toMatchObject({
      kind: 'agent_review',
      id: 'g1',
      recordId: null,
      subjectVersion: OLD,
      noteMd: 'Fix the header',
      raisedHeads: { 'pr-1': 'aaaa' },
    });
  });

  it('a person’s Request changes on the approve-and-merge gate is answered the same way', () => {
    const out = answeredReviewRefusalFrom(
      facts({
        latest: gate({ kind: 'pull_request_approval', decidedById: 'u-pat' }),
        gateDismissed: true,
      }),
    );
    // A dismissal takes back the review AGENT's refusal only.
    expect(out).toMatchObject({ kind: 'pull_request_approval', decidedById: 'u-pat' });
  });

  it('a gate-off send-back newer than every decided gate is the latest word', () => {
    expect(
      answeredReviewRefusalFrom(facts({ latest: gate({ state: 'approved' }), record: record() })),
    ).toMatchObject({
      kind: 'agent_review',
      id: null,
      recordId: 'r1',
      noteMd: 'The totals row is wrong',
    });
  });

  it('a decided gate after the send-back is the latest word — a refusal, or nothing', () => {
    const later = new Date('2026-11-08T19:50:00Z');
    expect(
      answeredReviewRefusalFrom(facts({ latest: gate({ decidedAt: later }), record: record() })),
    ).toMatchObject({ id: 'g1', recordId: null });
    expect(
      answeredReviewRefusalFrom(
        facts({ latest: gate({ state: 'approved', decidedAt: later }), record: record() }),
      ),
    ).toBeNull();
  });

  it('a pass recorded after the send-back answers it', () => {
    expect(
      answeredReviewRefusalFrom(facts({ record: record(), passAfterRecord: true })),
    ).toBeNull();
  });

  it('a dismissed agent refusal is not one, from either source', () => {
    expect(
      answeredReviewRefusalFrom(facts({ record: record(), recordDismissed: true })),
    ).toBeNull();
    expect(answeredReviewRefusalFrom(facts({ latest: gate({}), gateDismissed: true }))).toBeNull();
  });

  it('a refusal still standing at the current version is the standing read’s, not this one’s', () => {
    expect(answeredReviewRefusalFrom(facts({ latest: gate({}), currentVersion: OLD }))).toBeNull();
    expect(
      answeredReviewRefusalFrom(facts({ record: record({ subjectVersion: NEW }) })),
    ).toBeNull();
  });

  it('nothing to answer: no refusal, a decision of another kind, or a gate with no version', () => {
    expect(answeredReviewRefusalFrom(facts({}))).toBeNull();
    expect(
      answeredReviewRefusalFrom(facts({ latest: gate({ kind: 'design_result' }) })),
    ).toBeNull();
    expect(answeredReviewRefusalFrom(facts({ latest: gate({ subjectVersion: null }) }))).toBeNull();
  });

  it('a decided gate of another kind after the send-back hides nothing: the record is still the word', () => {
    const later = new Date('2026-11-08T19:50:00Z');
    expect(
      answeredReviewRefusalFrom(
        facts({
          latest: gate({ kind: 'design_result', state: 'approved', decidedAt: later }),
          record: record(),
        }),
      ),
    ).toMatchObject({ recordId: 'r1' });
  });

  it('a fix that already went green answers it for good: a later push finds nothing', () => {
    // Reviewed at aaaa, the fix at dddd went green, the card is at bbbb now.
    expect(
      answeredReviewRefusalFrom(
        facts({ latest: gate({}), deliveries: deliveriesWith([row('dddd', 'success')]) }),
      ),
    ).toBeNull();
  });

  it('a set with no known head (current version null) still finds the refusal', () => {
    expect(
      answeredReviewRefusalFrom(facts({ latest: gate({}), currentVersion: null })),
    ).toMatchObject({ id: 'g1' });
  });
});

describe('headsInVersion', () => {
  it('names the head each member was at, matched on repository AND number', () => {
    expect(headsInVersion('acme/api#7@cccc,acme/web#1@aaaa', deliveries)).toEqual({
      'pr-1': 'aaaa',
      'pr-2': 'cccc',
    });
  });

  it('leaves out a delivery the version does not name, and a malformed member', () => {
    expect(headsInVersion('acme/web#7@cccc,acme/api#7', deliveries)).toEqual({});
  });
});

describe('provedGreenSince', () => {
  const decidedAt = new Date('2026-11-08T19:36:00Z');
  const heads = { 'pr-1': 'aaaa' };
  const at = (rows: Row[]) => provedGreenSince(decidedAt, heads, deliveriesWith(rows));

  it('a commit first seen after the refusal, folding green, proves the fix', () => {
    expect(at([row('dddd', 'success')])).toBe(true);
  });

  it('the reviewed head and the current head prove nothing, however green', () => {
    expect(at([row('aaaa', 'success'), row('bbbb', 'success')])).toBe(false);
  });

  it('a commit from before the refusal proves nothing — the one CI passed before the review', () => {
    expect(at([row('0000', 'success', '2026-11-08T19:00:00Z')])).toBe(false);
  });

  it('a commit after the refusal that is red or still running proves nothing', () => {
    expect(at([row('dddd', 'failure')])).toBe(false);
    expect(at([row('dddd', 'success'), row('dddd', 'pending')])).toBe(false);
  });

  it('a member the refusal did not name is not read', () => {
    expect(provedGreenSince(decidedAt, {}, deliveriesWith([row('dddd', 'success')]))).toBe(false);
  });
});
