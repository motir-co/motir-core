'use client';

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  ChevronDown,
  CircleCheck,
  CircleX,
  History,
  LoaderCircle,
  MessageSquare,
  Square,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { useRowWindow } from '@/components/ui/useRowWindow';
import { ChatToolCallRow } from './ChatToolCallRow';
import type { ChatRow, Transcript } from './transcriptModel';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import { useChatWorkItemRefs } from './useChatWorkItemRefs';

// THE TRANSCRIPT (Story MOTIR-6863 · MOTIR-7017; `design/my-agents/design-notes.md`
// § the Chat tab, panels 2–4 and 6).
//
// - Assistant text is Markdown through the app's ONE sanitising renderer
//   (`MarkdownView` → `renderMarkdown`: rehype-sanitize). Prompts, tool output and
//   diffs are text. Nothing is ever injected as HTML.
// - It fills the tab, scrolls inside itself, stays pinned to the latest event, and
//   shows Jump to latest when the reader has scrolled up.
// - A long transcript WINDOWS its rows with the shipped `useRowWindow` (measured,
//   variable-height; it renders every row when no viewport is measurable).
// - Nothing here is logged, stored or reported (Q10).

/** Within this many px of the bottom counts as "at the latest". */
const PINNED_SLACK_PX = 48;
/** A first guess at a row's height before it is measured. */
const ROW_ESTIMATE_PX = 44;
/** The gap between rows (0.875rem, the design's). */
const ROW_GAP_PX = 14;

export function ChatTranscript({
  transcript,
  pendingPrompt,
  agentName,
  dimmed,
  historyNote,
  emptyFace,
}: {
  transcript: Transcript;
  /** A prompt sent and not yet echoed as its turn's `user` event. */
  pendingPrompt: string | null;
  agentName: string;
  dimmed: boolean;
  historyNote: 'truncated' | 'unavailable' | null;
  /** Drawn in place of the rows for a new chat with nothing in it yet. */
  emptyFace: ReactNode;
}) {
  const t = useTranslations('myAgents.panel');
  const scroller = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const [scrolledUp, setScrolledUp] = useState(false);
  const running = transcript.runningTurn !== null;

  const rows: ChatRow[] = pendingPrompt
    ? [...transcript.rows, { type: 'user', key: 'pending', text: pendingPrompt }]
    : transcript.rows;
  const last = rows[rows.length - 1];
  const streamingKey = running && last?.type === 'text' ? last.key : null;
  const workItemRefs = useChatWorkItemRefs(rows);

  const getScrollElement = useCallback(() => scroller.current, []);
  const { containerRef, range, totalSize, getOffset, measureElement, windowing } = useRowWindow({
    count: rows.length,
    estimateRowHeight: ROW_ESTIMATE_PX,
    gap: ROW_GAP_PX,
    getScrollElement,
  });

  // Stay pinned to the latest event unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= PINNED_SLACK_PX;
    pinned.current = atBottom;
    setScrolledUp(!atBottom);
  };

  const jump = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = true;
    el.scrollTop = el.scrollHeight;
    setScrolledUp(false);
  };

  const empty = rows.length === 0 && historyNote === null;
  const indices: number[] = [];
  for (let i = range.start; i < range.end; i += 1) indices.push(i);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        role="region"
        aria-label={t('chat.transcript')}
        onScroll={onScroll}
        data-testid="chat-transcript"
        className={`min-h-0 flex-1 overflow-y-auto bg-(--el-card) p-(--spacing-card-padding) text-sm leading-relaxed text-(--el-text) transition-opacity ${
          dimmed ? 'opacity-60' : ''
        }`}
      >
        {empty ? (
          emptyFace
        ) : (
          <>
            {historyNote ? (
              <p className="m-0 mb-3.5 flex items-start gap-2 rounded-(--radius-control) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y) text-xs text-(--el-text-secondary)">
                <History aria-hidden="true" className="mt-px size-3.5 flex-none" />
                {historyNote === 'truncated'
                  ? t('chat.history.truncated')
                  : t('chat.history.unavailable', { agent: agentName })}
              </p>
            ) : null}
            <div
              ref={containerRef}
              className={windowing ? 'relative' : 'flex flex-col gap-3.5'}
              style={windowing ? { height: totalSize } : undefined}
            >
              {indices.map((i) => {
                const row = rows[i]!;
                return (
                  <div
                    key={row.key}
                    ref={measureElement(i)}
                    className={`flex flex-col ${windowing ? 'absolute inset-x-0' : ''}`}
                    style={windowing ? { top: getOffset(i) } : undefined}
                  >
                    <Row
                      row={row}
                      running={running}
                      streaming={row.key === streamingKey}
                      agentName={agentName}
                      workItemRefs={workItemRefs}
                    />
                  </div>
                );
              })}
            </div>
            {running ? (
              <p
                data-testid="chat-working"
                className="m-0 mt-3.5 flex items-center gap-1.5 text-xs text-(--el-text-secondary)"
              >
                <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
                {t('chat.working', { agent: agentName })}
              </p>
            ) : null}
          </>
        )}
      </div>
      {scrolledUp ? (
        <Button
          variant="secondary"
          size="sm"
          className="absolute right-4 bottom-2.5 bg-(--el-card)"
          leftIcon={<ChevronDown aria-hidden="true" />}
          onClick={jump}
        >
          {t('jumpLatest')}
        </Button>
      ) : null}
    </div>
  );
}

