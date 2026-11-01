'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { Check, ChevronDown, Cloud, Layers, Minus, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Pill } from '@/components/ui/Pill';
import type {
  ProjectRepoDto,
  ProjectRepoRoomSeedDto,
  ProjectRepoSeedRefusalDto,
} from '@/lib/dto/projectRepos';
import type { SeedRegistryEntryDto } from '@/lib/dto/seedRegistry';
import { seedWhy, type SeedFact } from '@/lib/seedRegistry/seedWhy';
import { SEED_SOURCE_INITIALISED } from '@/lib/projectRepos/vocabulary';

// THE SEED ON A ROOM ROW (Story MOTIR-704 · MOTIR-712) — design MOTIR-705,
// `design/starter-library/repositories-room--seed.mock.html` §1. Three pieces,
// one per thing the row says about its starter:
//
//   · `SeedPills` — the STARTER pill (lavender) and the HOSTING-TARGET pill
//     (sky) after the row's state, and a DEFAULT pill beside the starter when
//     the matching fell back, so a default never reads as a match (§1.1);
//   · `WhyThisStarter` — the inset a not-yet-created row shows (§1.2);
//   · `StarterPicker` — the labelled Combobox that re-points it, offering only
//     what `patchRow` accepts, with a refused re-point's alert under it (§1.3–4).
//
// One composition, used by `TakeoverRow` for every Motir-created row, so the seed
// is drawn in ONE place rather than scattered across the row's states.

/** The `seedMatch` values that are defaults rather than matches (§1.1). */
const DEFAULT_MATCHES: ReadonlySet<string> = new Set(['no_stack_signal', 'no_target', 'no_match']);

/** The role the hosting port deploys; only its rows say "No hosting target". */
const DEPLOYED_ROLE = 'web';

const ICON = 'size-3.5 shrink-0';

/** A refused re-point as the room holds it: the route's typed `refusal`, the
 *  entry the person picked, and the server's sentence as the fallback copy. */
export interface SeedRefusalState {
  refusal: ProjectRepoSeedRefusalDto | null;
  picked: SeedRegistryEntryDto | null;
  message: string;
}

/**
 * The entry a row currently names. The room's seed was read on the server; after
 * a re-point the row's `seedSource` moves before the next server render, so the
 * picked option — which the person chose from `options` — answers in between.
 */
export function currentSeedEntry(
  row: Pick<ProjectRepoDto, 'seedSource'>,
  seed: ProjectRepoRoomSeedDto,
): SeedRegistryEntryDto | null {
  const names = (entry: SeedRegistryEntryDto) =>
    entry.key === row.seedSource || entry.legacyKeys.includes(row.seedSource);
  if (seed.entry && names(seed.entry)) return seed.entry;
  return seed.options?.find(names) ?? null;
}

export function SeedPills({
  row,
  entry,
}: {
  row: ProjectRepoDto;
  entry: SeedRegistryEntryDto | null;
}) {
  const t = useTranslations('repositorySet.seed');
  const label = entry?.label ?? row.seedSource;
  return (
    <>
      <Pill
        aria-label={t('starterPillLabel', { label })}
        className="gap-1 border-transparent bg-(--el-tint-lavender) text-(--el-text-strong)"
      >
        <Layers className={ICON} aria-hidden="true" />
        {label}
      </Pill>
      {row.seedMatch !== null && DEFAULT_MATCHES.has(row.seedMatch) ? (
        <Pill className="border-transparent bg-(--el-tint-yellow) text-(--el-text-strong)">
          {t('default')}
        </Pill>
      ) : null}
      {row.hostingTarget !== null ? (
        <Pill
          aria-label={t('targetPillLabel', { target: t(`target.${row.hostingTarget}`) })}
          className="gap-1 border-transparent bg-(--el-tint-sky) text-(--el-text-strong)"
        >
          <Cloud className={ICON} aria-hidden="true" />
          {t(`target.${row.hostingTarget}`)}
        </Pill>
      ) : row.role === DEPLOYED_ROLE ? (
        <Pill tone="neutral">{t('noTarget')}</Pill>
      ) : null}
    </>
  );
}

