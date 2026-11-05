import { describe, expect, it } from 'vitest';
import {
  withdrawnMergeCopy,
  type WithdrawnMember,
  type WithdrawnMessage,
} from '@/components/github/withdrawnMergeCopy';
import type { ApprovalGateSupersedeCauseDTO } from '@/lib/dto/approvalGate';

// STATE `G`'S WORDS FOLLOW `supersededCause` (Bug MOTIR-5884; `design/github/design-notes.md`
// § 29's cause table and cite table). One case per row of the cite table, plus the band-1
// meta each cause reads, asserted as KEYS — the copy itself is pinned by the frame tests.

const CORE = 'moooon/motir-core · #131';
const AI = 'moooon/motir-ai · #88';
const nameList = (names: string[]) => names.join(' and ');

function copyFor(
  cause: ApprovalGateSupersedeCauseDTO | null,
  members: WithdrawnMember[],
  { moved = [] as string[], terminal = false } = {},
) {
  return withdrawnMergeCopy({
    cause,
    members,
    moved,
    terminal,
    itemIdentifier: 'ACME-12',
    host: 'GitHub',
    nameList,
  });
}

const pra = (key: string, values: WithdrawnMessage['values'] = {}): WithdrawnMessage => ({
  scope: 'pra',
  key,
  values,
});
const gate = (key: string, values: WithdrawnMessage['values'] = {}): WithdrawnMessage => ({
  scope: 'gate',
  key,
  values,
});

const open = (name: string): WithdrawnMember => ({ name, state: 'open' });
const merged = (name: string): WithdrawnMember => ({ name, state: 'merged' });
const closed = (name: string): WithdrawnMember => ({ name, state: 'closed' });

describe('the cite — shown only where a re-ask is possible, naming what re-asks', () => {
  it('head_moved with a member open: the moved member named, and the re-ask on green', () => {
    expect(copyFor('head_moved', [open(CORE), open(AI)], { moved: [AI] })).toEqual({
      meta: pra('meta.withdrawn', { count: 2, pr: AI }),
      sentence: pra('withdrawn.port', { pr: AI }),
      cite: pra('withdrawn.portCite'),
    });
  });

  it('head_moved with no moved member nameable: the shared sentence, still the re-ask', () => {
    expect(copyFor('head_moved', [open(CORE)])).toEqual({
      meta: pra('meta.withdrawnUnknown', { count: 1 }),
      sentence: gate('withdrawn.cause.head_moved'),
      cite: pra('withdrawn.portCite'),
    });
  });

  it('set_changed with a member open: the set sentence, the re-ask on green', () => {
    expect(copyFor('set_changed', [open(CORE), open(AI)])).toEqual({
      meta: pra('meta.withdrawnSet', { count: 2 }),
      sentence: pra('withdrawn.portSet'),
      cite: pra('withdrawn.portCite'),
    });
  });

  it('member_closed read as MERGED, another member open (Panel 3a): the re-ask stands', () => {
    expect(copyFor('member_closed', [merged(CORE), open(AI)])).toEqual({
      meta: pra('meta.withdrawnMerged', { count: 2, pr: CORE, host: 'GitHub' }),
      sentence: pra('withdrawn.portMerged', { pr: CORE, host: 'GitHub' }),
      cite: pra('withdrawn.portCite'),
    });
  });

  it('member_closed read as CLOSED, another member open (Panel 3c): unlinking re-asks', () => {
    expect(copyFor('member_closed', [closed(CORE), open(AI)])).toEqual({
      meta: pra('meta.withdrawnClosed', { count: 2, pr: CORE }),
      sentence: pra('withdrawn.portClosed', { pr: CORE }),
      cite: pra('withdrawn.citeUnlink', { pr: CORE, key: 'ACME-12' }),
    });
  });

  it('member_closed with a closed AND a merged member: the closed one is named, since it is what blocks', () => {
    const copy = copyFor('member_closed', [closed(CORE), merged(AI), open('x · #1')]);
    expect(copy.sentence).toEqual(pra('withdrawn.portClosed', { pr: CORE }));
    expect(copy.cite).toEqual(pra('withdrawn.citeUnlink', { pr: CORE, key: 'ACME-12' }));
  });

  it('member_drafted with one member open: that member is the draft, and marking it ready re-asks', () => {
    expect(copyFor('member_drafted', [merged(CORE), open(AI)])).toEqual({
      meta: pra('meta.withdrawnDrafted', { count: 2, pr: AI }),
      sentence: pra('withdrawn.portDrafted', { pr: AI }),
      cite: pra('withdrawn.citeDrafted', { pr: AI }),
    });
  });

  it('member_drafted with two open: the row reads a draft as open (MOTIR-5002), so no member is named', () => {
    expect(copyFor('member_drafted', [open(CORE), open(AI)])).toEqual({
      meta: pra('meta.withdrawnUnknown', { count: 2 }),
      sentence: gate('withdrawn.cause.member_drafted'),
      cite: gate('withdrawn.portCite'),
    });
  });

  it('pulled_back on a live card: back in review re-asks', () => {
    expect(copyFor('pulled_back', [open(CORE)])).toEqual({
      meta: pra('meta.withdrawnPulledBack', { count: 1 }),
      sentence: gate('withdrawn.cause.pulled_back'),
      cite: pra('withdrawn.citePulledBack', { key: 'ACME-12' }),
    });
  });

  it.each([['unknown' as const], [null]])(
    '%s: the reason was not recorded, and nothing is promised',
    (cause) => {
      expect(copyFor(cause, [open(CORE)])).toEqual({
        meta: pra('meta.withdrawnUnknown', { count: 1 }),
        sentence: gate('withdrawn.cause.unknown'),
        cite: gate('withdrawn.portCite'),
      });
    },
  );

  it('a null cause never borrows one from a moved head', () => {
    expect(copyFor(null, [open(CORE)], { moved: [CORE] }).sentence).toEqual(
      gate('withdrawn.cause.unknown'),
    );
  });
});

