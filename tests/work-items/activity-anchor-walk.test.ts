import { describe, expect, it, vi } from 'vitest';
import {
  MAX_ANCHOR_WALK_PAGES,
  entriesDrawAgentVerdict,
  walkToAgentVerdict,
} from '@/lib/activity/anchorWalk';
import { agentVerdictRecordIdOfHash } from '@/lib/agentReview/verdictActivity';
import type {
  ActivityAllEntryDto,
  ActivityAllPageDto,
  ActivityEntryPartDto,
} from '@/lib/dto/activity';

// THE ANCHOR WALK (MOTIR-10463): the bounded read that brings an older verdict entry into the
// All tab's window when the address names it. The component half is
// `tests/components/activity-all-anchor-walk.test.tsx`.

function historyEntry(id: string, parts: ActivityEntryPartDto[]): ActivityAllEntryDto {
  return {
    type: 'history',
    entry: {
      id,
      workItemId: 'wi-1',
      changeKind: 'updated',
      changedAt: '2026-11-01T00:00:00.000Z',
      actor: { userId: 'u-1', name: 'Bo', image: null },
      parts,
    },
  };
}

function verdictEntry(id: string, recordId: string): ActivityAllEntryDto {
  return historyEntry(id, [
    {
      kind: 'agentVerdict',
      recordId,
      verdict: 'changes_requested',
      outcome: 'decided',
      hosted: true,
      harness: '',
      model: '',
      subjectVersion: 'acme/web#1@abcdef0',
      findingsExcerpt: 'Fix it',
      checklist: [],
      notified: null,
    },
  ]);
}

const filler = (id: string) => historyEntry(id, [{ kind: 'fieldEdited', field: 'descriptionMd' }]);

function page(
  entries: ActivityAllEntryDto[],
  nextCursor: string | null,
  extra: Partial<ActivityAllPageDto> = {},
): ActivityAllPageDto {
  return { entries, nextCursor, totalComments: 3, totalChanges: 40, workItemRefs: {}, ...extra };
}

describe('agentVerdictRecordIdOfHash', () => {
  it('reads the record id from a verdict anchor', () => {
    expect(agentVerdictRecordIdOfHash('#agent-verdict-rec-9')).toBe('rec-9');
  });
  it('is null for any other fragment, and for the bare prefix', () => {
    expect(agentVerdictRecordIdOfHash('')).toBeNull();
    expect(agentVerdictRecordIdOfHash('#development')).toBeNull();
    expect(agentVerdictRecordIdOfHash('#agent-verdict-')).toBeNull();
    expect(agentVerdictRecordIdOfHash('agent-verdict-rec-9')).toBeNull();
  });
});

describe('entriesDrawAgentVerdict', () => {
  it('finds the record among history parts, and only that record', () => {
    const entries = [
      { type: 'comment', thread: {} } as unknown as ActivityAllEntryDto,
      filler('r-1'),
      verdictEntry('r-2', 'rec-2'),
    ];
    expect(entriesDrawAgentVerdict(entries, 'rec-2')).toBe(true);
    expect(entriesDrawAgentVerdict(entries, 'rec-3')).toBe(false);
    expect(entriesDrawAgentVerdict([], 'rec-2')).toBe(false);
  });
});

describe('walkToAgentVerdict', () => {
  it('reads until the page that draws the record and hands back every page read', async () => {
    const fetchPage = vi
      .fn<(cursor: string) => Promise<ActivityAllPageDto>>()
      .mockResolvedValueOnce(
        page([filler('r-21')], 'k2', { workItemRefs: { 'MOTIR-1': {} as never } }),
      )
      .mockResolvedValueOnce(
        page([filler('r-41'), verdictEntry('r-42', 'rec-old')], 'k3', {
          totalComments: 4,
          totalChanges: 41,
          workItemRefs: { 'MOTIR-2': {} as never },
        }),
      );

    const reached = await walkToAgentVerdict({ recordId: 'rec-old', cursor: 'k1', fetchPage });

    expect(fetchPage.mock.calls.map(([c]) => c)).toEqual(['k1', 'k2']);
    expect(reached).not.toBeNull();
    expect(reached?.entries.map((e) => (e.type === 'history' ? e.entry.id : ''))).toEqual([
      'r-21',
      'r-41',
      'r-42',
    ]);
    expect(reached?.nextCursor).toBe('k3');
    expect(reached?.totalComments).toBe(4);
    expect(reached?.totalChanges).toBe(41);
    expect(Object.keys(reached?.workItemRefs ?? {})).toEqual(['MOTIR-1', 'MOTIR-2']);
  });

  it('is null when the trail ends without the record', async () => {
    const fetchPage = vi
      .fn<(cursor: string) => Promise<ActivityAllPageDto>>()
      .mockResolvedValueOnce(page([filler('r-21')], 'k2'))
      .mockResolvedValueOnce(page([filler('r-41')], null, { workItemRefs: undefined }));

    expect(await walkToAgentVerdict({ recordId: 'rec-x', cursor: 'k1', fetchPage })).toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('stops at the bound — never more reads than maxPages', async () => {
    let n = 0;
    const fetchPage = vi.fn(async () => page([filler(`r-${n}`)], `k${++n}`));

    expect(
      await walkToAgentVerdict({ recordId: 'rec-x', cursor: 'k0', fetchPage, maxPages: 3 }),
    ).toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('defaults the bound to MAX_ANCHOR_WALK_PAGES', async () => {
    let n = 0;
    const fetchPage = vi.fn(async () => page([], `k${++n}`));

    expect(await walkToAgentVerdict({ recordId: 'rec-x', cursor: 'k0', fetchPage })).toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(MAX_ANCHOR_WALK_PAGES);
  });

  it('is null — not a throw — when a read fails', async () => {
    const fetchPage = vi
      .fn<(cursor: string) => Promise<ActivityAllPageDto>>()
      .mockRejectedValueOnce(new Error('Activity read failed (500)'));

    expect(await walkToAgentVerdict({ recordId: 'rec-x', cursor: 'k1', fetchPage })).toBeNull();
  });
});