function Row({
  row,
  running,
  streaming,
  agentName,
  workItemRefs,
}: {
  row: ChatRow;
  running: boolean;
  streaming: boolean;
  agentName: string;
  workItemRefs: WorkItemRefMap;
}) {
  const t = useTranslations('myAgents.panel.chat');
  switch (row.type) {
    case 'user':
      return (
        <div
          data-testid="chat-user"
          className="max-w-[85%] self-end rounded-(--radius-card) bg-(--el-surface) px-(--spacing-input-x) py-(--spacing-input-y) break-words whitespace-pre-wrap text-(--el-text)"
        >
          {row.text}
        </div>
      );
    case 'text':
      return (
        <div data-testid="chat-text" className="text-(--el-text)">
          <MarkdownView value={row.text} workItemRefs={workItemRefs} />
          {streaming ? (
            <span
              aria-hidden="true"
              data-testid="chat-caret"
              className="ml-0.5 inline-block h-[1em] w-[0.5em] bg-(--el-accent) align-text-bottom"
            />
          ) : null}
        </div>
      );
    case 'tool':
      return (
        <ChatToolCallRow
          call={row.call}
          result={row.result}
          running={running}
          agentName={agentName}
        />
      );
    case 'turn_end':
      return <TurnEnd reason={row.reason} code={row.code} agentName={agentName} />;
    case 'error':
      return (
        <div
          data-testid="chat-error"
          className="flex items-start gap-2 rounded-(--radius-control) bg-(--el-warning-surface) px-(--spacing-control-x) py-(--spacing-control-y) text-[0.8125rem] text-(--el-warning-text)"
        >
          <TriangleAlert
            aria-hidden="true"
            className="mt-[3px] size-3.5 flex-none text-(--el-warning)"
          />
          <span>{t('error', { agent: agentName, message: row.message ?? row.code })}</span>
        </div>
      );
    case 'other':
      return (
        <p
          data-testid="chat-other"
          className="m-0 flex items-center gap-1.5 text-xs text-(--el-text-secondary)"
        >
          {t('other', { name: row.name })}
        </p>
      );
  }
}

function TurnEnd({
  reason,
  code,
  agentName,
}: {
  reason: 'completed' | 'stopped' | 'failed';
  code?: string;
  agentName: string;
}) {
  const t = useTranslations('myAgents.panel.chat.turn');
  const rule = 'h-px flex-1 bg-(--el-border-soft)';
  const glyph =
    reason === 'completed' ? (
      <CircleCheck aria-hidden="true" className="size-[13px] text-(--el-success)" />
    ) : reason === 'stopped' ? (
      <Square aria-hidden="true" className="size-[13px] text-(--el-text-secondary)" />
    ) : (
      <CircleX aria-hidden="true" className="size-[13px] text-(--el-danger)" />
    );
  const why =
    reason === 'stopped'
      ? t('stoppedWhy')
      : reason === 'failed'
        ? code === 'subscription_signin'
          ? t('failedWhy.subscription_signin')
          : t('failedWhy.generic', { agent: agentName, code: code ?? 'exit_nonzero' })
        : null;
  return (
    <div data-testid="chat-turn-end" data-reason={reason} className="flex flex-col gap-1.5">
      <div
        role="separator"
        aria-label={t(reason)}
        className="flex items-center gap-2.5 text-xs text-(--el-text-secondary)"
      >
        <span aria-hidden="true" className={rule} />
        <span
          className={`inline-flex items-center gap-1.5 whitespace-nowrap ${
            reason === 'failed' ? 'font-medium text-(--el-danger-on-surface)' : ''
          }`}
        >
          {glyph}
          {t(reason)}
        </span>
        <span aria-hidden="true" className={rule} />
      </div>
      {why ? <p className="m-0 text-center text-xs text-(--el-text-secondary)">{why}</p> : null}
    </div>
  );
}

/** A new chat: one centred face that says what the chat is (panel 1). */
export function ChatEmptyFace({
  agentName,
  machineName,
}: {
  agentName: string;
  machineName: string;
}) {
  const t = useTranslations('myAgents.panel.chat');
  return (
    <div
      data-testid="chat-empty"
      className="flex h-full min-h-[220px] flex-col items-center justify-center gap-2 text-center text-[0.8125rem] leading-normal text-(--el-text-secondary)"
    >
      <MessageSquare aria-hidden="true" className="size-[22px] text-(--el-text-secondary)" />
      <strong className="text-sm text-(--el-text)">{t('empty.title', { agent: agentName })}</strong>
      <span className="max-w-[30rem]">
        {t.rich('empty.body', {
          agent: agentName,
          name: machineName,
          cmd: (chunks) => (
            <code className="rounded-(--radius-badge) bg-(--el-code-bg) px-(--spacing-chip-x) font-mono text-xs whitespace-nowrap text-(--el-code-text)">
              {chunks}
            </code>
          ),
        })}
      </span>
    </div>
  );
}
