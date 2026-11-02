'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import {
  CircleAlert,
  CircleCheckBig,
  CircleX,
  Clock,
  KeyRound,
  ShieldAlert,
  Terminal,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Combobox } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/utils/cn';
import { CLI_TOKEN_EXPIRY_DAYS, DEVICE_CODE_EXPIRES_MINUTES } from '@/lib/cliDevice/constants';
import { formatUserCode, isCompleteUserCode, normalizeUserCode } from '@/lib/cliDevice/userCode';
import type { DeviceGrantDescriptionDTO } from '@/lib/dto/cliDevice';
import { AuthShell, CodeChip } from '../../_components/AuthShell';
import {
  grantedPermissionMeta,
  type PermissionMeta,
} from '@/app/(authed)/settings/account/_components/permissionMeta';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { permissionSlug } from '@/lib/permissions/catalog';
import {
  PermissionChangeSummary,
  diffGrant,
} from '@/app/(authed)/settings/account/_components/PermissionChangeSummary';

// The `/device` page's interactive half (Story MOTIR-1863 · Subtask MOTIR-1867),
// built to `design/cli-connect/` Panels 1–7. One island, six states, because they
// are one flow over one code and splitting them across routes would lose the code
// on every hop.
//
// IT ADDS NO ENDPOINT (the card's scope boundary). Three calls, all shipped:
//   GET  /api/cli/device/grant?user_code=…  — MOTIR-1888. Describes the grant AND
//        CLAIMS it (Better-Auth's verify read is the claim), which is why it runs on
//        Continue rather than on mount: claiming is a side effect, and the design
//        makes the human check the code against their terminal first.
//   POST /api/cli/device/approve            — MOTIR-1865. Binds the workspace, mints.
//   POST /api/auth/device/deny              — the plugin's own endpoint, which
//        `lib/auth/index.ts` documents as one of the two called from outside. Deny
//        needs no Motir-side write (nothing is minted), so there is no wrapper to
//        add and adding one would be the improvised route the card forbids.
//
// THERE IS NO UNHANDLED BRANCH. A dead end here strands a terminal that is still
// polling, so every failure resolves to a screen with a way forward: an unroutable
// error becomes a banner on a screen the user can act from, never a blank card.

/** Every screen this island can be on — design's "six states", with `expired` and
 *  `unknown` drawn as one screen with two copies (Panel 7). */
type Phase = 'entry' | 'confirm' | 'approved' | 'denied' | 'expired' | 'unknown';

export interface DeviceApprovalProps {
  /** From `?user_code=` — the `verification_uri_complete` the CLI opened. */
  initialUserCode: string;
  user: { name: string; email: string; image: string | null };
  /** The workspaces this user may bind a token in, labelled `org · workspace`. */
  workspaces: { id: string; label: string }[];
  activeWorkspaceId: string | null;
}

/** What the page does with a non-OK response, once the status + code are known. */
type Failure =
  | { kind: 'phase'; phase: Phase }
  | { kind: 'message'; message: string }
  | { kind: 'signin' }
  | { kind: 'refresh' };

