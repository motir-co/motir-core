'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ChevronRight, CircleAlert, ExternalLink, Plus, Search } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Pill } from '@/components/ui/Pill';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { githubInstallationManageUrl } from '@/lib/github/appLinks';
import type {
  GithubAccountForOrganizationDTO,
  GithubAccountRepositoriesDTO,
  GithubAccountsForOrganizationDTO,
} from '@/lib/dto/github';
import { RepoPickerRow, type RepoAvailability } from './RepoPickerRow';
import { NoReposLeftPanel } from './NoReposLeftPanel';
import { accountInitial, accountTypeKey, type GithubAccountRef } from './githubAccounts';

// CONNECT GITHUB — the account picker, then the repo picker, as ONE modal flow
// (Story MOTIR-8216 · MOTIR-8223), built to
// `design/github/github--multi-org-account.mock.html` Panels A2a–A5.
//
// ⚠️ THE RESPONSE SAYS WHAT IS AVAILABLE; THIS FILE NEVER GUESSES. Every row's
// kind comes from `GET …/accounts/{id}/repositories` (MOTIR-8220), and the one
// local override is the 409's own list: a repository another organisation took
// between listing and confirming flips to the locked kind, in place, with its
// sentence under it — and the rest of the selection stays ticked and
// submittable, because the refusal was all-or-nothing on the server.
//
// ⚠️ EVERY RESPONSE CODE MAPS TO ONE MESSAGE, AND AN UNKNOWN ONE TO A GENERIC
// MESSAGE — NEVER A BLANK. The table is `SUBMIT_ERRORS` below.
//
// ⚠️ A DEAD SIGN-IN IS A RECONNECT, NEVER A RETRY (Bug MOTIR-8984). GitHub
// refusing the admin's own token reaches this flow three ways — the accounts
// read's `identity_required` with `reason: 'refused'`, and the repository read's
// and the link's `github_identity_refused` — and all three land on the one
// identity prompt, which links to where the account is reconnected.
//
// ⚠️ IT ONLY ADDS. Removing a repository already has a home that names the
// projects it affects (the inventory row's Disconnect), so the picker says where
// that is instead of growing a second removal.

type AccountsState =
  | { kind: 'loading' }
  | { kind: 'error' }
  // `refused`: a linked identity GitHub no longer accepts (Bug MOTIR-8984) —
  // the same prompt, worded as "reconnect" rather than "connect".
  | { kind: 'identity_required'; refused: boolean }
  | { kind: 'ok'; accounts: GithubAccountForOrganizationDTO[] };

type ReposState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ok'; data: GithubAccountRepositoriesDTO };

type Step = { kind: 'accounts' } | { kind: 'repos'; account: GithubAccountRef };

/** The refusal codes the link route answers with, each with its own sentence. */
const SUBMIT_ERRORS = [
  'repo_selection_required',
  'repository_not_visible',
  'installation_not_accessible',
] as const;
type SubmitError = (typeof SUBMIT_ERRORS)[number] | 'generic';

