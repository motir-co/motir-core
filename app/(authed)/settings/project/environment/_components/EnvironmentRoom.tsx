'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { CircleCheck, FolderGit2, History, Inbox, Lock } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { Spinner } from '@/components/ui/Spinner';
import { Switch } from '@/components/ui/Switch';
import { Tooltip } from '@/components/ui/Tooltip';
import type { EnvironmentChangeDto, EnvironmentEntryDto } from '@/lib/dto/environmentConfig';
import type { ProjectRepoRoleDto } from '@/lib/dto/projectRepos';
import {
  environmentConfigClient,
  type EnvironmentRefusal,
  type EnvironmentScope,
} from '@/lib/environmentConfig/client';
import {
  isEnvironmentVariableName,
  isReservedEnvironmentName,
} from '@/lib/environmentConfig/reservedNames';
import type { EnvironmentName } from '@/lib/environmentConfig/vocabulary';

// EnvironmentRoom (Story MOTIR-9795 · MOTIR-9966) — a Motir repository's values per
// environment, per `design/environment/environment.mock.html` and
// `design/environment/design-notes.md` (MOTIR-9959).
//
// A client ISLAND over the four environment routes (MOTIR-9964), reached only
// through `environmentConfigClient`. The page decides on the server which
// repositories are offered (Motir's, never a customer's), whether the actor may
// change anything (`repository:manage`, read off the registry) and whether the
// Release tab exists; this island renders what it is handed.
//
// ⚠️ IT HOLDS NO SECRET. A secret entry's DTO carries `value: null`, so a Set row
// has nothing to leak; no input is ever seeded from a secret row; and the one
// secret the island ever holds is the one an administrator is typing, cleared the
// moment its save returns. Nothing here logs.
//
// After a save or a delete the RESPONSE updates the row in place — no
// `router.refresh()` (CLAUDE.md § page state, an inline edit). Each row's writes
// are sequence-guarded, so a slow answer to an older save never lands over a
// newer one. Disabling the controls for a member is presentation only: the
// routes' 403 stays the authority, and the room shows its note if one arrives.

export interface EnvironmentRepositoryOption {
  id: string;
  name: string;
  role: ProjectRepoRoleDto;
  label: string | null;
}

const ROW = 'flex items-center gap-3 border-b border-(--el-border-soft) py-(--spacing-control-y-8)';
const NAME_COLUMN = 'w-48 shrink-0 truncate font-mono text-sm text-(--el-text-identifier)';
const BOX =
  'rounded-(--radius-card) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) font-sans text-sm';