export function DeviceApproval({
  initialUserCode,
  user,
  workspaces,
  activeWorkspaceId,
}: DeviceApprovalProps) {
  const t = useTranslations('device');
  // `motir auth refresh`'s copy (MOTIR-10189, design
  // `account-settings--edit-token-permissions.mock.html` Panels 10–13): the same
  // island and the same flow, with an UPDATE grant's own words.
  const tu = useTranslations('device.update');
  const format = useFormatter();
  const router = useRouter();

  const arrivedPrefilled = normalizeUserCode(initialUserCode).length > 0;
  const [phase, setPhase] = useState<Phase>('entry');
  const [code, setCode] = useState(() => formatUserCode(initialUserCode));
  const [grant, setGrant] = useState<DeviceGrantDescriptionDTO | null>(null);
  /**
   * The instant the grant was READ, which is what "asked 12 seconds ago" is relative
   * to. Explicit, and not the app-wide `now`: `i18n/request.ts` pins ONE `now` per
   * request so SSR and the client agree on every other surface (the finding-#89
   * hydration fix), but that instant is page LOAD — and a reader who sits on the
   * entry screen for five minutes before pressing Continue would be told the code
   * was asked for in the FUTURE. On this screen the freshness cue is a security
   * signal, so it is measured from the read, not from the page.
   */
  const [describedAt, setDescribedAt] = useState<Date | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(() =>
    pickDefaultWorkspace(workspaces, activeWorkspaceId),
  );
  /** The workspace label as it stood at APPROVAL — the approved screen names it, and
   *  the picker must not be able to rewrite history behind that sentence. */
  const [approvedWorkspace, setApprovedWorkspace] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState('');
  const [pageError, setPageError] = useState('');

  const canonical = normalizeUserCode(code);

  // Where sign-in must return to if the session evaporates mid-flow — the same
  // round trip `DeviceSignedOut` builds, so a session that expires between arrival
  // and Approve costs the user a sign-in, not the code.
  const signInHref = `/sign-in?next=${encodeURIComponent(
    canonical ? `/device?user_code=${canonical}` : '/device',
  )}`;

  // Focus the code field whenever the user is being asked for a code — on arrival,
  // and again after "Enter another code" / "Try again" put them back on entry. Not
  // the `autoFocus` attribute: that fires only on mount, so the re-entry paths (the
  // ones where the user has already been told something went wrong) would leave
  // focus stranded on a button that no longer exists.
  const codeRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (phase === 'entry' || phase === 'unknown') codeRef.current?.focus();
  }, [phase]);

  /**
   * Translate a failed response into what the page should DO. Every status the
   * three endpoints document is listed; the fall-through is a real screen, not a
   * throw, because a terminal is waiting on this page either way.
   */
  const classify = useCallback(
    (status: number, errorCode: string | null): Failure => {
      if (status === 401) return { kind: 'signin' };
      if (status === 404) return { kind: 'phase', phase: 'unknown' };
      if (status === 410) return { kind: 'phase', phase: 'expired' };
      if (status === 403) {
        // The membership refusal the AC calls for — surfaced as a real message on
        // the confirm screen, where the picker that caused it still is.
        if (errorCode === 'WORKSPACE_FORBIDDEN')
          return { kind: 'message', message: t('errors.workspaceForbidden') };
        return { kind: 'message', message: t('errors.claimedByOther') };
      }
      if (status === 409) {
        if (errorCode === 'DEVICE_GRANT_NOT_CLAIMED')
          return { kind: 'message', message: t('errors.notClaimed') };
        // Already approved or already denied. Which one is a fact the server holds,
        // so re-read rather than guess — that lands the user on the true terminal
        // screen instead of a message about a state they are already past.
        return { kind: 'refresh' };
      }
      return { kind: 'message', message: t('errors.unexpected') };
    },
    [t],
  );

  /** Read the grant. Also CLAIMS it — see the module note. */
  const describe = useCallback(async (userCode: string) => {
    const res = await fetch(`/api/cli/device/grant?user_code=${encodeURIComponent(userCode)}`, {
      headers: { Accept: 'application/json' },
    });
    if (res.ok)
      return { ok: true as const, grant: (await res.json()) as DeviceGrantDescriptionDTO };
    return { ok: false as const, status: res.status, code: await readErrorCode(res) };
  }, []);

  const applyFailure = useCallback(
    (failure: Failure) => {
      if (failure.kind === 'signin') {
        router.push(signInHref);
        return;
      }
      if (failure.kind === 'phase') {
        setPhase(failure.phase);
        return;
      }
      if (failure.kind === 'message') {
        setPageError(failure.message);
      }
    },
    [router, signInHref],
  );

  /**
   * Re-read the grant and route to whatever state it is REALLY in. The recovery path
   * for "the server says this is no longer pending" — the state changed underneath
   * this tab (another tab approved it, the CLI gave up, the code aged out), and the
   * server is the only authority on which of the three it became.
   */
  const refreshState = useCallback(
    async (userCode: string) => {
      let result;
      try {
        result = await describe(userCode);
      } catch {
        setPageError(t('errors.network'));
        return;
      }
      if (!result.ok) {
        applyFailure(classify(result.status, result.code));
        return;
      }
      setGrant(result.grant);
      setDescribedAt(new Date());
      if (result.grant.status === 'approved') {
        setApprovedWorkspace(null);
        setPhase('approved');
      } else if (result.grant.status === 'denied') {
        setPhase('denied');
      } else {
        setPhase('confirm');
      }
    },
    [applyFailure, classify, describe, t],
  );

  /** Continue — the entry screen's only action. */
  async function handleContinue(event: FormEvent) {
    event.preventDefault();
    setFieldError('');
    setPageError('');
    if (!isCompleteUserCode(code)) {
      setFieldError(t('code.incomplete'));
      return;
    }
    setBusy(true);
    try {
      const result = await describe(canonical);
      if (!result.ok) {
        applyFailure(classify(result.status, result.code));
        return;
      }
      setGrant(result.grant);
      setDescribedAt(new Date());
      // Echo the form the SERVER matched, not what was typed.
      setCode(formatUserCode(result.grant.userCode));
      if (result.grant.status === 'approved') setPhase('approved');
      else if (result.grant.status === 'denied') setPhase('denied');
      else setPhase('confirm');
    } catch {
      setPageError(t('errors.network'));
    } finally {
      setBusy(false);
    }
  }

  async function handleApprove() {
    // An UPDATE grant binds nothing: the token it changes already has its
    // workspace, so the approval names none.
    const updating = grant?.update ?? null;
    if (!updating && !workspaceId) return;
    setPageError('');
    setBusy(true);
    const chosen = updating
      ? updating.workspaceName
      : (workspaces.find((w) => w.id === workspaceId)?.label ?? null);
    try {
      const res = await fetch('/api/cli/device/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          updating ? { userCode: canonical } : { userCode: canonical, workspaceId },
        ),
      });
      if (res.ok) {
        setApprovedWorkspace(chosen);
        setPhase('approved');
        return;
      }
      const errorCode = await readErrorCode(res);
      // The token could not be updated — it was revoked, is not this person's, or
      // the approval came from a staff session. The server DENIED the grant, so the
      // terminal has already been told; this screen says the same: nothing changed.
      if (errorCode === 'DEVICE_UPDATE_REFUSED') {
        setPhase('denied');
        return;
      }
      const failure = classify(res.status, errorCode);
      if (failure.kind === 'refresh') await refreshState(canonical);
      else applyFailure(failure);
    } catch {
      setPageError(t('errors.network'));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeny() {
    setPageError('');
    setBusy(true);
    try {
      // The plugin's own endpoint, and its own body shape (`userCode`, camelCase —
      // this one is not an RFC 8628 payload). It answers `{ error }` on failure, not
      // Motir's `{ code }`, so every non-OK response re-reads rather than trying to
      // map a vocabulary this page does not own.
      const res = await fetch('/api/auth/device/deny', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userCode: canonical }),
      });
      if (res.ok) {
        setPhase('denied');
        return;
      }
      if (res.status === 401) {
        router.push(signInHref);
        return;
      }
      await refreshState(canonical);
    } catch {
      setPageError(t('errors.network'));
    } finally {
      setBusy(false);
    }
  }

  /** Back to a blank field — the forward path out of every terminal state. */
  function restart() {
    setPhase('entry');
    setGrant(null);
    setDescribedAt(null);
    setApprovedWorkspace(null);
    setCode('');
    setFieldError('');
    setPageError('');
  }

  async function handleSignOutAndSwitch() {
    setBusy(true);
    // Imported lazily: `lib/auth/client` is only needed on the one path where the
    // reader is NOT the person the terminal belongs to.
    const { signOut } = await import('@/lib/auth/client');
    await signOut();
    router.push(signInHref);
    router.refresh();
  }

  const hostname = grant?.hostname ?? null;
  const banner = pageError ? <ErrorBanner>{pageError}</ErrorBanner> : null;

  // ── State 1 — code entry (Panels 1 + 2) ──────────────────────────────────────
  if (phase === 'entry' || phase === 'unknown') {
    const isUnknown = phase === 'unknown';
    return (
      <AuthShell
        headline={isUnknown ? t('heading.unknown') : t('heading.entry')}
        subhead={
          isUnknown
            ? t('subhead.unknown')
            : arrivedPrefilled
              ? t('subhead.entryPrefilled')
              : t('subhead.entry')
        }
      >
        <form className="flex flex-col gap-5" onSubmit={handleContinue}>
          {banner}
          {isUnknown ? (
            <Callout tone="warn" icon={<CircleAlert className="h-5 w-5" aria-hidden />}>
              {t.rich('unknown.body', {
                minutes: DEVICE_CODE_EXPIRES_MINUTES,
                cmd: (chunks) => <Cmd>{chunks}</Cmd>,
              })}
            </Callout>
          ) : null}

          <Input
            ref={codeRef}
            id="device-user-code"
            label={t('code.label')}
            placeholder={t('code.placeholder')}
            value={code}
            onChange={(event) => {
              setCode(formatUserCode(event.target.value));
              setFieldError('');
            }}
            error={fieldError || undefined}
            helperText={
              isUnknown
                ? t('code.helperTypo')
                : arrivedPrefilled
                  ? t('code.helperPrefilled')
                  : t('code.helper')
            }
            inputMode="text"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            // 9 = the 8 code characters plus the grouping dash the field inserts.
            maxLength={9}
            // The mock's `.codefield`: mono, centred, widely tracked, so the eight
            // characters read as a code to compare against a terminal rather than
            // as prose. Height stays the `Input` primitive's `--height-input`; the
            // mock's taller box is a detail the primitive owns.
            className="text-center font-mono text-xl tracking-[0.22em]"
          />

          <Button type="submit" size="lg" loading={busy} className="w-full">
            {busy ? t('checking') : isUnknown ? t('unknown.retry') : t('continue')}
          </Button>
        </form>

        {isUnknown ? null : (
          <p className="text-(--el-text-muted) font-sans text-xs leading-relaxed">
            {t.rich('foot.notYou', { cmd: (chunks) => <Cmd>{chunks}</Cmd> })}
          </p>
        )}
      </AuthShell>
    );
  }

  // ── State 2u — CONFIRM an UPDATE (`motir auth refresh`, MOTIR-10189 Panel 10). The
  //    same defence, naming the token that changes instead of a terminal connecting.
  const update = grant?.update ?? null;
  if (phase === 'confirm' && update) {
    const { added, removed } = diffGrant(update.permissions, CLI_TOKEN_GRANT);
    const unchanged = CLI_TOKEN_GRANT.filter((k) => update.permissions.includes(k)).length;
    const expiresInDays = update.expiresAt
      ? Math.max(
          0,
          Math.ceil(
            (new Date(update.expiresAt).getTime() - (describedAt ?? new Date()).getTime()) / DAY_MS,
          ),
        )
      : null;
    return (
      <div data-auth-wide>
        <AuthShell headline={tu('heading')} subhead={tu('subhead')} tight>
          <div className="flex flex-col gap-3">
            {banner}
            <div className="grid rounded-(--radius-card) border border-(--el-border) sm:grid-cols-2">
              <DetailColumn>
                <DetailBlock label={t('confirm.you')}>
                  <WhoIsApproving user={user} busy={busy} onSwitch={handleSignOutAndSwitch} />
                </DetailBlock>
                {/* WHICH TOKEN changes — its label, its display prefix, and the code
                    with its freshness cue. Same secret: nothing is handed over. */}
                <DetailBlock label={tu('updating')}>
                  <span className="flex items-center gap-2 font-sans text-sm font-medium text-(--el-text)">
                    <Terminal className="text-(--el-text-muted) h-4 w-4 shrink-0" aria-hidden />
                    <span className="truncate">{update.label}</span>
                  </span>
                  <DetailSub>
                    {tu.rich('tokenSub', {
                      prefix: update.tokenPrefix,
                      chip: (chunks) => <CodeChip>{chunks}</CodeChip>,
                    })}
                  </DetailSub>
                  <DetailSub>
                    {tu.rich('askedAgo', {
                      code: formatUserCode(grant?.userCode ?? canonical),
                      ago:
                        grant && describedAt
                          ? format.relativeTime(new Date(grant.askedAt), describedAt)
                          : '',
                      chip: (chunks) => <CodeChip>{chunks}</CodeChip>,
                    })}
                  </DetailSub>
                </DetailBlock>
                {/* The token's workspace — fixed, so a fact rather than a picker. */}
                <DetailBlock label={t('confirm.workspace')}>
                  <span className="line-clamp-2 font-sans text-sm font-medium text-(--el-text)">
                    {update.workspaceName}
                  </span>
                  <DetailSub>{tu('workspaceSub')}</DetailSub>
                </DetailBlock>
                {expiresInDays !== null ? (
                  <DetailBlock label={t('confirm.expires')}>
                    <span className="font-sans text-sm font-medium text-(--el-text)">
                      {tu('expiresValue', { days: expiresInDays })}
                    </span>
                    <DetailSub>{tu('expiresSub')}</DetailSub>
                  </DetailBlock>
                ) : null}
              </DetailColumn>
              <DetailColumn divided>
                {/* WHAT CHANGES, against `CLI_TOKEN_GRANT` — shorter than the login
                    screen's full list, which is what keeps this inside the fold. */}
                <DetailBlock label={tu('changes')}>
                  <PermissionChangeSummary added={added} removed={removed} compact />
                  <DetailSub>{tu('unchanged', { count: unchanged })}</DetailSub>
                  <DetailSub>{t('confirm.cant')}</DetailSub>
                </DetailBlock>
              </DetailColumn>
            </div>

            <Callout tone="warn" icon={<ShieldAlert className="h-5 w-5" aria-hidden />}>
              {tu.rich('warning', {
                hostname: hostname ?? update.label,
                cmd: (chunks) => <Cmd>{chunks}</Cmd>,
                strong: (chunks) => <strong className="font-semibold">{chunks}</strong>,
              })}
            </Callout>

            <div role="group" aria-label={tu('actions')} className="flex gap-3">
              <Button
                variant="secondary"
                size="lg"
                onClick={handleDeny}
                disabled={busy}
                leftIcon={<CircleX className="h-4 w-4" />}
                className="w-full border-(--el-danger)"
              >
                {tu('deny')}
              </Button>
              <Button size="lg" onClick={handleApprove} loading={busy} className="w-full">
                {tu('approve')}
              </Button>
            </div>
          </div>
        </AuthShell>
      </div>
    );
  }

  // ── State 2 — CONFIRM (Panels 3 + 4). The phishing defence. ──────────────────
  if (phase === 'confirm') {
    const multiWorkspace = workspaces.length > 1;
    return (
      // `data-auth-wide` widens the (auth) column to 40rem — see that layout. The
      // two-column detail block is what keeps the four facts AND both buttons above
      // the fold at 648px, which is the whole reason this screen works.
      <div data-auth-wide>
        <AuthShell headline={t('heading.confirm')} subhead={t('subhead.confirm')} tight>
          <div className="flex flex-col gap-3">
            {banner}

            {/* TWO COLUMNS, not a row-flowing grid — the mock's `.detail.cols` is a
                pair of column CONTAINERS, and the difference is 200px of height:
                row-flowed cells stretch each row to its tallest cell, which opens a
                dead gap under WHO to match the scope rows opposite. Measured
                in Chromium at 1366×648 before and after. Which block sits in which
                column is ALSO a measurement — see Expires below. */}
            <div className="grid rounded-(--radius-card) border border-(--el-border) sm:grid-cols-2">
              <DetailColumn>
                {/* 1 — WHO */}
                <DetailBlock label={t('confirm.you')}>
                  <WhoIsApproving user={user} busy={busy} onSwitch={handleSignOutAndSwitch} />
                </DetailBlock>

                {/* 2 — WHAT is connecting. `hostname` is attacker-suppliable text
                    the substrate never interprets, so it is rendered as data, never
                    as a claim about identity. */}
                <DetailBlock label={t('confirm.connecting')}>
                  <span className="flex items-center gap-2 font-sans text-sm font-medium text-(--el-text)">
                    <Terminal className="text-(--el-text-muted) h-4 w-4 shrink-0" aria-hidden />
                    <span className="truncate">
                      {hostname ? t('confirm.agent', { hostname }) : t('confirm.agentUnknownHost')}
                    </span>
                  </span>
                  <DetailSub>
                    {t.rich('confirm.askedAgo', {
                      code: formatUserCode(grant?.userCode ?? canonical),
                      // Relative, because "asked 12 seconds ago" is the cue that
                      // catches a code the reader did not just generate. Measured
                      // from the READ (see `describedAt`), not from page load.
                      ago:
                        grant && describedAt
                          ? format.relativeTime(new Date(grant.askedAt), describedAt)
                          : '',
                      chip: (chunks) => <CodeChip>{chunks}</CodeChip>,
                    })}
                  </DetailSub>
                </DetailBlock>

                {/* 3 — WHICH WORKSPACE. No choice to make ⇒ no control to render. */}
                <DetailBlock label={t('confirm.workspace')}>
                  {multiWorkspace ? (
                    <Combobox
                      id="device-workspace"
                      label={t('confirm.workspacePicker')}
                      options={workspaces.map((w) => ({ value: w.id, label: w.label }))}
                      value={workspaceId}
                      onChange={setWorkspaceId}
                    />
                  ) : (
                    <span className="line-clamp-2 font-sans text-sm font-medium text-(--el-text)">
                      {workspaces[0]?.label ?? ''}
                    </span>
                  )}
                  <DetailSub>
                    {multiWorkspace
                      ? t('confirm.workspaceHelp', { count: workspaces.length })
                      : t('confirm.workspaceOnly')}
                  </DetailSub>
                </DetailBlock>

                {/* 5 — Expires. The exit is stated before the action is taken. It sits
                    in the LEFT column, under the workspace, and that placement is the
                    fold budget (MOTIR-7818): the scope list is derived from
                    `CLI_TOKEN_GRANT`, and at ten keys it is the tallest thing in the
                    box by a long way. Stacked under it, Expires made the right column
                    set the box's height alone (425px), and Approve/Deny ended at 702px
                    in a 648px window. Moved across, the two columns balance — the scope
                    list now has ~22px of slack beneath it before it grows the box. */}
                <DetailBlock label={t('confirm.expires')}>
                  <span className="font-sans text-sm font-medium text-(--el-text)">
                    {t('confirm.expiresValue', { days: CLI_TOKEN_EXPIRY_DAYS })}
                  </span>
                  <DetailSub>{t('confirm.expiresHelp')}</DetailSub>
                </DetailBlock>
              </DetailColumn>

              <DetailColumn divided>
                {/* 4 — WHAT SCOPES. Names only: fewer words on a screen people skim,
                    and the per-permission descriptions live in the tokens UI that owns
                    them. Read from the shipped `permissions.*` copy through the SHARED
                    presenter (MOTIR-2579), so this screen, the picker and the list row
                    cannot describe one grant in three sets of words. DERIVED from
                    `CLI_TOKEN_GRANT` rather than hard-coded: a change to what the CLI
                    needs must not be able to leave this screen telling someone something
                    the credential no longer does. */}
                <DetailBlock label={t('confirm.itCan')}>
                  <span className="flex flex-col gap-1.5">
                    {grantedPermissionMeta(CLI_TOKEN_GRANT).map((meta) => (
                      <PermissionRow key={meta.key} meta={meta} />
                    ))}
                  </span>
                  <DetailSub>{t('confirm.cant')}</DetailSub>
                </DetailBlock>
              </DetailColumn>
            </div>

            <Callout tone="warn" icon={<ShieldAlert className="h-5 w-5" aria-hidden />}>
              {hostname
                ? t.rich('confirm.warning', {
                    hostname,
                    cmd: (chunks) => <Cmd>{chunks}</Cmd>,
                    strong: (chunks) => <strong className="font-semibold">{chunks}</strong>,
                  })
                : t.rich('confirm.warningUnknownHost', {
                    cmd: (chunks) => <Cmd>{chunks}</Cmd>,
                    strong: (chunks) => <strong className="font-semibold">{chunks}</strong>,
                  })}
            </Callout>

            {/* Deny is FIRST in the DOM so the destructive-of-nothing option is
                reachable without tabbing through Approve, and it carries equal
                visual weight: same size, same row, 50/50. The danger hue lives in
                the BORDER + glyph, never the label — `--el-danger` as 16px text is
                4.25:1 on the dark card (under AA), and `--el-danger-text` is the ink
                FOR a danger fill (white in the light palette, the MOTIR-1553 bug). */}
            <div role="group" aria-label={t('confirm.actions')} className="flex gap-3">
              <Button
                variant="secondary"
                size="lg"
                onClick={handleDeny}
                disabled={busy}
                leftIcon={<CircleX className="h-4 w-4" />}
                className="w-full border-(--el-danger)"
              >
                {t('confirm.deny')}
              </Button>
              <Button
                size="lg"
                onClick={handleApprove}
                loading={busy}
                disabled={!workspaceId}
                className="w-full"
              >
                {t('confirm.approve')}
              </Button>
            </div>
          </div>
        </AuthShell>
      </div>
    );
  }

  // ── States 3–5 — the terminal screens (Panels 5, 6, 7) ───────────────────────
  if (phase === 'approved' && update) {
    const { added, removed } = diffGrant(update.permissions, CLI_TOKEN_GRANT);
    return (
      <TerminalState
        headline={tu('approvedHeading')}
        subhead={tu('approvedSubhead')}
        foot={t('foot.close')}
      >
        <Callout tone="success" icon={<CircleCheckBig className="h-5 w-5" aria-hidden />}>
          {tu.rich('approvedBody', {
            label: update.label,
            cmd: (chunks) => <Cmd>{chunks}</Cmd>,
            strong: (chunks) => <strong className="font-semibold">{chunks}</strong>,
          })}
        </Callout>
        {/* What was applied — empty after a re-read of an already-approved grant,
            whose token now holds the CLI set, which the summary says plainly. */}
        {grant?.status === 'approved' ? null : (
          <PermissionChangeSummary added={added} removed={removed} />
        )}
        <Link
          href="/settings/account/tokens"
          className={cn(buttonVariants({ variant: 'secondary', size: 'md' }), 'w-full')}
        >
          <KeyRound className="h-4 w-4" aria-hidden />
          {t('approved.viewTokens')}
        </Link>
      </TerminalState>
    );
  }

  if (phase === 'approved') {
    const tokenLabel = hostname ? `CLI · ${hostname}` : null;
    return (
      <TerminalState
        headline={t('heading.approved')}
        subhead={t('subhead.approved')}
        foot={t('foot.close')}
      >
        <Callout tone="success" icon={<CircleCheckBig className="h-5 w-5" aria-hidden />}>
          {approvedWorkspace === null
            ? t.rich('approved.bodyAlready', { cmd: (chunks) => <Cmd>{chunks}</Cmd> })
            : hostname
              ? t.rich('approved.body', {
                  hostname,
                  workspace: approvedWorkspace,
                  cmd: (chunks) => <Cmd>{chunks}</Cmd>,
                  strong: (chunks) => <strong className="font-semibold">{chunks}</strong>,
                })
              : t.rich('approved.bodyUnknownHost', {
                  workspace: approvedWorkspace,
                  cmd: (chunks) => <Cmd>{chunks}</Cmd>,
                  strong: (chunks) => <strong className="font-semibold">{chunks}</strong>,
                })}
        </Callout>

        {tokenLabel && approvedWorkspace !== null ? (
          <p className="font-sans text-sm leading-relaxed text-(--el-text-secondary)">
            {t.rich('approved.tokenNote', {
              label: tokenLabel,
              days: CLI_TOKEN_EXPIRY_DAYS,
              chip: (chunks) => <CodeChip>{chunks}</CodeChip>,
            })}
          </p>
        ) : null}

        <Link
          href="/settings/account/tokens"
          className={cn(buttonVariants({ variant: 'secondary', size: 'md' }), 'w-full')}
        >
          <KeyRound className="h-4 w-4" aria-hidden />
          {t('approved.viewTokens')}
        </Link>
      </TerminalState>
    );
  }

  if (phase === 'denied' && update) {
    return (
      <TerminalState
        headline={t('heading.denied')}
        subhead={t('subhead.denied')}
        foot={t('foot.close')}
      >
        <Callout tone="danger" icon={<CircleX className="h-5 w-5" aria-hidden />}>
          {tu.rich('deniedBody', {
            label: update.label,
            strong: (chunks) => <strong className="font-semibold">{chunks}</strong>,
          })}
        </Callout>
        <p className="font-sans text-sm leading-relaxed text-(--el-text-secondary)">
          {tu.rich('deniedRetry', { cmd: (chunks) => <Cmd>{chunks}</Cmd> })}
        </p>
        <Button variant="secondary" onClick={restart} className="w-full">
          {t('denied.another')}
        </Button>
      </TerminalState>
    );
  }

  if (phase === 'denied') {
    return (
      <TerminalState
        headline={t('heading.denied')}
        subhead={t('subhead.denied')}
        foot={t('foot.close')}
      >
        <Callout tone="danger" icon={<CircleX className="h-5 w-5" aria-hidden />}>
          {t('denied.body')}
        </Callout>
        <p className="font-sans text-sm leading-relaxed text-(--el-text-secondary)">
          {t.rich('denied.retry', { cmd: (chunks) => <Cmd>{chunks}</Cmd> })}
        </p>
        <Button variant="secondary" onClick={restart} className="w-full">
          {t('denied.another')}
        </Button>
      </TerminalState>
    );
  }

  // phase === 'expired' — with an UPDATE grant's copy when the code was a refresh's.
  return (
    <TerminalState
      headline={t('heading.expired')}
      subhead={t('subhead.expired', { minutes: DEVICE_CODE_EXPIRES_MINUTES })}
      foot={update ? tu('expiredNote') : t('expired.terminalNote')}
    >
      <Callout tone="warn" icon={<Clock className="h-5 w-5" aria-hidden />}>
        {(update ? tu.rich : t.rich)(update ? 'expiredBody' : 'expired.body', {
          code: formatUserCode(canonical),
          cmd: (chunks) => <Cmd>{chunks}</Cmd>,
          chip: (chunks) => <CodeChip>{chunks}</CodeChip>,
        })}
      </Callout>
      <Button onClick={restart} className="w-full">
        {t('expired.newCode')}
      </Button>
    </TerminalState>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** WHO is approving — the signed-in reader, with the way out if it is the wrong
 *  account. Shared by both confirm screens so the identity check reads the same. */
function WhoIsApproving({
  user,
  busy,
  onSwitch,
}: {
  user: DeviceApprovalProps['user'];
  busy: boolean;
  onSwitch: () => void;
}) {
  const t = useTranslations('device');
  return (
    <>
      <span className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-(--el-text) font-sans text-sm font-semibold text-(--el-text-inverted)"
        >
          {(user.name || user.email).trim().charAt(0).toUpperCase() || '?'}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-sans text-sm font-medium text-(--el-text)">
            {user.name || user.email}
          </span>
          <span className="text-(--el-text-muted) truncate font-sans text-xs">{user.email}</span>
        </span>
      </span>
      <DetailSub>
        {t.rich('confirm.notYou', {
          link: (chunks) => (
            <button
              type="button"
              onClick={onSwitch}
              disabled={busy}
              className="rounded-(--radius-control) underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) disabled:opacity-50"
            >
              {chunks}
            </button>
          ),
        })}
      </DetailSub>
    </>
  );
}

// ── Composition helpers (page-local; none of these is a design-system primitive
//    in waiting — they are this screen's grammar, named so the states read alike)

/** A terminal screen: headline, subhead, body, and a closing line. Announced via a
 *  live region so a screen reader hears the RESULT without re-reading the card. */
function TerminalState({
  headline,
  subhead,
  foot,
  children,
}: {
  headline: string;
  subhead: string;
  foot: string;
  children: ReactNode;
}) {
  return (
    <div role="status" aria-live="polite">
      <AuthShell headline={headline} subhead={subhead}>
        <div className="flex flex-col gap-5">{children}</div>
        <p className="text-(--el-text-muted) font-sans text-xs leading-relaxed">{foot}</p>
      </AuthShell>
    </div>
  );
}

/** One COLUMN of the confirm screen's detail box (the mock's `.dcol`): its blocks
 *  stack and divide among themselves, independent of the other column's heights.
 *  `divided` draws the hairline between the two columns. */
function DetailColumn({ divided = false, children }: { divided?: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col divide-y divide-(--el-border-soft) px-4',
        divided && 'sm:border-l sm:border-(--el-border-soft)',
      )}
    >
      {children}
    </div>
  );
}

