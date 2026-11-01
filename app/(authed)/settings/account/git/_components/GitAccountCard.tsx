import { Info, TriangleAlert } from 'lucide-react';
import { GithubMark } from '@/components/icons/GithubMark';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { buttonVariants } from '@/components/ui/Button';
import type { GithubIdentityDTO } from '@/lib/dto/github';
import { DisconnectAccountButton } from './DisconnectAccountButton';

// The account Git pane's CONNECTED card (Story MOTIR-4669 · MOTIR-4682), built to
// `design/settings/account-settings.mock.html` Panel 9 (connected), Panel 10 · B
// (needs re-auth) and Panel 10 · C (no organisation installation).
//
// A component of its own, rather than a function inside `page.tsx`, so the
// states can be rendered by a test: the page is an async server component that
// reads the session, and a state nobody can render is a state nobody asserts.
//
// ⚠️ STATE B — NEEDS RE-AUTH (Bug MOTIR-10047). GitHub refused to renew the
// member's sign-in (`github_identity.refresh_refused_at`, written by
// `githubIdentityService.getLiveToken` since MOTIR-10021), so every action that
// uses it now fails with the reconnect message of MOTIR-8984. This page is the
// one place about the sign-in itself, so it says so: a danger notice, the row
// kept with a warning `Needs re-auth` pill, and a primary `Reconnect` that runs
// the same OAuth round trip as `Connect GitHub`. The design draws no
// `Disconnect` in this state, and no state C note either: the sign-in is dead,
// and the organisation's installation is not what the member has to act on.
//
// ⚠️ THE NOTICE'S GLYPH IS `--el-danger-on-surface`, never `--el-danger-text`
// (the ink FOR a danger FILL, 1.00:1 on a light page). Its body is
// `--el-text-strong` on `--el-danger-surface`, as the design's token table says.

export interface GitAccountCardCopy {
  host: string;
  connected: string;
  connectedOn: string;
  needsReauth: string;
  reauthTitle: string;
  reauthBody: string;
  reconnect: string;
  noInstallationTitle: string;
  noInstallationBody: string;
}

export function GitAccountCard({
  identity,
  hasInstallation,
  reconnectHref,
  copy,
}: {
  identity: GithubIdentityDTO;
  hasInstallation: boolean;
  /** The OAuth start path, the same one `Connect GitHub` uses. */
  reconnectHref: string;
  copy: GitAccountCardCopy;
}) {
  const needsReauth = identity.needsReauth;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-col gap-4">
          {needsReauth ? (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-(--radius-card) border-l-2 border-(--el-danger) bg-(--el-danger-surface) px-(--spacing-card-padding-16) py-(--spacing-card-padding-12)"
            >
              <TriangleAlert
                className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger-on-surface)"
                aria-hidden
              />
              <p className="font-sans text-sm text-(--el-text-strong)">
                <span className="font-semibold">{copy.reauthTitle}</span> {copy.reauthBody}
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <span
              aria-hidden
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-(--el-muted) text-(--el-text-secondary)"
            >
              <GithubMark className="h-5 w-5" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-sans text-sm font-semibold text-(--el-text)">
                  @{identity.githubLogin}
                </span>
                {needsReauth ? (
                  <Pill severity="warning">{copy.needsReauth}</Pill>
                ) : (
                  <Pill severity="success">{copy.connected}</Pill>
                )}
              </div>
              <span className="font-sans text-xs text-(--el-text-secondary)">
                {copy.host} · {copy.connectedOn}
              </span>
            </div>
            {needsReauth ? (
              <a
                href={reconnectHref}
                className={buttonVariants({ variant: 'primary', size: 'sm' })}
              >
                {copy.reconnect}
              </a>
            ) : (
              <DisconnectAccountButton />
            )}
          </div>
        </div>
      </Card>

      {/* ⚠️ STATE C — connected, and the organisation has no installation. It is a
          COMPLETE, WORKING STATE, not an error and not a pending one: the two
          grants are INDEPENDENT, which the shipped connect page says in as many
          words. So it is drawn as a quiet fact on a neutral surface —
          - NOT a warning: nothing is wrong.
          - NOT a call to action: connecting the organisation is an ORG-ADMIN act,
            and a member sent to do it is sent to a door that will not open for
            them, which is worse than saying nothing.
          This is the arm an implementer would otherwise improvise as an error,
          which is why the design drew it and why the test asserts it BY NAME. */}
      {hasInstallation || needsReauth ? null : (
        <div className="flex gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) p-(--spacing-card-padding)">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-(--el-icon-muted)" aria-hidden />
          <div className="flex flex-col gap-1">
            <p className="font-sans text-sm font-medium text-(--el-text)">
              {copy.noInstallationTitle}
            </p>
            <p className="font-sans text-sm text-(--el-text-secondary)">
              {copy.noInstallationBody}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
