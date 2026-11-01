'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowLeft, ArrowRight, Calculator, Check, Coins, Info, Users } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Segmented } from '@/components/ui/Segmented';
import type {
  BillingStatusDTO,
  CalculatorCategoriesDTO,
  CalculatorEmptyCategoryDTO,
  CalculatorEstimateDTO,
} from '@/lib/dto/billing';
import { CALCULATOR_REQUEST_LIMITS } from '@/lib/dto/billing';
import {
  INCLUDED_TRACKER_SEATS_PER_AI_PLAN,
  type AiPlanCatalogEntry,
  type BillingCadence,
} from '@/lib/billing/catalog';
import {
  fetchCalculatorCategories,
  fetchCalculatorEstimate,
  type CalculatorOutcome,
} from '@/lib/billing/calculatorClient';
import { dragShare, evenShares, maxShare, MIN_SHARE } from '@/lib/billing/calculatorShares';
import { largerPoolRefusalFor, type LargerPoolRefusal } from '@/lib/billing/largerPoolRefusal';
import { UpgradeDialog, type PlanNames } from './PlanChangeDialog';
import { RungEntitlements, isOnSaleRung } from './RungEntitlements';
import { fmt } from './billingFormat';
import { exampleModels } from '@/lib/billing/modelExamples';

// The Calculator view on Billing & plans (Story MOTIR-8381 · MOTIR-8639 · MOTIR-9224 ·
// MOTIR-8997) — the fourth view of the page. It computes nothing: the categories, the
// split, the credit range, the top-up and the plan key are the answer's; the price and
// pool of a plan the catalog lists are the catalog's; every sentence is a
// `billing.calculator.*` or `billing.plans.*` key. It asks nothing about a MODEL — a
// category lists the models it serves as text, and the request carries category keys.
//
// Two ranges (MOTIR-9224): items PLANNED in Motir and items RUN on Motir's runner. The
// picked categories are the RUNNER's models; the planning lane is the engine's own.
//
// With two or three picked, each carries a share of the run set on a slider (MOTIR-9832,
// § "Amendment 2026-10-27 — each category's share of the run"). They start even, reset to
// even when the set changes, and a drag takes the difference from the others equally
// (`dragShare`), so they always total 100 and are sent as `shares`.
//
// The answer sells the larger pool itself (design/billing § "Amendment 2026-10-21 — the
// larger credit pool plan", approved 2026-10-22): Choose starts Checkout here, and an
// org on a smaller live plan gets the shipped change-of-plan dialog instead. The larger
// offer starts above HOST's pool (§ "Amendment 2026-10-26 — the larger pools above
// Host"): below it the engine answers the regular plan with top-ups, and only a rung the
// catalog sells is ever offered.
//
// ⚠️ The recommendation ARM is read, never derived. `ceiling.outcome` is the engine's
// own statement of which situation the high end is in, so nothing below compares a
// credit figure against a ceiling, a pool or a constant to decide it.

type Arm = 'regular' | 'larger' | 'largest' | 'above' | 'topup_only';

type RangeIssue = 'rangeEmpty' | 'rangeInvalid' | 'rangeOrder';
type FormIssue = RangeIssue | 'rangeBothZero';
type CategoryIssue = 'categoryMissing' | 'tooManyCategories';
type Lane = 'planned' | 'run';
type Range = { low: string; high: string };
type Parsed = { low: number; high: number };

type CategoriesState =
  | { kind: 'loading' }
  | { kind: 'ready'; value: CalculatorCategoriesDTO }
  | { kind: 'failed' };

type ResultState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'estimate'; value: CalculatorEstimateDTO }
  | { kind: 'empty'; value: CalculatorEmptyCategoryDTO }
  | { kind: 'unavailable' }
  | { kind: 'failed' };

/** Start Checkout for one price; `onRefused` gets the failed body and says if it handled it. */
export type CalculatorCheckout = (
  priceLookupKey: string,
  onRefused: (payload: unknown) => boolean,
) => void;

export interface CalculatorViewProps {
  orgId: string;
  orgName: string;
  data: BillingStatusDTO;
  /** The page's ONE cadence value, shared with the plans view. */
  cadence: BillingCadence;
  onCadence: (cadence: BillingCadence) => void;
  /** Back to the plans view. */
  back: () => void;
  /** Open the plans view with this plan distinguished (null when it names no plan). */
  goToPlan: (planKey: string | null) => void;
  /** Buy the offered pool (no live plan): the page's shipped checkout. */
  checkout: CalculatorCheckout;
  /** The shipped Stripe portal (the upgrade dialog's payment-method fallback). */
  portal: () => void;
  /** Re-read the billing status after a change of plan. */
  reload: () => Promise<void>;
  redirecting: boolean;
}

// A whole, non-negative count typed as text. Letters, decimals, signs and blanks are
// refused before any request, each with its own sentence.
function parseCount(text: string): number | 'empty' | 'invalid' {
  const trimmed = text.trim();
  if (trimmed === '') return 'empty';
  if (!/^\d+$/.test(trimmed)) return 'invalid';
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : 'invalid';
}

