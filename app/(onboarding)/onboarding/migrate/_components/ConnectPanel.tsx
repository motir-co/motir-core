'use client';

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  ArrowRight,
  ArrowUpRight,
  Building2,
  Check,
  CheckCircle2,
  Clock,
  CloudOff,
  FolderGit2,
  FolderX,
  GitBranch,
  Hourglass,
  Info,
  Shield,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import { buttonVariants } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { Spinner } from '@/components/ui/Spinner';
import { GithubMark } from '@/components/icons/GithubMark';
import { WARM_CTA, WarmButton as Button } from '@/components/onboarding/layout';
import { cn } from '@/lib/utils/cn';
import { shallowReplace } from '@/lib/navigation/shallowUrl';
import { githubInstallationManageUrl } from '@/lib/github/appLinks';
import {
  GITHUB_BANNER_TONE,
  type GithubBannerStatus,
  type GithubBannerTone,
} from '@/lib/github/bannerStatus';
import type {
  MigrateConnectInstallationAccountDto,
  MigrateConnectStateDto,
} from '@/lib/dto/migrateOnboarding';
import { StepHead } from './StepHead';
import { ExistingAccounts, InstallRow, existingAccountsShown } from './ExistingAccounts';
import { ExistingRepositoryPicker } from './ExistingRepositoryPicker';
import { useAccountRepositories } from './useAccountRepositories';
import { ConnectOutcome } from './ConnectOutcome';
import { useLinkInstallation, type LinkResult } from './useLinkInstallation';
import { useInstalledAccounts } from './useInstalledAccounts';

// THE CONNECT STEP (Story MOTIR-8241 · MOTIR-8475), built on
// `design/onboarding-migrate/` Revision 7 (MOTIR-8469) and its delta mock
// `onboarding-migrate--connect-states.mock.html`, panels 2a–2k.
//
// RENDER, NEVER DERIVE. Two producers decide what the step says, and this file
// is neither of them:
//   - the connect read (`GET …/connect-state`, MOTIR-8472) decides which WORLD
//     the person is in, as ONE `outcome`, never recombined here from booleans;
//   - the install round trip (`/api/github/install/start` → GitHub →
//     `/onboarding/migrate?…&github=<status>`, MOTIR-8471) REPORTS what happened
//     on GitHub, and a report outranks the derivation.
// The only logic of its own is that precedence plus the three states neither
// producer can see: `starting` (the press, until the browser leaves), `waiting`
// (the other tab is open) and `read_failed` (the read itself failed).
//
// NO CONTROL THAT DOES NOTHING. Every state has exactly the one next action the
// design's table names; Continue exists only where the exit gate can pass, and a
// gate that still answers `conflict` re-reads instead of leaving a dead button.

/** The eleven states (Revision 7's rows 1–11, one to one). */
export type ConnectStepState =
  | 'checking'
  | 'preflight'
  | 'starting'
  | 'waiting'
  | 'connected'
  | 'already_connected'
  | 'no_repositories_selected'
  | 'install_cancelled'
  | 'owner_pending'
  | 'failed'
  | 'read_failed';

/** The round-trip statuses this step draws as `failed` — each has its own
 *  `onboardingMigrate.connect.outcome.<status>Title/Hint` copy. */
export type ConnectFailedStatus =
  | 'install_expired'
  | 'install_forbidden'
  | 'install_provider_error'
  | 'install_error'
  | 'repo_unavailable'
  | 'installation_not_accessible'
  | 'not_configured';

/** What a `?github=<status>` REPORT does on this step. TOTAL over the banner
 *  statuses, so a status added to `GITHUB_BANNER_STATUSES` is a type error here
 *  until somebody decides what it means on Connect.
 *   - `read` — the report defers to the read, which alone knows whether usable
 *     repositories exist (`installed`, `repos_updated`, `select_repos`). The
 *     identity-grant statuses (`connected`, `denied`, `state_error`, `error`)
 *     come back from the GitHub sign-in the accounts list offers (MOTIR-8762);
 *     they say nothing about the install, so they defer to the read too — the
 *     accounts read re-reads on that arrival, and `IDENTITY_DECLINED` below is
 *     the one thing a refused sign-in changes.
 *   - `owner_pending` — `setup_action=request`: an owner must approve.
 *   - `install_cancelled` — `install_unbound` from this step's own state: GitHub
 *     came back with nothing installed (a `deny`), which is the cancelled panel's
 *     situation — benign, nothing lost, start again.
 *   - `failed` — the failure family, drawn in its own tone. */
