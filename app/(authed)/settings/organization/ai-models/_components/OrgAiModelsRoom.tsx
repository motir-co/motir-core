'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Info, Lock, RefreshCw, RotateCcw, Sparkles, TriangleAlert } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import { SettingsCard } from '@/components/settings/SettingsCard';
import type {
  OrgOfferedModelDTO,
  OrgPlannerFunctionDTO,
  OrgPlannerModelRowDTO,
  OrgPlannerModelsDTO,
  OrgRunModelKeyDTO,
  OrgRunModelRowDTO,
  OrgRunModelsDTO,
  OrgRunModelWriteDTO,
} from '@/lib/dto/orgAiModels';

// OrgAiModelsRoom (MOTIR-10846 · Story MOTIR-10838) — the organisation's AI models
// room, per `design/org-admin/org-admin--ai-models.mock.html` and
// `design/org-admin/design-notes.md` § *Settings › Organisation › AI models*.
//
// A client ISLAND over two route sets — `/api/organizations/[orgId]/ai-models/
// planning` (Planning, Guide, Debug, Ask) and `/ai-models/runs` (Review agent, the
// four agent-run levels, Design run) — built on `HostedAgentSettingsEditor`'s shape:
// read on mount (the loading and unavailable states ARE the reads), a sequence ref
// per read so an older answer never lands, staged vs committed values, an explicit
// Save, and the PATCH answers as the confirmation (never a `router.refresh()`).
//
// ⚠️ THE ROOM HAS NO PRECEDENCE OF ITS OWN. Every row's effective model and source
// is what its route answered, so the room cannot disagree with what a job or run
// uses. The only state it derives is which FACE to show, from the pair of answers,
// in one pure function (`combineRoom`): unreadable beats locked, which beats ready.
//
// ⚠️ THE LOCKED AND UNAVAILABLE FACES TAKE NO MODEL DATA. They are separate
// components whose props carry the org's name, its plan name and `keptChoices`
// only, so no future DTO field can leak a model id through them.

export type FnId =
  | OrgPlannerFunctionDTO
  | 'review'
  | 'trivial'
  | 'low'
  | 'medium'
  | 'high'
  | 'design';

type Side = 'planning' | 'runs';

const PLANNING_ROWS: readonly OrgPlannerFunctionDTO[] = ['planning', 'guide', 'debug', 'ask'];
const LEVEL_ROWS: readonly OrgRunModelKeyDTO[] = ['trivial', 'low', 'medium', 'high'];
const ALL_ROWS: readonly FnId[] = [...PLANNING_ROWS, 'review', ...LEVEL_ROWS, 'design'];

const sideOf = (id: FnId): Side =>
  (PLANNING_ROWS as readonly string[]).includes(id) ? 'planning' : 'runs';
const isLevel = (id: FnId) => (LEVEL_ROWS as readonly string[]).includes(id);

/** One side's read: in flight, failed (a non-OK answer or a network error), or answered. */
export type SideRead<T> =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'answered'; dto: T };

/** One row as the room shows it, from either route. */
export interface RoomRow {
  id: FnId;
  model: string | null;
  withdrawn: boolean;
  effectiveModel: string | null;
  /** The effective model is the organisation's own choice. */
  isOrg: boolean;
}

export type RoomState =
  | { face: 'loading' }
  | { face: 'unavailable' }
  | { face: 'locked'; keptChoices: boolean }
  | {
      face: 'ready';
      canEdit: boolean;
      rows: Record<FnId, RoomRow>;
      offered: Record<Side, OrgOfferedModelDTO[]>;
    };

function planningRow(row: OrgPlannerModelRowDTO): RoomRow {
  return {
    id: row.function,
    model: row.model,
    withdrawn: row.withdrawn,
    effectiveModel: row.effectiveModel,
    isOrg: row.effectiveSource === 'org',
  };
}

const ORG_RUN_SOURCES = new Set(['org_level', 'org_review', 'org_design']);
export function runRow(row: OrgRunModelRowDTO): RoomRow {
  return {
    id: row.key,
    model: row.model,
    withdrawn: row.withdrawn,
    effectiveModel: row.effectiveModel,
    isOrg: row.effectiveSource !== null && ORG_RUN_SOURCES.has(row.effectiveSource),
  };
}