function parseRange(range: Range): Parsed | RangeIssue {
  const lo = parseCount(range.low);
  const hi = parseCount(range.high);
  if (lo === 'empty' || hi === 'empty') return 'rangeEmpty';
  if (lo === 'invalid' || hi === 'invalid') return 'rangeInvalid';
  return lo > hi ? 'rangeOrder' : { low: lo, high: hi };
}

// A category names a few of its models as examples, never the whole list: the
// engine can serve dozens, and listing them all ran the picker off the card.
export const CATEGORY_MODEL_EXAMPLES = 3;

// Presentational capitalisation at most: the engine's category rule owns the names,
// and a key→label map here would go stale the day a band is added.
function categoryLabel(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function CalculatorView(props: CalculatorViewProps) {
  const { orgId, orgName, data, cadence, onCadence, back } = props;
  const t = useTranslations('billing');
  const locale = useLocale();
  const [categories, setCategories] = useState<CategoriesState>({ kind: 'loading' });
  const [planned, setPlanned] = useState<Range>({ low: '', high: '' });
  const [run, setRun] = useState<Range>({ low: '', high: '' });
  // The run range follows the planned one until the owner types into it, so an org
  // that runs everything on Motir gets the single-range estimate without retyping.
  const runTouched = useRef(false);
  const [picked, setPicked] = useState<string[]>([]);
  // Each picked category's share, keyed by category; set only with two or more picked.
  const [shares, setShares] = useState<Record<string, number>>({});
  const [issues, setIssues] = useState<Partial<Record<Lane, FormIssue>>>({});
  const [categoryIssue, setCategoryIssue] = useState<CategoryIssue | null>(null);
  const [result, setResult] = useState<ResultState>({ kind: 'idle' });
  // Stamped on every ask and bumped on every edit: an older answer never lands under
  // newer inputs (the page's own `load()` and PlanChangeDialog guard the same way).
  const seq = useRef(0);
  const readSeq = useRef(0);

  // The state starts as `loading`, so the first read sets nothing before it answers;
  // a retry sets it itself.
  const loadCategories = useCallback(async () => {
    const mine = ++readSeq.current;
    const out = await fetchCalculatorCategories(orgId);
    if (mine !== readSeq.current) return;
    setCategories(out.kind === 'answer' ? { kind: 'ready', value: out.value } : { kind: 'failed' });
  }, [orgId]);

  useEffect(() => {
    void loadCategories();
    return () => {
      readSeq.current += 1;
      seq.current += 1;
    };
  }, [loadCategories]);

  // An edit returns the result block to not-yet-asked; the inputs themselves stay.
  const clear = useCallback(() => {
    seq.current += 1;
    setResult({ kind: 'idle' });
    setIssues({});
    setCategoryIssue(null);
  }, []);

  const ask = useCallback(async () => {
    const p = parseRange(planned);
    const r = parseRange(run);
    if (typeof p === 'string' || typeof r === 'string') {
      return void setIssues({
        ...(typeof p === 'string' ? { planned: p } : {}),
        ...(typeof r === 'string' ? { run: r } : {}),
      });
    }
    if (p.high === 0 && r.high === 0) {
      return void setIssues({ planned: 'rangeBothZero', run: 'rangeBothZero' });
    }
    if (picked.length === 0) return void setCategoryIssue('categoryMissing');
    setIssues({});
    setCategoryIssue(null);
    const mine = ++seq.current;
    setResult({ kind: 'loading' });
    const out = await fetchCalculatorEstimate(orgId, {
      plannedPerMonth: p,
      runPerMonth: r,
      categories: picked,
      ...(picked.length > 1 ? { shares } : {}),
      cadence,
    });
    if (mine !== seq.current) return;
    applyOutcome(out, { planned: p, run: r }, setResult, setIssues, setCategoryIssue);
  }, [planned, run, picked, shares, orgId, cadence]);

  const editPlanned = (field: keyof Range, value: string) => {
    clear();
    setPlanned((current) => ({ ...current, [field]: value }));
    if (!runTouched.current) setRun((current) => ({ ...current, [field]: value }));
  };
  const editRun = (field: keyof Range, value: string) => {
    clear();
    runTouched.current = true;
    setRun((current) => ({ ...current, [field]: value }));
  };

  // Picked categories in the tiles' order — the order the share sliders are listed in,
  // and the order the even split's remainder follows.
  const tileOrder =
    categories.kind === 'ready' ? categories.value.categories.map((c) => c.key) : [];
  const inTileOrder = (keys: string[]) =>
    [...keys].sort((a, b) => tileOrder.indexOf(a) - tileOrder.indexOf(b));

  const togglePicked = (key: string) => {
    clear();
    const next = inTileOrder(
      picked.includes(key) ? picked.filter((k) => k !== key) : [...picked, key],
    );
    setPicked(next);
    // A changed set starts the shares even again.
    const even = evenShares(next.length);
    setShares(next.length > 1 ? Object.fromEntries(next.map((k, i) => [k, even[i]!])) : {});
  };

  const dragTo = (key: string, to: number) => {
    clear();
    const values = dragShare(
      picked.map((k) => shares[k] ?? MIN_SHARE),
      picked.indexOf(key),
      to,
    );
    setShares(Object.fromEntries(picked.map((k, i) => [k, values[i]!])));
  };

  const asking = result.kind === 'loading';
  const bothZero = issues.planned === 'rangeBothZero';

  return (
    <>
      <header className="flex flex-col gap-1">
        <button
          type="button"
          onClick={back}
          className="flex w-fit items-center gap-1 font-sans text-xs text-(--el-link) hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {t('calculator.back')}
        </button>
        <p className="font-sans text-xs text-(--el-text-secondary)">
          {t('calculator.breadcrumb', { org: orgName })}
        </p>
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
          {t('calculator.title')}
        </h1>
        <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">
          {t('calculator.subtitle')}
        </p>
      </header>

      <Segmented<BillingCadence>
        label={t('plans.cadenceLabel')}
        value={cadence}
        onChange={(next) => {
          clear();
          onCadence(next);
        }}
        options={[
          { value: 'monthly', label: t('plans.monthly') },
          { value: 'annual', label: t('plans.annual') },
        ]}
      />

      {/* The form on the left and the answer on the right at desktop width; one
          column below it (design panel 11). */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card>
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void ask();
            }}
          >
            <RangeField
              legend={t('calculator.inputs.plannedLabel')}
              help={t('calculator.inputs.rangeHelp')}
              value={planned}
              issue={bothZero ? 'invalid' : issues.planned}
              onEdit={editPlanned}
              testId="calculator-planned"
            />
            <RangeField
              legend={t('calculator.inputs.runLabel')}
              help={t('calculator.inputs.runHelp')}
              value={run}
              issue={bothZero ? 'invalid' : issues.run}
              onEdit={editRun}
              testId="calculator-run"
            />
            {bothZero ? (
              <p role="alert" className="font-sans text-xs text-(--el-danger-on-surface)">
                {t('calculator.errors.rangeBothZero')}
              </p>
            ) : null}

            <CategoryGroup
              categories={categories}
              picked={picked}
              toggle={togglePicked}
              retry={() => {
                setCategories({ kind: 'loading' });
                void loadCategories();
              }}
              issue={categoryIssue}
              locale={locale}
            />

            {picked.length > 1 ? (
              <SharesField picked={picked} shares={shares} onDrag={dragTo} />
            ) : null}

            <div>
              <Button
                type="submit"
                variant="primary"
                size="md"
                loading={asking}
                disabled={categories.kind !== 'ready'}
                leftIcon={<Calculator className="h-4 w-4" />}
              >
                {t('calculator.inputs.submit')}
              </Button>
            </div>
          </form>
        </Card>

        <ResultBlock
          result={result}
          retry={() => void ask()}
          view={{ ...props, locale }}
          data={data}
        />
      </div>
    </>
  );
}