const REPORT_OF_STATUS: Record<
  GithubBannerStatus,
  'read' | 'owner_pending' | 'install_cancelled' | ConnectFailedStatus
> = {
  installed: 'read',
  repos_updated: 'read',
  select_repos: 'read',
  connected: 'read',
  denied: 'read',
  state_error: 'read',
  error: 'read',
  install_requested: 'owner_pending',
  install_unbound: 'install_cancelled',
  install_expired: 'install_expired',
  install_forbidden: 'install_forbidden',
  install_provider_error: 'install_provider_error',
  install_error: 'install_error',
  repo_unavailable: 'repo_unavailable',
  installation_not_accessible: 'installation_not_accessible',
  not_configured: 'not_configured',
  // GitHub refused the person's own sign-in (Bug MOTIR-8984). The accounts read
  // answers `identity_required` for the same dead token, so the existing
  // accounts list already draws the sign-in prompt — the one remedy.
  identity_refused: 'read',
};

/** A report the step holds until the person acts or the read shows something
 *  to continue with. */
export type ConnectReport =
  | { kind: 'owner_pending' }
  | { kind: 'install_cancelled' }
  | { kind: 'failed'; status: ConnectFailedStatus };

/** Read a raw `?github=` value into a report — `null` for no value, an unknown
 *  value (the tone map is the allow-list, as on `GitConnectBanner`) and every
 *  status that defers to the read. */
export function connectReportFrom(raw: string | null | undefined): ConnectReport | null {
  if (!raw || !Object.hasOwn(GITHUB_BANNER_TONE, raw)) return null;
  const meaning = REPORT_OF_STATUS[raw as GithubBannerStatus];
  if (meaning === 'read') return null;
  if (meaning === 'owner_pending' || meaning === 'install_cancelled') return { kind: meaning };
  return { kind: 'failed', status: meaning };
}

/** A sign-in that came back refused or unfinished: the identity prompt stays up
 *  with one benign line (Revision 8, 2o.iv) — never a danger tone. */
const IDENTITY_DECLINED: ReadonlySet<string> = new Set(['denied', 'state_error', 'error']);

/** The send phase — client-only, invisible to both producers. */
type SendPhase = 'idle' | 'starting' | 'waiting';

/**
 * THE PRECEDENCE, as one pure function (the whole of this step's own logic).
 *   1. No run yet, or no read yet → `checking`.
 *   2. The press, until the browser has left → `starting`.
 *   3. A failed read → `read_failed` (never the previous state, silently).
 *   4. Usable repositories → the read's `connected` / `already_connected`. Even a
 *      report does not hide a Continue the gate would pass (an owner who approved
 *      while the person waited is exactly this).
 *   5. A report → `owner_pending` / `install_cancelled` / `failed`.
 *   6. Waiting on the other tab → `waiting`, unless the read already says the
 *      install landed with nothing usable.
 *   7. Otherwise the read's outcome, one to one (`not_started` is the pre-flight).
 */
export function connectStepState(input: {
  hasRun: boolean;
  read: MigrateConnectStateDto | null;
  readFailed: boolean;
  phase: SendPhase;
  report: ConnectReport | null;
}): ConnectStepState {
  const { hasRun, read, readFailed, phase, report } = input;
  if (!hasRun) return 'checking';
  if (phase === 'starting') return 'starting';
  if (readFailed) return 'read_failed';
  if (!read) return 'checking';
  if (read.outcome === 'connected' || read.outcome === 'already_connected') return read.outcome;
  if (report) return report.kind;
  if (phase === 'waiting') {
    return read.outcome === 'no_repositories_selected' ? 'no_repositories_selected' : 'waiting';
  }
  switch (read.outcome) {
    case 'no_repositories_selected':
      return 'no_repositories_selected';
    case 'install_cancelled':
      return 'install_cancelled';
    case 'not_started':
      return 'preflight';
  }
}

/** How often the step re-reads while the other tab is open (Revision 1, 2c). */
export const CONNECT_POLL_MS = 5000;

/** Where the step keeps its `before` token across GitHub's round trip: per tab
 *  (`sessionStorage`), per run. A tab opened by the send inherits a copy. */
export function connectBeforeStorageKey(runId: string): string {
  return `motir.onboarding.connect.before.${runId}`;
}

function loadBefore(runId: string): string | null {
  try {
    return window.sessionStorage.getItem(connectBeforeStorageKey(runId));
  } catch {
    // storage unavailable: the read answers `not_started` instead of
    // `install_cancelled` — the same remedy, so nothing is lost.
    return null;
  }
}

