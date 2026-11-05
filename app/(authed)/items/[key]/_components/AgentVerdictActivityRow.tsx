'use client';

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Bot } from 'lucide-react';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { Pill } from '@/components/ui/Pill';
import { agentVerdictAnchor, reviewCommitsLabel } from '@/lib/agentReview/verdictActivity';
import type { ActivityAgentVerdictPartDto, ActivityEntryDto } from '@/lib/dto/activity';

// ONE AGENT VERDICT in the card's activity (Story MOTIR-10327 · MOTIR-10338), built to
// `design/work-items/decision-waiting--review-path.mock.html` M12 and
// `design/github/design-notes.md` § 32.9: `ActivityEntryRow`'s grid (the 22px gutter), an
// 18px `--el-tint-lavender` disc with `Bot` in place of the initial avatar, the sentence in
// `--el-text-secondary` with the agent lifted out in `--el-text`.
//
// - a pass / a send-back that answered its version: *{agent} passed the review at {commits}*
//   or *asked for changes at {commits}*, the time, and *Findings* — which opens the findings
//   the trail kept, here, in place. A send-back that notified its assignee says so.
// - a LATE verdict: a neutral *Late* pill before the sentence, and *Reviewed {commits},
//   which is no longer the current version. It decided nothing.*
// - a SECOND verdict: a neutral *Second review* pill, and *A second review at a version
//   already decided. It decided nothing.*
//
// ⚠️ INK. The time takes `--el-text-secondary`, not the shipped row's `--el-text-muted`,
// which fails AA on `--el-surface` (the notes say this entry does not repeat that).
//
// ⚠️ THE ENTRY IS THE NOTIFICATION'S LANDING. Its id is `agentVerdictAnchor(recordId)`, and
// arriving at that hash opens the findings, so the send-back notice's link shows them.

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

export function AgentVerdictActivityRow({
  entry,
  part,
}: {
  entry: ActivityEntryDto;
  part: ActivityAgentVerdictPartDto;
}) {
  const t = useTranslations('approvalGate.reviewPath.activity');
  const tActivity = useTranslations('activity');
  const format = useFormatter();
  const changedAt = new Date(entry.changedAt);
  const anchor = agentVerdictAnchor(part.recordId);
  const findingsId = useId();
  // THE NOTIFICATION'S LINK lands on `#agent-verdict-<id>` with the findings OPEN — read from
  // the address as an external store, so a later hash change opens it too. A press then owns it.
  const atAnchor = useSyncExternalStore(
    subscribeToHash,
    () => window.location.hash === `#${anchor}`,
    /* v8 ignore next -- the server snapshot: a server render has no address hash. */
    () => false,
  );
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? atAnchor;
  // ARRIVING AT THE ANCHOR PUTS THE ENTRY IN VIEW (MOTIR-10458). Activity streams in after
  // the browser — or the router, on a client navigation — has looked for the fragment, so the
  // entry lands itself, the `#pages` precedent; a later hash change scrolls it natively.
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (atAnchor) rowRef.current?.scrollIntoView?.({ block: 'start' });
  }, [atAnchor]);

  const commits = reviewCommitsLabel(part.subjectVersion);
  const agentName = part.hosted
    ? t('agentHosted')
    : t('agentOwn', { name: entry.actor.name ?? tActivity('formerMember'), harness: part.harness });
  const agentChunk = (chunks: ReactNode): ReactNode => (
    <span
      className="font-semibold text-(--el-text)"
      // The model is named on the agent, as the Reviewed badge's card names it.
      title={part.model ? `${part.harness || t('agentHosted')} · ${part.model}` : undefined}
    >
      {chunks}
    </span>
  );
  const decidedNothing = part.outcome === 'late' || part.outcome === 'second';
  const sentence = t.rich(part.verdict === 'pass' ? 'passed' : 'sentBack', {
    actor: agentChunk,
    agent: agentName,
    commits,
  });
  const showFindings = !decidedNothing && part.findingsExcerpt !== null;
  const notifiedName =
    part.notified?.type === 'user' ? (part.notified.name ?? tActivity('formerMember')) : null;

  return (
    <div
      ref={rowRef}
      id={anchor}
      className="grid scroll-mt-6 grid-cols-[22px_minmax(0,1fr)] gap-x-2.5"
    >
      <span
        className="mt-px inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center justify-self-center rounded-full bg-(--el-tint-lavender) text-(--el-text-strong)"
        aria-hidden
      >
        <Bot className="size-3" />
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="m-0 font-sans text-[13px] leading-relaxed text-(--el-text-secondary)">
          {decidedNothing ? (
            <Pill tone="neutral" className="mr-1.5 align-middle">
              {part.outcome === 'late' ? t('late') : t('secondTag')}
            </Pill>
          ) : null}
          {sentence}{' '}
          <span
            className="ml-1 text-xs whitespace-nowrap text-(--el-text-secondary)"
            title={format.dateTime(changedAt, { dateStyle: 'medium', timeStyle: 'short' })}
          >
            {format.relativeTime(changedAt)}
          </span>
        </p>
        {decidedNothing ? (
          <span className="text-xs text-(--el-text-secondary)">
            {part.outcome === 'late' ? t('lateNote', { commits }) : t('second')}
          </span>
        ) : showFindings || notifiedName ? (
          <span className="flex flex-wrap items-center gap-2 text-xs text-(--el-text-secondary)">
            {showFindings ? (
              <button
                type="button"
                aria-expanded={open}
                aria-controls={findingsId}
                onClick={() => setToggled(!open)}
                className="text-xs font-medium text-(--el-link) hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
              >
                {t('findings')}
              </button>
            ) : null}
            {notifiedName ? <span>{t('notified', { name: notifiedName })}</span> : null}
          </span>
        ) : null}
        {showFindings && open ? (
          <div id={findingsId}>
            <MarkdownView
              value={part.findingsExcerpt ?? ''}
              workItemRefs={{}}
              className="motir-how-to-test min-w-0 text-[13px]"
              data-testid="agent-verdict-findings"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