/** One key → value → sub-line block of the confirm screen's detail box (`.dblock`).
 *  The key carries meaning, so it uses `--el-text-muted` (4.54:1), never the
 *  decorative `--el-text-faint` (2.61:1 on white). */
function DetailBlock({ label, children }: { label: string; children: ReactNode }) {
  // `py-2`, not the mock's `py-2.5`: the left column stacks four blocks, so this
  // padding is paid eight times on the column that sets the box's height — 16px of
  // the fold budget (MOTIR-7818), spent on whitespace rather than on content.
  return (
    <div className="flex min-w-0 flex-col gap-1 py-2">
      <span className="text-(--el-text-muted) font-sans text-[11px] font-semibold uppercase tracking-wider">
        {label}
      </span>
      {children}
    </div>
  );
}

function DetailSub({ children }: { children: ReactNode }) {
  return (
    <span className="text-(--el-text-muted) font-sans text-xs leading-relaxed">{children}</span>
  );
}

/** A granted permission, by NAME only — the description belongs to the tokens UI
 *  that owns it, and this screen buys its one-screen fit by not repeating it.
 *  The name is the SHIPPED catalogue label, so it reads identically here and on
 *  Roles & permissions. */
function PermissionRow({ meta }: { meta: PermissionMeta }) {
  const tp = useTranslations('permissions');
  const Icon = meta.Icon;
  return (
    <span className="flex items-center gap-2 font-sans text-sm text-(--el-text)">
      <span aria-hidden className="text-(--el-text-muted) inline-flex shrink-0">
        <Icon className="h-4 w-4" />
      </span>
      {tp(`${permissionSlug(meta.key)}.label`)}
    </span>
  );
}

