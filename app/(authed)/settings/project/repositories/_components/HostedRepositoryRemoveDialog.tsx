'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  Database,
  FolderGit2,
  Globe,
  KeyRound,
  Layers,
  ListTodo,
  Loader2,
  MoveUpRight,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import type { HostedRepositoryRemovalDto, ProjectRepoDto } from '@/lib/dto/projectRepos';

// REMOVING A MOTIR-HOSTED REPOSITORY — the confirm behind a hosted row's Delete
// repository / Remove from this project (bug MOTIR-11979 · MOTIR-11981; design
// `design/repository-set/design-notes.md` §19, `repositories-room--hosted-remove.mock.html`).
//
// ⚠️ THE CONFIRM NEVER GUESSES WHAT IT WOULD DESTROY (§19.4). It opens on the
// row's blast radius, read once from `GET …/removal`: while that loads it shows
// the check (`role="status"`) with the danger button disabled; if it fails it
// says so (`role="alert"`) and offers Check again, and nothing can be confirmed.
// The read also CHOOSES THE WEIGHT: anything to destroy ⇒ the danger confirm,
// otherwise ⇒ §17.6's quiet remove.
//
// ⚠️ THE ACT IS THE ROOM'S, NOT THIS DIALOG'S. `onConfirm` is the room's DELETE,
// so the page-state contract (§19.12) stays in one place: the row leaves the
// island on success, and a failure closes this dialog for the room's banner.
//
// Product-local, like `DeleteOrganizationDialog`, whose head and consequence list
// it reuses verbatim: one product flow, not a design-system primitive.

export interface HostedRepositoryRemoveDialogProps {
  row: ProjectRepoDto;
  projectKey: string;
  /** Whether the room's DELETE is in flight for this row. */
  pending: boolean;
  onClose: () => void;
  /** The room's DELETE — the act itself. */
  onConfirm: (row: ProjectRepoDto) => void;
  /** Take it over instead — opens the shipped takeover modal for this row. */
  onTakeOver: (row: ProjectRepoDto) => void;
}

type Check =
  | { phase: 'checking' }
  | { phase: 'failed' }
  | { phase: 'ready'; impact: HostedRepositoryRemovalDto };

export function HostedRepositoryRemoveDialog({
  row,
  projectKey,
  pending,
  onClose,
  onConfirm,
  onTakeOver,
}: HostedRepositoryRemoveDialogProps) {
  const t = useTranslations('repositoryTakeover.hostedRemove');
  const [check, setCheck] = useState<Check>({ phase: 'checking' });
  const [typed, setTyped] = useState('');
  const repo = row.realizedRepo?.repoRef ?? row.name;
  // The repository's NAME, not the owner-qualified reference (§19.5).
  const name = row.realizedRepo?.name ?? row.name;

  // Which read this is: Check again bumps it, and the effect reads again.
  const [attempt, setAttempt] = useState(0);
  const url = `/api/projects/${encodeURIComponent(projectKey)}/repositories/${encodeURIComponent(row.id)}/removal`;

  // Every state the read sets lands in its callbacks, after the answer; a read a
  // newer one replaced (or an unmount) is dropped rather than applied.
  useEffect(() => {
    let live = true;
    fetch(url, { cache: 'no-store' })
      .then(async (res) => {
        const next: Check = res.ok
          ? { phase: 'ready', impact: (await res.json()) as HostedRepositoryRemovalDto }
          : { phase: 'failed' };
        if (live) setCheck(next);
      })
      .catch(() => {
        if (live) setCheck({ phase: 'failed' });
      });
    return () => {
      live = false;
    };
  }, [url, attempt]);

  const checkAgain = () => {
    setCheck({ phase: 'checking' });
    setAttempt((n) => n + 1);
  };

  const close = (open: boolean) => {
    if (!open && !pending) onClose();
  };

  if (check.phase === 'ready' && !check.impact.destructive) {
    return (
      <QuietConfirm
        repo={repo}
        impact={check.impact}
        pending={pending}
        onOpenChange={close}
        onCancel={onClose}
        onConfirm={() => onConfirm(row)}
      />
    );
  }

  const gone = check.phase === 'ready' && check.impact.repository !== 'motir';
  const title = gone ? t('goneTitle', { repo }) : t('deleteTitle', { repo });
  const matches = typed === name;

  return (
    <Modal open onOpenChange={close} size="lg" srTitle={title} role="alertdialog">
      <div className="mb-3 flex items-start gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-(--el-tint-rose)">
          <Trash2 className="h-5 w-5 text-(--el-danger-on-surface)" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="font-serif text-xl font-semibold break-words text-(--el-text)">{title}</h2>
          <p className="mt-1 font-sans text-sm text-(--el-text-secondary)">
            {gone ? t('goneLead') : t('deleteLead')}
          </p>
        </div>
      </div>

      {check.phase === 'ready' ? (
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (matches && !pending) onConfirm(row);
          }}
        >
          <Modal.Body className="gap-4">
            <Consequences impact={check.impact} />
            <p className="font-sans text-sm text-(--el-text-secondary)">{t('kept')}</p>
            {check.impact.repository === 'motir' ? (
              <div className="flex flex-col gap-2 rounded-(--radius-card) bg-(--el-tint-sky) p-3 font-sans text-sm text-(--el-text-strong)">
                <p>
                  <b>{t('keepTitle')}</b> {t('keepBody')}
                </p>
                <div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={pending}
                    onClick={() => onTakeOver(row)}
                    leftIcon={<MoveUpRight className="size-3.5 shrink-0" aria-hidden />}
                  >
                    {t('keepAction')}
                  </Button>
                </div>
              </div>
            ) : null}
            <Input
              label={t('confirmLabel', { name })}
              placeholder={name}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              disabled={pending}
              autoComplete="off"
              error={typed.length > 0 && !matches ? t('nameMismatch') : undefined}
            />
          </Modal.Body>
          <Modal.Footer className="shrink-0">
            <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button type="submit" variant="danger" disabled={!matches || pending} loading={pending}>
              {pending ? t('pending') : gone ? t('goneConfirm') : t('confirm')}
            </Button>
          </Modal.Footer>
        </form>
      ) : (
        <>
          <Modal.Body className="gap-4">
            {check.phase === 'failed' ? (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-rose) p-3 font-sans text-sm text-(--el-text-strong)"
              >
                <TriangleAlert
                  className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger-on-surface)"
                  aria-hidden
                />
                <span>{t('checkFailed', { repo })}</span>
              </div>
            ) : (
              <p
                role="status"
                className="flex items-center gap-2 rounded-(--radius-card) border border-(--el-border) p-3 font-sans text-sm text-(--el-text-secondary)"
              >
                <Loader2
                  className="h-4 w-4 shrink-0 animate-spin text-(--el-icon-muted)"
                  aria-hidden
                />
                {t('checking', { repo })}
              </p>
            )}
          </Modal.Body>
          <Modal.Footer className="shrink-0">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('cancel')}
            </Button>
            {check.phase === 'failed' ? (
              <Button type="button" variant="secondary" onClick={checkAgain}>
                {t('checkAgain')}
              </Button>
            ) : (
              <Button type="button" variant="danger" disabled>
                {t('confirm')}
              </Button>
            )}
          </Modal.Footer>
        </>
      )}
    </Modal>
  );
}

