import type { CostExplorerLine } from './costExplorerReader';

// THE STORED SHAPE OF A COST EXPLORER DAY (MOTIR-11712). Pure: no SDK, no
// database. Cost Explorer answers per (day, record type, service); the Costs page
// draws a day as its services, then ONE Tax, ONE Credits and ONE Refund line
// (design MOTIR-11711, § Breakdown line). So the lines are folded here, once,
// before they are stored.

/** What a stored line is. Every record type other than the three below is usage of its service. */
export type AwsCostKind = 'service' | 'tax' | 'credit' | 'refund';

export const AWS_COST_KINDS: readonly AwsCostKind[] = ['service', 'tax', 'credit', 'refund'];

/** One stored line of one UTC day. `service` is empty on a tax, credit or refund line. */
export interface AwsCostRow {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  kind: AwsCostKind;
  service: string;
  amountMicroUsd: number;
}

/** Cost Explorer's `RECORD_TYPE` values that the page draws on their own line. */
const KIND_BY_RECORD_TYPE: Readonly<Record<string, Exclude<AwsCostKind, 'service'>>> = {
  Tax: 'tax',
  Credit: 'credit',
  Refund: 'refund',
};

export function kindOfRecordType(recordType: string): AwsCostKind {
  return KIND_BY_RECORD_TYPE[recordType] ?? 'service';
}

/**
 * Fold Cost Explorer's lines into the stored rows: a service's usage, fees and
 * other record types become one line per service and day; every tax, credit and
 * refund of a day become one line each. A line that sums to zero is not stored —
 * a covered day with no row cost nothing. The rows' sum per day is Cost
 * Explorer's unblended total for the day.
 */
export function toCostRows(lines: readonly CostExplorerLine[]): AwsCostRow[] {
  const byKey = new Map<string, AwsCostRow>();
  for (const line of lines) {
    const kind = kindOfRecordType(line.recordType);
    const service = kind === 'service' ? line.service : '';
    const key = `${line.day}\u0000${kind}\u0000${service}`;
    const row = byKey.get(key);
    if (row) row.amountMicroUsd += line.amountMicroUsd;
    else byKey.set(key, { day: line.day, kind, service, amountMicroUsd: line.amountMicroUsd });
  }
  return [...byKey.values()]
    .filter((row) => row.amountMicroUsd !== 0)
    .sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        AWS_COST_KINDS.indexOf(a.kind) - AWS_COST_KINDS.indexOf(b.kind) ||
        a.service.localeCompare(b.service, 'en'),
    );
}

/** A `YYYY-MM-DD` UTC day as a `DATE` column's value. */
export function dayDate(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

/** A `DATE` column's value as its `YYYY-MM-DD` UTC day. */
export function dayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}