describe('a done-category card: nobody decided it, and nothing asks again', () => {
  it.each([
    ['head_moved' as const, [open(CORE)], [CORE]],
    ['set_changed' as const, [open(CORE)], []],
    ['member_closed' as const, [merged(CORE), open(AI)], []],
    ['member_closed' as const, [closed(CORE), open(AI)], []],
    ['member_drafted' as const, [open(AI)], []],
    ['pulled_back' as const, [open(CORE)], []],
  ])('%s — the shared cite', (cause, members, moved) => {
    expect(copyFor(cause, members, { moved, terminal: true }).cite).toEqual(
      gate('withdrawn.portCite'),
    );
  });

  it('keeps the cause’s own sentence and meta', () => {
    const copy = copyFor('member_closed', [merged(CORE), open(AI)], { terminal: true });
    expect(copy.sentence).toEqual(pra('withdrawn.portMerged', { pr: CORE, host: 'GitHub' }));
    expect(copy.meta).toEqual(pra('meta.withdrawnMerged', { count: 2, pr: CORE, host: 'GitHub' }));
  });
});

describe('nothing left open (the frame is not drawn at all — Panel 2 — but the resolver is total)', () => {
  it('member_closed read as merged with no member open promises no re-ask', () => {
    expect(copyFor('member_closed', [merged(CORE)]).cite).toEqual(gate('withdrawn.portCite'));
  });

  it('member_closed read as closed with no member open promises no unlink', () => {
    expect(copyFor('member_closed', [closed(CORE)]).cite).toEqual(gate('withdrawn.portCite'));
  });
});

// A CONFLICT FOUND BEFORE ANY PRESS (MOTIR-5916; design/github § 30 Panels 1, 2 and 7). The
// conflicted member is READ off its row, and `{base}` is named only when every conflicted
// member names the same one — else, and when the row never recorded a base, the `NoBase`
// forms say *its base branch*.
describe('`conflict` — the conflicted row is named, with its base (Panels 1, 2, 7)', () => {
  const conflicted = (name: string, baseRef: string | null = 'main'): WithdrawnMember => ({
    name,
    state: 'open',
    conflicted: true,
    baseRef,
  });

  it('one pull request, conflicted: meta, sentence and cite name it and `main` (Panel 1)', () => {
    expect(copyFor('conflict', [conflicted(CORE)])).toEqual({
      meta: pra('meta.withdrawnConflict', { count: 1, pr: CORE, base: 'main' }),
      sentence: pra('withdrawn.portConflict', { pr: CORE, base: 'main' }),
      cite: pra('withdrawn.citeConflict'),
    });
  });

  it('two pull requests, ONE conflicted: only that one is named (Panel 2)', () => {
    expect(copyFor('conflict', [open(CORE), conflicted(AI)])).toEqual({
      meta: pra('meta.withdrawnConflict', { count: 2, pr: AI, base: 'main' }),
      sentence: pra('withdrawn.portConflict', { pr: AI, base: 'main' }),
      cite: pra('withdrawn.citeConflict'),
    });
  });

  it('a row that never recorded its base uses the NoBase forms (Panel 7)', () => {
    expect(copyFor('conflict', [open(CORE), conflicted(AI, null)])).toEqual({
      meta: pra('meta.withdrawnConflictNoBase', { count: 2, pr: AI }),
      sentence: pra('withdrawn.portConflictNoBase', { pr: AI }),
      cite: pra('withdrawn.citeConflict'),
    });
  });

  it('two conflicted members on DIFFERENT bases: both named, and the NoBase forms', () => {
    const copy = copyFor('conflict', [conflicted(CORE, 'main'), conflicted(AI, 'release')]);
    expect(copy.sentence).toEqual(pra('withdrawn.portConflictNoBase', { pr: `${CORE} and ${AI}` }));
  });

  it('no conflicted row left (it was resolved since): the shared cause sentence, promising nothing', () => {
    expect(copyFor('conflict', [open(CORE)])).toEqual({
      meta: pra('meta.withdrawnUnknown', { count: 1 }),
      sentence: gate('withdrawn.cause.conflict'),
      cite: gate('withdrawn.portCite'),
    });
  });

  it('on a done-category card the cite is the shared one', () => {
    expect(copyFor('conflict', [conflicted(CORE)], { terminal: true }).cite).toEqual(
      gate('withdrawn.portCite'),
    );
  });
});