const bold = (chunks: ReactNode) => <b className="text-(--el-text)">{chunks}</b>;

/** One row per TRUE fact, in the design's order (§19.5); a zero is not drawn. */
function Consequences({ impact }: { impact: HostedRepositoryRemovalDto }) {
  const t = useTranslations('repositoryTakeover.hostedRemove');
  const { production } = impact;
  return (
    <ul className="divide-y divide-(--el-border-soft) rounded-(--radius-card) border border-(--el-border)">
      {impact.repository === 'motir' || impact.repository === 'gone' ? (
        <Consequence icon={<FolderGit2 className="h-4 w-4" aria-hidden />}>
          {impact.repository === 'motir'
            ? t.rich('consequenceRepo', { b: bold })
            : t.rich('consequenceRepoGone', { b: bold })}
        </Consequence>
      ) : null}
      {production ? (
        <Consequence icon={<Database className="h-4 w-4" aria-hidden />}>
          {t.rich('consequenceProduction', { b: bold, address: production.address })}
        </Consequence>
      ) : null}
      {production && production.domains > 0 ? (
        <Consequence icon={<Globe className="h-4 w-4" aria-hidden />}>
          {t.rich('consequenceDomains', { b: bold, count: production.domains })}
        </Consequence>
      ) : null}
      {impact.previews > 0 ? (
        <Consequence icon={<Layers className="h-4 w-4" aria-hidden />}>
          {t.rich('consequencePreviews', { b: bold, count: impact.previews })}
        </Consequence>
      ) : null}
      {impact.environmentValues > 0 ? (
        <Consequence icon={<KeyRound className="h-4 w-4" aria-hidden />}>
          {t.rich('consequenceEnvironment', { b: bold, count: impact.environmentValues })}
        </Consequence>
      ) : null}
      {impact.openWorkItems > 0 ? (
        <Consequence icon={<ListTodo className="h-4 w-4" aria-hidden />}>
          {t.rich('consequenceWorkItems', { b: bold, count: impact.openWorkItems })}
        </Consequence>
      ) : null}
    </ul>
  );
}

/** `DeleteOrganizationDialog`'s `ConsequenceRow`, verbatim. */
function Consequence({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3 px-3 py-2.5 font-sans text-sm text-(--el-text-secondary)">
      <span className="mt-0.5 shrink-0 text-(--el-text-secondary)">{icon}</span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/**
 * §17.6's remove confirm, verbatim in shape — a title, one paragraph, ghost
 * Cancel and a SECONDARY Remove: nothing is destroyed, so nothing claims a blast
 * radius (§19.5).
 */
function QuietConfirm({
  repo,
  impact,
  pending,
  onOpenChange,
  onCancel,
  onConfirm,
}: {
  repo: string;
  impact: HostedRepositoryRemovalDto;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations('repositoryTakeover.hostedRemove');
  const body =
    impact.repository === 'gone'
      ? t('removeBodyGone', { repo, envCount: impact.environmentValues })
      : impact.repository === 'yours'
        ? t('removeBodyYours', { repo })
        : t('removeBodyNeverCreated');
  return (
    <Modal open onOpenChange={onOpenChange} title={t('removeTitle', { repo })}>
      <div className="flex flex-col gap-4">
        <p className="font-sans text-sm text-(--el-text-secondary)">{body}</p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button type="button" variant="secondary" size="sm" loading={pending} onClick={onConfirm}>
            {t('removeConfirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