/** Design §1.2: one sentence, then the facts the matching read. */
export function WhyThisStarter({
  row,
  entry,
}: {
  row: ProjectRepoDto;
  entry: SeedRegistryEntryDto;
}) {
  const t = useTranslations('repositorySet.seed');
  const why = seedWhy(row, entry);
  const b = (chunks: ReactNode) => <b className="font-semibold">{chunks}</b>;
  const target = row.hostingTarget !== null ? t(`target.${row.hostingTarget}`) : '';
  const values = {
    target,
    use: row.hostingUseCase ?? 'none',
    size: row.hostingSize ?? 'none',
    role: row.role,
    where: row.hostingTarget !== null ? 'target' : 'stack',
    b,
  };
  return (
    <div
      data-testid={`seed-why-${row.id}`}
      data-why={why.kind}
      className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) px-(--spacing-card-padding-16) py-(--spacing-card-padding-12)"
    >
      <p className="min-w-0 text-sm leading-relaxed text-(--el-text)">
        {t.rich(`why.${whyMessage(why.kind, row)}`, values)}
      </p>
      <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1.5 p-0">
        {why.facts.map((fact) => (
          <FactItem key={fact.name} fact={fact} role={row.role} />
        ))}
      </ul>
    </div>
  );
}

/** The message key for a kind; `matched` splits on whether the row names a use. */
function whyMessage(kind: ReturnType<typeof seedWhy>['kind'], row: ProjectRepoDto): string {
  if (kind === 'matched') return row.hostingUseCase === null ? 'matchedTarget' : 'matched';
  return {
    soft_use: 'softUse',
    soft_size: 'softSize',
    not_deployed: 'notDeployed',
    no_stack_signal: 'noStackSignal',
    no_target: 'noTarget',
    no_match: 'noMatch',
    by_hand: 'byHand',
  }[kind];
}

function FactItem({ fact, role }: { fact: SeedFact; role: string }) {
  const t = useTranslations('repositorySet.seed');
  const value =
    fact.value === null
      ? t(`fact.${fact.empty ?? 'not_set'}`)
      : fact.name === 'stack'
        ? fact.value
        : t(`${fact.name === 'hosting' ? 'target' : fact.name}.${fact.value}`);
  return (
    <li
      data-fact={fact.name}
      data-state={fact.state}
      className="inline-flex items-center gap-1.5 text-[13px] text-(--el-text-secondary)"
    >
      {fact.state === 'hit' ? (
        <Check className={`${ICON} text-(--el-success)`} aria-hidden="true" />
      ) : (
        <Minus className={`${ICON} text-(--el-icon-muted)`} aria-hidden="true" />
      )}
      <span>
        {t(`fact.${fact.name}`)} <b className="font-semibold text-(--el-text)">{value}</b>
        {fact.note === 'not_served' ? ` ${t('fact.notServed')}` : null}
        {fact.note === 'no_role_starter' ? ` ${t('fact.noRoleStarter', { role })}` : null}
      </span>
    </li>
  );
}

