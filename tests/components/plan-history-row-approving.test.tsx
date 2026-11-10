// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import type { PlanSessionRowDto } from '@/lib/dto/planSessions';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanHistoryRow } from '@/components/planning/PlanHistoryRow';

// Bug MOTIR-9006 — the overlay's session list (History) read *Waiting for approval* for a
// plan whose approval was still being written. It reads *Approving…* now, in the sky the
// other in-progress state (`generating`) wears.

afterEach(cleanup);

function row(over: Partial<PlanSessionRowDto> = {}): PlanSessionRowDto {
  return {
    id: 's1',
    origin: 'conversation',
    targetKeys: [],
    lastActivityAt: '2026-11-10T11:00:00.000Z',
    startedBy: { id: 'u1', name: 'Yue' },
    firstTurn: 'Split the importer',
    latestPlan: { id: 'plan_1', status: 'approving', title: null },
    planCount: 1,
    state: 'approving',
    failure: null,
    endedAt: null,
    endReason: null,
    endedBy: null,
    copiedFrom: null,
    seed: null,
    ...over,
  } as PlanSessionRowDto;
}

describe('PlanHistoryRow — a session whose plan is being approved', () => {
  it('chips *Approving…* in the sky tint, never *Waiting for approval*', () => {
    renderWithIntl(<PlanHistoryRow session={row()} current={false} onOpen={vi.fn()} />);
    const chip = screen.getByText('Approving…');
    expect(chip.className).toContain('bg-(--el-tint-sky)');
    expect(screen.queryByText('Waiting for approval')).toBeNull();
  });
});