/**
 * A tinted callout — hue in the BACKGROUND with strong ink on top (10:1 and above
 * in both themes), never coloured text on the card. Always tint + icon + copy, so
 * the state is never carried by colour alone.
 */
function Callout({
  tone,
  icon,
  children,
}: {
  tone: 'warn' | 'success' | 'danger';
  icon: ReactNode;
  children: ReactNode;
}) {
  // Each tone uses its DEDICATED surface-ink token where the design system defines
  // one (danger, warning); mint has no dedicated ink, so it takes `--el-text-strong`
  // — the token whose stated job is "AA-safe text on tints", and the one
  // `design/cli-connect/design-notes.md` measured these three fills against
  // (10.4 / 10.4 / 10.0:1 light, higher in dark).
  const surface = {
    warn: 'bg-(--el-warning-surface) text-(--el-warning-text)',
    success: 'bg-(--el-success-surface) text-(--el-text-strong)',
    danger: 'bg-(--el-danger-surface) text-(--el-danger-surface-text)',
  }[tone];
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-(--radius-card) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) font-sans text-sm leading-normal',
        surface,
      )}
    >
      <span className="inline-flex shrink-0 pt-0.5">{icon}</span>
      <p>{children}</p>
    </div>
  );
}

/** A shell command inside prose — mono only, no fill. The mock's `.mono`: the
 *  command is a THING TO TYPE, and a chip around it would compete with the code
 *  chip, which is the value the reader is actually asked to check. */
function Cmd({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[0.95em]">{children}</code>;
}

/** A page-scoped failure that is NOT a state change — the user stays where they are
 *  and can act on it. */
function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="rounded-(--radius-card) bg-(--el-danger-surface) p-(--spacing-card-padding) font-sans text-sm leading-relaxed text-(--el-danger-surface-text)"
    >
      {children}
    </div>
  );
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** Default the picker to the workspace the user is actually working in; fall back to
 *  the first they may bind in. Never null when they have any. */
function pickDefaultWorkspace(
  workspaces: { id: string }[],
  activeWorkspaceId: string | null,
): string | null {
  if (activeWorkspaceId && workspaces.some((w) => w.id === activeWorkspaceId))
    return activeWorkspaceId;
  return workspaces[0]?.id ?? null;
}

/** Motir's routes answer `{ code }`; Better-Auth's answer `{ error }`. Read either,
 *  and treat an unparseable body as "no code" rather than as a crash — a failed
 *  response must never become a blank page. */
async function readErrorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { code?: unknown; error?: unknown };
    if (typeof body.code === 'string') return body.code;
    if (typeof body.error === 'string') return body.error;
    return null;
  } catch {
    return null;
  }
}