/** Design §1.3–1.4: the Starter picker and, under it, a refused re-point. */
export function StarterPicker({
  row,
  entry,
  options,
  busy,
  refusal,
  onPick,
}: {
  row: ProjectRepoDto;
  entry: SeedRegistryEntryDto | null;
  options: SeedRegistryEntryDto[];
  busy: boolean;
  refusal: SeedRefusalState | null;
  onPick: (row: ProjectRepoDto, entry: SeedRegistryEntryDto) => void;
}) {
  const t = useTranslations('repositorySet.seed');
  const format = useFormatter();
  const target = row.hostingTarget !== null ? t(`target.${row.hostingTarget}`) : null;
  const list = (items: string[]) => format.list(items, { type: 'unit', style: 'short' });
  const serves = (option: SeedRegistryEntryDto) =>
    [
      ...(target === null && option.hostingTargets.length > 0
        ? [list(option.hostingTargets.map((v) => t(`target.${v}`)))]
        : []),
      list(option.useCases.map((v) => t(`use.${v}`))),
      list(option.sizes.map((v) => t(`size.${v}`))),
    ]
      .filter(Boolean)
      .join(' · ');

  const comboOptions: ComboboxOption<string>[] = options.map((option) => {
    const initialised = option.key === SEED_SOURCE_INITIALISED;
    return {
      value: option.key,
      label: option.label,
      description: initialised ? t('picker.initialisedSub') : serves(option),
      group: initialised
        ? t('picker.groupAny')
        : target !== null
          ? t('picker.groupTarget', { role: row.role, target })
          : t('picker.groupRole', { role: row.role }),
    };
  });
  const id = `starter-${row.id}`;

  return (
    <div className="flex max-w-[420px] flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-(--el-text)">
        {t('picker.label')}
      </label>
      <Combobox
        id={id}
        label={t('picker.label')}
        options={comboOptions}
        value={entry?.key ?? row.seedSource}
        disabled={busy}
        busy={busy}
        triggerIcon={<ChevronDown className="size-4" aria-hidden="true" />}
        onChange={(key) => {
          const picked = options.find((option) => option.key === key);
          if (picked && picked.key !== entry?.key) onPick(row, picked);
        }}
        footer={
          <p className="text-xs text-(--el-text-secondary)">
            {target !== null
              ? t('picker.footerTarget', { role: row.role, target })
              : t('picker.footerNoTarget', { role: row.role })}
          </p>
        }
      />
      {refusal ? <SeedRefusalAlert row={row} refusal={refusal} /> : null}
    </div>
  );
}

/** Design §1.4: the route's typed refusal, in the person's words. The server's
 *  English sentence is the fallback for a refusal the room has no copy for. */
function SeedRefusalAlert({ row, refusal }: { row: ProjectRepoDto; refusal: SeedRefusalState }) {
  const t = useTranslations('repositorySet.seed');
  const format = useFormatter();
  const b = (chunks: ReactNode) => (
    <b className="font-semibold text-(--el-text-strong)">{chunks}</b>
  );
  const label = refusal.picked?.label ?? '';
  const targets = format.list(
    (refusal.picked?.hostingTargets ?? []).map((v) => t(`target.${v}`)),
    { type: 'conjunction' },
  );
  let body: ReactNode = refusal.message;
  switch (refusal.refusal) {
    case 'target_mismatch':
      body =
        row.hostingTarget !== null
          ? t.rich('refusal.targetMismatch', {
              label,
              targets,
              target: t(`target.${row.hostingTarget}`),
              b,
            })
          : t.rich('refusal.targetMismatchNoTarget', { label, targets, b });
      break;
    case 'retired':
      body = t.rich('refusal.retired', { label, b });
      break;
    case 'role_mismatch':
      body = t.rich('refusal.roleMismatch', {
        label,
        entryRole: refusal.picked?.role ?? '',
        role: row.role,
        b,
      });
      break;
    case 'not_editable':
      body = t.rich('refusal.notEditable', { b });
      break;
    case 'unknown':
      body = t.rich('refusal.unknown', { b });
      break;
  }
  return (
    <div
      role="alert"
      data-refusal={refusal.refusal ?? 'other'}
      className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-danger) bg-(--el-danger-surface) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) text-sm text-(--el-danger-surface-text)"
    >
      <TriangleAlert
        className="mt-0.5 size-4 shrink-0 text-(--el-danger-on-surface)"
        aria-hidden="true"
      />
      <span className="min-w-0">{body}</span>
    </div>
  );
}