function storeBefore(runId: string, token: string): void {
  try {
    window.sessionStorage.setItem(connectBeforeStorageKey(runId), token);
  } catch {
    // as above
  }
}

/** The round trip's own params — dropped from the step's query once rendered,
 *  so a reload renders from the read alone, and never forwarded on a send. */
const RETURN_PARAMS = ['github', 'installation_id'] as const;

function stepQuery(params: URLSearchParams): URLSearchParams {
  const query = new URLSearchParams(params);
  for (const name of RETURN_PARAMS) query.delete(name);
  return query;
}

/** The install start, carrying the step's own query (the route narrows it). */
export function installStartHref(params: URLSearchParams): string {
  const query = stepQuery(params).toString();
  return `/api/github/install/start${query ? `?${query}` : ''}`;
}

function manageUrlFor(account: MigrateConnectInstallationAccountDto | undefined): string | null {
  if (!account) return null;
  return githubInstallationManageUrl({
    accountLogin: account.accountLogin,
    accountType: account.accountType,
    installationId: account.installationRef,
  });
}

type ReadTrigger = 'arrival' | 'return' | 'poll' | 'retry';

/** The advance's answer, as the wizard reports it. */
export interface ConnectAdvanceResult {
  kind: 'ok' | 'conflict' | 'failed';
}

