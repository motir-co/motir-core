'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { AlertTriangle, ChevronRight, FileSearch, Info } from 'lucide-react';
import { renderMarkdown } from '@/lib/markdown/render';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { EmptyState } from '@/components/ui/EmptyState';
import { Textarea } from '@/components/ui/Textarea';
import { cn } from '@/lib/utils/cn';
import type { CodingConventionDTO, ConventionSurfaceDTO } from '@/lib/dto/codeHealth';
import { useRelativeTime } from '@/lib/hooks/useRelativeTime';

// The longest convention a person may save, in characters — the same number the
// server enforces (`CONVENTION_MAX_CHARS` in aiConventionService, which a client
// module cannot import: it reaches the database).
const MAX_CHARS = 65_536;

const CONVENTION_URL = '/api/ai/coding-convention/convention';

// The query parameter that deep-links the expanded card (MOTIR-9193).
const REPO_PARAM = 'repo';
const DEFAULT_KEY = '__default__';

const cardKey = (c: ConventionSurfaceDTO): string => c.repoKey ?? DEFAULT_KEY;

// Which card a `?repo=` value expands: the one it names, else the FIRST (an
// unknown value falls back like an absent one, so the page never opens on N
// closed bars).
function resolveOpenKey(conventions: ConventionSurfaceDTO[], repo: string | null | undefined) {
  const named = repo ? conventions.find((c) => c.repoKey === repo) : undefined;
  return cardKey(named ?? conventions[0]!);
}