function RangeField({
  legend,
  help,
  value,
  issue,
  onEdit,
  testId,
}: {
  legend: string;
  help: string;
  value: Range;
  /** A range sentence to show under it, or `invalid` to mark it with no sentence of its own. */
  issue: FormIssue | 'invalid' | undefined;
  onEdit: (field: keyof Range, value: string) => void;
  testId: string;
}) {
  const t = useTranslations('billing');
  const id = useId();
  const sentence = issue && issue !== 'invalid' && issue !== 'rangeBothZero' ? issue : null;
  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={`${id}-help`} data-testid={testId}>
      <legend className="font-sans text-sm font-medium text-(--el-text)">{legend}</legend>
      <div className="grid grid-cols-2 items-start gap-3">
        {(['low', 'high'] as const).map((field) => (
          <Input
            key={field}
            label={t(
              field === 'low' ? 'calculator.inputs.lowLabel' : 'calculator.inputs.highLabel',
            )}
            inputMode="numeric"
            autoComplete="off"
            value={value[field]}
            aria-invalid={issue !== undefined}
            onChange={(event) => onEdit(field, event.target.value)}
          />
        ))}
      </div>
      <p id={`${id}-help`} className="font-sans text-xs text-(--el-text-secondary)">
        {help}
      </p>
      {sentence ? (
        <p role="alert" className="font-sans text-xs text-(--el-danger-on-surface)">
          {t(`calculator.errors.${sentence}`)}
        </p>
      ) : null}
    </fieldset>
  );
}