export interface ConnectGithubFlowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  organizationName: string;
  /** Open straight at this account's repo picker — `Add or remove repositories`. */
  initialAccount: GithubAccountRef | null;
  /** `?github=select_repos`: open at the repo picker of the installation the
   *  round trip named, found in the account list once it loads. */
  initialInstallationId: string | null;
  onLinked: (result: { account: GithubAccountRef; count: number }) => void;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return ((await res.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function ConnectGithubFlow({
  open,
  onOpenChange,
  organizationId,
  organizationName,
  initialAccount,
  initialInstallationId,
  onLinked,
}: ConnectGithubFlowProps) {
  const t = useTranslations('github.picker');
  const tAccounts = useTranslations('github.accounts');
  const tConnect = useTranslations('github.connect');
  const base = `/api/organizations/${encodeURIComponent(organizationId)}/github`;

  const [step, setStep] = useState<Step>({ kind: 'accounts' });
  const [accounts, setAccounts] = useState<AccountsState>({ kind: 'loading' });
  const [repos, setRepos] = useState<ReposState>({ kind: 'loading' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [taken, setTaken] = useState<Map<string, string>>(new Map());
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<SubmitError | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installProblem, setInstallProblem] = useState<'unconfigured' | 'failed' | null>(null);
  // A slow answer for an account the admin already left must not paint over the
  // one they are looking at.
  const reposSeq = useRef(0);
  const accountsSeq = useRef(0);
  const pendingInstallation = useRef<string | null>(null);

  // A PURE read — no state write — so the open effect may call it and apply the
  // answer in a `.then` (the React-19 set-state-in-effect rule; the
  // NotificationDrawer precedent).
  const requestAccounts = useCallback(async (): Promise<AccountsState> => {
    try {
      const res = await fetch(`${base}/accounts`);
      if (!res.ok) return { kind: 'error' };
      const body = (await readJson(res)) as unknown as GithubAccountsForOrganizationDTO;
      if (body.state === 'identity_required') {
        return { kind: 'identity_required', refused: body.reason === 'refused' };
      }
      if (body.state !== 'ok' || !Array.isArray(body.accounts)) return { kind: 'error' };
      const sorted = [...body.accounts].sort((x, y) =>
        x.accountLogin.localeCompare(y.accountLogin),
      );
      return { kind: 'ok', accounts: sorted };
    } catch {
      return { kind: 'error' };
    }
  }, [base]);

  const applyAccounts = (seq: number, next: AccountsState) => {
    if (seq !== accountsSeq.current) return;
    setAccounts(next);
    const wanted = pendingInstallation.current;
    if (next.kind === 'ok' && wanted) {
      pendingInstallation.current = null;
      const match = next.accounts.find((x) => x.installationId === wanted);
      if (match) chooseAccount(match);
    }
  };

  // The repository read or the link found the admin's sign-in dead: back to the
  // accounts step, at the reconnect prompt. Any read still in flight is stale.
  const showIdentityRefused = useCallback(() => {
    reposSeq.current++;
    accountsSeq.current++;
    pendingInstallation.current = null;
    setStep({ kind: 'accounts' });
    setFormError(null);
    setAccounts({ kind: 'identity_required', refused: true });
  }, []);

  const loadAccounts = () => {
    const seq = ++accountsSeq.current;
    setAccounts({ kind: 'loading' });
    void requestAccounts().then((next) => applyAccounts(seq, next));
  };

  const loadRepos = useCallback(
    async (account: GithubAccountRef) => {
      const seq = ++reposSeq.current;
      setRepos({ kind: 'loading' });
      try {
        const res = await fetch(
          `${base}/accounts/${encodeURIComponent(account.installationId)}/repositories`,
        );
        if (seq !== reposSeq.current) return;
        if (!res.ok) {
          const body = await readJson(res);
          if (seq !== reposSeq.current) return;
          if (body.code === 'github_identity_refused') {
            showIdentityRefused();
            return;
          }
          if (body.code === 'installation_not_accessible')
            setFormError('installation_not_accessible');
          setRepos({ kind: 'error' });
          return;
        }
        const data = (await readJson(res)) as unknown as GithubAccountRepositoriesDTO;
        if (seq !== reposSeq.current) return;
        if (!Array.isArray(data.repos)) {
          setRepos({ kind: 'error' });
          return;
        }
        setRepos({ kind: 'ok', data });
      } catch {
        if (seq === reposSeq.current) setRepos({ kind: 'error' });
      }
    },
    [base, showIdentityRefused],
  );

  function chooseAccount(account: GithubAccountRef) {
    setStep({ kind: 'repos', account });
    setSelected(new Set());
    setTaken(new Map());
    setQuery('');
    setFormError(null);
    void loadRepos(account);
  }

  function backToAccounts() {
    reposSeq.current++;
    setStep({ kind: 'accounts' });
    setFormError(null);
    if (accounts.kind !== 'ok') loadAccounts();
  }

  // Each OPEN starts the flow over: the room re-keys this component per open,
  // so every piece of state above starts fresh, and where it starts is the
  // caller's.
  useEffect(() => {
    if (!open) return;
    if (initialAccount) {
      chooseAccount(initialAccount);
      return;
    }
    pendingInstallation.current = initialInstallationId;
    // A fresh mount already reads `loading`.
    const seq = ++accountsSeq.current;
    void requestAccounts().then((next) => applyAccounts(seq, next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const installOther = async () => {
    setInstalling(true);
    setInstallProblem(null);
    try {
      const res = await fetch(`${base}/install-url`);
      const body = await readJson(res);
      if (res.ok && typeof body.url === 'string') {
        window.location.assign(body.url);
        return;
      }
      // A 200 with `url: null` is a deployment with no App registered.
      setInstallProblem(res.ok ? 'unconfigured' : 'failed');
    } catch {
      setInstallProblem('failed');
    } finally {
      setInstalling(false);
    }
  };

  // ── The repo picker's derived state ─────────────────────────────────────────
  const rows = useMemo(() => {
    if (repos.kind !== 'ok') return [];
    return [...repos.data.repos]
      .map((repo) => ({
        ...repo,
        availability: (taken.has(repo.repoId)
          ? 'connected_elsewhere'
          : repo.availability) as RepoAvailability,
      }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  }, [repos, taken]);
  const available = rows.filter((row) => row.availability === 'available');
  const connectedHereIds = rows
    .filter((row) => row.availability === 'connected_here')
    .map((row) => row.repoId);
  const visible = query.trim()
    ? rows.filter((row) => row.fullName.toLowerCase().includes(query.trim().toLowerCase()))
    : rows;
  const allSelected = available.length > 0 && available.every((row) => selected.has(row.repoId));
  // None-left is a fact about what GitHub and the server said, not about the
  // admin's last refusal: a 409 that takes the last available row keeps its
  // sentence on screen rather than swapping the list for a panel.
  const noneLeft = repos.kind === 'ok' && repos.data.counts.available === 0;

  const toggle = (repoId: string, next: boolean) => {
    setSelected((prev) => {
      const out = new Set(prev);
      if (next) out.add(repoId);
      else out.delete(repoId);
      return out;
    });
    setFormError(null);
  };

  const toggleAll = (next: boolean) => {
    setSelected(next ? new Set(available.map((row) => row.repoId)) : new Set());
    setFormError(null);
  };

  const submit = async (account: GithubAccountRef) => {
    const added = available.filter((row) => selected.has(row.repoId)).map((row) => row.repoId);
    if (added.length === 0) {
      setFormError('repo_selection_required');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch(`${base}/installations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // ⚠️ THE BODY IS THE ORGANISATION'S WHOLE SET ON THIS ACCOUNT, not the
        // additions: the link replaces this organisation's repositories with
        // exactly `repoIds`, so leaving out the ones already connected here
        // would release them. The picker only adds, so it sends both.
        body: JSON.stringify({
          installationId: account.installationId,
          repoIds: [...connectedHereIds, ...added],
        }),
      });
      if (res.ok) {
        onLinked({ account, count: added.length });
        return;
      }
      const body = await readJson(res);
      if (res.status === 409 && body.code === 'repository_owned_by_other_organization') {
        const refused = Array.isArray(body.repos)
          ? (body.repos as { repoId: string; fullName: string }[])
          : [];
        setTaken((prev) => {
          const out = new Map(prev);
          for (const repo of refused) {
            out.set(
              repo.repoId,
              t('errors.repository_owned_by_other_organization', { repo: repo.fullName }),
            );
          }
          return out;
        });
        setSelected((prev) => {
          const out = new Set(prev);
          for (const repo of refused) out.delete(repo.repoId);
          return out;
        });
        if (refused.length === 0) setFormError('generic');
        return;
      }
      const code = typeof body.code === 'string' ? body.code : '';
      if (code === 'github_identity_refused') {
        showIdentityRefused();
        return;
      }
      if (code === 'BAD_REQUEST') setFormError('repo_selection_required');
      else if ((SUBMIT_ERRORS as readonly string[]).includes(code))
        setFormError(code as SubmitError);
      else setFormError('generic');
    } catch {
      setFormError('generic');
    } finally {
      setSubmitting(false);
    }
  };

  const formErrorText = (account: GithubAccountRef | null) =>
    formError === null
      ? null
      : formError === 'installation_not_accessible'
        ? t('errors.installation_not_accessible', { account: account?.accountLogin ?? '' })
        : t(`errors.${formError}`);

  const selectedCount = available.filter((row) => selected.has(row.repoId)).length;

  // ── Render ──────────────────────────────────────────────────────────────────
  if (step.kind === 'repos') {
    const account = step.account;
    const errorText = formErrorText(account);
    return (
      <Modal
        open={open}
        onOpenChange={(next) => !submitting && onOpenChange(next)}
        size="lg"
        title={t('reposTitle', { account: account.accountLogin })}
        description={t('reposDescription')}
      >
        <button
          type="button"
          onClick={backToAccounts}
          className="mb-3 inline-flex w-fit items-center gap-1.5 font-sans text-sm font-medium text-(--el-link) hover:text-(--el-link-pressed)"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {t('back')}
        </button>
        <Modal.Body className="gap-3">
          {repos.kind === 'loading' ? (
            <div className="flex flex-col gap-2" aria-busy="true">
              <span role="status" className="sr-only">
                {t('loadingRepos')}
              </span>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-3 px-(--spacing-control-x) py-2">
                  <span className="size-4 rounded-(--radius-control) bg-(--el-muted)" />
                  <span className="h-3 w-48 rounded-(--radius-control) bg-(--el-muted)" />
                </div>
              ))}
            </div>
          ) : repos.kind === 'error' ? (
            <ErrorState
              title={t('reposError.title')}
              description={t('reposError.body', { account: account.accountLogin })}
              retry={() => void loadRepos(account)}
              retryLabel={t('retry')}
            />
          ) : noneLeft ? (
            <NoReposLeftPanel
              accountLogin={account.accountLogin}
              connectedHere={repos.data.counts.connectedHere}
              connectedElsewhere={repos.data.counts.connectedElsewhere}
              manageUrl={githubInstallationManageUrl(account)}
              onChooseAnother={backToAccounts}
            />
          ) : (
            <>
              <Input
                type="search"
                aria-label={t('search')}
                placeholder={t('search')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                addonStart={<Search className="h-4 w-4 text-(--el-icon-muted)" aria-hidden />}
              />
              <div className="flex items-center justify-between gap-3 px-(--spacing-control-x)">
                <Checkbox
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={available.length === 0}
                  label={t('selectAll', { count: available.length })}
                  labelVisible
                  stateLabels={{
                    checked: t('rowState.selected'),
                    unchecked: t('rowState.notSelected'),
                  }}
                />
                <span aria-live="polite" className="font-sans text-sm text-(--el-text-secondary)">
                  {t('selected', { count: selectedCount })}
                </span>
              </div>
              {visible.length === 0 ? (
                <p className="px-(--spacing-control-x) font-sans text-sm text-(--el-text-secondary)">
                  {t('noMatches')}
                </p>
              ) : (
                <ul
                  aria-label={t('reposTitle', { account: account.accountLogin })}
                  className="flex flex-col"
                >
                  {visible.map((row) => (
                    <RepoPickerRow
                      key={row.repoId}
                      fullName={row.fullName}
                      availability={row.availability}
                      checked={selected.has(row.repoId)}
                      onToggle={(next) => toggle(row.repoId, next)}
                      error={taken.get(row.repoId) ?? null}
                    />
                  ))}
                </ul>
              )}
              <p className="font-sans text-sm text-(--el-text-secondary)">
                {t('hint', { org: organizationName })}
              </p>
            </>
          )}
        </Modal.Body>
        <Modal.Footer className="flex-wrap">
          {errorText ? (
            <p
              role="alert"
              className="mr-auto flex items-start gap-1.5 font-sans text-sm text-(--el-danger-on-surface)"
            >
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{errorText}</span>
            </p>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            {t('cancel')}
          </Button>
          {repos.kind === 'ok' && !noneLeft ? (
            <Button
              type="button"
              variant="primary"
              size="sm"
              loading={submitting}
              disabled={selectedCount === 0 || submitting}
              onClick={() => void submit(account)}
            >
              {t('submit', { count: selectedCount })}
            </Button>
          ) : null}
        </Modal.Footer>
      </Modal>
    );
  }

  const installRow = (
    <li>
      <button
        type="button"
        onClick={() => void installOther()}
        disabled={installing}
        aria-busy={installing || undefined}
        className="flex min-h-(--height-control) w-full items-center gap-3 rounded-(--radius-control) border border-dashed border-(--el-button-border) px-(--spacing-control-x) py-(--spacing-control-y) text-left hover:bg-(--el-option-active-bg) disabled:opacity-50"
      >
        <span
          aria-hidden
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-(--el-card-icon-bg) text-(--el-card-icon-fg)"
        >
          <Plus className="h-4 w-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-sans text-sm font-medium text-(--el-text)">
            {t('installOther')}
          </span>
          <span className="font-sans text-xs text-(--el-text-secondary)">
            {t('installOtherMeta')}
          </span>
        </span>
        <ExternalLink className="h-4 w-4 shrink-0 text-(--el-icon-muted)" aria-hidden />
      </button>
    </li>
  );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={t('title')}
      description={t('description', { org: organizationName })}
    >
      <Modal.Body className="gap-3">
        {accounts.kind === 'identity_required' ? (
          <EmptyState
            title={accounts.refused ? t('identity.refusedTitle') : t('identity.title')}
            description={accounts.refused ? t('identity.refusedBody') : t('identity.body')}
            action={
              <a
                href="/settings/account/git"
                className="inline-flex items-center gap-1.5 font-sans text-sm font-medium text-(--el-link) hover:text-(--el-link-pressed)"
              >
                {t('identity.action')}
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              </a>
            }
          />
        ) : (
          <>
            {accounts.kind === 'loading' ? (
              <div className="flex flex-col gap-2" aria-busy="true">
                <span role="status" className="sr-only">
                  {t('loadingAccounts')}
                </span>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-3 px-(--spacing-control-x) py-2">
                    <span className="h-8 w-8 rounded-full bg-(--el-muted)" />
                    <span className="h-3 w-40 rounded-(--radius-control) bg-(--el-muted)" />
                  </div>
                ))}
              </div>
            ) : accounts.kind === 'error' ? (
              <ErrorState
                title={t('accountsError.title')}
                description={t('accountsError.body')}
                retry={() => loadAccounts()}
                retryLabel={t('retry')}
              />
            ) : accounts.accounts.length === 0 ? (
              <EmptyState title={t('noAccounts.title')} description={t('noAccounts.body')} />
            ) : null}
            <ul aria-label={t('accountsLabel')} className="flex flex-col gap-1">
              {accounts.kind === 'ok'
                ? accounts.accounts.map((account) => (
                    <li key={account.installationId}>
                      <button
                        type="button"
                        onClick={() => chooseAccount(account)}
                        className="flex min-h-(--height-control) w-full items-center gap-3 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left hover:bg-(--el-option-active-bg) focus-visible:bg-(--el-option-active-bg) focus-visible:outline-none"
                      >
                        {account.avatarUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element -- a GitHub avatar URL, not a static asset
                          <img
                            src={account.avatarUrl}
                            alt=""
                            className="h-8 w-8 shrink-0 rounded-full"
                          />
                        ) : (
                          <span
                            aria-hidden
                            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-(--el-avatar-fallback) font-sans text-sm font-semibold text-(--el-text-inverted)"
                          >
                            {accountInitial(account.accountLogin)}
                          </span>
                        )}
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate font-sans text-sm font-medium text-(--el-text)">
                            {account.accountLogin}
                          </span>
                          <span className="font-sans text-xs text-(--el-text-secondary)">
                            {account.visibleRepoCount === null
                              ? tAccounts(`type.${accountTypeKey(account.accountType)}`)
                              : t('accountMeta', {
                                  type: tAccounts(`type.${accountTypeKey(account.accountType)}`),
                                  count: account.visibleRepoCount,
                                })}
                          </span>
                        </span>
                        {account.linkState === 'linked_here' ? (
                          <Pill severity="success">{t('linkedHere')}</Pill>
                        ) : (
                          <Pill tone="neutral">{t('notLinked')}</Pill>
                        )}
                        <ChevronRight
                          className="h-4 w-4 shrink-0 text-(--el-icon-muted)"
                          aria-hidden
                        />
                      </button>
                    </li>
                  ))
                : null}
              {installRow}
            </ul>
            {installProblem ? (
              <p role="alert" className="font-sans text-sm text-(--el-danger-on-surface)">
                {installProblem === 'unconfigured'
                  ? tConnect('noInstallHref')
                  : t('errors.generic')}
              </p>
            ) : null}
          </>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
          {t('cancel')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
