'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Cloud, Info, Lock, RefreshCw, RotateCcw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Combobox } from '@/components/ui/Combobox';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { WORK_ITEM_DIFFICULTIES } from '@/lib/issues/difficulty';
import { resolveHostedModel, type HostedModelOffer } from '@/lib/hosted/resolveHostedModel';
import type { WorkItemDifficultyDto } from '@/lib/dto/workItems';
import type { ProjectHostedAgentSettingsDto } from '@/lib/dto/projectHostedAgentSettings';

// HostedAgentSettingsEditor (Story MOTIR-6989 · MOTIR-6995) — the Hosted agent
// settings room, per `design/settings/hosted-agent.mock.html` and
// `design/settings/design-notes.md` § Hosted agent room (MOTIR-6991).
//
// A client ISLAND over `GET / PATCH /api/projects/[key]/hosted-agent-settings`
// (MOTIR-6993). It reads on mount rather than being seeded by the server, because
// the room's loading and unavailable states ARE the read: the offered list and
// the platform defaults are motir-ai's, read fresh on every call, and *Try again*
// re-asks without re-running the page.
//
// One row per difficulty, easiest first. Each row shows the EFFECTIVE model — the
// select never shows a model a run would not use — and its source, computed by
// `resolveHostedModel`, the one rule the start path and the Run hosted picker
// also call. Picking a row's own platform default IS a reset (no override is
// stored), so *Override* always means "different from the default".
//
// The Save is explicit (the AI planning room's footer): changes are staged,
// *Save changes* PATCHes only the levels that differ, and the response IS the
// confirmation — it replaces the committed state in place, never a
// `router.refresh()` (CLAUDE.md § page state, case 1).
//
// Colour strictly `--el-*`; shape through the element tokens. Every text ink on a
// non-white surface is `--el-text-secondary` / `--el-text-identifier` /
// `--el-text-strong` (design § Contrast).

type Level = WorkItemDifficultyDto;
type Overrides = Record<Level, string | null>;

type Load =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'ready'; dto: ProjectHostedAgentSettingsDto };

/** The DTO's stored overrides, keyed by level. */
export function overridesOf(dto: ProjectHostedAgentSettingsDto): Overrides {
  const out = { trivial: null, low: null, medium: null, high: null } as Overrides;
  for (const row of dto.levels) out[row.level] = row.override;
  return out;
}

/** The DTO → the offer `resolveHostedModel` reads (motir-ai's single default is
 *  recovered from the no-difficulty answer, which resolves to it when offered). */
export function offerOf(dto: ProjectHostedAgentSettingsDto): HostedModelOffer {
  const defaultsByDifficulty = { trivial: null, low: null, medium: null, high: null } as Overrides;
  for (const row of dto.levels) defaultsByDifficulty[row.level] = row.platformDefault;
  return {
    models: dto.offeredModels,
    default: dto.noDifficulty.source === 'platform_default' ? dto.noDifficulty.effective : null,
    defaultsByDifficulty,
    // The room resolves non-design leaves only, so neither run-side default applies.
    reviewAgentDefault: null,
    designRunDefault: null,
  };
}

/** What one row shows for a working set of overrides. Exported for the test. */
export function rowView(dto: ProjectHostedAgentSettingsDto, overrides: Overrides, level: Level) {
  const offer = offerOf(dto);
  const override = overrides[level];
  // `platformDefault` already folds in the organisation's choice (MOTIR-10843), so
  // the org layer is not passed a second time.
  const resolved = resolveHostedModel({
    difficulty: level,
    overrides,
    offered: offer,
    org: null,
    design: false,
  });
  return {
    effective: resolved?.model ?? null,
    isOverride: resolved?.source === 'override',
    /** A stored override exists (offered or withdrawn) — Reset is offered. */
    hasOverride: override !== null,
    /** The stored override is no longer offered. */
    withdrawn: override !== null && !offer.models.includes(override),
    override,
    platformDefault: offer.defaultsByDifficulty[level],
  };
}

