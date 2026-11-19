import { AWS_COST_KINDS, type AwsCostKind } from '@/lib/awsCost/costLines';
import type {
  CostsAwsLineDTO,
  CostsModelLineDTO,
  CostsPageDTO,
  CostsRowDTO,
  CostsView,
} from '@/lib/dto/platformCosts';

/**
 * THE COSTS PAGE'S ARITHMETIC (MOTIR-11712, design MOTIR-11711). Pure: no
 * database, no fetch. `platformReadService.getCosts` reads the two sources and
 * hands them here; this decides the rows, their figures, marks and drill-downs.
 *
 * The rules it holds, from the design's "Rules the drawing holds":
 *   • A missing figure is never a zero — a source that did not answer, a period
 *     AWS holds no read of, a period with no model record: each is `null`.
 *   • Total needs both figures.
 *   • Partial = the period is not over; Estimate = AWS may still revise its cell.
 *   • Rows are never padded past today, and the Year view lists only years with
 *     a cost.
 */

/** An inclusive UTC day range, `YYYY-MM-DD`. */
export interface DayRange {
  fromDay: string;
  toDay: string;
}

/** One AWS line summed over the covered days of a period. */
export interface AwsPeriodLine {
  kind: AwsCostKind;
  service: string;
  amountMicroUsd: number;
}

/** One day of the model read, as motir-ai answers it. */
export interface ModelCostDayInput {
  day: string;
  recordedMicroUsd: number | null;
  providers: ReadonlyArray<{ provider: string; recordedMicroUsd: number }>;
}

export type AwsSource =
  | { status: 'unavailable' }
  | {
      status: 'ok';
      coverage: DayRange;
      fetchedAt: string;
      /** By period: the lines of the period's covered days. A period AWS holds no read of is absent. */
      lines: ReadonlyMap<string, readonly AwsPeriodLine[]>;
    };

export type ModelsSource =
  | { status: 'unavailable' }
  | { status: 'ok'; firstRecordedDay: string | null; days: readonly ModelCostDayInput[] };

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const YEAR_RE = /^\d{4}$/;

/** `YYYY-MM-DD` of a UTC instant. */
export function utcDayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function lastDayOfMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function minDay(a: string, b: string): string {
  return a < b ? a : b;
}

function maxDay(a: string, b: string): string {
  return a > b ? a : b;
}

/**
 * The view a URL asks for. No `view` (or one the page does not know) is Day on the
 * current month; a month or year that is malformed or after today falls back to the
 * current one, so a typed URL can never ask for the future.
 */
export function parseCostsView(
  params: { view?: string | null; month?: string | null; year?: string | null },
  today: string,
): CostsView {
  const currentMonth = today.slice(0, 7);
  const currentYear = today.slice(0, 4);
  if (params.view === 'year') return { kind: 'year' };
  if (params.view === 'month') {
    const year = params.year ?? '';
    return {
      kind: 'month',
      year: YEAR_RE.test(year) && year <= currentYear && year >= '2000' ? year : currentYear,
    };
  }
  const month = params.month ?? '';
  return {
    kind: 'day',
    month:
      MONTH_RE.test(month) && month <= currentMonth && month >= '2000-01' ? month : currentMonth,
  };
}

/** The days a period spans, clamped to today; null for a period that starts after today. */
export function periodRange(period: string, today: string): DayRange | null {
  let range: DayRange;
  if (period.length === 10) range = { fromDay: period, toDay: period };
  else if (period.length === 7) range = { fromDay: `${period}-01`, toDay: lastDayOfMonth(period) };
  else range = { fromDay: `${period}-01-01`, toDay: `${period}-12-31` };
  if (range.fromDay > today) return null;
  return { fromDay: range.fromDay, toDay: minDay(range.toDay, today) };
}

/** The part of `range` that `coverage` holds, or null when they do not meet. */
export function intersectRange(range: DayRange, coverage: DayRange): DayRange | null {
  const fromDay = maxDay(range.fromDay, coverage.fromDay);
  const toDay = minDay(range.toDay, coverage.toDay);
  return fromDay <= toDay ? { fromDay, toDay } : null;
}