export function EnvironmentRoom({
  projectKey,
  repositories,
  initialRepositoryId,
  initialEnvironment,
  canEdit,
  showReleaseTab,
}: {
  projectKey: string;
  /** The project's repositories Motir hosts, in set order; never empty. */
  repositories: EnvironmentRepositoryOption[];
  initialRepositoryId: string;
  initialEnvironment: EnvironmentName;
  /** The actor holds the room's write key (`repository:manage`). */
  canEdit: boolean;
  /** The project is live and the repository is in a train. */
  showReleaseTab: boolean;
}) {
  const t = useTranslations('settings.environment');
  const [repositoryId, setRepositoryId] = useState(initialRepositoryId);
  const [environment, setEnvironment] = useState<EnvironmentName>(initialEnvironment);
  // A 403 that arrives anyway (the role changed under an open page) turns the
  // room read-only and shows the note.
  const [forbidden, setForbidden] = useState(false);
  const editable = canEdit && !forbidden;

  const tabs = useMemo<EnvironmentName[]>(
    () => (showReleaseTab ? ['production', 'preview', 'release'] : ['production', 'preview']),
    [showReleaseTab],
  );

  // The address names the view, so a link reopens it.
  const remember = useCallback((repository: string, env: EnvironmentName) => {
    const url = new URL(window.location.href);
    url.searchParams.set('repository', repository);
    url.searchParams.set('environment', env);
    window.history.replaceState(null, '', url.toString());
  }, []);

  const chooseRepository = (next: string) => {
    setRepositoryId(next);
    remember(next, environment);
  };
  const chooseEnvironment = (next: EnvironmentName) => {
    setEnvironment(next);
    remember(repositoryId, next);
  };

  const options = repositories.map((repo) => ({
    value: repo.id,
    label: repo.name,
    secondary: repo.label ?? t(`role.${repo.role}`),
  }));
  const tabLabel = (env: EnvironmentName) => t(`tab.${env}`);
  const selectorId = useId();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <span id={selectorId} className="font-sans text-sm font-medium text-(--el-text)">
          {t('repositoryLabel')}
        </span>
        <div className="w-72" aria-labelledby={selectorId}>
          <Combobox
            options={options}
            value={repositoryId}
            onChange={chooseRepository}
            label={t('repositoryLabel')}
            triggerIcon={<FolderGit2 className="size-4" aria-hidden />}
          />
        </div>
      </div>

      {!editable ? (
        <p
          role="note"
          data-testid="environment-read-only-note"
          className={`${BOX} border border-(--el-border-soft) bg-(--el-surface-soft) text-(--el-text-secondary)`}
        >
          {t('readOnly.note')}
        </p>
      ) : null}

      <Card>
        <EnvironmentTabs
          tabs={tabs}
          selected={environment}
          onSelect={chooseEnvironment}
          label={tabLabel}
        />
        <EnvironmentPanel
          key={`${repositoryId}:${environment}`}
          scope={{ projectKey, repositoryId, environment }}
          tabs={tabs}
          editable={editable}
          onForbidden={() => setForbidden(true)}
        />
      </Card>
    </div>
  );
}

// ── Tabs — the Workflow editor's tablist, with the design's roving focus ──────