// Per-repo convention surface. A repository's convention is derived from its code
// and auto-used (MOTIR-1660/1663), and a person with `ai:configure` can WRITE it
// (MOTIR-9079/9082): Edit saves a new `edited` version through motir-ai, and a
// later re-derive parks its output beside that text instead of replacing it. The
// page reads on `ai:plan` and a member sees this panel read-only (MOTIR-9173), so
// `canEdit` is the courtesy the design asks for (Edit absent, not disabled), not
// the gate — the server enforces it.
//
// The cards are an ACCORDION (MOTIR-9193/9194): at most one is expanded. The
// expanded key lives here; every card stays mounted so a draft in Edit survives
// its card collapsing (the body unmounts, the edit state does not).
export function ConventionPanel({
  conventions,
  onSaved,
  canEdit = true,
  initialRepo = null,
}: {
  conventions: ConventionSurfaceDTO[];
  // Hands the re-read surface of the repository just saved to the island that owns
  // the set (page-state contract, case 3: a client island seeded from props).
  onSaved?: (surface: ConventionSurfaceDTO) => void;
  canEdit?: boolean;
  // The `?repo=` the SERVER resolved for this load. A prop and not a hook read:
  // `useSearchParams()` is empty during the server render, so a state seeded from
  // it would paint the wrong card and hydration would keep it (MOTIR-1754).
  initialRepo?: string | null;
}) {
  const t = useTranslations('codeHealth');
  const params = useSearchParams();
  const [openKey, setOpenKey] = useState<string | null>(() =>
    conventions.length === 0 ? null : resolveOpenKey(conventions, initialRepo),
  );
  // The `repo` value this panel last wrote (or read), so the effect below can tell
  // Back/forward from its own `shallowPush`.
  const written = useRef<string | null>(initialRepo);
  const anchor = useRef<{ key: string; top: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const urlRepo = params?.get(REPO_PARAM) ?? null;
  useEffect(() => {
    if (urlRepo === written.current || conventions.length === 0) return;
    written.current = urlRepo;
    setOpenKey(resolveOpenKey(conventions, urlRepo));
  }, [urlRepo, conventions]);

  // Keep the pressed header where it was in the viewport: the card above it just
  // shrank, and without this the page jumps.
  useLayoutEffect(() => {
    const a = anchor.current;
    anchor.current = null;
    if (!a || typeof window.scrollBy !== 'function') return;
    const header = rootRef.current?.querySelector<HTMLElement>(
      `[data-card-key="${CSS.escape(a.key)}"]`,
    );
    const delta = header ? header.getBoundingClientRect().top - a.top : 0;
    if (delta !== 0) window.scrollBy(0, delta);
  }, [openKey]);

  if (conventions.length === 0) {
    return (
      <EmptyState
        icon={<FileSearch aria-hidden />}
        title={t('convention.emptyTitle')}
        description={t('convention.emptyDescription')}
      />
    );
  }

  const toggle = (c: ConventionSurfaceDTO, headerTop: number) => {
    const key = cardKey(c);
    const next = openKey === key ? null : key;
    anchor.current = { key, top: headerTop };
    setOpenKey(next);
    // Collapsing the open card drops the parameter; a reload then loads as the
    // default again. Other parameters (`?section=`) are kept.
    const q = new URLSearchParams(window.location.search);
    const repo = next === null ? null : c.repoKey;
    if (repo === null) q.delete(REPO_PARAM);
    else q.set(REPO_PARAM, repo);
    written.current = repo;
    const query = q.toString();
    shallowPush(query === '' ? window.location.pathname : `${window.location.pathname}?${query}`);
  };

  return (
    <div ref={rootRef} className="flex flex-col gap-3">
      {conventions.map((c) => (
        <RepoConventionCard
          key={cardKey(c)}
          convention={c}
          canEdit={canEdit}
          onSaved={onSaved}
          open={openKey === cardKey(c)}
          onToggle={(top) => toggle(c, top)}
        />
      ))}
    </div>
  );
}

type EditState =
  | { mode: 'read' }
  | { mode: 'edit'; draft: string; base: number; saving: boolean; failed: boolean }
  | { mode: 'conflict'; draft: string; base: number; latest: ConventionSurfaceDTO; copy: boolean };

function RepoConventionCard({
  convention: c,
  canEdit,
  onSaved,
  open,
  onToggle,
}: {
  convention: ConventionSurfaceDTO;
  canEdit: boolean;
  onSaved?: (surface: ConventionSurfaceDTO) => void;
  open: boolean;
  onToggle: (headerTop: number) => void;
}) {
  const t = useTranslations('codeHealth');
  const format = useFormatter();
  const uid = useId();
  const headId = `${uid}-head`;
  const bodyId = `${uid}-body`;
  // The latest version IS the one injected — derived or edited, auto-used. Null
  // means the repo has neither been audited nor written yet.
  const current = c.convention;
  const [state, setState] = useState<EditState>({ mode: 'read' });
  const [comparing, setComparing] = useState(false);
  const repoKey = c.repoKey;
  const repoLabel = repoKey ?? t('convention.defaultRepo');
  const slash = repoLabel.lastIndexOf('/');
  const owner = slash === -1 ? '' : repoLabel.slice(0, slash + 1);
  const name = slash === -1 ? repoLabel : repoLabel.slice(slash + 1);

  const startEdit = () =>
    setState({
      mode: 'edit',
      draft: current?.contentMd ?? '',
      base: current?.version ?? 0,
      saving: false,
      failed: false,
    });

  const save = async () => {
    if (state.mode !== 'edit' || repoKey === null) return;
    const { draft, base } = state;
    setState({ ...state, saving: true, failed: false });
    try {
      const res = await fetch(CONVENTION_URL, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repoKey, contentMd: draft, baseVersion: base }),
      });
      if (res.status === 409) {
        const body = (await res.json()) as { latest?: ConventionSurfaceDTO };
        if (body.latest) {
          setState({ mode: 'conflict', draft, base, latest: body.latest, copy: false });
          return;
        }
      }
      if (!res.ok) throw new Error(`save failed: ${res.status}`);
      const saved = (await res.json()) as ConventionSurfaceDTO;
      setState({ mode: 'read' });
      setComparing(false);
      onSaved?.(saved);
    } catch {
      setState({ mode: 'edit', draft, base, saving: false, failed: true });
    }
  };

  // "Load their version": adopt the surface the conflict carried, close the editor.
  const loadTheirs = () => {
    if (state.mode !== 'conflict') return;
    onSaved?.(state.latest);
    setState({ mode: 'read' });
  };

  const editing = state.mode !== 'read';
  // Text the person typed that exists nowhere else. An editor opened and left
  // untouched holds nothing to lose, so it neither marks the header nor warns.
  const dirty =
    state.mode === 'conflict' ||
    (state.mode === 'edit' && state.draft !== (current?.contentMd ?? ''));
  const edited = current?.authorKind === 'edited';
  const pending = edited ? current.pendingDerivedMd : null;

  // Reload, closing the tab or typing a URL with a draft present raises the
  // browser's own prompt; collapsing a card never asks (the draft is kept).
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  return (
    <div
      className={cn(
        'rounded-(--radius-card) bg-(--el-card)',
        editing && open
          ? 'border-2 border-(--el-accent)'
          : open
            ? 'border border-(--el-border-strong)'
            : 'border border-(--el-border)',
      )}
    >
      <h3 className="m-0 flex items-center gap-2 pr-(--spacing-card-padding-12)">
        <button
          type="button"
          id={headId}
          data-card-key={repoKey ?? DEFAULT_KEY}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={(e) => onToggle(e.currentTarget.getBoundingClientRect().top)}
          className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-(--radius-card) px-(--spacing-card-padding-16) py-(--spacing-card-padding-12) text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--focus-ring-color)"
        >
          <ChevronRight
            className={cn(
              'size-4 shrink-0 text-(--el-text-secondary) transition-transform motion-reduce:transition-none',
              open && 'rotate-90',
            )}
            aria-hidden
          />
          <span className="text-sm font-medium text-(--el-text-secondary)">
            {owner}
            <b className="font-semibold text-(--el-text-strong)">{name}</b>
          </span>
          {current ? (
            edited ? (
              <Pill severity="info">
                {t('convention.versionEdited', { version: current.version })}
              </Pill>
            ) : (
              <Pill status="planned">
                {t('convention.versionDerived', { version: current.version })}
              </Pill>
            )
          ) : (
            <Pill tone="neutral">{t('convention.emptyTitle')}</Pill>
          )}
          {current ? (
            <span className="text-xs text-(--el-text-secondary)">
              {edited
                ? current.editedByName
                  ? t('convention.bylineEdited', {
                      name: current.editedByName,
                      date: format.dateTime(new Date(current.createdAt), { dateStyle: 'medium' }),
                    })
                  : t('convention.bylineEditedUnknown', {
                      date: format.dateTime(new Date(current.createdAt), { dateStyle: 'medium' }),
                    })
                : t('convention.bylineDerived')}
            </span>
          ) : null}
          {pending ? <Pill tone="awaiting">{t('convention.markerPending')}</Pill> : null}
          {open && editing ? (
            <Pill severity="warning">{t('convention.markerEditing')}</Pill>
          ) : !open && dirty ? (
            <Pill severity="warning">{t('convention.markerDraft')}</Pill>
          ) : null}
        </button>
        {open && canEdit && current && !editing ? (
          <Button variant="secondary" size="sm" onClick={startEdit}>
            {t('convention.edit')}
          </Button>
        ) : null}
      </h3>
      {open ? (
        <div
          id={bodyId}
          role="region"
          aria-labelledby={headId}
          className="flex flex-col gap-4 border-t border-(--el-border) p-(--spacing-card-padding)"
        >
          {state.mode === 'edit' ? (
            <ConventionEditor
              state={state}
              repo={repoLabel}
              repoName={name}
              next={(current?.version ?? 0) + 1}
              version={current?.version ?? 0}
              onChange={(draft) => setState({ ...state, draft, failed: false })}
              onCancel={() => setState({ mode: 'read' })}
              onSave={() => void save()}
            />
          ) : state.mode === 'conflict' ? (
            <ConventionConflict
              state={state}
              onLoadTheirs={loadTheirs}
              onKeepMine={() => setState({ ...state, copy: true })}
            />
          ) : current ? (
            <div className="flex flex-col gap-4">
              {pending ? (
                <PendingDerived
                  current={current}
                  pending={pending}
                  comparing={comparing}
                  onToggle={() => setComparing((v) => !v)}
                />
              ) : null}
              <ConventionDocument contentMd={current.contentMd} />
              {edited ? null : <ProvenanceList provenance={current.provenance} />}
            </div>
          ) : (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-(--el-text-secondary)">
                {canEdit ? t('convention.emptyWriteBody') : t('convention.noRules')}
              </p>
              {canEdit ? (
                <Button variant="primary" size="sm" onClick={startEdit}>
                  {t('convention.writeFirst')}
                </Button>
              ) : null}
            </div>
          )}
          {c.versions.length > 1 ? (
            <VersionHistory versions={c.versions} currentId={current?.id ?? null} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ConventionEditor({
  state,
  repo,
  repoName,
  next,
  version,
  onChange,
  onCancel,
  onSave,
}: {
  state: Extract<EditState, { mode: 'edit' }>;
  repo: string;
  repoName: string;
  next: number;
  version: number;
  onChange: (draft: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const t = useTranslations('codeHealth');
  const format = useFormatter();
  const count = state.draft.length;
  const tooLong = count > MAX_CHARS;
  const blank = state.draft.trim().length === 0;
  const error = state.failed
    ? t('convention.saveFailed')
    : tooLong
      ? t('convention.tooLong', { max: format.number(MAX_CHARS) })
      : undefined;
  return (
    <div className="flex flex-col gap-3">
      <div
        role="group"
        aria-label={`${t('convention.editingBanner')} ${repo}`}
        className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-(--radius-card) bg-(--el-tint-sky) px-(--spacing-card-padding-16) py-(--spacing-card-padding-12) text-(--el-text-strong)"
      >
        <span className="font-mono text-xs uppercase tracking-wider">
          {t('convention.editingBanner')}
        </span>
        <span className="font-serif text-lg font-semibold">{repo}</span>
        <span className="text-sm">{t('convention.editingBannerSub', { next, version })}</span>
      </div>
      <span className="text-xs font-medium text-(--el-text-secondary)">
        {t('convention.editingVersion', { version })}
      </span>
      <Textarea
        label={t('convention.editFieldLabelRepo', { repo })}
        rows={14}
        value={state.draft}
        onChange={(e) => onChange(e.target.value)}
        error={error}
        helperText={`${t('convention.saveCreatesRepo', {
          next,
          repo,
          count: format.number(count),
          max: format.number(MAX_CHARS),
        })} ${t('convention.editHelper')}`}
        className="font-mono text-xs"
      />
      {blank && count > 0 ? (
        <p className="text-xs text-(--el-text-secondary)">{t('convention.blank')}</p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={state.saving}>
          {t('convention.cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={onSave}
          loading={state.saving}
          disabled={blank || tooLong || state.saving}
        >
          {state.saving ? t('convention.saving') : t('convention.saveTo', { name: repoName })}
        </Button>
      </div>
    </div>
  );
}

function ConventionConflict({
  state,
  onLoadTheirs,
  onKeepMine,
}: {
  state: Extract<EditState, { mode: 'conflict' }>;
  onLoadTheirs: () => void;
  onKeepMine: () => void;
}) {
  const t = useTranslations('codeHealth');
  const format = useFormatter();
  const latest = state.latest.convention;
  return (
    <div className="flex flex-col gap-3">
      <div
        role="alert"
        className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-warning-surface) p-(--spacing-card-padding-12)"
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-(--el-warning)" aria-hidden />
        <div className="flex flex-col gap-3">
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-(--el-text-strong)">
              {t('convention.conflictTitle')}
            </span>
            <span className="text-sm text-(--el-text-secondary)">
              {t('convention.conflictBody', {
                name: latest?.editedByName ?? t('convention.bylineDerived'),
                latest: latest?.version ?? 0,
                date: latest
                  ? format.dateTime(new Date(latest.createdAt), { dateStyle: 'medium' })
                  : '',
                base: state.base,
              })}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" onClick={onLoadTheirs}>
              {t('convention.conflictLoadTheirs')}
            </Button>
            {state.copy ? null : (
              <Button variant="secondary" size="sm" onClick={onKeepMine}>
                {t('convention.conflictKeepMine')}
              </Button>
            )}
          </div>
        </div>
      </div>
      {state.copy ? (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-(--el-text-secondary)">
            {t('convention.conflictCopyLabel')}
          </span>
          <Textarea
            aria-label={t('convention.conflictCopyLabel')}
            readOnly
            rows={10}
            value={state.draft}
            helperText={t('convention.conflictCopyHint')}
            className="font-mono text-xs"
          />
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void navigator.clipboard?.writeText(state.draft)}
            >
              {t('convention.copy')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PendingDerived({
  current,
  pending,
  comparing,
  onToggle,
}: {
  current: CodingConventionDTO;
  pending: string;
  comparing: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations('codeHealth');
  const format = useFormatter();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-surface-soft) p-(--spacing-card-padding-12)">
        <Info className="mt-0.5 size-4 shrink-0 text-(--el-accent-on-surface)" aria-hidden />
        <div className="flex flex-col gap-3">
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-(--el-text-strong)">
              {t('convention.pendingTitle')}
            </span>
            <span className="text-sm text-(--el-text-secondary)">
              {t('convention.pendingBody', {
                date: format.dateTime(new Date(current.createdAt), { dateStyle: 'medium' }),
              })}
            </span>
          </div>
          <div>
            <Button variant="secondary" size="sm" onClick={onToggle} aria-expanded={comparing}>
              {t('convention.pendingCompare')}
            </Button>
          </div>
        </div>
      </div>
      {comparing ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <ComparisonColumn
            label={t('convention.pendingInUse', { version: current.version })}
            contentMd={current.contentMd}
          />
          <ComparisonColumn label={t('convention.pendingWaiting')} contentMd={pending} />
        </div>
      ) : null}
    </div>
  );
}

function ComparisonColumn({ label, contentMd }: { label: string; contentMd: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border) p-(--spacing-card-padding-12)">
      <span className="text-xs font-semibold text-(--el-text-secondary)">{label}</span>
      <ConventionDocument contentMd={contentMd} />
    </div>
  );
}

function ProvenanceBadge({ source }: { source: 'adopted' | 'proposed' }) {
  const t = useTranslations('codeHealth');
  return source === 'adopted' ? (
    <Pill severity="success">{t('convention.provenance.adopted')}</Pill>
  ) : (
    <Pill status="planned">{t('convention.provenance.proposed')}</Pill>
  );
}

function ProvenanceList({
  provenance,
}: {
  provenance: { ruleId: string; category: string; source: 'adopted' | 'proposed' }[];
}) {
  const t = useTranslations('codeHealth');
  if (provenance.length === 0) return null;
  return (
    <Card
      header={
        <span className="text-sm font-medium text-(--el-text-strong)">
          {t('convention.provenanceTitle')}
        </span>
      }
    >
      <ul className="flex flex-col gap-2">
        {provenance.map((p) => (
          <li key={p.ruleId} className="flex flex-wrap items-center gap-2 text-sm">
            <ProvenanceBadge source={p.source} />
            <span className="font-medium text-(--el-text-strong)">{p.ruleId}</span>
            <span className="text-(--el-text-muted)">· {p.category}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-(--el-text-muted)">{t('convention.provenanceLegend')}</p>
    </Card>
  );
}

function ConventionDocument({ contentMd }: { contentMd: string }) {
  return (
    <div className="flex flex-col gap-2 text-sm leading-relaxed text-(--el-text) [&_h1]:font-serif [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:text-(--el-text-strong) [&_h2]:mt-3 [&_h2]:font-serif [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-(--el-text-strong) [&_h3]:mt-2 [&_h3]:font-medium [&_h3]:text-(--el-text-strong) [&_ul]:list-disc [&_ul]:pl-5 [&_code]:text-(--el-text-identifier) [&_a]:text-(--el-link)">
      {renderMarkdown(contentMd)}
    </div>
  );
}

// The design's `.version` list (design/coding-convention, Panel 4): a mono version
// id, the CURRENT marker, and when the version was derived. It switches on
// identity, never on a lifecycle `status` — MOTIR-1660/1662 deleted that
// lifecycle and motir-ai does not send one (MOTIR-2127).
function VersionHistory({
  versions,
  currentId,
}: {
  versions: ConventionSurfaceDTO['versions'];
  currentId: string | null;
}) {
  const t = useTranslations('codeHealth');
  const relativeTime = useRelativeTime();
  if (versions.length === 0) return null;
  return (
    <Card
      header={
        <span className="text-sm font-medium text-(--el-text-strong)">
          {t('convention.historyTitle')}
        </span>
      }
    >
      <ul className="flex flex-col gap-2">
        {versions.map((v) => (
          <li key={v.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono text-xs font-semibold text-(--el-text-secondary)">
              v{v.version}
            </span>
            {v.id === currentId ? (
              <Pill status="planned">{t('convention.historyCurrent')}</Pill>
            ) : null}
            <span className="text-xs text-(--el-text-muted)">
              {relativeTime(new Date(v.createdAt))}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