// `queue_failed` (MOTIR-6595 · MOTIR-6596; `design-notes.md` § 31 panels 5 and 5b): a gate the
// OLD rule re-asked from a queue FAILURE, withdrawn by the convergence. The member is the one
// whose delivery still carries the held failure; its own sentence, never `ci_failed`'s.
describe('`queue_failed` — the member held by a queue failure is named (§ 31 panel 5)', () => {
  const failed = (name: string): WithdrawnMember => ({ name, state: 'open', leftQueue: true });

  it('names the held member in the meta and the sentence, and cites the green push', () => {
    expect(copyFor('queue_failed', [merged(CORE), failed(AI)])).toEqual({
      meta: pra('meta.withdrawnQueueFailed', { count: 2, pr: AI }),
      sentence: pra('withdrawn.portQueueFailed', { pr: AI }),
      cite: pra('withdrawn.citeQueueFailed'),
    });
  });

  it('no held member left (a push moved on): the shared cause sentence, with the re-ask', () => {
    expect(copyFor('queue_failed', [open(CORE)])).toEqual({
      meta: pra('meta.withdrawnUnknown', { count: 1 }),
      sentence: gate('withdrawn.cause.queue_failed'),
      cite: pra('withdrawn.portCite'),
    });
  });

  it('on a done-category card the cite is the shared one', () => {
    expect(copyFor('queue_failed', [failed(AI)], { terminal: true }).cite).toEqual(
      gate('withdrawn.portCite'),
    );
  });
});

// `ci_rerunning` (MOTIR-6946): a check at the asked-about commits is pending again — the set
// left green without going red. Its own sentence (never `ci_failed`'s: nothing failed), naming
// nobody, and the re-ask cite, because the next green at these same commits asks again.
describe('`ci_rerunning` — the set left green without going red', () => {
  it('says what the cause records, and cites the re-ask while a member is open', () => {
    expect(copyFor('ci_rerunning', [open(CORE), open(AI)])).toEqual({
      meta: pra('meta.withdrawnUnknown', { count: 2 }),
      sentence: gate('withdrawn.cause.ci_rerunning'),
      cite: pra('withdrawn.portCite'),
    });
  });

  it('on a done-category card the cite is the shared one', () => {
    expect(copyFor('ci_rerunning', [open(CORE)], { terminal: true }).cite).toEqual(
      gate('withdrawn.portCite'),
    );
  });
});

// THE REVIEW PATH'S CAUSES HAVE WORDS (Story MOTIR-10327 · MOTIR-10345): a gate the review
// agent withdrew — the gate switched off, or a send-back at the asked version — reads
// `withdrawn.cause.<cause>` like every other cause. Found by the story's recording, where the
// frame threw MISSING_MESSAGE for `agent_changes_requested`.
describe('the review path’s withdrawn causes have copy in every locale', () => {
  const locales = ['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'zh'] as const;
  const causes: ApprovalGateSupersedeCauseDTO[] = [
    'review_agent_disabled',
    'agent_changes_requested',
  ];
  it.each(locales)('%s', async (locale) => {
    const messages = (await import(`@/messages/${locale}.json`)).default as {
      approvalGate: { withdrawn: { cause: Record<string, string> } };
    };
    for (const cause of causes) {
      expect(messages.approvalGate.withdrawn.cause[cause], `${locale}:${cause}`).toBeTruthy();
    }
  });
});