function EnvironmentTabs({
  tabs,
  selected,
  onSelect,
  label,
}: {
  tabs: EnvironmentName[];
  selected: EnvironmentName;
  onSelect: (env: EnvironmentName) => void;
  label: (env: EnvironmentName) => string;
}) {
  const t = useTranslations('settings.environment');
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    const env = tabs[next]!;
    onSelect(env);
    refs.current[env]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={t('tablistLabel')}
      className="flex gap-1 border-b border-(--el-border)"
    >
      {tabs.map((env, index) => {
        const active = env === selected;
        return (
          <button
            key={env}
            ref={(el) => {
              refs.current[env] = el;
            }}
            id={`environment-tab-${env}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls="environment-panel"
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(env)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={`-mb-px border-b-2 px-(--spacing-control-x-12) py-(--spacing-control-y-8) font-sans text-sm font-medium ${
              active
                ? 'border-(--el-text) text-(--el-text)'
                : 'border-transparent text-(--el-text-secondary)'
            }`}
          >
            {label(env)}
          </button>
        );
      })}
    </div>
  );
}

// ── One environment's panel ───────────────────────────────────────────────────

type Load<T> = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; data: T };

type RowMode = { name: string; kind: 'edit' | 'replace'; draft: string } | null;
type RowFailure = { name: string; kind: 'save' | 'delete'; retry: () => void } | null;
type AddError = 'nameRequired' | 'duplicate' | 'invalid' | 'reserved' | null;

function sortByName(entries: EnvironmentEntryDto[]): EnvironmentEntryDto[] {
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function EnvironmentPanel({
  scope,
  tabs,
  editable,
  onForbidden,
}: {
  scope: EnvironmentScope;
  tabs: EnvironmentName[];
  editable: boolean;
  onForbidden: () => void;
}) {
  const t = useTranslations('settings.environment');
  const format = useFormatter();
  const envLabel = t(`tab.${scope.environment}`);
  const [entries, setEntries] = useState<Load<EnvironmentEntryDto[]>>({ state: 'loading' });
  const [changes, setChanges] = useState<Load<EnvironmentChangeDto[]>>({ state: 'loading' });
  const [mode, setMode] = useState<RowMode>(null);
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const [failure, setFailure] = useState<RowFailure>(null);
  const [saved, setSaved] = useState<{ name: string; secret: boolean } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  // Per-name write sequence: an answer to an older write of a name never lands.
  const seq = useRef(new Map<string, number>());
  const changesSeq = useRef(0);
  const actionRefs = useRef(new Map<string, HTMLButtonElement | null>());

  // Sets state only in its callback, so the mount effect can start it; the
  // retry below shows the loading face first.
  const readEntries = useCallback(() => {
    void environmentConfigClient.listEntries(scope).then((result) => {
      if (result.ok) setEntries({ state: 'ready', data: sortByName(result.data) });
      else setEntries({ state: 'failed' });
    });
    // `scope` is a fresh object per render; its fields are the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.projectKey, scope.repositoryId, scope.environment]);

  const readChanges = useCallback(() => {
    const mine = ++changesSeq.current;
    void environmentConfigClient.listChanges(scope).then((result) => {
      if (mine !== changesSeq.current) return;
      setChanges(result.ok ? { state: 'ready', data: result.data } : { state: 'failed' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.projectKey, scope.repositoryId, scope.environment]);

  useEffect(() => {
    readEntries();
    readChanges();
  }, [readEntries, readChanges]);

  const setRowSaving = (name: string, on: boolean) =>
    setSaving((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  const nextSeq = (name: string) => {
    const n = (seq.current.get(name) ?? 0) + 1;
    seq.current.set(name, n);
    return n;
  };

  /**
   * Save `value` under `name`. Resolves to the refusal (or null on success) so
   * the add row can keep its typed value and say why; a row edit reports through
   * the row's failure line instead.
   */
  const save = useCallback(
    async (name: string, value: string, isSecret: boolean): Promise<EnvironmentRefusal | null> => {
      const mine = nextSeq(name);
      setFailure(null);
      setSaved(null);
      setRowSaving(name, true);
      const result = await environmentConfigClient.putEntry(scope, name, { value, isSecret });
      if (seq.current.get(name) !== mine) return null;
      setRowSaving(name, false);
      if (!result.ok) {
        if (result.refusal.kind === 'forbidden') onForbidden();
        return result.refusal;
      }
      const entry = result.data.entry;
      setEntries((prev) =>
        prev.state === 'ready'
          ? {
              state: 'ready',
              data: sortByName([...prev.data.filter((e) => e.name !== entry.name), entry]),
            }
          : prev,
      );
      setSaved({ name: entry.name, secret: entry.isSecret });
      setMode((m) => (m?.name === name ? null : m));
      readChanges();
      return null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope.projectKey, scope.repositoryId, scope.environment, onForbidden, readChanges],
  );

  const saveRow = (name: string, value: string, isSecret: boolean) => {
    void save(name, value, isSecret).then((refusal) => {
      if (refusal && refusal.kind !== 'forbidden') {
        setFailure({ name, kind: 'save', retry: () => saveRow(name, value, isSecret) });
      }
    });
  };

  const remove = (name: string) => {
    const mine = nextSeq(name);
    setFailure(null);
    setSaved(null);
    setRowSaving(name, true);
    void environmentConfigClient.deleteEntry(scope, name).then((result) => {
      if (seq.current.get(name) !== mine) return;
      setRowSaving(name, false);
      if (!result.ok && result.refusal.kind !== 'not_found') {
        if (result.refusal.kind === 'forbidden') onForbidden();
        else setFailure({ name, kind: 'delete', retry: () => remove(name) });
        return;
      }
      // A 404 means it is already gone, which is what the person asked for.
      setEntries((prev) =>
        prev.state === 'ready'
          ? { state: 'ready', data: prev.data.filter((e) => e.name !== name) }
          : prev,
      );
      readChanges();
    });
  };

  const closeConfirm = (returnFocusTo: string | null) => {
    setConfirming(null);
    if (returnFocusTo) actionRefs.current.get(`delete:${returnFocusTo}`)?.focus();
  };

  const otherTabs = tabs.filter((env) => env !== scope.environment).map((env) => t(`tab.${env}`));
  const existing = entries.state === 'ready' ? entries.data : [];

  return (
    <div
      id="environment-panel"
      role="tabpanel"
      aria-labelledby={`environment-tab-${scope.environment}`}
      className="flex flex-col gap-2 pt-(--spacing-card-padding-16)"
    >
      {entries.state === 'loading' ? (
        <div
          aria-busy="true"
          aria-live="polite"
          className="flex flex-col gap-2"
          data-testid="environment-loading"
        >
          <span className="flex items-center gap-2 font-sans text-sm text-(--el-text-secondary)">
            <Spinner size="sm" aria-label={t('loading')} />
            {t('loading')}
          </span>
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-6 w-full rounded-(--radius-control) bg-(--el-muted)" />
          ))}
        </div>
      ) : entries.state === 'failed' ? (
        <ErrorState
          title={t('loadError.title')}
          description={t('loadError.body')}
          retry={() => {
            setEntries({ state: 'loading' });
            readEntries();
          }}
          retryLabel={t('retry')}
        />
      ) : (
        <>
          {saved ? (
            <p
              role="status"
              data-testid="environment-saved"
              className={`${BOX} flex items-center gap-2 bg-(--el-success-surface) text-(--el-text-strong)`}
            >
              <CircleCheck className="size-4 shrink-0" aria-hidden />
              {saved.secret
                ? t('saved.secret', { name: saved.name })
                : t('saved.plain', { name: saved.name })}
            </p>
          ) : null}

          {entries.data.length === 0 ? (
            <EmptyState
              icon={<Inbox aria-hidden />}
              title={t('empty.title', { environment: envLabel })}
              description={t(`empty.${scope.environment}`)}
            />
          ) : (
            <>
              <div className="flex items-center gap-3 border-b border-(--el-border) py-(--spacing-control-y-4) font-sans text-xs font-medium text-(--el-text-secondary)">
                <span className="w-48 shrink-0">{t('column.name')}</span>
                <span className="flex-1">{t('column.value')}</span>
              </div>
              <ul className="flex flex-col" data-testid="environment-entries">
                {entries.data.map((entry) => (
                  <EntryRow
                    key={entry.name}
                    entry={entry}
                    editable={editable}
                    saving={saving.has(entry.name)}
                    mode={mode?.name === entry.name ? mode : null}
                    onMode={setMode}
                    onSave={(value) => saveRow(entry.name, value, entry.isSecret)}
                    onDelete={() => setConfirming(entry.name)}
                    actionRef={(key, el) => actionRefs.current.set(key, el)}
                  />
                ))}
              </ul>
            </>
          )}

          {failure ? (
            <div
              role="alert"
              data-testid="environment-row-error"
              className={`${BOX} flex items-center justify-between gap-3 border border-(--el-border-soft) bg-(--el-danger-surface)`}
            >
              <span className="text-(--el-danger-surface-text)">
                {failure.kind === 'save'
                  ? t('saveError', { name: failure.name })
                  : t('deleteError', { name: failure.name })}
              </span>
              <Button variant="secondary" size="sm" onClick={failure.retry}>
                {t('retry')}
              </Button>
            </div>
          ) : null}

          <AddEntryRow
            editable={editable}
            environmentLabel={envLabel}
            existing={existing}
            saving={(name) => saving.has(name)}
            onSave={save}
            onFailed={(name, retry) => setFailure({ name, kind: 'save', retry })}
          />
        </>
      )}

      <RecentChanges
        environmentLabel={envLabel}
        changes={changes}
        onRetry={() => {
          setChanges({ state: 'loading' });
          readChanges();
        }}
      />

      <Modal
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) closeConfirm(confirming);
        }}
        role="alertdialog"
        title={
          confirming
            ? t('deleteDialog.title', { name: confirming, environment: envLabel })
            : undefined
        }
        description={
          confirming
            ? t('deleteDialog.body', {
                name: confirming,
                environment: envLabel,
                others: format.list(otherTabs, { type: 'conjunction' }),
                count: otherTabs.length,
              })
            : undefined
        }
      >
        <Modal.Footer>
          <Button variant="secondary" autoFocus onClick={() => closeConfirm(confirming)}>
            {t('deleteDialog.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              const name = confirming;
              setConfirming(null);
              if (name) remove(name);
            }}
          >
            {t('deleteDialog.confirm')}
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
}

// ── A member's control: disabled with its reason, still focusable ─────────────

function GatedButton({
  editable,
  ...props
}: ButtonProps & { editable: boolean; ref?: Ref<HTMLButtonElement> }) {
  const t = useTranslations('settings.environment');
  if (editable) return <Button {...props} />;
  const { onClick: _onClick, disabled: _disabled, ...rest } = props;
  return (
    <Tooltip content={t('readOnly.tooltip')}>
      <Button
        {...rest}
        aria-disabled="true"
        onClick={(event) => event.preventDefault()}
        className="cursor-not-allowed opacity-50"
      />
    </Tooltip>
  );
}

// ── One entry row ─────────────────────────────────────────────────────────────

function EntryRow({
  entry,
  editable,
  saving,
  mode,
  onMode,
  onSave,
  onDelete,
  actionRef,
}: {
  entry: EnvironmentEntryDto;
  editable: boolean;
  saving: boolean;
  mode: RowMode;
  onMode: (mode: RowMode) => void;
  onSave: (value: string) => void;
  onDelete: () => void;
  actionRef: (key: string, el: HTMLButtonElement | null) => void;
}) {
  const t = useTranslations('settings.environment');
  const fieldRef = useRef<HTMLInputElement>(null);
  const triggerKey = `${entry.isSecret ? 'replace' : 'edit'}:${entry.name}`;
  const triggerEl = useRef<HTMLButtonElement | null>(null);

  // Opening the field focuses it; Cancel returns focus to the control that opened
  // it, once that control is back in the DOM.
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (mode) fieldRef.current?.focus();
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      triggerEl.current?.focus();
    }
  }, [mode]);

  const cancel = () => {
    restoreFocus.current = true;
    onMode(null);
  };

  if (mode) {
    const secret = entry.isSecret;
    return (
      <li className="flex flex-col gap-2 border-b border-(--el-border-soft) py-(--spacing-control-y-8)">
        <div className="flex items-center gap-3">
          <code className="w-48 shrink-0 font-mono text-sm text-(--el-text-identifier)">
            {entry.name}
          </code>
          <div className="min-w-0 flex-1">
            <Input
              ref={fieldRef}
              aria-label={
                secret
                  ? t('replaceFlow.aria', { name: entry.name })
                  : t('editAria', { name: entry.name })
              }
              type={secret ? 'password' : 'text'}
              autoComplete="off"
              placeholder={secret ? t('replaceFlow.placeholder') : undefined}
              helperText={secret ? t('replaceFlow.helper') : undefined}
              value={mode.draft}
              disabled={saving}
              className={secret ? undefined : 'font-mono'}
              onChange={(event) => onMode({ ...mode, draft: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  cancel();
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  onSave(mode.draft);
                }
              }}
            />
          </div>
          <span className="flex gap-1 self-start">
            <Button variant="primary" size="sm" loading={saving} onClick={() => onSave(mode.draft)}>
              {t('add.save')}
            </Button>
            <Button variant="ghost" size="sm" disabled={saving} onClick={cancel}>
              {t('replaceFlow.cancel')}
            </Button>
          </span>
        </div>
      </li>
    );
  }

  return (
    <li className={ROW} data-testid="environment-entry" data-name={entry.name}>
      <code className={NAME_COLUMN}>{entry.name}</code>
      {entry.isSecret ? (
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <Pill tone="neutral" className="inline-flex items-center gap-1">
            <Lock className="size-3" aria-hidden />
            {t('set')}
          </Pill>
          <span className="font-sans text-xs text-(--el-text-secondary)">{t('secretHidden')}</span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-(--el-text)">
          {entry.value}
        </span>
      )}
      <span className="flex items-center gap-1">
        {saving ? <Spinner size="sm" aria-label={t('saving')} /> : null}
        <GatedButton
          editable={editable}
          ref={(el) => {
            triggerEl.current = el;
            actionRef(triggerKey, el);
          }}
          variant="ghost"
          size="sm"
          disabled={saving}
          aria-label={
            entry.isSecret
              ? t('replaceAria', { name: entry.name })
              : t('editAria', { name: entry.name })
          }
          // A plain value is edited from what it holds; a secret's field starts
          // EMPTY — there is no value on this side to seed it with.
          onClick={() =>
            onMode({
              name: entry.name,
              kind: entry.isSecret ? 'replace' : 'edit',
              draft: entry.isSecret ? '' : (entry.value ?? ''),
            })
          }
        >
          {entry.isSecret ? t('replace') : t('edit')}
        </GatedButton>
        <GatedButton
          editable={editable}
          ref={(el) => actionRef(`delete:${entry.name}`, el)}
          variant="ghost"
          size="sm"
          disabled={saving}
          aria-label={t('deleteAria', { name: entry.name })}
          onClick={onDelete}
        >
          {t('delete')}
        </GatedButton>
      </span>
    </li>
  );
}

// ── The add row ───────────────────────────────────────────────────────────────

function AddEntryRow({
  editable,
  environmentLabel,
  existing,
  saving,
  onSave,
  onFailed,
}: {
  editable: boolean;
  environmentLabel: string;
  existing: EnvironmentEntryDto[];
  saving: (name: string) => boolean;
  onSave: (name: string, value: string, isSecret: boolean) => Promise<EnvironmentRefusal | null>;
  onFailed: (name: string, retry: () => void) => void;
}) {
  const t = useTranslations('settings.environment');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [isSecret, setIsSecret] = useState(false);
  const [error, setError] = useState<{ kind: AddError; name: string }>({ kind: null, name: '' });
  const nameRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const switchLabelId = useId();
  const trimmed = name.trim();
  const busy = trimmed !== '' && saving(trimmed);

  const refuse = (kind: AddError, offending: string) => {
    setError({ kind, name: offending });
    nameRef.current?.focus();
  };

  const submit = async () => {
    if (!editable || busy) return;
    if (trimmed === '') return refuse('nameRequired', '');
    if (isReservedEnvironmentName(trimmed)) return refuse('reserved', trimmed);
    if (!isEnvironmentVariableName(trimmed)) return refuse('invalid', trimmed);
    // The server's write is an upsert, so a duplicate would silently replace the
    // value; the list's Edit is the way to change one.
    if (existing.some((e) => e.name === trimmed)) return refuse('duplicate', trimmed);
    setError({ kind: null, name: '' });
    const refusal = await onSave(trimmed, value, isSecret);
    if (refusal === null) {
      // The value — a secret's included — leaves the form the moment it is saved.
      setName('');
      setValue('');
      setIsSecret(false);
      return;
    }
    if (refusal.kind === 'reserved') return refuse('reserved', refusal.name || trimmed);
    if (refusal.kind === 'invalid') return refuse('invalid', refusal.name || trimmed);
    if (refusal.kind !== 'forbidden') onFailed(trimmed, () => void submit());
  };

  const message =
    error.kind === 'nameRequired'
      ? t('error.nameRequired')
      : error.kind === 'invalid'
        ? t('error.invalidName')
        : error.kind === 'reserved'
          ? t('error.reserved', { name: error.name })
          : error.kind === 'duplicate'
            ? t('error.duplicate', { name: error.name, environment: environmentLabel })
            : null;

  const inert = !editable;

  return (
    <div className="flex flex-col gap-2 pt-(--spacing-control-y-8)" data-testid="environment-add">
      <p className="font-sans text-sm font-medium text-(--el-text)">{t('add.heading')}</p>
      <div className="flex items-start gap-3">
        <div className="w-48 shrink-0">
          <Input
            ref={nameRef}
            aria-label={t('column.name')}
            placeholder={t('add.namePlaceholder')}
            className="font-mono"
            value={name}
            readOnly={inert}
            aria-disabled={inert || undefined}
            aria-invalid={message ? true : undefined}
            aria-describedby={message ? errorId : undefined}
            onChange={(event) => {
              setName(event.target.value);
              if (error.kind) setError({ kind: null, name: '' });
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </div>
        <div className="min-w-0 flex-1">
          <Input
            aria-label={t('column.value')}
            placeholder={t('add.valuePlaceholder')}
            type={isSecret ? 'password' : 'text'}
            autoComplete="off"
            value={value}
            readOnly={inert}
            aria-disabled={inert || undefined}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </div>
        <span className="flex h-(--height-input) items-center gap-2 font-sans text-sm text-(--el-text)">
          <Switch
            checked={isSecret}
            onCheckedChange={(next) => {
              if (!inert) setIsSecret(next);
            }}
            aria-labelledby={switchLabelId}
          />
          <span id={switchLabelId}>{t('add.secret')}</span>
        </span>
        <GatedButton
          editable={editable}
          variant="primary"
          loading={busy}
          onClick={() => void submit()}
        >
          {t('add.save')}
        </GatedButton>
      </div>
      {message ? (
        <p
          id={errorId}
          role="alert"
          data-testid="environment-add-error"
          className="font-sans text-sm text-(--el-danger-on-surface)"
        >
          {message}
        </p>
      ) : null}
      <p className="font-sans text-xs text-(--el-text-secondary)">{t('add.helper')}</p>
    </div>
  );
}

// ── Recent changes ────────────────────────────────────────────────────────────

function RecentChanges({
  environmentLabel,
  changes,
  onRetry,
}: {
  environmentLabel: string;
  changes: Load<EnvironmentChangeDto[]>;
  onRetry: () => void;
}) {
  const t = useTranslations('settings.environment');
  const format = useFormatter();
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 pt-(--spacing-card-padding-16)"
    >
      <h2
        id={headingId}
        className="flex items-center gap-2 font-sans text-base font-semibold text-(--el-text)"
      >
        <History className="size-4" aria-hidden />
        {t('changes.heading', { environment: environmentLabel })}
      </h2>
      {changes.state === 'loading' ? (
        <span className="flex items-center gap-2 font-sans text-sm text-(--el-text-secondary)">
          <Spinner size="sm" aria-label={t('loading')} />
        </span>
      ) : changes.state === 'failed' ? (
        <div className="flex items-center gap-3 font-sans text-sm text-(--el-text-secondary)">
          <span>{t('changes.loadError')}</span>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {t('retry')}
          </Button>
        </div>
      ) : changes.data.length === 0 ? (
        <p className="font-sans text-sm text-(--el-text-secondary)">{t('changes.empty')}</p>
      ) : (
        <ol className="flex flex-col" data-testid="environment-changes">
          {changes.data.map((change) => (
            <li
              key={change.id}
              data-testid="environment-change"
              className="flex items-center gap-2 border-b border-(--el-border-soft) py-(--spacing-control-y-4) font-sans text-sm text-(--el-text)"
            >
              <span className="font-medium">{change.actorName ?? t('changes.unknownActor')}</span>
              <span>{t(`changes.${change.action}`)}</span>
              <code className="font-mono text-(--el-text-identifier)">{change.name}</code>
              {change.isSecret ? <Pill tone="neutral">{t('changes.secret')}</Pill> : null}
              <span className="ml-auto text-xs text-(--el-text-secondary)">
                <time dateTime={change.createdAt}>
                  {format.relativeTime(new Date(change.createdAt))}
                </time>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
