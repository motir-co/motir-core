// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../../helpers/renderWithIntl';
import {
  Capacity429Row,
  CapacityLimitRow,
} from '@/app/(admin)/admin/capacity/_components/CapacityLimitRow';
import { STATE_LOOK } from '@/app/(admin)/admin/capacity/_components/capacityDisplay';
import type { PlatformCapacityLimitRowDTO } from '@/lib/dto/platformCapacity';
import { claudeEntry, deepseekEntry, qwenEntry } from '../../fixtures/capacityViewFixtures';

/**
 * One LIMIT ROW (MOTIR-9614, design `platform-admin` AMENDMENT 2026-10-25 § How a
 * row is judged): rendered from the DTO alone, and a missing number is never 0.
 */

afterEach(cleanup);

function renderRow(row: PlatformCapacityLimitRowDTO) {
  renderWithIntl(
    <table>
      <tbody>
        <CapacityLimitRow row={row} />
      </tbody>
    </table>,
  );
  return screen.getByTestId(`capacity-row-${row.unit}`);
}

const unitRow = (entry: ReturnType<typeof claudeEntry>, unit: string) =>
  entry.limits.find((r) => r.unit === unit)!;

describe('CapacityLimitRow', () => {
  it('a live row: usage / limit, lane split, share bar and percent, the state pill', () => {
    const tr = renderRow(unitRow(claudeEntry(), 'rpm'));
    expect(tr.textContent).toContain('Requests / min');
    expect(tr.textContent).toContain('54 / 1,000');
    expect(tr.textContent).toContain('Planning 14 · Agent 40');
    expect(within(tr).getByTestId('capacity-share-bar').getAttribute('style')).toContain('5.4%');
    expect(tr.textContent).toContain('5 %');
    expect(within(tr).getByText('Normal')).toBeTruthy();
  });

  it('takes the pill label and the bar colour from the row state', () => {
    const tr = renderRow(unitRow(qwenEntry(), 'rpm'));
    expect(within(tr).getByText('Over alert share')).toBeTruthy();
    expect(within(tr).getByTestId('capacity-share-bar').className).toContain(
      STATE_LOOK.over_share.bar,
    );
  });

  it('usage not reported: the word, no bar, a dash for the share, and no 0', () => {
    const r = unitRow(claudeEntry(), 'input_tpm');
    const tr = renderRow(r);
    expect(within(tr).getAllByText('Usage not reported')).toHaveLength(2);
    expect(within(tr).queryByTestId('capacity-share-bar')).toBeNull();
    expect(tr.textContent).toContain('—');
    // The only 0s are the limit's own digits (200,000).
    expect(tr.textContent!.replace('200,000', '')).not.toMatch(/0/);
  });

  it('an unavailable row (usage null) shows no number and no bar', () => {
    const r: PlatformCapacityLimitRowDTO = {
      ...unitRow(claudeEntry(), 'rpm'),
      usage: null,
      sharePercent: null,
      state: 'unavailable',
    };
    const tr = renderRow(r);
    expect(within(tr).getAllByText('Unavailable')).toHaveLength(2);
    expect(within(tr).queryByTestId('capacity-share-bar')).toBeNull();
    expect(tr.textContent).not.toContain('Planning');
    expect(tr.textContent!.replace('1,000', '')).not.toMatch(/0/);
  });

  it('an unknown limit: the usage, "limit not known", a dash and the Unknown limit pill', () => {
    const tr = renderRow(unitRow(qwenEntry(), 'tpm'));
    expect(tr.textContent).toContain('22 / limit not known');
    expect(within(tr).getByText('Unknown limit')).toBeTruthy();
    expect(within(tr).queryByTestId('capacity-share-bar')).toBeNull();
    expect(tr.textContent).not.toMatch(/0/);
  });

  it('a set limit of 0 reads "Limit 0", with a dash for its share', () => {
    const tr = renderRow(unitRow(deepseekEntry(), 'max_concurrency'));
    expect(tr.textContent).toContain('12 / Limit 0');
    expect(tr.textContent).toContain('—');
    expect(within(tr).queryByTestId('capacity-share-bar')).toBeNull();
    expect(within(tr).getByText('Over alert share')).toBeTruthy();
  });

  it('has a look for every state the threshold function can decide', () => {
    expect(Object.keys(STATE_LOOK).sort()).toEqual(
      [
        'near_limit',
        'normal',
        'not_applicable',
        'over_share',
        'unavailable',
        'unknown_limit',
        'usage_not_reported',
      ].sort(),
    );
  });
});

describe('Capacity429Row', () => {
  it('per-lane minute and day counts, no bar and no pill; a null lane reads Unavailable', () => {
    renderWithIntl(
      <table>
        <tbody>
          <Capacity429Row counts={qwenEntry().rateLimited429} />
        </tbody>
      </table>,
    );
    const tr = screen.getByTestId('capacity-row-429');
    expect(tr.textContent).toContain('429 answers');
    expect(tr.textContent).toContain('This minute');
    expect(tr.textContent).toContain('Planning Unavailable · Agent 4');
    expect(tr.textContent).toContain('Today (UTC)');
    expect(tr.textContent).toContain('Planning Unavailable · Agent 31');
    expect(tr.textContent).toContain('No limit — counted only');
    expect(within(tr).queryByTestId('capacity-share-bar')).toBeNull();
  });
});