function CategoryGroup({
  categories,
  picked,
  toggle,
  retry,
  issue,
  locale,
}: {
  categories: CategoriesState;
  picked: string[];
  toggle: (key: string) => void;
  retry: () => void;
  issue: CategoryIssue | null;
  locale: string;
}) {
  const t = useTranslations('billing');
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  // With one category picked the tile says it carries the whole run; with two or three
  // the share sliders below say what each carries.
  const share = picked.length === 1 ? percent.format(1) : null;
  const ready = categories.kind === 'ready' ? categories.value : null;
  return (
    <div className="flex flex-col gap-2">
      <span className="font-sans text-sm font-medium text-(--el-text)">
        {t('calculator.inputs.runCategoriesLabel')}
      </span>
      {categories.kind === 'loading' ? (
        <p role="status" className="font-sans text-sm text-(--el-text-secondary)">
          {t('states.loading')}
        </p>
      ) : null}
      {categories.kind === 'failed' ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="font-sans text-sm text-(--el-text-secondary)">
            {t('calculator.categories.failed')}
          </p>
          <Button variant="secondary" size="sm" onClick={retry}>
            {t('states.retry')}
          </Button>
        </div>
      ) : null}
      {ready ? (
        <div
          className="grid gap-2 sm:grid-cols-3"
          role="group"
          aria-label={t('calculator.inputs.runCategoriesLabel')}
        >
          {ready.categories.map((category) => {
            const on = picked.includes(category.key);
            const empty = category.models.length === 0;
            const full = !on && picked.length >= CALCULATOR_REQUEST_LIMITS.maxCategories;
            return (
              <button
                key={category.key}
                type="button"
                aria-pressed={on}
                disabled={empty || full}
                onClick={() => toggle(category.key)}
                className="flex min-w-0 flex-col items-start gap-0.5 rounded-(--radius-control) border px-(--spacing-control-x-12) py-(--spacing-control-y-8) text-left disabled:cursor-not-allowed"
                style={{
                  borderColor: on ? 'var(--el-accent)' : 'var(--el-border)',
                  backgroundColor: on ? 'var(--el-surface)' : 'transparent',
                }}
              >
                <span className="flex items-center gap-1 font-sans text-sm font-medium text-(--el-text)">
                  {on ? (
                    <Check className="h-3.5 w-3.5 text-(--el-accent-on-surface)" aria-hidden />
                  ) : null}
                  {categoryLabel(category.key)}
                </span>
                {on && share ? (
                  <span
                    data-testid="calculator-category-share"
                    className="font-sans text-xs font-medium text-(--el-text-strong)"
                  >
                    {t('calculator.inputs.categoryShare', { share })}
                  </span>
                ) : null}
                <span className="font-sans text-xs break-words text-(--el-text-secondary)">
                  {empty
                    ? t('calculator.categories.empty')
                    : t('calculator.inputs.categoryExamples', {
                        models: exampleModels(
                          category.models.map((m) => m.id),
                          CATEGORY_MODEL_EXAMPLES,
                        ).join(', '),
                      })}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      <p className="font-sans text-xs text-(--el-text-secondary)">
        {t('calculator.inputs.runCategoriesHelp')}
      </p>
      {issue ? (
        <p role="alert" className="font-sans text-xs text-(--el-danger-on-surface)">
          {t(`calculator.errors.${issue}`)}
        </p>
      ) : null}
    </div>
  );
}

// The split bar's segment fills, in the sliders' order: three distinct pastel tints.
const SHARE_TINTS = ['var(--el-tint-sky)', 'var(--el-tint-mint)', 'var(--el-tint-lavender)'];

function SharesField({
  picked,
  shares,
  onDrag,
}: {
  picked: string[];
  shares: Record<string, number>;
  onDrag: (key: string, to: number) => void;
}) {
  const t = useTranslations('billing');
  const id = useId();
  const max = maxShare(picked.length);
  return (
    <fieldset
      className="flex flex-col gap-3"
      aria-describedby={`${id}-help`}
      data-testid="calculator-shares"
    >
      <legend className="font-sans text-sm font-medium text-(--el-text)">
        {t('calculator.inputs.sharesLabel')}
      </legend>
      <div className="flex flex-col gap-3">
        {picked.map((key) => {
          const label = categoryLabel(key);
          const value = shares[key] ?? MIN_SHARE;
          return (
            <div key={key} className="grid grid-cols-[6rem_1fr_3rem] items-center gap-3">
              <label htmlFor={`${id}-${key}`} className="font-sans text-sm text-(--el-text)">
                {label}
              </label>
              <input
                id={`${id}-${key}`}
                type="range"
                min={MIN_SHARE}
                max={max}
                step={1}
                value={value}
                aria-valuetext={t('calculator.inputs.shareValue', {
                  category: label,
                  share: value,
                })}
                onChange={(event) => onDrag(key, Number(event.target.value))}
                className="h-6 w-full cursor-grab focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring-color)"
                style={{ accentColor: 'var(--el-accent)' }}
              />
              <span
                data-testid="calculator-share-value"
                className="text-right font-sans text-sm font-medium text-(--el-text-strong) tabular-nums"
              >
                {value}%
              </span>
            </div>
          );
        })}
      </div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-(--el-muted)" aria-hidden>
        {picked.map((key, i) => (
          <span
            key={key}
            style={{
              width: `${shares[key] ?? MIN_SHARE}%`,
              backgroundColor: SHARE_TINTS[i % SHARE_TINTS.length],
              borderRight: i < picked.length - 1 ? '2px solid var(--el-surface)' : undefined,
            }}
          />
        ))}
      </div>
      <p id={`${id}-help`} className="font-sans text-xs text-(--el-text-secondary)">
        {t('calculator.inputs.sharesHelp')}
      </p>
    </fieldset>
  );
}

// Fold one door outcome into the view's state. A refusal that names a field it owns
// renders on that field; one that names none (or one this view cannot place) renders
// as the failed state, so a validation drift surfaces rather than posing as an outage.
function applyOutcome(
  out: CalculatorOutcome<CalculatorEstimateDTO | CalculatorEmptyCategoryDTO>,
  ranges: Record<Lane, Parsed>,
  setResult: (next: ResultState) => void,
  setIssues: (next: Partial<Record<Lane, FormIssue>>) => void,
  setCategoryIssue: (next: CategoryIssue | null) => void,
) {
  if (out.kind === 'answer') {
    return setResult(
      out.value.kind === 'empty_category'
        ? { kind: 'empty', value: out.value }
        : { kind: 'estimate', value: out.value },
    );
  }
  if (out.kind === 'unavailable') return setResult({ kind: 'unavailable' });
  if (out.kind === 'refused' && out.field) {
    if (out.field === 'categories') {
      setResult({ kind: 'idle' });
      return setCategoryIssue('tooManyCategories');
    }
    const lane: Lane | null = out.field.startsWith('plannedPerMonth')
      ? 'planned'
      : out.field.startsWith('runPerMonth')
        ? 'run'
        : null;
    if (lane) {
      setResult({ kind: 'idle' });
      const range = ranges[lane];
      return setIssues({ [lane]: range.low > range.high ? 'rangeOrder' : 'rangeInvalid' });
    }
  }
  return setResult({ kind: 'failed' });
}

type ViewContext = CalculatorViewProps & { locale: string };

function ResultBlock({
  result,
  retry,
  view,
  data,
}: {
  result: ResultState;
  retry: () => void;
  view: ViewContext;
  data: BillingStatusDTO;
}) {
  const t = useTranslations('billing');
  let body: React.ReactNode;
  switch (result.kind) {
    case 'idle':
      body = <Note>{t('calculator.result.idle')}</Note>;
      break;
    case 'loading':
      body = (
        <p role="status" className="font-sans text-sm text-(--el-text-secondary)">
          {t('calculator.result.loading')}
        </p>
      );
      break;
    case 'unavailable':
    case 'failed':
      body = (
        <div className="flex flex-wrap items-center gap-3">
          <Note>{t(`calculator.errors.${result.kind}`)}</Note>
          <Button variant="secondary" size="sm" onClick={retry}>
            {t('states.retry')}
          </Button>
        </div>
      );
      break;
    case 'empty':
      body = (
        <ul className="flex flex-col gap-1">
          {result.value.categories.map((key) => (
            <li key={key} className="font-sans text-sm text-(--el-text-secondary)">
              <span className="font-medium text-(--el-text)">{categoryLabel(key)}</span>{' '}
              {t('calculator.categories.empty')}
            </li>
          ))}
        </ul>
      );
      break;
    case 'estimate':
      // Keyed by the answer, so an offer's refusal never outlives the estimate it was for.
      body = (
        <Estimate
          key={JSON.stringify(result.value.credits)}
          answer={result.value}
          view={view}
          data={data}
        />
      );
      break;
  }
  return (
    <Card aria-live="polite" data-testid="calculator-result">
      {body}
    </Card>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 font-sans text-sm text-(--el-text-secondary)">
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

// The engine's own discriminant — `ceiling.outcome` — and whether it names a plan.
// No credit figure is compared to decide it.
function armOf(answer: CalculatorEstimateDTO): Arm {
  switch (answer.ceiling.outcome) {
    case 'larger_pool':
      return 'larger';
    case 'largest_pool':
      return 'largest';
    case 'top_ups_only':
      return 'above';
    case 'within_ladder':
      return answer.recommendation.planKey === null ? 'topup_only' : 'regular';
  }
}

/** The org holds a live paid AI plan: a buy is then a change of plan, never a checkout. */
function holdsLivePlan(data: BillingStatusDTO): boolean {
  const { tier, subscription } = data.motirAi;
  return (
    !!tier &&
    tier.key !== 'free' &&
    (subscription.status === 'active' ||
      subscription.status === 'trialing' ||
      subscription.status === 'past_due')
  );
}

function Estimate({
  answer,
  view,
  data,
}: {
  answer: CalculatorEstimateDTO;
  view: ViewContext;
  data: BillingStatusDTO;
}) {
  const t = useTranslations('billing');
  const { cadence, locale, goToPlan } = view;
  const arm = armOf(answer);
  const { recommendation, topUp, split } = answer;
  const { aiPlans, seatPlan } = data.catalog;

  // Every plan figure is the CATALOG's: `recommendation.monthlyPriceUsd` is the monthly
  // equivalent (annual = yearly / 12), which would understate an annual plan. The key
  // is an open string, so the lookup may miss — and a miss keeps the answer's own name
  // rather than borrowing another entry's.
  const entry = aiPlans.find((p) => p.key === recommendation.planKey) ?? null;
  const planName = entry?.name ?? recommendation.planName;
  const includedSeats =
    arm === 'topup_only'
      ? null
      : (entry?.includedTrackerSeats ?? INCLUDED_TRACKER_SEATS_PER_AI_PLAN);
  const seatFee = seatPlan.prices[cadence].amountUsd;

  const holdsPlan = holdsLivePlan(data);
  const currentPool =
    aiPlans.find((p) => p.key === data.motirAi.tier?.key)?.allotment?.credits ?? null;
  const entryPool = entry?.allotment?.credits ?? null;
  const above =
    holdsPlan &&
    (arm === 'regular' || arm === 'above') &&
    entryPool !== null &&
    currentPool !== null &&
    entryPool > currentPool;

  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  const names = split.categories.map((c) => categoryLabel(c.key));
  const pool = arm === 'larger' || arm === 'largest';
  // Only a rung on sale is offered: a pool key the catalog does not sell (unlisted, or
  // no longer on sale) gets no offer card and no buy control.
  const offer = pool && entry?.prices && isOnSaleRung(entry) ? entry : null;
  // A pool key this catalog cannot sell is shown as the answer names it, with no buy.
  const named = arm === 'regular' || arm === 'above' || (pool && !offer);
  const hasTopUp = topUp.high.credits > 0;

  return (
    <div className="flex flex-col gap-4">
      <p
        data-testid="calculator-priced"
        className="rounded-(--radius-control) border border-(--el-border-soft) bg-(--el-surface-soft) px-(--spacing-control-x-12) py-(--spacing-control-y-8) font-sans text-sm text-(--el-text)"
      >
        {t('calculator.result.priced', {
          plannedLow: fmt(answer.plannedPerMonth.low, locale),
          plannedHigh: fmt(answer.plannedPerMonth.high, locale),
          runLow: fmt(answer.runPerMonth.low, locale),
          runHigh: fmt(answer.runPerMonth.high, locale),
        })}
      </p>

      <div className="flex flex-col gap-1">
        <p className="font-sans text-sm text-(--el-text)">
          {split.count === 1
            ? t('calculator.split.one', { category: names[0] ?? '' })
            : t('calculator.split.shares', {
                shares: split.categories
                  .map((c) => `${categoryLabel(c.key)} ${percent.format(c.weight)}`)
                  .join(' · '),
              })}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {split.categories.map((c) => (
            <Pill
              key={c.key}
              className="border-(--el-border-strong) bg-(--el-surface) text-(--el-text-strong)"
            >
              {categoryLabel(c.key)} · {percent.format(c.weight)}
            </Pill>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="font-sans text-xs font-medium text-(--el-text-secondary)">
          {t('calculator.result.creditsLabel')}
        </span>
        <span className="font-serif text-2xl text-(--el-text)" data-testid="calculator-credits">
          {fmt(answer.credits.low, locale)} – {fmt(answer.credits.high, locale)}
        </span>
        <p className="font-sans text-xs text-(--el-text-secondary)">
          {t('calculator.result.estimateCaveat')}
        </p>
      </div>

      {offer ? (
        <PoolOffer
          plan={offer}
          largest={arm === 'largest'}
          excess={Math.max(0, answer.credits.high - (offer.allotment?.credits ?? 0))}
          topUp={topUp.high}
          poolCredits={recommendation.poolCredits}
          holdsPlan={holdsPlan}
          view={view}
          data={data}
        />
      ) : null}

      {named ? (
        <div className="flex flex-col gap-1" data-testid="calculator-plan">
          <span className="font-sans text-xs font-medium text-(--el-text-secondary)">
            {t('calculator.result.planLabel')}
          </span>
          <span className="font-sans text-lg font-semibold text-(--el-text)">{planName}</span>
          {/* The regular plan with top-ups (design panel 1): the plan and its pool are the
              catalog entry's, and no Host or rung is named here. */}
          {arm === 'above' ? (
            <p
              className="font-sans text-sm text-(--el-text)"
              data-testid="calculator-regular-topups"
            >
              {t('calculator.result.regularWithTopUps', {
                plan: planName ?? '',
                credits: fmt(entryPool ?? 0, locale),
              })}
            </p>
          ) : null}
          <PlanPrice
            cadence={cadence}
            locale={locale}
            amountUsd={entry?.prices?.[cadence].amountUsd ?? recommendation.monthlyPriceUsd}
            fromCatalog={entry?.prices != null}
          />
          {arm === 'above' && topUp.high.units > 0 ? (
            <TopUpBox
              testId="calculator-above-topup"
              excess={Math.max(0, answer.credits.high - (entryPool ?? 0))}
              topUp={topUp.high}
              locale={locale}
            />
          ) : null}
          <p className="font-sans text-xs text-(--el-text-secondary)">
            {t('calculator.result.perOrg')}
          </p>
        </div>
      ) : null}

      {arm === 'topup_only' ? <Note>{t('calculator.result.topupOnly')}</Note> : null}

      {!offer && arm !== 'above' && hasTopUp ? (
        <div className="flex flex-col gap-0.5" data-testid="calculator-topup">
          <span className="font-sans text-xs font-medium text-(--el-text-secondary)">
            {t('calculator.result.topupLabel')}
          </span>
          <span className="font-sans text-sm text-(--el-text)">
            {t('topup.bundleCredits', { n: fmt(topUp.low.credits, locale) })} –{' '}
            {t('topup.bundleCredits', { n: fmt(topUp.high.credits, locale) })}
          </span>
        </div>
      ) : null}

      {offer ? null : (
        <p
          data-testid="calculator-seat"
          className="flex items-start gap-1.5 font-sans text-xs text-(--el-text-secondary)"
        >
          <Users className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {includedSeats === null ? (
              t('calculator.seat.noPlan')
            ) : (
              <>
                {t('calculator.seat.included', { count: includedSeats })}{' '}
                {t(
                  cadence === 'annual'
                    ? 'calculator.seat.feePerUserAnnual'
                    : 'calculator.seat.feePerUserMonthly',
                  { price: fmt(seatFee, locale) },
                )}
              </>
            )}
          </span>
        </p>
      )}

      {above ? <Note>{t('calculator.result.upgradeNote')}</Note> : null}

      {arm === 'regular' || arm === 'above' ? (
        <div>
          <Button
            variant="secondary"
            size="sm"
            rightIcon={<ArrowRight className="h-4 w-4" />}
            onClick={() => goToPlan(recommendation.planKey)}
          >
            {t('calculator.result.goToPlan')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// The larger pool, offered and SOLD from the answer (design panels 2–4, 6–8): the
// catalog entry's own name, price and pool, and one buy control. No live plan →
// Checkout at quantity 1; a smaller live plan → the shipped change-of-plan dialog.
// Above every pool (`largest`), the box under the price says the rest is top-ups.
function PoolOffer({
  plan,
  largest,
  excess,
  topUp,
  poolCredits,
  holdsPlan,
  view,
  data,
}: {
  plan: AiPlanCatalogEntry;
  largest: boolean;
  /** Credits a month past this pool's — top-ups cover them (`largest` only). */
  excess: number;
  topUp: CalculatorEstimateDTO['topUp']['high'];
  /** The answer's own pool (MOTIR-9262); absent from an engine older than MOTIR-9189. */
  poolCredits: number | undefined;
  holdsPlan: boolean;
  view: ViewContext;
  data: BillingStatusDTO;
}) {
  const t = useTranslations('billing');
  const { cadence, locale, orgId, checkout, portal, reload, redirecting } = view;
  const reasonId = useId();
  const [refusal, setRefusal] = useState<LargerPoolRefusal | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const canManage = data.access.canManageBilling;
  const prices = plan.prices!;
  const pool = plan.allotment?.credits ?? 0;
  const isCurrent = data.motirAi.tier?.key === plan.key;
  const currentPool =
    data.catalog.aiPlans.find((p) => p.key === data.motirAi.tier?.key)?.allotment?.credits ?? null;
  // An org whose live plan already holds at least this pool is not sold it again.
  const covered = holdsPlan && !isCurrent && currentPool !== null && currentPool >= pool;
  const planNames: PlanNames = Object.fromEntries(data.catalog.aiPlans.map((p) => [p.key, p.name]));

  const buy = () => {
    setRefusal(null);
    if (holdsPlan) return setUpgrading(true);
    checkout(prices[cadence].priceLookupKey, (payload) => {
      const reason = largerPoolRefusalFor(payload);
      if (reason) setRefusal(reason);
      return reason !== null;
    });
  };

  return (
    <div className="flex flex-col gap-2">
      {refusal ? (
        <p
          role="alert"
          data-testid="calculator-larger-refused"
          className="rounded-(--radius-card) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) p-(--spacing-card-padding) font-sans text-sm text-(--el-text)"
        >
          {t(`plans.larger.refused.${refusal}`)}
        </p>
      ) : null}
      <div
        className="flex flex-col gap-2 rounded-(--radius-card) border bg-(--el-surface) p-(--spacing-card-padding) shadow-(--shadow-card)"
        style={{ borderColor: 'var(--el-accent)' }}
        data-testid="calculator-larger"
      >
        <Pill className="w-fit border-transparent bg-(--el-tint-lavender) text-(--el-text-strong)">
          {t(largest ? 'calculator.result.largestPoolLabel' : 'calculator.result.largerPoolLabel')}
        </Pill>
        <span className="font-sans text-base font-semibold text-(--el-text)">{plan.name}</span>
        <p className="font-sans text-sm text-(--el-text)">
          {t(largest ? 'calculator.result.largestPool' : 'calculator.result.largerPlan', {
            plan: plan.name,
          })}
        </p>
        <OfferPrice plan={plan} cadence={cadence} locale={locale} />
        {/* The pool's size is the answer's own when it sends one, else the catalog row's. */}
        <p
          className="font-sans text-sm font-semibold text-(--el-text-strong)"
          data-testid="calculator-larger-pool"
        >
          {t('plans.creditsAllotment', { n: fmt(poolCredits || pool, locale) })}
        </p>
        {largest && topUp.units > 0 ? (
          <TopUpBox
            testId="calculator-largest-topup"
            excess={excess}
            topUp={topUp}
            locale={locale}
          />
        ) : null}
        <p className="font-sans text-xs text-(--el-text-secondary)">
          {t('calculator.result.largerPlanEstimate')}
        </p>
        <p className="flex items-center gap-1.5 font-sans text-xs text-(--el-text-secondary)">
          <Users className="h-3.5 w-3.5 shrink-0 text-(--el-accent-on-surface)" aria-hidden />
          {t('calculator.result.perOrg')}
        </p>
        <RungEntitlements plan={plan} testId="calculator-rung-entitlements" />
        {!canManage ? (
          <p id={reasonId} className="font-sans text-xs text-(--el-text-secondary)">
            {t('plans.upgrade.disabledReason')}
          </p>
        ) : null}
        {covered ? null : (
          <Button
            variant="primary"
            size="md"
            className="w-full"
            disabled={!canManage || isCurrent}
            loading={!holdsPlan && redirecting}
            aria-describedby={!canManage ? reasonId : undefined}
            aria-haspopup={holdsPlan ? 'dialog' : undefined}
            onClick={buy}
          >
            {isCurrent
              ? t('plans.ctaCurrent')
              : holdsPlan
                ? t('plans.ctaUpgrade', { plan: plan.name })
                : t('plans.ctaChoose', { plan: plan.name })}
          </Button>
        )}
      </div>
      {holdsPlan && !isCurrent && !covered ? (
        <Note>{t('calculator.result.upgradeNote')}</Note>
      ) : null}
      {upgrading ? (
        <UpgradeDialog
          orgId={orgId}
          toPlanKey={plan.key}
          planNames={planNames}
          onClose={() => setUpgrading(false)}
          onChanged={() => void reload()}
          portal={portal}
        />
      ) : null}
    </div>
  );
}

// The top-up box (design panels 1 and 5): the credits a month past the plan's pool, and
// the top-ups the answer prices for them. Every figure is the answer's or the entry's.
function TopUpBox({
  testId,
  excess,
  topUp,
  locale,
}: {
  testId: string;
  excess: number;
  topUp: CalculatorEstimateDTO['topUp']['high'];
  locale: string;
}) {
  const t = useTranslations('billing');
  const unitCredits = topUp.units > 0 ? topUp.credits / topUp.units : 0;
  return (
    <p
      data-testid={testId}
      className="flex items-start gap-1.5 rounded-(--radius-control) border border-(--el-border-soft) bg-(--el-surface-soft) px-(--spacing-control-x-12) py-(--spacing-control-y-8) font-sans text-sm text-(--el-text)"
    >
      <Coins className="mt-0.5 h-4 w-4 shrink-0 text-(--el-accent-on-surface)" aria-hidden />
      <span>
        {t('calculator.result.largestPoolTopUp', {
          excess: fmt(excess, locale),
          units: fmt(topUp.units, locale),
          unitCredits: fmt(unitCredits, locale),
          price: fmt(topUp.priceUsd, locale),
        })}
      </span>
    </p>
  );
}

// The offered pool's price in the plan cards' own price block: the per-month
// equivalent and the yearly figure on annual, the monthly figure on monthly.
function OfferPrice({
  plan,
  cadence,
  locale,
}: {
  plan: AiPlanCatalogEntry;
  cadence: BillingCadence;
  locale: string;
}) {
  const t = useTranslations('billing');
  const { monthly, annual } = plan.prices!;
  const save = monthly.amountUsd * 12 - annual.amountUsd;
  return (
    <div data-testid="calculator-larger-price">
      <span className="font-serif text-2xl text-(--el-text)">
        {t('plans.perMoEquiv', {
          n: fmt(
            cadence === 'annual' ? Math.round(annual.amountUsd / 12) : monthly.amountUsd,
            locale,
          ),
        })}
      </span>
      <p className="font-sans text-xs text-(--el-text-secondary)">
        {cadence === 'annual'
          ? t('plans.annualSub', { yr: fmt(annual.amountUsd, locale) })
          : t('plans.monthlySub', {
              yr: fmt(monthly.amountUsd * 12, locale),
              n: fmt(save, locale),
            })}
      </p>
      {cadence === 'annual' && save > 0 ? (
        <Pill className="mt-1 border-transparent bg-(--el-tint-mint) text-(--el-text-strong)">
          {t('plans.annualSave', { n: fmt(save, locale) })}
        </Pill>
      ) : null}
    </div>
  );
}

// A plan's price for the picked cadence, in the annotations the plan cards use: the
// annual price is the catalog's yearly figure as it stands (no division), the monthly
// price its monthly figure. An open key the catalog does not list prints the answer's
// own monthly figure.
function PlanPrice({
  cadence,
  locale,
  amountUsd,
  fromCatalog,
}: {
  cadence: BillingCadence;
  locale: string;
  amountUsd: number;
  fromCatalog: boolean;
}) {
  const t = useTranslations('billing');
  const yearly = cadence === 'annual' && fromCatalog;
  return (
    <span className="font-serif text-2xl text-(--el-text)" data-testid="calculator-price">
      {yearly
        ? t('plans.annualSub', { yr: fmt(amountUsd, locale) })
        : t('plans.perMoEquiv', { n: fmt(amountUsd, locale) })}
    </span>
  );
}