export function ConnectPanel({
  runId,
  onAdvance,
  busy,
}: {
  /** Null while the run is still being started on arrival (Revision 3). */
  runId: string | null;
  onAdvance: () => Promise<ConnectAdvanceResult>;
  busy: boolean;
}) {
  const t = useTranslations('onboardingMigrate.connect');
  const searchParams = useSearchParams();

  const [read, setRead] = useState<MigrateConnectStateDto | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [phase, setPhase] = useState<SendPhase>('idle');
  // The round trip's report, captured ONCE from the address it returned to.
  const [report, setReport] = useState<ConnectReport | null>(() =>
    connectReportFrom(searchParams.get('github')),
  );
  // Revision 8: the accounts the App is already installed on (MOTIR-8762).
  const accounts = useInstalledAccounts(read?.organizationId ?? null);
  const [identitySkipped, setIdentitySkipped] = useState(false);
  const [identityDeclined] = useState(() =>
    IDENTITY_DECLINED.has(searchParams.get('github') ?? ''),
  );
  // The account whose repositories the picker shows (MOTIR-8763): a pick from
  // the list, or the install round trip's `select_repos` + `installation_id`,
  // read ONCE here beside the report (`select_repos` stays a `read` status
  // there) and dropped from the address with the rest of `RETURN_PARAMS`.
  const [pickTarget, setPickTarget] = useState<{
    installationId: string;
    fromInstall: boolean;
  } | null>(() => {
    const id = searchParams.get('installation_id');
    return searchParams.get('github') === 'select_repos' && id
      ? { installationId: id, fromInstall: true }
      : null;
  });
  const repositories = useAccountRepositories(
    read?.organizationId ?? null,
    pickTarget?.installationId ?? null,
  );
  // The link write and what it last answered (MOTIR-8764).
  const linking = useLinkInstallation(read?.organizationId ?? null);
  const [linkResult, setLinkResult] = useState<LinkResult | null>(null);

  const phaseRef = useRef<SendPhase>('idle');
  const beforeRef = useRef<string | null>(null);
  const beforeLoaded = useRef<string | null>(null);
  const inFlight = useRef(false);
  const seq = useRef(0);

  const enterPhase = useCallback((next: SendPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  // The report is rendered from state, so the address can drop it now: a reload
  // renders from the read alone. A replace, not a push — Back must not return
  // to an address that replays the report.
  useEffect(() => {
    if (!RETURN_PARAMS.some((name) => searchParams.has(name))) return;
    const url = new URL(window.location.href);
    for (const name of RETURN_PARAMS) url.searchParams.delete(name);
    shallowReplace(`${url.pathname}${url.search}${url.hash}`);
  }, [searchParams]);

  const readNow = useCallback(
    async (trigger: ReadTrigger) => {
      if (!runId || inFlight.current) return;
      if (beforeLoaded.current !== runId) {
        beforeLoaded.current = runId;
        beforeRef.current = loadBefore(runId);
      }
      inFlight.current = true;
      const mine = ++seq.current;
      try {
        const before = beforeRef.current;
        const res = await fetch(
          `/api/onboarding/migrate/${runId}/connect-state${
            before ? `?before=${encodeURIComponent(before)}` : ''
          }`,
          { cache: 'no-store' },
        );
        if (!res.ok) throw new Error(`connect-state → ${res.status}`);
        const next = (await res.json()) as MigrateConnectStateDto;
        if (mine !== seq.current) return;
        setRead(next);
        setReadFailed(false);
        if (phaseRef.current === 'starting') {
          // A read landed after the press: the browser has left (or a blocker
          // kept it here) — either way the step is now waiting on GitHub.
          enterPhase('waiting');
        } else if (phaseRef.current === 'waiting') {
          const landed = next.outcome !== 'install_cancelled' && next.outcome !== 'not_started';
          // The person came BACK to this tab and nothing was installed: that is
          // the cancel (2h), computed against the token taken before the send. A
          // poll alone never decides it — they may still be on GitHub.
          if (landed || trigger === 'return' || trigger === 'retry') enterPhase('idle');
        }
      } catch {
        if (mine === seq.current) setReadFailed(true);
      } finally {
        inFlight.current = false;
      }
    },
    [runId, enterPhase],
  );

  // Read on arrival, and again whenever this tab comes back into view.
  useEffect(() => {
    if (!runId) return;
    // Deferred a tick so the first read lands from a callback, like every later
    // one (react-hooks/set-state-in-effect).
    const first = window.setTimeout(() => void readNow('arrival'), 0);
    const onFocus = () => void readNow('return');
    const onVisible = () => {
      if (document.visibilityState === 'visible') void readNow('return');
      // The browser left for GitHub: the press is over, the wait begins.
      else if (phaseRef.current === 'starting') enterPhase('waiting');
    };
    const onBlur = () => {
      if (phaseRef.current === 'starting') enterPhase('waiting');
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(first);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [runId, readNow, enterPhase]);

  // Poll ONLY while a send is out (2c).
  useEffect(() => {
    if (phase === 'idle') return;
    const id = window.setInterval(() => void readNow('poll'), CONNECT_POLL_MS);
    return () => window.clearInterval(id);
  }, [phase, readNow]);

  /** Send the person to GitHub's install screen FROM this step. The tab is
   *  opened inside the click (a popup blocker refuses one after an await), with
   *  the `before` token stored first so the returning tab can echo it. */
  const send = () => {
    if (!runId) return;
    const token = read?.snapshot ?? beforeRef.current;
    if (token) {
      beforeRef.current = token;
      storeBefore(runId, token);
    }
    setReport(null);
    enterPhase('starting');
    const href = installStartHref(new URLSearchParams(window.location.search));
    // No `noopener` in the features: the new tab must inherit this tab's
    // sessionStorage (the token). The opener handle is cut straight after.
    const opened = window.open(href, '_blank');
    if (opened) {
      try {
        opened.opener = null;
      } catch {
        // a cross-origin window may refuse the write; nothing depends on it
      }
    } else {
      // Blocked: leave in THIS tab instead — GitHub returns here with the step's
      // own address, and the token is already in this tab's storage.
      window.location.assign(href);
    }
  };

  const onContinue = () => {
    void onAdvance().then((r) => {
      // The gate did not see the connection yet: read it again rather than
      // leaving the person on a button that silently did nothing.
      if (r.kind === 'conflict') void readNow('retry');
    });
  };

  const state = connectStepState({ hasRun: runId !== null, read, readFailed, phase, report });
  const retry = () => {
    void readNow('retry');
    accounts.reload();
  };
  /** Link the chosen repositories, and say what happened (2s). */
  const confirm = async (chosen: string[]) => {
    if (!pickTarget) return;
    const installationId = pickTarget.installationId;
    // ⚠️ THE BODY IS THIS ORGANISATION'S WHOLE SET ON THE ACCOUNT: the link
    // replaces the organisation's repositories with exactly `repoIds` (it
    // answers `released`), so the ones already connected here ride along —
    // the picker only adds, as Settings' does.
    const here =
      repositories.state.kind === 'ok'
        ? repositories.state.rows
            .filter((r) => r.availability === 'connected_here')
            .map((r) => r.repoId)
        : [];
    setLinkResult(null);
    const result = await linking.link({ installationId, repoIds: [...here, ...chosen] });
    if (!result) return;
    setLinkResult(result);
    switch (result.kind) {
      case 'linked':
        // The connect read decides what is connected now; Continue appears
        // through the same gate a reload would pass.
        setPickTarget(null);
        void readNow('retry');
        break;
      case 'taken':
        repositories.markTaken(result.repos.map((r) => r.repoId));
        repositories.refresh();
        break;
      case 'not_visible':
        repositories.refresh();
        break;
      case 'not_accessible':
        accounts.dropAccount(installationId);
        setPickTarget(null);
        break;
      case 'not_admin':
        setPickTarget(null);
        break;
      case 'selection_required':
      case 'failed':
        break;
    }
  };

  const accountsBlock =
    read !== null && existingAccountsShown(accounts.state, identitySkipped) ? (
      <ExistingAccounts
        state={accounts.state}
        identitySkipped={identitySkipped}
        identityDeclined={identityDeclined}
        onSkipIdentity={() => setIdentitySkipped(true)}
        onRetry={accounts.reload}
        onPickAccount={(installationId) => {
          setLinkResult(null);
          setPickTarget({ installationId, fromInstall: false });
        }}
        onInstall={send}
      />
    ) : null;
  // 2r.ii: the install round trip named an installation this person cannot
  // reach — the picker does not open; the shipped line sits above whatever the
  // accounts read gives, and an install control is always there.
  const arrivalUnreachable =
    pickTarget?.fromInstall === true && repositories.state.kind === 'not_accessible';
  const pickedAccount =
    pickTarget && accounts.state.kind === 'ok'
      ? accounts.state.accounts.find((a) => a.installationId === pickTarget.installationId)
      : undefined;
  const firstRow =
    repositories.state.kind === 'ok' ? repositories.state.rows[0]?.fullName : undefined;
  const pickedLogin =
    pickedAccount?.accountLogin ?? firstRow?.split('/')[0] ?? pickTarget?.installationId ?? '';
  const existing =
    read === null ? null : pickTarget && !arrivalUnreachable ? (
      <ExistingRepositoryPicker
        accountLogin={pickedLogin}
        state={repositories.state}
        selected={repositories.selected}
        taken={repositories.taken}
        fromInstall={pickTarget.fromInstall}
        manageUrl={githubInstallationManageUrl({
          accountLogin: pickedLogin,
          accountType: pickedAccount?.accountType ?? 'User',
          installationId: pickTarget.installationId,
        })}
        onToggle={repositories.toggle}
        onToggleAll={repositories.toggleAll}
        onBack={() => {
          setLinkResult(null);
          setPickTarget(null);
        }}
        onRetry={repositories.refresh}
        confirming={linking.pending}
        notice={
          linkResult && linkResult.kind !== 'linked' ? (
            <ConnectOutcome
              result={linkResult}
              onRetry={() => void confirm([...repositories.selected])}
            />
          ) : null
        }
        onConfirm={(chosen) => void confirm(chosen)}
      />
    ) : arrivalUnreachable ? (
      <>
        <StatusBlock
          pill={{ tone: 'info', label: t('pill.notConnected') }}
          glyph={<Info className="size-4" />}
          title={t('outcome.installation_not_accessibleTitle')}
          hint={t('outcome.installation_not_accessibleHint')}
        />
        {accountsBlock ?? <InstallRow onInstall={send} />}
      </>
    ) : linkResult?.kind === 'not_admin' ? (
      // 2s.vii: the refusal replaces the list; the install row stays.
      <>
        <ConnectOutcome result={linkResult} />
        <InstallRow onInstall={send} />
      </>
    ) : linkResult?.kind === 'not_accessible' ? (
      // 2s.v / 2s.vi: the account is gone from the list, and an install
      // control is there whether or not any account is left.
      <>
        <ConnectOutcome result={linkResult} />
        {accountsBlock ?? <InstallRow onInstall={send} />}
      </>
    ) : (
      accountsBlock
    );
  const account = read?.installation.accounts[0];
  const manageUrl = manageUrlFor(account);
  const repos = read?.repositories ?? [];
  const headingId = useId();

  // A region named by the step's own heading, so the step is one landmark a
  // reader (and a test) can address without reaching past it into the page.
  return (
    <section aria-labelledby={headingId}>
      <StepHead id={headingId} eyebrow={t('eyebrow')} heading={t('heading')} body={t('body')} />
      <Card>
        <div
          data-testid={`connect-state-${state}`}
          data-connect-state={state}
          className="flex min-h-[148px] flex-col gap-3"
          aria-busy={state === 'checking' ? true : undefined}
        >
          <ConnectBody
            state={state}
            report={report}
            repos={repos}
            manageUrl={manageUrl}
            existing={existing}
            linked={linkResult?.kind === 'linked' ? <ConnectOutcome result={linkResult} /> : null}
            onSend={send}
            onRetry={retry}
          />
        </div>
      </Card>
      {state === 'connected' || state === 'already_connected' ? (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {manageUrl ? (
            <a
              href={manageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-(--radius-control) text-sm text-(--el-text-secondary) underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--el-accent-on-surface)"
            >
              <span>{state === 'connected' ? t('manage') : t('alreadyConnectedAddMore')}</span>
              <ArrowUpRight className="size-4" aria-hidden />
              <span className="sr-only"> {t('newTab')}</span>
            </a>
          ) : null}
          <span className="ml-auto">
            <Button
              variant="primary"
              size="md"
              onClick={onContinue}
              loading={busy}
              data-testid="connect-continue"
              rightIcon={<ArrowRight className="size-4" />}
            >
              {t('continue')}
            </Button>
          </span>
        </div>
      ) : null}
    </section>
  );
}

// ── The card's body, per state ─────────────────────────────────────────────

type Tone = GithubBannerTone;

/** A failed status's way forward: the install again, the same install as a
 *  retry, the repository selection on GitHub, or nothing that would work. */
const FAILED_ACTION: Record<ConnectFailedStatus, 'connect' | 'tryAgain' | 'chooseRepos' | null> = {
  install_expired: 'connect',
  install_forbidden: 'connect',
  install_provider_error: 'tryAgain',
  install_error: 'connect',
  repo_unavailable: 'chooseRepos',
  installation_not_accessible: 'connect',
  // No App on this deployment: another press would land right back here.
  not_configured: null,
};

function ConnectBody({
  state,
  report,
  repos,
  manageUrl,
  existing,
  linked,
  onSend,
  onRetry,
}: {
  state: ConnectStepState;
  report: ConnectReport | null;
  repos: MigrateConnectStateDto['repositories'];
  manageUrl: string | null;
  /** The already-installed accounts (Revision 8), or null when they add nothing
   *  — an empty list, a skipped sign-in. When present it OWNS the install
   *  control (its install row), so a state drops its own install button. */
  existing: ReactNode | null;
  /** 2s.i: the link landed — said above the connected summary. */
  linked: ReactNode | null;
  onSend: () => void;
  onRetry: () => void;
}) {
  const t = useTranslations('onboardingMigrate.connect');
  const gitlabNote = <p className="m-0 text-xs text-(--el-text-secondary)">{t('gitlabNote')}</p>;

  switch (state) {
    case 'checking':
      return (
        <p
          role="status"
          className="m-0 flex items-center gap-2.5 text-sm text-(--el-text-secondary)"
        >
          <span aria-hidden className="flex-none text-(--el-highlight)">
            <Spinner size="sm" />
          </span>
          {t('checking')}
        </p>
      );

    case 'preflight':
    case 'starting':
    case 'install_cancelled':
      // 2l / 2t.iii: the list leads; a cancel keeps its line below it, and the
      // list's install row is the retry.
      if (existing && state !== 'starting') {
        return (
          <>
            {existing}
            {state === 'install_cancelled' ? (
              <StatusBlock
                glyph={<Undo2 className="size-4" />}
                title={t('cancelledTitle')}
                hint={t('cancelledHint')}
              />
            ) : null}
            {gitlabNote}
          </>
        );
      }
      // No accounts (2n), or the press is out: the shipped pre-flight.
      return (
        <>
          {state === 'install_cancelled' ? (
            <StatusBlock
              glyph={<Undo2 className="size-4" />}
              title={t('cancelledTitle')}
              hint={t('cancelledHint')}
            />
          ) : (
            <StatusBlock
              glyph={<GitBranch className="size-4" />}
              title={t('missingTitle')}
              hint={t('missingHint')}
            />
          )}
          <Preflight />
          <span>
            <Button
              variant="primary"
              size="md"
              onClick={onSend}
              loading={state === 'starting'}
              data-testid="connect-start"
              rightIcon={<ArrowUpRight className="size-4" />}
            >
              {state === 'starting' ? t('starting') : t('preflightCta')}
              {state === 'starting' ? null : <span className="sr-only"> {t('newTab')}</span>}
            </Button>
          </span>
          {gitlabNote}
        </>
      );

    case 'waiting':
      return (
        <>
          <StatusBlock
            glyph={<Spinner size="sm" />}
            glyphClassName="text-(--el-highlight)"
            title={t('waitingTitle')}
            hint={t('waitingHint')}
          />
          <span>
            <Button
              variant="secondary"
              size="md"
              onClick={onSend}
              rightIcon={<ArrowUpRight className="size-4" />}
            >
              {t('reopenCta')}
              <span className="sr-only"> {t('newTab')}</span>
            </Button>
          </span>
          {gitlabNote}
        </>
      );

    case 'connected':
    case 'already_connected':
      return (
        <>
          {linked}
          <StatusBlock
            pill={{
              tone: 'success',
              label: state === 'connected' ? t('pill.connected') : t('pill.alreadyConnected'),
            }}
            glyph={<CheckCircle2 className="size-4" />}
            glyphClassName="text-(--el-success)"
            title={
              state === 'connected'
                ? t('detected', { count: repos.length })
                : t('alreadyConnectedTitle')
            }
            hint={state === 'connected' ? t('detectedHint') : t('alreadyConnectedHint')}
          />
          <RepoList repos={repos} />
          {state === 'already_connected' ? existing : null}
        </>
      );

    case 'no_repositories_selected':
      return (
        <>
          {existing}
          <StatusBlock
            pill={{ tone: GITHUB_BANNER_TONE.select_repos, label: t('pill.chooseRepos') }}
            glyph={<FolderX className="size-4" />}
            title={t('noReposTitle')}
            hint={t('noReposHint')}
          />
          {manageUrl ? (
            <ChooseReposLink href={manageUrl} />
          ) : existing ? null : (
            <SendButton onSend={onSend} label={t('preflightCta')} />
          )}
          {gitlabNote}
        </>
      );

    case 'owner_pending':
      return (
        <>
          {existing}
          <StatusBlock
            pill={{ tone: GITHUB_BANNER_TONE.install_requested, label: t('pill.ownerPending') }}
            glyph={<Hourglass className="size-4" />}
            title={t('ownerPendingTitle')}
            hint={t('ownerPendingHint')}
          />
          {existing ? null : (
            <span>
              <Button
                variant="secondary"
                size="md"
                onClick={onSend}
                rightIcon={<ArrowUpRight className="size-4" />}
              >
                {t('ownerPendingOpenCta')}
                <span className="sr-only"> {t('newTab')}</span>
              </Button>
            </span>
          )}
        </>
      );

    case 'failed': {
      // `failed` is only ever reached with a failed report (connectStepState).
      const status: ConnectFailedStatus =
        report?.kind === 'failed' ? report.status : 'install_error';
      const tone = GITHUB_BANNER_TONE[status];
      const action = FAILED_ACTION[status];
      return (
        <>
          <StatusBlock
            pill={{
              tone,
              label: status === 'install_expired' ? t('pill.expired') : t('pill.notConnected'),
            }}
            glyph={
              tone === 'danger' ? (
                <TriangleAlert className="size-4" />
              ) : status === 'install_expired' ? (
                <Clock className="size-4" />
              ) : (
                <Info className="size-4" />
              )
            }
            glyphClassName={tone === 'danger' ? 'text-(--el-danger-on-surface)' : undefined}
            title={t(`outcome.${status}Title`)}
            hint={t(`outcome.${status}Hint`)}
          />
          {action === 'chooseRepos' && manageUrl ? (
            <ChooseReposLink href={manageUrl} />
          ) : action && existing ? (
            // 2r.ii: the line stays above whatever the accounts read gives, and
            // the list's install row is the way forward.
            existing
          ) : action === 'tryAgain' ? (
            <SendButton onSend={onSend} label={t('tryAgainCta')} />
          ) : action ? (
            <SendButton onSend={onSend} label={t('preflightCta')} />
          ) : null}
          {gitlabNote}
        </>
      );
    }

    case 'read_failed':
      return (
        <>
          <StatusBlock
            glyph={<CloudOff className="size-4" />}
            title={t('readFailedTitle')}
            hint={t('readFailedHint')}
          />
          <span>
            <Button variant="secondary" size="md" onClick={onRetry} data-testid="connect-retry">
              {t('recheckCta')}
            </Button>
          </span>
          {existing}
          {gitlabNote}
        </>
      );
  }
}

/** One polite status region: an optional tone chip (glyph + label — never
 *  colour alone), the state's own glyph and title, and its hint. */
function StatusBlock({
  pill,
  glyph,
  glyphClassName,
  title,
  hint,
}: {
  pill?: { tone: Tone; label: string };
  glyph: ReactNode;
  glyphClassName?: string;
  title: string;
  hint: string;
}) {
  return (
    <div role="status" className="grid gap-1">
      {pill ? (
        <span className="mb-1">
          <Pill severity={pill.tone} data-tone={pill.tone}>
            <PillGlyph tone={pill.tone} />
            {pill.label}
          </Pill>
        </span>
      ) : null}
      <p className="m-0 flex items-center gap-2.5 text-sm font-semibold text-(--el-text)">
        <span
          aria-hidden
          className={cn('flex flex-none text-(--el-text-secondary)', glyphClassName)}
        >
          {glyph}
        </span>
        {title}
      </p>
      <p className="m-0 max-w-[60ch] text-sm leading-normal text-(--el-text-secondary)">{hint}</p>
    </div>
  );
}

function PillGlyph({ tone }: { tone: Tone }) {
  const className = 'size-3.5 flex-none';
  if (tone === 'success') return <Check className={className} aria-hidden />;
  if (tone === 'danger') return <TriangleAlert className={className} aria-hidden />;
  return <Info className={className} aria-hidden />;
}

/** The pre-flight (2b, repeated under 2h): what GitHub will ask, before the
 *  person leaves — the account, all-or-some repositories, the access, and that
 *  GitHub sends them straight back here. */
function Preflight() {
  const t = useTranslations('onboardingMigrate.connect');
  const rows: { glyph: ReactNode; text: string }[] = [
    { glyph: <Building2 className="size-4" />, text: t('preflightAccount') },
    { glyph: <FolderGit2 className="size-4" />, text: t('preflightRepositories') },
    { glyph: <Shield className="size-4" />, text: t('preflightAccess') },
  ];
  return (
    <div data-testid="connect-preflight" className="grid gap-3">
      <ol className="m-0 grid list-none gap-3 p-0">
        {rows.map((row, i) => (
          <li key={i} className="flex items-start gap-3">
            <span
              aria-hidden
              className="grid size-6 flex-none place-items-center rounded-full border border-(--el-border) font-mono text-xs text-(--el-text-secondary)"
            >
              {i + 1}
            </span>
            <span aria-hidden className="mt-1 flex flex-none text-(--el-text-secondary)">
              {row.glyph}
            </span>
            <p className="m-0 max-w-[60ch] pt-0.5 text-sm leading-normal text-(--el-text)">
              {row.text}
            </p>
          </li>
        ))}
      </ol>
      <p className="m-0 max-w-[60ch] text-sm leading-normal text-(--el-text-secondary)">
        {t('preflightReturn')}
      </p>
    </div>
  );
}

function SendButton({ onSend, label }: { onSend: () => void; label: string }) {
  const t = useTranslations('onboardingMigrate.connect');
  return (
    <span>
      <Button
        variant="primary"
        size="md"
        onClick={onSend}
        data-testid="connect-start"
        rightIcon={<ArrowUpRight className="size-4" />}
      >
        {label}
        <span className="sr-only"> {t('newTab')}</span>
      </Button>
    </span>
  );
}

/** The repository selection lives on the installation's own page on GitHub
 *  (F1: never Motir's settings). The step re-reads when the tab returns. */
function ChooseReposLink({ href }: { href: string }) {
  const t = useTranslations('onboardingMigrate.connect');
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(buttonVariants({ variant: 'primary', size: 'md' }), 'w-fit gap-2', WARM_CTA)}
    >
      <span>{t('changeReposCta')}</span>
      <ArrowUpRight className="size-4" aria-hidden />
      <span className="sr-only"> {t('newTab')}</span>
    </a>
  );
}

function RepoList({ repos }: { repos: MigrateConnectStateDto['repositories'] }) {
  const t = useTranslations('onboardingMigrate.connect');
  return (
    <ul aria-label={t('listLabel')} className="m-0 flex list-none flex-col gap-2 p-0">
      {repos.map((repo) => {
        const [owner, ...rest] = repo.repoRef.split('/');
        const name = rest.join('/') || repo.repoRef;
        return (
          <li
            key={`${repo.provider}:${repo.repoRef}`}
            className="flex items-center gap-3 rounded-(--radius-control) border border-(--el-border-soft) px-(--spacing-control-x) py-(--spacing-control-y-8)"
          >
            <span className="flex flex-none items-center text-(--el-text-secondary)">
              {repo.provider === 'github' ? (
                <>
                  <GithubMark className="size-4" />
                  <span className="sr-only">{t('providerGithub')}</span>
                </>
              ) : (
                <GitBranch className="size-4" aria-hidden />
              )}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-(--el-text)">
              {rest.length > 0 ? (
                <span className="text-(--el-text-secondary)">{owner}/</span>
              ) : null}
              {name}
            </span>
            <Check className="size-4 flex-none text-(--el-success)" aria-hidden />
          </li>
        );
      })}
    </ul>
  );
}