/**
 * The periods a view could draw, oldest first, never past today. Day: each day of
 * the month. Month: each month of the year. Year: every year from `firstDay`'s
 * (the earliest day either source holds) to this one — the rows with no cost are
 * dropped later, once the figures are known.
 */
export function candidatePeriods(
  view: CostsView,
  today: string,
  firstDay: string | null,
): string[] {
  const periods: string[] = [];
  if (view.kind === 'day') {
    const range = periodRange(view.month, today);
    if (!range) return periods;
    for (let d = range.fromDay; d <= range.toDay; d = nextDay(d)) periods.push(d);
    return periods;
  }
  if (view.kind === 'month') {
    for (let m = 1; m <= 12; m++) {
      const month = `${view.year}-${String(m).padStart(2, '0')}`;
      if (`${month}-01` > today) break;
      periods.push(month);
    }
    return periods;
  }
  const currentYear = Number(today.slice(0, 4));
  const firstYear = firstDay ? Math.min(Number(firstDay.slice(0, 4)), currentYear) : currentYear;
  for (let y = firstYear; y <= currentYear; y++) periods.push(String(y));
  return periods;
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The model reads a view needs, each within motir-ai's 366-day limit: the month on
 * Day, the year on Month, and on Year this year first (whose answer names the first
 * recorded day) — `modelYearRanges` gives the earlier years once that is known.
 */
export function modelRangeFor(view: CostsView, today: string): DayRange | null {
  if (view.kind === 'day') return periodRange(view.month, today);
  if (view.kind === 'month') return periodRange(view.year, today);
  return periodRange(today.slice(0, 4), today);
}

/** The Year view's further model reads: every whole year from the first recorded one up to last year. */
export function modelYearRanges(firstRecordedDay: string | null, today: string): DayRange[] {
  if (!firstRecordedDay) return [];
  const ranges: DayRange[] = [];
  const currentYear = Number(today.slice(0, 4));
  for (let y = Number(firstRecordedDay.slice(0, 4)); y < currentYear; y++) {
    ranges.push({ fromDay: `${y}-01-01`, toDay: `${y}-12-31` });
  }
  return ranges;
}

/** Whether `period` (a day, month or year) holds `day`. */
function periodHolds(period: string, day: string): boolean {
  return day.startsWith(period);
}

function share(amount: number, of: number): number | null {
  return of === 0 ? null : amount / of;
}

function awsLinesFor(lines: readonly AwsPeriodLine[], figure: number): CostsAwsLineDTO[] {
  return [...lines]
    .filter((line) => line.amountMicroUsd !== 0)
    .sort((a, b) => {
      const byKind = AWS_COST_KINDS.indexOf(a.kind) - AWS_COST_KINDS.indexOf(b.kind);
      if (byKind !== 0) return byKind;
      return b.amountMicroUsd - a.amountMicroUsd || a.service.localeCompare(b.service, 'en');
    })
    .map((line) => ({ ...line, share: share(line.amountMicroUsd, figure) }));
}

function modelLinesFor(
  byProvider: ReadonlyMap<string, number>,
  figure: number,
): CostsModelLineDTO[] {
  return [...byProvider.entries()]
    .filter(([, amount]) => amount !== 0)
    .sort(([pa, a], [pb, b]) => b - a || pa.localeCompare(pb, 'en'))
    .map(([provider, amountMicroUsd]) => ({
      provider,
      amountMicroUsd,
      share: share(amountMicroUsd, figure),
    }));
}

function sumOrNull(values: ReadonlyArray<number | null>): number | null {
  let sum: number | null = null;
  for (const value of values) if (value !== null) sum = (sum ?? 0) + value;
  return sum;
}

/** The earliest day either source holds, or null when neither holds one. */
export function firstDayHeld(
  awsCoverage: DayRange | null,
  modelFirstDay: string | null,
): string | null {
  if (awsCoverage && modelFirstDay) return minDay(awsCoverage.fromDay, modelFirstDay);
  return awsCoverage?.fromDay ?? modelFirstDay;
}

/**
 * The range picker's choices, newest first: on Day every month from this one back
 * to the first either source holds (or the chosen one, if older); on Month the same
 * in years; on Year none.
 */
export function pickerOptions(view: CostsView, today: string, firstDay: string | null): string[] {
  if (view.kind === 'year') return [];
  const options: string[] = [];
  if (view.kind === 'day') {
    const oldest = [firstDay?.slice(0, 7), view.month].filter(Boolean).sort()[0]!;
    let [y, m] = today.slice(0, 7).split('-').map(Number) as [number, number];
    for (;;) {
      const month = `${y}-${String(m).padStart(2, '0')}`;
      options.push(month);
      if (month <= oldest) break;
      m -= 1;
      if (m === 0) {
        m = 12;
        y -= 1;
      }
    }
    return options;
  }
  const oldest = Math.min(Number(firstDay?.slice(0, 4) ?? view.year), Number(view.year));
  for (let y = Number(today.slice(0, 4)); y >= oldest; y--) options.push(String(y));
  return options;
}

/** The whole page from its two sources. */
export function buildCosts(input: {
  view: CostsView;
  today: string;
  aws: AwsSource;
  models: ModelsSource;
}): CostsPageDTO {
  const { view, today, aws, models } = input;
  const awsCoverage = aws.status === 'ok' ? aws.coverage : null;
  const modelFirstDay = models.status === 'ok' ? models.firstRecordedDay : null;
  const firstDay = firstDayHeld(awsCoverage, modelFirstDay);

  const currentPeriod =
    view.kind === 'day' ? today : view.kind === 'month' ? today.slice(0, 7) : today.slice(0, 4);

  const rows: CostsRowDTO[] = [];
  for (const period of candidatePeriods(view, today, firstDay)) {
    const awsLines = aws.status === 'ok' ? aws.lines.get(period) : undefined;
    const awsMicroUsd = awsLines
      ? awsLines.reduce((sum, line) => sum + line.amountMicroUsd, 0)
      : null;

    let modelsMicroUsd: number | null = null;
    const byProvider = new Map<string, number>();
    if (models.status === 'ok') {
      for (const day of models.days) {
        if (!periodHolds(period, day.day) || day.recordedMicroUsd === null) continue;
        modelsMicroUsd = (modelsMicroUsd ?? 0) + day.recordedMicroUsd;
        for (const line of day.providers) {
          byProvider.set(
            line.provider,
            (byProvider.get(line.provider) ?? 0) + line.recordedMicroUsd,
          );
        }
      }
    }

    const partial = period === currentPeriod;
    rows.push({
      period,
      partial,
      estimate: partial && awsMicroUsd !== null,
      awsMicroUsd,
      modelsMicroUsd,
      totalMicroUsd:
        awsMicroUsd !== null && modelsMicroUsd !== null ? awsMicroUsd + modelsMicroUsd : null,
      awsLines: awsLines ? awsLinesFor(awsLines, awsMicroUsd ?? 0) : [],
      modelLines: modelsMicroUsd !== null ? modelLinesFor(byProvider, modelsMicroUsd) : [],
    });
  }

  const hasCost = (row: CostsRowDTO) => row.awsLines.length > 0 || row.modelsMicroUsd !== null;
  const drawn = view.kind === 'year' ? rows.filter(hasCost) : rows;
  const awsAvailable = aws.status === 'ok';
  const modelsAvailable = models.status === 'ok';
  const awsTotal = sumOrNull(drawn.map((row) => row.awsMicroUsd));
  const modelsTotal = sumOrNull(drawn.map((row) => row.modelsMicroUsd));

  return {
    view,
    today,
    awsAvailable,
    modelsAvailable,
    awsFetchedAt: aws.status === 'ok' ? aws.fetchedAt : null,
    rows: drawn,
    totals: {
      awsMicroUsd: awsTotal,
      modelsMicroUsd: modelsTotal,
      totalMicroUsd: awsTotal !== null && modelsTotal !== null ? awsTotal + modelsTotal : null,
      partial: drawn.some((row) => row.partial),
    },
    empty: awsAvailable && modelsAvailable && !drawn.some(hasCost),
    options: pickerOptions(view, today, firstDay),
  };
}