/**
 * The pair of reads → the room's one face. Unreadable (or a failed read) beats
 * locked, which beats ready; a side still in flight with no failure is loading.
 * A split qualification (one side ready, the other locked) is locked: the two read
 * the same tier, so a split means it changed between the reads, and the face that
 * names no model is the safe one. A ready room may be edited only when both sides
 * say so.
 */
export function combineRoom(
  planning: SideRead<OrgPlannerModelsDTO>,
  runs: SideRead<OrgRunModelsDTO>,
): RoomState {
  const reads = [planning, runs];
  if (
    reads.some(
      (r) => r.state === 'failed' || (r.state === 'answered' && r.dto.state === 'unreadable'),
    )
  ) {
    return { face: 'unavailable' };
  }
  if (planning.state !== 'answered' || runs.state !== 'answered') return { face: 'loading' };
  const p = planning.dto;
  const r = runs.dto;
  if (p.state === 'locked' || r.state === 'locked') {
    const kept = [p, r].some((d) => d.state === 'locked' && d.keptChoices);
    return { face: 'locked', keptChoices: kept };
  }
  // Both are ready here: unreadable and locked were answered above.
  const readyP = p as Extract<OrgPlannerModelsDTO, { state: 'ready' }>;
  const readyR = r as Extract<OrgRunModelsDTO, { state: 'ready' }>;
  const rows = {} as Record<FnId, RoomRow>;
  for (const row of readyP.rows) rows[row.function] = planningRow(row);
  for (const row of readyR.rows) rows[row.key] = runRow(row);
  return {
    face: 'ready',
    canEdit: readyP.canEdit && readyR.canEdit,
    rows,
    offered: { planning: readyP.offered, runs: readyR.offered },
  };
}

export type Stored = Partial<Record<FnId, string | null>>;

/** The stored choices of a ready room's rows. */
export function storedOf(rows: Record<FnId, RoomRow>): Stored {
  const out: Stored = {};
  for (const id of ALL_ROWS) if (rows[id]) out[id] = rows[id].model;
  return out;
}

/** The rows whose staged value differs from what is stored, in the room's order. */
export function changedRows(
  committed: Stored,
  working: Stored,
): { id: FnId; model: string | null }[] {
  return ALL_ROWS.filter((id) => id in working && working[id] !== committed[id]).map((id) => ({
    id,
    model: working[id] ?? null,
  }));
}

/** Why a row's save was refused, as the row says it. */
type RowError =
  | { kind: 'notOffered'; model: string }
  | { kind: 'unreachable'; model: string }
  | { kind: 'failed' };

type SaveOutcome =
  | { id: FnId; ok: true; row?: OrgRunModelRowDTO }
  | { id: FnId; ok: false; code: string | null; model: string | null };

