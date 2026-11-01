import type { ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Activity, CircleAlert, GitMerge, RefreshCw, Rocket, RotateCcw } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import { Spinner } from '@/components/ui/Spinner';
import type { HostedReleaseDto } from '@/lib/dto/hostedApplications';
import {
  releaseFailureLabel,
  releaseStateLabel,
  releaseTriggerLabel,
  shortCommit,
  type ReleaseStateWord,
  type ReleaseTriggerKind,
} from '@/lib/hosting/releaseStateLabel';

// The pieces a release is drawn with wherever it appears — the current release
// card, a history row and the rollback dialog (Story MOTIR-9797 · MOTIR-10037,
// `design/hosting/design-notes.md` § Tokens and parts). Every word comes from
// `releaseStateLabel.ts`; every caption sits in `--el-text-secondary`, which
// clears AA on the page and on every surface.

const STATE_GLYPH: Record<ReleaseStateWord, ReactNode> = {
  building: null,
  live: <Activity className="size-3" aria-hidden />,
  failed: <CircleAlert className="size-3" aria-hidden />,
  replaced: null,
  rolledBack: <RotateCcw className="size-3" aria-hidden />,
};

const TRIGGER_GLYPH: Record<ReleaseTriggerKind, ReactNode> = {
  merge: <GitMerge className="size-3.5" aria-hidden />,
  redeploy: <RefreshCw className="size-3.5" aria-hidden />,
  rollback: <RotateCcw className="size-3.5" aria-hidden />,
  ref: <Rocket className="size-3.5" aria-hidden />,
};

/** The state pill: its own tone and word, and a glyph wherever the hue is a
 *  tint, so no state rests on colour alone (finding #35). */
export function ReleaseStatePill({ release }: { release: Pick<HostedReleaseDto, 'state'> }) {
  const t = useTranslations('settings.production');
  const label = releaseStateLabel(release.state);
  return (
    <Pill {...label.tone} data-testid="production-state-pill" data-release-state={label.word}>
      {label.word === 'building' ? (
        <Spinner size="sm" className="h-3 w-3" aria-hidden />
      ) : (
        STATE_GLYPH[label.word]
      )}
      {t(label.labelKey)}
    </Pill>
  );
}

/** The release's short commit, in the identifier ink. */
export function CommitLabel({ sha }: { sha: string }) {
  return (
    <code className="shrink-0 font-mono text-sm text-(--el-text-identifier)" title={sha}>
      {shortCommit(sha)}
    </code>
  );
}

/** The commit's subject line beside its hash (MOTIR-10103); nothing for a
 *  release that does not know it. Cut to one line on the card and the history;
 *  the dialog lets it wrap. */
export function CommitSubject({
  subject,
  truncate = true,
}: {
  subject: string | null;
  truncate?: boolean;
}) {
  if (!subject) return null;
  return (
    <span
      className={`min-w-0 font-sans text-sm text-(--el-text)${truncate ? ' truncate' : ''}`}
      title={truncate ? subject : undefined}
      data-testid="production-commit-subject"
    >
      {subject}
    </span>
  );
}

/** When the release last went live by a person's hand (a restore), else when it
 *  was made: relative, with the absolute time on hover. */
export function ReleaseTime({
  release,
}: {
  release: Pick<HostedReleaseDto, 'createdAt' | 'restoredAt'>;
}) {
  const format = useFormatter();
  const iso = release.restoredAt ?? release.createdAt;
  const at = new Date(iso);
  return (
    <time
      dateTime={iso}
      title={format.dateTime(at, { dateStyle: 'medium', timeStyle: 'short' })}
      className="shrink-0 font-sans text-xs text-(--el-text-secondary)"
    >
      {format.relativeTime(at)}
    </time>
  );
}

/** The absolute time alone — the dialog names the two releases by it. */
export function AbsoluteReleaseTime({
  release,
}: {
  release: Pick<HostedReleaseDto, 'createdAt' | 'restoredAt'>;
}) {
  const format = useFormatter();
  const iso = release.restoredAt ?? release.createdAt;
  return (
    <time dateTime={iso} className="text-xs">
      {format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' })}
    </time>
  );
}

/** What started the release. */
export function ReleaseTriggerLine({
  release,
}: {
  release: Pick<
    HostedReleaseDto,
    'cause' | 'ref' | 'restoredBy' | 'pullRequestNumber' | 'requestedBy'
  >;
}) {
  const t = useTranslations('settings.production');
  const trigger = releaseTriggerLabel(release);
  return (
    <span
      className="inline-flex items-center gap-1 font-sans text-xs text-(--el-text-secondary)"
      data-testid="production-trigger"
      data-trigger={trigger.kind}
    >
      {TRIGGER_GLYPH[trigger.kind]}
      {t(trigger.labelKey, trigger.values)}
    </span>
  );
}

/** A failed release's one-line reason: the glyph carries the danger hue, the
 *  words stay in body ink. Nothing for a release that did not fail. */
export function ReleaseFailureReason({
  release,
}: {
  release: Pick<HostedReleaseDto, 'state' | 'failureReason'>;
}) {
  const t = useTranslations('settings.production');
  const reason = release.state === 'failed' ? releaseFailureLabel(release.failureReason) : null;
  if (!reason) return null;
  return (
    <p
      className="flex items-start gap-1.5 font-sans text-xs text-(--el-text)"
      data-testid="production-failure-reason"
    >
      <CircleAlert className="mt-px size-3.5 shrink-0 text-(--el-danger-on-surface)" aria-hidden />
      {t(reason.labelKey, reason.values)}
    </p>
  );
}