function sameOverrides(a: Overrides, b: Overrides): boolean {
  return WORK_ITEM_DIFFICULTIES.every((level) => a[level] === b[level]);
}

export function HostedAgentSettingsEditor({
  projectKey,
  canConfigure,
}: {
  projectKey: string;
  /** Whether the actor holds the room's WRITE key (`ai:configure`), read off the
   *  registry entry by the page. Without it the room is read-only (panel 5). */
  canConfigure: boolean;
}) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const tl = useTranslations('labels');
  const tp = useTranslations('runs.hosted.picker');
  const { toast } = useToast();

  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [committed, setCommitted] = useState<Overrides | null>(null);
  const [working, setWorking] = useState<Overrides | null>(null);
  const [saving, setSaving] = useState(false);
  // A read resolving after a newer one (Try again pressed twice) never lands.
  const readSeq = useRef(0);

  // The read itself. It sets state only in its callbacks, so the mount effect
  // below can start it; `retry` shows the loading face first.
  const read = useCallback(() => {
    const seq = ++readSeq.current;
    void fetch(`/api/projects/${encodeURIComponent(projectKey)}/hosted-agent-settings`, {
      headers: { accept: 'application/json' },
    })
      .then(async (res) => {
        if (seq !== readSeq.current) return;
        if (!res.ok) {
          setLoad({ state: 'unavailable' });
          return;
        }
        const dto = (await res.json()) as ProjectHostedAgentSettingsDto;
        if (seq !== readSeq.current) return;
        const stored = overridesOf(dto);
        setCommitted(stored);
        setWorking(stored);
        setLoad({ state: 'ready', dto });
      })
      .catch(() => {
        if (seq === readSeq.current) setLoad({ state: 'unavailable' });
      });
  }, [projectKey]);

  useEffect(() => {
    read();
  }, [read]);

  const retry = useCallback(() => {
    setLoad({ state: 'loading' });
    read();
  }, [read]);

  const levelLabel = useCallback((level: Level) => tl(`difficulty.${level}`), [tl]);

  const dto = load.state === 'ready' ? load.dto : null;
  const empty = dto !== null && dto.offeredModels.length === 0;
  const editable = dto !== null && !empty && canConfigure;
  const dirty = committed !== null && working !== null && !sameOverrides(working, committed);

  const choose = useCallback(
    (level: Level, model: string) => {
      if (!dto) return;
      const platformDefault = offerOf(dto).defaultsByDifficulty[level];
      // Picking the row's own platform default IS a reset: an override never
      // names the model it overrides.
      setWorking((prev) =>
        prev ? { ...prev, [level]: model === platformDefault ? null : model } : prev,
      );
    },
    [dto],
  );

  const reset = useCallback((level: Level) => {
    setWorking((prev) => (prev ? { ...prev, [level]: null } : prev));
  }, []);

  const cancel = useCallback(() => setWorking(committed), [committed]);

  const save = useCallback(() => {
    if (!editable || !committed || !working || !dirty || saving) return;
    const prev = committed;
    const next = working;
    const patch: Partial<Overrides> = {};
    for (const level of WORK_ITEM_DIFFICULTIES) {
      if (next[level] !== prev[level]) patch[level] = next[level];
    }
    // Optimistic: the committed snapshot flips now and reverts on a failure.
    setCommitted(next);
    setSaving(true);
    const failed = () => {
      setCommitted(prev);
      setSaving(false);
      toast({
        variant: 'error',
        title: t('hostedAgent.errorTitle'),
        description: t('hostedAgent.saveError'),
      });
    };
    void fetch(`/api/projects/${encodeURIComponent(projectKey)}/hosted-agent-settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(patch),
    })
      .then(async (res) => {
        if (!res.ok) {
          failed();
          return;
        }
        // The response IS the confirmation, and the authoritative state: apply it
        // in place (never a refresh — the cells keep their value).
        const saved = (await res.json()) as ProjectHostedAgentSettingsDto;
        const stored = overridesOf(saved);
        setCommitted(stored);
        setWorking(stored);
        setLoad({ state: 'ready', dto: saved });
        setSaving(false);
        toast({
          variant: 'success',
          title: t('hostedAgent.savedTitle'),
          description: t('hostedAgent.savedDesc'),
        });
      })
      .catch(failed);
  }, [editable, committed, working, dirty, saving, projectKey, t, toast]);

  const options = useMemo(() => {
    if (!dto) return [];
    return dto.offered.map((m) => ({
      value: m.id,
      label: m.id,
      secondary: m.provider || undefined,
    }));
  }, [dto]);

  const placeholder =
    load.state === 'loading'
      ? tp('loadingTrigger')
      : load.state === 'unavailable'
        ? tp('unavailableTrigger')
        : empty
          ? tp('emptyTrigger')
          : undefined;

  return (
    <SettingsCard
      testId="hosted-agent-settings"
      icon={<Cloud className="size-[17px]" aria-hidden />}
      title={t('hostedAgent.card.title')}
      subtitle={t('hostedAgent.card.subtitle')}
      footer={
        editable ? (
          <div className="bg-(--el-surface-soft) border-(--el-border-soft) flex items-center justify-end gap-2.5 border-t px-(--spacing-card-padding) py-3.5">
            <span
              className="text-(--el-text-secondary) mr-auto text-xs"
              data-testid="hosted-agent-footer-hint"
            >
              {dirty ? t('aiPlanning.footer.dirtyHint') : null}
            </span>
            <Button variant="secondary" onClick={cancel} disabled={!dirty || saving}>
              {tc('cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={save}
              loading={saving}
              disabled={!dirty || saving}
              data-testid="hosted-agent-save"
            >
              {t('aiPlanning.footer.save')}
            </Button>
          </div>
        ) : null
      }
    >
      {!canConfigure ? (
        <Callout
          tint="plain"
          icon={<Lock className="size-[15px]" aria-hidden />}
          testId="hosted-agent-readonly-banner"
        >
          {t('hostedAgent.readOnlyBanner')}
        </Callout>
      ) : null}

      {load.state === 'unavailable' ? (
        <Callout
          tint="peach"
          role="status"
          icon={<TriangleAlert className="size-[15px]" aria-hidden />}
          testId="hosted-agent-unavailable"
        >
          <span className="block">{t('hostedAgent.unavailableBody')}</span>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            leftIcon={<RefreshCw className="size-[13px]" aria-hidden />}
            onClick={retry}
            data-testid="hosted-agent-retry"
          >
            {tp('retry')}
          </Button>
        </Callout>
      ) : null}

      {empty ? (
        <Callout
          tint="plain"
          role="status"
          icon={<Info className="size-[15px]" aria-hidden />}
          testId="hosted-agent-empty"
        >
          {t('hostedAgent.emptyBody')}
        </Callout>
      ) : null}

      <div className="@container">
        <div
          className="text-(--el-text-eyebrow) border-(--el-border) hidden grid-cols-[6.5rem_minmax(0,18rem)_minmax(0,1fr)] gap-x-4 border-b pb-2 font-mono text-[11px] font-semibold tracking-[0.06em] uppercase @lg:grid"
          aria-hidden
        >
          <span>{t('hostedAgent.col.difficulty')}</span>
          <span>{t('hostedAgent.col.model')}</span>
          <span>{t('hostedAgent.col.source')}</span>
        </div>
        <ul className="m-0 flex list-none flex-col p-0">
          {WORK_ITEM_DIFFICULTIES.map((level) => {
            const view = dto && !empty && working ? rowView(dto, working, level) : null;
            const difficulty = levelLabel(level);
            return (
              <li
                key={level}
                data-testid={`hosted-agent-row-${level}`}
                className="border-(--el-border-soft) grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 border-b py-3 [grid-template-areas:'diff_src'_'cbx_cbx'] @lg:grid-cols-[6.5rem_minmax(0,18rem)_minmax(0,1fr)] @lg:[grid-template-areas:'diff_cbx_src']"
              >
                <span className="flex min-h-(--height-control) items-center text-sm font-medium text-(--el-text) [grid-area:diff]">
                  {difficulty}
                </span>
                <div className="min-w-0 [grid-area:cbx]">
                  <Combobox
                    options={
                      view
                        ? options.map((o) =>
                            o.value === view.platformDefault
                              ? {
                                  ...o,
                                  description: t('hostedAgent.optionDefault', { difficulty }),
                                }
                              : o,
                          )
                        : []
                    }
                    value={view?.effective ?? null}
                    onChange={(model) => choose(level, model)}
                    label={t('hostedAgent.modelFor', { difficulty })}
                    placeholder={placeholder}
                    searchable={false}
                    disabled={!editable || saving}
                  />
                </div>
                <div className="flex min-h-(--height-control) flex-wrap items-center justify-end gap-2 [grid-area:src] @lg:justify-start">
                  {load.state === 'loading' ? (
                    <span
                      className="bg-(--el-muted) block h-5 w-24 rounded-(--radius-badge)"
                      aria-hidden
                      data-testid={`hosted-agent-skeleton-${level}`}
                    />
                  ) : view ? (
                    <>
                      {view.isOverride ? (
                        <Pill
                          className="border-transparent bg-(--el-tint-lavender) text-(--el-text-strong)"
                          data-testid={`hosted-agent-source-${level}`}
                        >
                          {t('hostedAgent.source.override')}
                        </Pill>
                      ) : (
                        <Pill tone="neutral" data-testid={`hosted-agent-source-${level}`}>
                          {t('hostedAgent.source.default')}
                        </Pill>
                      )}
                      {editable && view.hasOverride ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          leftIcon={
                            <RotateCcw className="size-[14px] text-(--el-icon-muted)" aria-hidden />
                          }
                          onClick={() => reset(level)}
                          disabled={saving}
                          data-testid={`hosted-agent-reset-${level}`}
                        >
                          {t('hostedAgent.reset')}
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                </div>
                {view?.withdrawn && view.override ? (
                  <p
                    role="note"
                    data-testid={`hosted-agent-withdrawn-${level}`}
                    className="col-span-full m-0 flex items-start gap-2 text-[12.5px] leading-normal text-(--el-text) @lg:col-start-2"
                  >
                    <TriangleAlert
                      className="mt-0.5 size-[13px] shrink-0 text-(--el-warning)"
                      aria-hidden
                    />
                    <span>
                      {t.rich('hostedAgent.withdrawn', {
                        model: view.override,
                        difficulty,
                        id: (chunks) => (
                          <s className="font-mono text-(--el-text-secondary)">{chunks}</s>
                        ),
                      })}
                    </span>
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>

      {dto && !empty && dto.noDifficulty.effective ? (
        <Callout
          tint="plain"
          icon={<Info className="size-[15px]" aria-hidden />}
          testId="hosted-agent-no-difficulty"
        >
          {t.rich('hostedAgent.noDifficulty', {
            model: dto.noDifficulty.effective,
            id: (chunks) => <MonoId>{chunks}</MonoId>,
            b: (chunks) => <strong className="font-semibold">{chunks}</strong>,
          })}
        </Callout>
      ) : null}
    </SettingsCard>
  );
}

function MonoId({ children }: { children: ReactNode }) {
  return <span className="font-mono text-(--el-text-identifier)">{children}</span>;
}

// ── Callout — the AI planning room's box, two of its tints ────────────────────

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
  role?: 'status';
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