function withdrawnKey(
  editable: boolean,
  hasFallback: boolean,
): 'withdrawn.edit' | 'withdrawn.read' | 'withdrawn.editNoFallback' | 'withdrawn.readNoFallback' {
  if (editable) return hasFallback ? 'withdrawn.edit' : 'withdrawn.editNoFallback';
  return hasFallback ? 'withdrawn.read' : 'withdrawn.readNoFallback';
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await res.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function OrgAiModelsRoom({
  orgId,
  orgName,
  isMeta,
  planName,
}: {
  orgId: string;
  orgName: string;
  /** Motir's meta organisation: its subtitle says it chooses on any plan. Copy only. */
  isMeta: boolean;
  /** The org's plan name for the locked panel; null when it could not be read. */
  planName: string | null;
}) {
  const t = useTranslations('settings.organization.aiModels');
  const tl = useTranslations('labels');
  const { toast } = useToast();

  const base = `/api/organizations/${encodeURIComponent(orgId)}/ai-models`;
  const [planning, setPlanning] = useState<SideRead<OrgPlannerModelsDTO>>({ state: 'loading' });
  const [runs, setRuns] = useState<SideRead<OrgRunModelsDTO>>({ state: 'loading' });
  const [working, setWorking] = useState<Stored>({});
  const [errors, setErrors] = useState<Partial<Record<FnId, RowError>>>({});
  const [saving, setSaving] = useState(false);
  // A read resolving after a newer one of the same side never lands.
  const seq = useRef<Record<Side, number>>({ planning: 0, runs: 0 });

  const room = useMemo(() => combineRoom(planning, runs), [planning, runs]);
  const committed = useMemo(() => (room.face === 'ready' ? storedOf(room.rows) : {}), [room]);

  // Each read sets state only in its callbacks, so the mount effect can start it.
  const readSide = useCallback(
    (side: Side): Promise<void> => {
      const mine = ++seq.current[side];
      const set = side === 'planning' ? setPlanning : setRuns;
      const land = (read: SideRead<OrgPlannerModelsDTO & OrgRunModelsDTO>) => {
        if (mine !== seq.current[side]) return;
        set(read as never);
        if (read.state === 'answered' && read.dto.state === 'ready') {
          const fresh: Stored = {};
          const rows = read.dto.rows as (OrgPlannerModelRowDTO | OrgRunModelRowDTO)[];
          for (const row of rows) {
            fresh['function' in row ? row.function : row.key] = row.model;
          }
          setWorking((prev) => ({ ...prev, ...fresh }));
        }
      };
      return fetch(`${base}/${side}`, { headers: { accept: 'application/json' } })
        .then(async (res) => {
          const body = res.ok ? await readJson(res) : null;
          land(body ? { state: 'answered', dto: body as never } : { state: 'failed' });
        })
        .catch(() => land({ state: 'failed' }));
    },
    [base],
  );

  const readBoth = useCallback(() => {
    void readSide('planning');
    void readSide('runs');
  }, [readSide]);

  useEffect(() => {
    readBoth();
  }, [readBoth]);

  const retry = useCallback(() => {
    setPlanning({ state: 'loading' });
    setRuns({ state: 'loading' });
    setErrors({});
    readBoth();
  }, [readBoth]);

  const fnName = useCallback(
    (id: FnId) => (isLevel(id) ? tl(`difficulty.${id}`) : t(`fn.${id}.name` as never)),
    [t, tl],
  );

  const ready = room.face === 'ready' ? room : null;
  const editable = ready !== null && ready.canEdit;
  const changes = useMemo(
    () => (ready ? changedRows(committed, working) : []),
    [ready, committed, working],
  );
  const dirty = changes.length > 0;

  const choose = useCallback(
    (id: FnId, model: string) => {
      const row = ready?.rows[id];
      if (!row) return;
      // Picking the model the row inherits IS a clear: the organisation never
      // stores the model it inherits. That model is known only while the row
      // inherits (unset, or its stored choice withdrawn).
      const inherited = row.model === null || row.withdrawn ? row.effectiveModel : null;
      setErrors((prev) => ({ ...prev, [id]: undefined }));
      setWorking((prev) => ({ ...prev, [id]: model === inherited ? null : model }));
    },
    [ready],
  );

  const clear = useCallback((id: FnId) => {
    setErrors((prev) => ({ ...prev, [id]: undefined }));
    setWorking((prev) => ({ ...prev, [id]: null }));
  }, []);

  const cancel = useCallback(() => setWorking(committed), [committed]);

  const patchRow = useCallback(
    async (id: FnId, model: string | null): Promise<SaveOutcome> => {
      const side = sideOf(id);
      const body = side === 'planning' ? { function: id, model } : { key: id, model };
      try {
        const res = await fetch(`${base}/${side}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await readJson(res);
        if (res.ok) {
          return side === 'runs' && json && typeof json.row === 'object'
            ? { id, ok: true, row: (json as unknown as OrgRunModelWriteDTO).row }
            : { id, ok: true };
        }
        return {
          id,
          ok: false,
          code: typeof json?.code === 'string' ? json.code : null,
          model: typeof json?.model === 'string' ? json.model : model,
        };
      } catch {
        return { id, ok: false, code: null, model };
      }
    },
    [base],
  );

  const save = useCallback(async () => {
    if (!editable || !dirty || saving) return;
    setSaving(true);
    setErrors({});
    // One PATCH per changed row; each row's answer stands on its own, so rows that
    // saved stay saved when another is refused.
    const outcomes = await Promise.all(changes.map((c) => patchRow(c.id, c.model)));
    const nextErrors: Partial<Record<FnId, RowError>> = {};
    const reread = new Set<Side>();
    let notQualified = false;
    let unreadable = false;
    const savedRuns: OrgRunModelRowDTO[] = [];
    for (const o of outcomes) {
      if (o.ok) {
        // The run route answers the recomputed row; the planning route answers
        // previous → new only, so its side is re-read for the effective model.
        if (o.row) savedRuns.push(o.row);
        else reread.add(sideOf(o.id));
        continue;
      }
      if (o.code === 'ORG_MODEL_CHOICE_NOT_QUALIFIED') notQualified = true;
      else if (o.code === 'MODELS_UNREADABLE') unreadable = true;
      else if (o.code === 'MODEL_NOT_OFFERED' && o.model) {
        nextErrors[o.id] = { kind: 'notOffered', model: o.model };
        reread.add(sideOf(o.id)); // the list moved: read it again
      } else if (o.code === 'MODEL_UNREACHABLE' && o.model) {
        nextErrors[o.id] = { kind: 'unreachable', model: o.model };
      } else nextErrors[o.id] = { kind: 'failed' };
    }
    const savedAny = outcomes.some((o) => o.ok);

    // A refused row keeps its stored value; a saved one takes its new value.
    setWorking((prev) => {
      const next = { ...prev };
      for (const o of outcomes) {
        if (!o.ok) next[o.id] = committed[o.id] ?? null;
      }
      return next;
    });
    if (savedRuns.length > 0) {
      setRuns((prev) => {
        if (prev.state !== 'answered' || prev.dto.state !== 'ready') return prev;
        const byKey = new Map(savedRuns.map((row) => [row.key, row]));
        return {
          state: 'answered',
          dto: { ...prev.dto, rows: prev.dto.rows.map((row) => byKey.get(row.key) ?? row) },
        };
      });
    }

    if (notQualified) {
      // The tier changed under the room: read it again, which shows locked.
      setErrors({});
      readBoth();
    } else if (unreadable) {
      setErrors({});
      setPlanning({ state: 'failed' });
      setRuns({ state: 'failed' });
    } else {
      setErrors(nextErrors);
      await Promise.all([...reread].map((side) => readSide(side)));
    }
    setSaving(false);
    if (savedAny) {
      toast({
        variant: 'success',
        title: t('saved.title'),
        description: t('saved.description', { org: orgName }),
      });
    }
  }, [
    editable,
    dirty,
    saving,
    changes,
    patchRow,
    committed,
    readBoth,
    readSide,
    toast,
    t,
    orgName,
  ]);

  const options = useCallback(
    (side: Side, inherited: string | null): ComboboxOption<string>[] =>
      (ready?.offered[side] ?? []).map((m) => ({
        value: m.id,
        label: m.id,
        secondary: m.provider || undefined,
        ...(m.id === inherited ? { description: t('optionDefault') } : {}),
      })),
    [ready, t],
  );

  const providerOf = useCallback(
    (id: string) =>
      [...(ready?.offered.planning ?? []), ...(ready?.offered.runs ?? [])].find((m) => m.id === id)
        ?.provider ?? null,
    [ready],
  );

  const renderRow = (id: FnId) => {
    const name = fnName(id);
    const row = ready?.rows[id];
    if (room.face === 'loading' || !row) {
      return <LoadingRow key={id} id={id} name={name} desc={descOf(id)} />;
    }
    const value = id in working ? (working[id] ?? null) : row.model;
    const staged = value !== row.model;
    const inherited = row.model === null || row.withdrawn ? row.effectiveModel : null;
    // What the chooser shows: the effective model, never a blank. A staged
    // clear of a chosen row inherits a model this read does not name.
    const shown = staged ? (value ?? inherited) : row.effectiveModel;
    const isOrg = staged ? value !== null : row.isOrg;
    const error = errors[id];
    const placeholder =
      shown === null
        ? staged
          ? t('platformDefaultPending')
          : id === 'design'
            ? t('byDifficulty')
            : undefined
        : undefined;
    return (
      <li
        key={id}
        data-testid={`org-ai-models-row-${id}`}
        className="grid grid-cols-[minmax(0,13rem)_minmax(0,18rem)_minmax(0,1fr)] gap-x-4 gap-y-2 border-b border-(--el-border-soft) py-3"
      >
        <RowName name={name} desc={descOf(id)} indent={isLevel(id)} />
        <div className="min-w-0">
          {editable ? (
            <Combobox
              options={options(sideOf(id), inherited)}
              value={shown}
              onChange={(model) => choose(id, model)}
              label={t('modelFor', { function: name })}
              placeholder={placeholder}
              searchable={false}
              disabled={saving}
            />
          ) : (
            <div className="flex min-h-(--height-control) flex-col justify-center gap-0.5">
              {shown ? (
                <>
                  <span className="font-mono text-xs text-(--el-text)">{shown}</span>
                  {providerOf(shown) ? (
                    <span className="text-xs text-(--el-text-identifier)">{providerOf(shown)}</span>
                  ) : null}
                </>
              ) : (
                <span className="text-xs text-(--el-text)">{t('byDifficulty')}</span>
              )}
            </div>
          )}
        </div>
        <div className="flex min-h-(--height-control) flex-wrap items-center gap-2">
          {isOrg ? (
            <Pill
              className="border-transparent bg-(--el-tint-lavender) text-(--el-text-strong)"
              data-testid={`org-ai-models-source-${id}`}
            >
              {t('source.org')}
            </Pill>
          ) : (
            <Pill tone="neutral" data-testid={`org-ai-models-source-${id}`}>
              {t('source.inherits')}
            </Pill>
          )}
          {row.withdrawn && !staged ? (
            <Pill severity="warning" data-testid={`org-ai-models-withdrawn-chip-${id}`}>
              {t('withdrawnChip')}
            </Pill>
          ) : null}
          {staged ? (
            <span className="text-xs text-(--el-text-secondary)">{t('staged')}</span>
          ) : null}
          {editable && value !== null ? (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<RotateCcw className="size-[14px] text-(--el-icon-muted)" aria-hidden />}
              onClick={() => clear(id)}
              disabled={saving}
              aria-label={t('clearAria', { function: name })}
              data-testid={`org-ai-models-clear-${id}`}
            >
              {t('clear')}
            </Button>
          ) : null}
        </div>
        {row.withdrawn && row.model && !staged ? (
          <p
            role="note"
            data-testid={`org-ai-models-withdrawn-${id}`}
            className="col-span-full col-start-2 m-0 flex items-start gap-2 text-[12.5px] leading-normal text-(--el-text)"
          >
            <TriangleAlert
              className="mt-0.5 size-[13px] shrink-0 text-(--el-warning)"
              aria-hidden
            />
            <span>
              {t.rich(withdrawnKey(editable, row.effectiveModel !== null), {
                model: row.model,
                function: name,
                fallback: row.effectiveModel ?? '',
                id: (chunks) => <s className="font-mono text-(--el-text-secondary)">{chunks}</s>,
                mono: (chunks) => <span className="font-mono">{chunks}</span>,
              })}
            </span>
          </p>
        ) : null}
        {error ? (
          <p
            role="alert"
            data-testid={`org-ai-models-refused-${id}`}
            className="col-span-full col-start-2 m-0 text-xs text-(--el-danger-on-surface)"
          >
            {t.rich(`refused.${error.kind}`, {
              model: error.kind === 'failed' ? '' : error.model,
              function: name,
              mono: (chunks) => <span className="font-mono">{chunks}</span>,
            })}
          </p>
        ) : null}
      </li>
    );
  };

  function descOf(id: FnId): string | null {
    return isLevel(id) ? null : t(`fn.${id}.desc` as never);
  }

  const showRows = room.face === 'loading' || room.face === 'ready';

  return (
    <div data-testid="org-ai-models" className="mx-auto flex max-w-[64rem] flex-col gap-6">
      <div className="flex flex-col gap-2">
        <p className="font-sans text-xs tracking-wide text-(--el-text-secondary) uppercase">
          {t('breadcrumb', { org: orgName })}
        </p>
        <h1 className="font-serif text-3xl text-(--el-text)">{t('title')}</h1>
        <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">
          {t('lead', { org: orgName })}
        </p>
      </div>
      <div aria-busy={room.face === 'loading'}>
        <SettingsCard
          testId="org-ai-models-card"
          icon={<Sparkles className="size-[17px]" aria-hidden />}
          title={t('card.title')}
          subtitle={isMeta ? t('card.subtitleMeta', { org: orgName }) : t('card.subtitle')}
          footer={
            editable ? (
              <div className="flex items-center justify-end gap-2.5 border-t border-(--el-border-soft) bg-(--el-surface-soft) px-(--spacing-card-padding) py-3.5">
                <span
                  className="mr-auto text-xs text-(--el-text-secondary)"
                  data-testid="org-ai-models-footer-hint"
                >
                  {dirty ? t('footer.dirtyHint') : null}
                </span>
                <Button variant="secondary" onClick={cancel} disabled={!dirty || saving}>
                  {t('footer.cancel')}
                </Button>
                <Button
                  variant="primary"
                  onClick={() => void save()}
                  loading={saving}
                  disabled={!dirty || saving}
                  data-testid="org-ai-models-save"
                >
                  {t('footer.save')}
                </Button>
              </div>
            ) : null
          }
        >
          {ready && !ready.canEdit ? (
            <Callout
              tint="plain"
              role="note"
              icon={<Lock className="size-[15px]" aria-hidden />}
              testId="org-ai-models-read-only"
            >
              {t('readOnly', { org: orgName })}
            </Callout>
          ) : null}
          {room.face === 'unavailable' ? <UnavailableCard onRetry={retry} /> : null}
          {room.face === 'locked' ? (
            <LockedPanel orgName={orgName} planName={planName} keptChoices={room.keptChoices} />
          ) : null}
          {showRows ? (
            <>
              <div className="flex flex-col">
                <GroupHead title={t('group.planning.title')} list={t('group.planning.list')} />
                <ul className="m-0 flex list-none flex-col p-0">{PLANNING_ROWS.map(renderRow)}</ul>
              </div>
              <div className="flex flex-col">
                <GroupHead title={t('group.runs.title')} list={t('group.runs.list')} />
                <ul className="m-0 flex list-none flex-col p-0">
                  {renderRow('review')}
                  <li
                    data-testid="org-ai-models-agent-run"
                    className="flex flex-col gap-0.5 border-b border-(--el-border-soft) pt-3 pb-1"
                  >
                    <span className="text-sm font-medium text-(--el-text)">
                      {t('agentRun.name')}
                    </span>
                    <span className="text-xs text-(--el-text-secondary)">{t('agentRun.desc')}</span>
                  </li>
                  {LEVEL_ROWS.map(renderRow)}
                  {renderRow('design')}
                </ul>
              </div>
              {ready ? (
                <Callout
                  tint="plain"
                  icon={<Info className="size-[15px]" aria-hidden />}
                  testId="org-ai-models-precedence"
                >
                  <span className="block">
                    {t.rich('precedence.body', {
                      org: orgName,
                      b: (chunks) => <b className="font-semibold text-(--el-text)">{chunks}</b>,
                    })}
                  </span>
                  <span className="mt-1 block">{t('precedence.cost', { org: orgName })}</span>
                </Callout>
              ) : null}
            </>
          ) : null}
        </SettingsCard>
      </div>
    </div>
  );
}

function RowName({ name, desc, indent }: { name: string; desc: string | null; indent: boolean }) {
  return (
    <div
      className={`flex min-h-(--height-control) flex-col justify-center gap-0.5 ${indent ? 'pl-4' : ''}`}
    >
      <span className="text-sm font-medium text-(--el-text)">{name}</span>
      {desc ? <span className="text-xs text-(--el-text-secondary)">{desc}</span> : null}
    </div>
  );
}

/** A row in the read's loading face: the picker's own loading face and a bar. */
function LoadingRow({ id, name, desc }: { id: FnId; name: string; desc: string | null }) {
  const t = useTranslations('settings.organization.aiModels');
  return (
    <li
      data-testid={`org-ai-models-row-${id}`}
      className="grid grid-cols-[minmax(0,13rem)_minmax(0,18rem)_minmax(0,1fr)] gap-x-4 gap-y-2 border-b border-(--el-border-soft) py-3"
    >
      <RowName name={name} desc={desc} indent={isLevel(id)} />
      <div className="min-w-0">
        <Combobox
          options={[]}
          value={null}
          onChange={() => undefined}
          label={t('modelFor', { function: name })}
          placeholder={t('loadingTrigger')}
          searchable={false}
          disabled
        />
      </div>
      <div className="flex min-h-(--height-control) items-center">
        <span
          aria-hidden
          data-testid={`org-ai-models-skeleton-${id}`}
          className="block h-5 w-28 rounded-(--radius-badge) bg-(--el-muted)"
        />
      </div>
    </li>
  );
}

function GroupHead({ title, list }: { title: string; list: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-(--el-border) pt-1 pb-2">
      <span className="font-mono text-[11px] font-semibold tracking-[0.06em] text-(--el-text-eyebrow) uppercase">
        {title}
      </span>
      <span className="text-xs text-(--el-text-secondary)">{list}</span>
    </div>
  );
}

/** The locked face. Takes NO model data — it cannot print a model id. */
function LockedPanel({
  orgName,
  planName,
  keptChoices,
}: {
  orgName: string;
  planName: string | null;
  keptChoices: boolean;
}) {
  const t = useTranslations('settings.organization.aiModels.locked');
  return (
    <div
      data-testid="org-ai-models-locked"
      className="flex flex-col items-start gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface) px-(--spacing-card-padding-16) py-(--spacing-card-padding-16)"
    >
      <span
        aria-hidden
        className="flex h-(--height-control-32) w-8 items-center justify-center rounded-(--radius-control) bg-(--el-tint-lavender) text-(--el-text-strong)"
      >
        <Lock className="h-4 w-4" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-(--el-text)">{t('title')}</p>
        <p className="max-w-[58ch] text-xs text-(--el-text-secondary)">
          {planName
            ? t('body', { org: orgName, plan: planName })
            : t('bodyNoPlan', { org: orgName })}
        </p>
        {keptChoices ? (
          <p
            data-testid="org-ai-models-not-applying"
            className="max-w-[58ch] text-xs text-(--el-text-strong)"
          >
            {t('notApplying', { org: orgName })}
          </p>
        ) : null}
      </div>
      <Link
        href="/settings/organization/billing"
        className={buttonVariants({ variant: 'secondary', size: 'sm' })}
      >
        {t('seePlans')}
      </Link>
    </div>
  );
}

/** The unavailable face. Takes NO model data — it cannot print a model id. */
function UnavailableCard({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('settings.organization.aiModels.unavailable');
  return (
    <Callout
      tint="peach"
      role="status"
      icon={<TriangleAlert className="size-[15px]" aria-hidden />}
      testId="org-ai-models-unavailable"
    >
      <span className="block">{t('body')}</span>
      <Button
        variant="secondary"
        size="sm"
        className="mt-2"
        leftIcon={<RefreshCw className="size-[13px]" aria-hidden />}
        onClick={onRetry}
        data-testid="org-ai-models-retry"
      >
        {t('retry')}
      </Button>
    </Callout>
  );
}

/** The Hosted agent room's callout, its two tints. */
function Callout({
  tint,
  icon,
  children,
  testId,
  role,
}: {
  tint: 'peach' | 'plain';
  icon: ReactNode;
  children: ReactNode;
  testId?: string;
  role?: 'status' | 'note';
}) {
  const surface =
    tint === 'peach'
      ? 'bg-(--el-tint-peach) border-(--el-border-soft) text-(--el-text-strong)'
      : 'bg-(--el-surface) border-(--el-border) text-(--el-text-secondary)';
  const iconTone = tint === 'peach' ? 'text-(--el-warning)' : 'text-(--el-icon-muted)';
  return (
    <div
      data-testid={testId}
      {...(role ? { role } : {})}
      className={`flex gap-2.5 rounded-(--radius-card) border px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) text-xs leading-relaxed ${surface}`}
    >
      <span className={`mt-px shrink-0 ${iconTone}`}>{icon}</span>
      <span>{children}</span>
    </div>
  );
}
