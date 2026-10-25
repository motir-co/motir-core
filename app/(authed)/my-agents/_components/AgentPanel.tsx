'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  ArrowLeft,
  Ban,
  CircleAlert,
  CircleArrowUp,
  CircleCheck,
  CircleHelp,
  Eye,
  LoaderCircle,
  MessageSquare,
  Moon,
  Package,
  Power,
  RotateCw,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import { chatProfile } from '@/lib/agentInstances/profiles';
import type { AgentInstanceListItemDto } from '@/lib/dto/agentInstances';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { ChatFace, useChatArea } from './AgentChat';
import { AgentPanelHeader, ICON_BUTTON } from './AgentPanelHeader';
import { itemHref } from './AgentRunLine';
import { AgentTerminal } from './AgentTerminal';
import { RefusalBox, type AgentRefusal } from './agentRefusal';
import { AgentBootReadout } from './AgentBootReadout';
import {
  DOT,
  FACE_ICON,
  STRIP_ICON,
  Strip,
  type Dot,
  type FaceComponent,
  type TabArea,
} from './panelParts';
import { useAgentBoot } from './useAgentBoot';
import { useAgentChat } from './useAgentChat';
import { useAgentTerminal, type TerminalConn, type TerminalSink } from './useAgentTerminal';
import { useRunSessionWatch } from './useRunSessionWatch';

// THE AGENT PANEL (Story MOTIR-6861 · MOTIR-6941) — one of the reader's own agents,
// opened in the right half of My agents beside the list. Built to the approved
// `design/my-agents/my-agents--panel.mock.html` (MOTIR-6937) and its section of
// `design/my-agents/design-notes.md`:
//
//   panel 2  the header (AgentPanelHeader)
//   panel 3  sign-in status, pushed by the terminal server — none before it connects
//   panel 4  every lifecycle value as the terminal area's words; opening a
//            hibernated agent WAKES it and connects when it runs, no second click
//   panel 5  the terminal tab: connecting, live, reconnecting, lost, exited
//   panel 6  the refusals in words — and never another person's agent
//   panel 7  the narrow width (the room hides the list; the header's crumb returns)
//
// THE CHAT TAB (Story MOTIR-6863 · MOTIR-7017) sits beside Terminal in the track,
// built to the approved delta `design/my-agents/my-agents--chat.mock.html`
// (MOTIR-7011): the open tab is kept in the address as `&tab=chat` (written with
// `shallowPush`), an agent still opens on Terminal, aider's tab is disabled from
// `CHAT_PROFILES` without connecting, and the chat's own socket, faces and strips
// live in `AgentChat.tsx` / `useAgentChat.ts`.
//
// THE AGENT'S LIVE RUN (Story MOTIR-6864 · MOTIR-7029, `my-agents--run.mock.html`):
//   panel 1  the run line (the header), and the run's session offered beside the
//            developer's own shell in a `Segmented` at the head of the Terminal
//            tab — listed by the terminal server on the shell's own socket, and
//            watched over a SECOND socket through the same ticket route and relay
//            (one connection answers one session); watch-only, with its sky strip
//   panel 2  Hibernate / Delete off during the run (the header), and the server's
//            refusal shown in the panel's refusal box when pressed from elsewhere
//   panel 3  the end, from either direction: the session exits (the watch shows its
//            last screen, dimmed, under the ended strip, and the list re-reads) or
//            the record closes (the next read turns the run line to "Last run")
//   panel 4  the narrow width: the switch fills the width and drops its hint
// The run's switch and strip belong to the Terminal tab: the Chat tab never shows them.
//
// ⚠️ THE SERVER DECIDES WHO MAY OPEN AN AGENT. The panel is handed the row from
// the reader's own list (the server's answer), or null when the address names an
// agent that list does not hold; the relay's 4403 lands on the same face. It
// never asks for, and never shows, anything about an agent that is not theirs.

/** The states whose boot is read: live while booting, once for the summary or the failure. */
const BOOT_READ_STATES = new Set(['starting', 'waking', 'running', 'failed']);

/** The panel fills down to the viewport's bottom edge, but never below this. */
const MIN_PANEL_PX = 420;
/** Room left under the panel so its border is not flush with the window edge. */
const PANEL_BOTTOM_GAP_PX = 24;
/** The terminal / chat area never collapses below this, whatever sits above the tab strip (MOTIR-8845). */
const TAB_BODY_MIN = 'min-h-40';

export interface AgentPanelActions {
  onClose: () => void;
  onHibernate: (agent: AgentInstanceListItemDto) => void;
  onDelete: (agent: AgentInstanceListItemDto) => void;
  /** Open the Update confirmation for this agent (MOTIR-6953). */
  onUpdate: (agent: AgentInstanceListItemDto) => void;
  /** Call the Wake route and re-read the list; the refusal to show, or null. */
  onWake: (agent: AgentInstanceListItemDto) => Promise<AgentRefusal | null>;
  /** Re-read the list (the agent's state moved under the panel). */
  onRefresh: () => void;
}

export function AgentPanel({
  projectKey,
  projectName,
  agent,
  actions,
  initialTab = 'terminal',
  refusal = null,
}: {
  projectKey: string;
  projectName: string;
  /** The open agent, from the reader's own list; null when that list does not hold it. */
  agent: AgentInstanceListItemDto | null;
  actions: AgentPanelActions;
  /** The tab the address names (`&tab=chat`) for the agent it opened; Terminal otherwise. */
  initialTab?: AgentPanelTab;
  /** A Hibernate / Delete refused for THIS agent (MOTIR-7029 panel 2), in the page's box. */
  refusal?: AgentRefusal | null;
}) {
  const t = useTranslations('myAgents.panel');
  const panel = useRef<HTMLDivElement | null>(null);
  useFillViewport(panel);

  const onKeyDown = (event: React.KeyboardEvent) => {
    // Esc closes from anywhere in the panel EXCEPT the terminal (there it is the
    // shell's) and the chat's prompt box and popover (there it is theirs).
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-testid="agent-terminal"]')) return;
    if (target?.closest('[data-testid="chat-composer"]')) return;
    actions.onClose();
  };

  return (
    <section
      ref={panel}
      aria-label={t('label')}
      onKeyDown={onKeyDown}
      data-testid="agent-panel"
      className={`flex min-w-0 flex-col overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-card) ${
        agent?.state === 'deleting' ? 'opacity-55' : ''
      }`}
    >
      {agent ? (
        <OpenAgent
          key={agent.id}
          projectKey={projectKey}
          projectName={projectName}
          agent={agent}
          actions={actions}
          initialTab={initialTab}
          refusal={refusal}
        />
      ) : (
        <NotAvailable onClose={actions.onClose} />
      )}
    </section>
  );
}

/** Size the panel from its own top edge down to the viewport's bottom (panel 5: the page never scrolls to reach the terminal's last line). */
function useFillViewport(ref: React.RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      const height = Math.max(MIN_PANEL_PX, window.innerHeight - top - PANEL_BOTTOM_GAP_PX);
      el.style.height = `${height}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [ref]);
}

/** Panel 6: one answer for "not yours" and "not found", on purpose — nothing about the agent. */
function NotAvailable({ onClose }: { onClose: () => void }) {
  const t = useTranslations('myAgents.panel');
  return (
    <>
      <div className="flex items-start justify-between gap-3 border-b border-(--el-border-soft) p-(--spacing-card-padding)">
        <h2 className="m-0 font-serif text-lg font-semibold text-(--el-text)">
          {t('unavailable.title')}
        </h2>
        <button
          type="button"
          aria-label={t('closeUnavailable')}
          onClick={onClose}
          className={ICON_BUTTON}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      <div
        data-testid="agent-unavailable"
        className="flex flex-col gap-3 p-(--spacing-card-padding) text-sm text-(--el-text)"
      >
        <CircleHelp className="size-7 text-(--el-text-secondary)" aria-hidden="true" />
        <p className="m-0">{t('unavailable.body')}</p>
        <p className="m-0">
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<ArrowLeft aria-hidden="true" />}
            onClick={onClose}
          >
            {t('unavailable.back')}
          </Button>
        </p>
      </div>
    </>
  );
}

/** The panel's two tabs (the chat delta, MOTIR-7011 panel 1). */
export type AgentPanelTab = 'terminal' | 'chat';

/** The query parameter that keeps the open tab in the address (`&tab=chat`). */
export const TAB_PARAM = 'tab';

function tabHref(tab: AgentPanelTab): string {
  const url = new URL(window.location.href);
  if (tab === 'chat') url.searchParams.set(TAB_PARAM, 'chat');
  else url.searchParams.delete(TAB_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

function tabFromAddress(): AgentPanelTab {
  return new URLSearchParams(window.location.search).get(TAB_PARAM) === 'chat'
    ? 'chat'
    : 'terminal';
}

/** The shipped tab's box, shared by both tabs in every state. */
const TAB_BOX =
  'relative inline-flex h-(--height-control) items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x) text-[0.8125rem] font-medium';
const TAB_ON = `${TAB_BOX} bg-(--el-page-bg) text-(--el-text-strong) shadow-(--shadow-subtle)`;
const TAB_OFF = `${TAB_BOX} text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none`;

function OpenAgent({
  projectKey,
  projectName,
  agent,
  actions,
  initialTab,
  refusal,
}: {
  projectKey: string;
  projectName: string;
  agent: AgentInstanceListItemDto;
  actions: AgentPanelActions;
  initialTab: AgentPanelTab;
  refusal: AgentRefusal | null;
}) {
  const t = useTranslations('myAgents');
  const sink = useRef<TerminalSink | null>(null);
  const [waking, setWaking] = useState(false);
  const [wakeRefusal, setWakeRefusal] = useState<AgentRefusal | null>(null);
  const agentRef = useRef(agent);
  useLayoutEffect(() => {
    agentRef.current = agent;
  });

  // Q1/Q8: an unsupported profile's Chat tab is drawn disabled WITHOUT connecting.
  const chatVerdict = chatProfile(agent.profileId);
  const [tab, setTab] = useState<AgentPanelTab>(
    initialTab === 'chat' && chatVerdict.supported ? 'chat' : 'terminal',
  );
  // The chat connects the first time its tab is opened, and stays while the panel does.
  const [chatOpened, setChatOpened] = useState(tab === 'chat');

  const hasTerminal = agent.terminalServer !== 'absent';
  const term = useAgentTerminal({
    projectKey,
    agentId: agent.id,
    enabled: agent.state === 'running' && hasTerminal,
    sink,
  });
  const chat = useAgentChat({
    projectKey,
    agentId: agent.id,
    enabled: agent.state === 'running' && hasTerminal && chatVerdict.supported && chatOpened,
  });
  const conn = term.conn;
  // Did the READER ask for this terminal (or this chat) just now — by opening the
  // panel or the tab, or by pressing Reconnect / Use it here / Try again / Start a
  // new shell? Only then is `not_running` a cue to wake: a tab left open in a
  // background browser tab whose agent hibernated on the idle rule must NOT wake
  // it by itself (Q6).
  const readerAsked = useRef(true);
  const chatReaderAsked = useRef(true);
  useEffect(() => {
    if (conn.kind === 'live') readerAsked.current = false;
  }, [conn.kind]);
  useEffect(() => {
    if (chat.conn.kind === 'live') chatReaderAsked.current = false;
  }, [chat.conn.kind]);

  const wake = useCallback(async () => {
    setWakeRefusal(null);
    setWaking(true);
    const refusal = await actions.onWake(agentRef.current);
    setWaking(false);
    setWakeRefusal(refusal);
  }, [actions]);

  // Q6: opening a hibernated agent wakes it — no second click. Only on OPEN: an
  // agent that stops while the panel is open rests on the hibernated face.
  const openedWith = useRef(agent.state);
  useEffect(() => {
    if (openedWith.current === 'hibernated') void wake();
    // Once per open (the panel is keyed by the agent).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `not_running` / 4409 carry no words: they are the cue to wake the agent when
  // the reader asked for the terminal or the chat, and otherwise to re-read its state.
  useEffect(() => {
    if (conn.kind !== 'notRunning') return;
    if (readerAsked.current) void wake();
    else actions.onRefresh();
  }, [conn.kind, wake, actions]);
  useEffect(() => {
    if (chat.conn.kind !== 'notRunning') return;
    if (chatReaderAsked.current) void wake();
    else actions.onRefresh();
  }, [chat.conn.kind, wake, actions]);

  // Back / forward move the address; the open tab follows it.
  useEffect(() => {
    const onPop = () => {
      const next = tabFromAddress();
      if (next === 'chat' && !chatProfile(agentRef.current.profileId).supported) return;
      setTab(next);
      if (next === 'chat') setChatOpened(true);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const selectTab = (next: AgentPanelTab) => {
    if (next === tab) return;
    if (next === 'chat' && !chatVerdict.supported) return;
    setTab(next);
    // The chat renders itself; the server answers nothing (CLAUDE.md § URL state).
    shallowPush(tabHref(next));
    if (next !== 'chat') return;
    chatReaderAsked.current = true;
    setChatOpened(true);
    // Opening Chat on a hibernated agent wakes it exactly as the terminal does;
    // the chat ticket follows once it reads running — no second click.
    if (agent.state === 'hibernated' && !waking && !wakeRefusal) void wake();
  };

  const onWake = () => {
    readerAsked.current = true;
    chatReaderAsked.current = true;
    void wake();
  };

  // THE BOOT READ-OUT (MOTIR-7400): read while the agent boots, and once for a
  // running or failed agent (its summary, or its failure). A change of state
  // re-opens the stream, which is how a wake's new attempt is picked up.
  const { boot } = useAgentBoot({
    projectKey,
    agentId: agent.id,
    live: BOOT_READ_STATES.has(agent.state),
    epoch: agent.state,
  });
  // The waiting delta (MOTIR-9475): the boot waits for room in the pool — read
  // from the DTO's typed `waiting`, never from a step's detail.
  const waitingFor =
    boot !== null &&
    boot.outcome === null &&
    (agent.state === 'starting' || agent.state === 'waking')
      ? (boot.steps.find((s) => s.waiting)?.waiting?.reason ?? null)
      : null;
  // The read-out is the panel's only progress while it covers this state.
  const bootShown =
    boot !== null &&
    (agent.state === 'starting' ||
      agent.state === 'waking' ||
      (agent.state === 'failed' && boot.outcome === 'failed'));

  const terminalLifecycle = useLifecycleArea({
    agent,
    waking,
    wakeRefusal,
    onWake,
    Face,
    wakingHint: t('panel.face.wakingHint'),
    bootShown,
  });
  const chatLifecycle = useLifecycleArea({
    agent,
    waking,
    wakeRefusal,
    onWake,
    Face: ChatFace,
    wakingHint: t('panel.chat.face.wakingHint'),
    bootShown,
  });

  const terminalArea = useTerminalArea({
    agent,
    hasTerminal,
    lifecycle: terminalLifecycle,
    everLive: term.everLive,
    reconnect: () => {
      readerAsked.current = true;
      term.reconnect();
    },
    newShell: () => {
      readerAsked.current = true;
      term.newShell();
    },
    term,
    sink,
    onUpdate: () => actions.onUpdate(agent),
  });
  const chatArea = useChatArea({
    agent,
    hasServer: hasTerminal,
    lifecycle: chatLifecycle,
    chat,
    onOpenTerminal: () => selectTab('terminal'),
    onUpdate: () => actions.onUpdate(agent),
    reconnect: () => {
      chatReaderAsked.current = true;
      chat.reconnect();
    },
  });

  const run = useRunView({ projectKey, agent, term, onRefresh: actions.onRefresh });

  if (conn.kind === 'notAvailable' || chat.conn.kind === 'notAvailable') {
    return <NotAvailable onClose={actions.onClose} />;
  }

  const area = tab === 'chat' ? chatArea : terminalArea;
  const chatTipId = `agent-chat-tip-${agent.id}`;
  const terminalTipId = `agent-terminal-tip-${agent.id}`;
  // The run's session is offered at the head of the TERMINAL tab (MOTIR-7029).
  const watchingRun = tab === 'terminal' && run.watching;

  return (
    <>
      <AgentPanelHeader
        agent={agent}
        projectName={projectName}
        signIn={term.signIn}
        onClose={actions.onClose}
        onHibernate={() => actions.onHibernate(agent)}
        onDelete={() => actions.onDelete(agent)}
        onUpdate={() => actions.onUpdate(agent)}
        waiting={waitingFor !== null}
      />
      {refusal ? (
        <div className="border-b border-(--el-border-soft) p-(--spacing-card-padding)">
          <RefusalBox refusal={refusal} />
        </div>
      ) : null}
      {boot && !wakeRefusal ? (
        <AgentBootReadout
          boot={boot}
          agentState={agent.state}
          waking={waking}
          onWake={onWake}
          onDelete={() => actions.onDelete(agent)}
        />
      ) : null}
      <div className="flex items-center justify-between gap-3 border-b border-(--el-border-soft) px-(--spacing-card-padding) py-2">
        {/* The shipped tab track: Terminal, then Chat (MOTIR-7011 panel 1). */}
        <nav
          aria-label={t('panel.tabs.label')}
          className="inline-flex items-center gap-0.5 rounded-(--radius-btn) border border-(--el-border) bg-(--el-tabnav-track) p-0.5"
        >
          {waitingFor ? (
            // The waiting delta, panel 5: the Terminal tab disabled while the agent
            // waits for room, its reason on hover AND keyboard focus — the pattern
            // the disabled Chat tab below already draws.
            <span
              role="button"
              tabIndex={0}
              aria-disabled="true"
              aria-describedby={terminalTipId}
              data-testid="agent-terminal-tab-disabled"
              className={`group ${TAB_BOX} cursor-not-allowed text-(--el-text-secondary) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none`}
            >
              <Ban aria-hidden="true" className="size-3.5" />
              {t('panel.tabs.terminal')}
              <span
                role="tooltip"
                id={terminalTipId}
                className="absolute top-[calc(100%+6px)] left-0 z-20 hidden w-[260px] rounded-(--radius-control) bg-(--el-tooltip-bg) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) text-xs leading-normal font-normal whitespace-normal text-(--el-tooltip-text) shadow-(--shadow-elevated) group-hover:block group-focus-visible:block"
              >
                {t('waiting.terminalTip')}
              </span>
            </span>
          ) : (
            <button
              type="button"
              aria-current={tab === 'terminal' ? 'page' : undefined}
              onClick={() => selectTab('terminal')}
              className={tab === 'terminal' ? TAB_ON : TAB_OFF}
            >
              <span
                aria-hidden="true"
                className={`inline-flex ${tab === 'terminal' ? 'text-(--el-tabnav-active)' : ''}`}
              >
                <SquareTerminal className="size-3.5" />
              </span>
              {t('panel.tabs.terminal')}
            </button>
          )}
          {chatVerdict.supported ? (
            <button
              type="button"
              aria-current={tab === 'chat' ? 'page' : undefined}
              onClick={() => selectTab('chat')}
              className={tab === 'chat' ? TAB_ON : TAB_OFF}
            >
              <span
                aria-hidden="true"
                className={`inline-flex ${tab === 'chat' ? 'text-(--el-tabnav-active)' : ''}`}
              >
                <MessageSquare className="size-3.5" />
              </span>
              {t('panel.tabs.chat')}
            </button>
          ) : (
            // Q1 (aider): disabled, still read — secondary ink, never faint — with
            // the reason on hover AND keyboard focus, tied by aria-describedby.
            <span
              role="button"
              tabIndex={0}
              aria-disabled="true"
              aria-describedby={chatTipId}
              data-testid="agent-chat-tab-disabled"
              className={`group ${TAB_BOX} cursor-not-allowed text-(--el-text-secondary) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none`}
            >
              <Ban aria-hidden="true" className="size-3.5" />
              {t('panel.tabs.chat')}
              <span
                role="tooltip"
                id={chatTipId}
                className="absolute top-[calc(100%+6px)] left-0 z-20 hidden w-[260px] rounded-(--radius-control) bg-(--el-tooltip-bg) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) text-xs leading-normal font-normal whitespace-normal text-(--el-tooltip-text) shadow-(--shadow-elevated) group-hover:block group-focus-visible:block"
              >
                {t('panel.chat.unsupported')}
              </span>
            </span>
          )}
        </nav>
        <span
          data-testid="agent-conn"
          className="inline-flex items-center gap-1.5 text-xs text-(--el-text-secondary)"
        >
          <span aria-hidden="true" className={`size-[7px] rounded-full ${DOT[area.dot]}`} />
          {area.word}
        </span>
      </div>
      {tab === 'terminal' ? run.bar : null}
      {watchingRun ? run.strip : area.strip}
      {/* The terminal stays mounted under the chat, so its screen and socket survive a tab switch. */}
      <div
        data-testid="agent-terminal-body"
        className={`${TAB_BODY_MIN} flex-1 flex-col ${tab === 'terminal' ? 'flex' : 'hidden'}`}
      >
        {/* The shell stays mounted while the run is watched, so switching back is instant. */}
        <div className={run.watching ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
          {terminalArea.body}
        </div>
        {run.body}
      </div>
      {chatOpened ? (
        <div
          data-testid="agent-chat-tab"
          className={`${TAB_BODY_MIN} flex-1 flex-col ${tab === 'chat' ? 'flex' : 'hidden'}`}
        >
          {chatArea.body}
        </div>
      ) : null}
    </>
  );
}

type RunView =
  | { kind: 'shell' }
  | { kind: 'run'; session: string; runId: string; workItemKey: string | null };

/**
 * THE RUN'S SESSION, beside the developer's shell (MOTIR-7029 panels 1, 3, 4).
 *
 * The switch shows while the shell's socket lists a run session AND the record
 * says that run is working in this agent — the panel matches the listing's run id
 * to the run line's. A listing the record has not caught up with asks the list to
 * re-read (the run just started); a listing that drops its run, or a watched
 * session that exits, does too (the run just ended) — the end arrives from both
 * directions, and either one turns the header without a reload.
 */
function useRunView({
  projectKey,
  agent,
  term,
  onRefresh,
}: {
  projectKey: string;
  agent: AgentInstanceListItemDto;
  term: ReturnType<typeof useAgentTerminal>;
  onRefresh: () => void;
}): { watching: boolean; bar: ReactNode; strip: ReactNode; body: ReactNode } {
  const t = useTranslations('myAgents');
  const sink = useRef<TerminalSink | null>(null);
  const [view, setView] = useState<RunView>({ kind: 'shell' });
  const listed = term.sessions.find((s) => s.kind === 'run') ?? null;
  const activeRun = agent.activeRun;
  const offered = listed && activeRun && listed.runId === activeRun.id ? listed : null;
  const watch = useRunSessionWatch({
    projectKey,
    agentId: agent.id,
    session: view.kind === 'run' ? view.session : null,
    sink,
  });

  // The listing and the record disagree: re-read the record, once per change.
  const listedRun = listed?.runId ?? null;
  const seenListed = useRef<string | null>(null);
  useEffect(() => {
    const previous = seenListed.current;
    seenListed.current = listedRun;
    if (listedRun !== null && listedRun !== activeRun?.id) onRefresh();
    else if (listedRun === null && previous !== null) onRefresh();
  }, [listedRun, activeRun?.id, onRefresh]);

  // The watched session exited (or the server no longer knows it) — the run
  // ended: re-read the record for how it ended.
  const watchEnded = view.kind === 'run' && watch.conn.kind === 'ended';
  useEffect(() => {
    if (watchEnded) onRefresh();
  }, [watchEnded, onRefresh]);

  // A watch that could not be opened at all hands the reader back their shell.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (watch.conn.kind === 'lost') setView({ kind: 'shell' });
  }, [watch.conn.kind]);

  const toShell = () => setView({ kind: 'shell' });
  const watching = view.kind === 'run';
  const stripIcon = 'size-4 flex-none';

  // Panel 3: once the watched session has ended its segment has left the switch,
  // and with one session left the switch goes — the ended strip holds the way back.
  const bar =
    offered || (watching && !watchEnded) ? (
      <div className="flex items-center gap-3 border-b border-(--el-border-soft) px-(--spacing-card-padding) py-2">
        <Segmented
          label={t('panel.run.sessions.label')}
          value={watching ? 'run' : 'shell'}
          fill
          className="@5xl:inline-flex @5xl:w-auto @5xl:[&>button]:flex-none @5xl:[&>button]:px-(--spacing-control-x)"
          onChange={(next) => {
            if (next === 'shell') toShell();
            else if (offered) {
              setView({
                kind: 'run',
                session: offered.session,
                runId: offered.runId ?? '',
                workItemKey: activeRun?.workItemKey ?? null,
              });
            }
          }}
          options={[
            {
              value: 'shell',
              label: t('panel.run.sessions.shell'),
              icon: <SquareTerminal className="size-3.5" />,
            },
            {
              value: 'run',
              label: t('panel.run.sessions.run', {
                key: (watching ? view.workItemKey : activeRun?.workItemKey) ?? '',
              }),
              icon: <span className="size-[7px] rounded-full bg-(--el-status-in-progress)" />,
              trailing: <Eye aria-hidden="true" className="size-3.5" />,
            },
          ]}
        />
        <span className="ml-auto hidden text-xs text-(--el-text-secondary) @5xl:inline">
          {t('panel.run.sessions.watchOnly')}
        </span>
      </div>
    ) : null;

  if (view.kind === 'shell') return { watching: false, bar, strip: null, body: null };

  const key = view.workItemKey ?? '';
  let strip: ReactNode;
  if (watchEnded) {
    const last = agent.lastRun?.id === view.runId ? agent.lastRun : null;
    const text = !last
      ? t('panel.conn.ended')
      : last.status === 'succeeded'
        ? t('panel.run.strip.endedSucceeded')
        : t('panel.run.strip.endedFailed');
    strip = (
      <Strip
        tone="muted"
        icon={
          last?.status === 'succeeded' ? (
            <CircleCheck className={stripIcon} aria-hidden="true" />
          ) : (
            <SquareTerminal className={stripIcon} aria-hidden="true" />
          )
        }
        text={text}
        action={
          <Button
            variant="secondary"
            size="sm"
            className="flex-none bg-(--el-card)"
            leftIcon={<SquareTerminal aria-hidden="true" />}
            onClick={toShell}
          >
            {t('panel.run.backToShell')}
          </Button>
        }
      />
    );
  } else if (watch.conn.kind === 'takenOver') {
    strip = (
      <Strip
        tone="muted"
        icon={<Eye className={stripIcon} aria-hidden="true" />}
        text={t('panel.strip.takenOver')}
        action={
          <Button
            variant="secondary"
            size="sm"
            className="flex-none bg-(--el-card)"
            leftIcon={<RotateCw aria-hidden="true" />}
            onClick={watch.retake}
          >
            {t('panel.useHere')}
          </Button>
        }
      />
    );
  } else {
    strip = (
      <Strip
        tone="sky"
        icon={<Eye className={stripIcon} aria-hidden="true" />}
        text={t.rich('panel.run.strip.watching', {
          key,
          link: (chunks) =>
            view.workItemKey ? (
              <Link href={itemHref(view.workItemKey)} className="text-(--el-link) underline">
                {chunks}
              </Link>
            ) : (
              chunks
            ),
        })}
      />
    );
  }

  const connecting = watch.conn.kind === 'connecting' || watch.conn.kind === 'idle';
  const body = (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="agent-run-watch">
      <AgentTerminal
        key={view.session}
        sinkRef={sink}
        onData={() => {}}
        onResize={watch.sendResize}
        inputEnabled={false}
        watchOnly
        dimmed={watchEnded || watch.conn.kind === 'takenOver'}
        label={t('panel.run.sessions.run', { key })}
        jumpLabel={t('panel.jumpLatest')}
        sizeLabel={(cols, rows) => t('panel.size', { cols, rows })}
        overlay={
          connecting && !watchEnded ? (
            <Face icon={<LoaderCircle className={FACE_ICON} aria-hidden="true" />}>
              <span>{t('panel.face.connecting', { name: agent.name })}</span>
            </Face>
          ) : undefined
        }
      />
    </div>
  );
  return { watching: true, bar, strip, body };
}

function Face({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-(--el-code-bg) p-4 text-center text-[0.8125rem] text-(--el-code-text)">
      {icon}
      {title ? <strong className="text-sm">{title}</strong> : null}
      {children}
    </div>
  );
}

/**
 * The agent's lifecycle, in either tab's faces (panel 4): every state but
 * `running` is a face, whichever tab is open. Null when the agent runs.
 */
function useLifecycleArea({
  agent,
  waking,
  wakeRefusal,
  onWake,
  Face: FaceC,
  wakingHint,
  bootShown,
}: {
  agent: AgentInstanceListItemDto;
  waking: boolean;
  wakeRefusal: AgentRefusal | null;
  onWake: () => void;
  Face: FaceComponent;
  wakingHint: string;
  /** The boot read-out above the tabs carries the progress and the failure (MOTIR-7400). */
  bootShown: boolean;
}): TabArea | null {
  const t = useTranslations('myAgents');
  const wakeButton = (
    <Button size="sm" leftIcon={<Power aria-hidden="true" />} onClick={onWake} loading={waking}>
      {t('panel.wake')}
    </Button>
  );
  const closed = { word: t('panel.conn.closed'), dot: 'ended' as Dot, strip: null };
  const wakingFace = (
    <FaceC
      icon={<LoaderCircle className={FACE_ICON} aria-hidden="true" />}
      title={t('progress.waking')}
    >
      <span>{wakingHint}</span>
    </FaceC>
  );
  const refused = (refusal: AgentRefusal) => (
    <FaceC>
      <div className="max-w-[28rem] text-left">
        <RefusalBox refusal={refusal} />
      </div>
      {wakeButton}
    </FaceC>
  );

  // While the read-out shows the boot, the area under the tabs only says where
  // the terminal will be — the old progress title leaves it (the boot delta).
  if (bootShown && (agent.state === 'starting' || agent.state === 'waking')) {
    return {
      word: t('panel.conn.waiting'),
      dot: agent.state === 'waking' ? 'busy' : 'idle',
      strip: null,
      body: (
        <FaceC>
          <span>{t('panel.face.startingHint')}</span>
        </FaceC>
      ),
    };
  }
  if (bootShown && agent.state === 'failed' && !wakeRefusal) {
    return {
      ...closed,
      body: (
        <FaceC>
          <span>{t('boot.terminalClosed')}</span>
        </FaceC>
      ),
    };
  }

  switch (agent.state) {
    case 'starting':
      return {
        word: t('panel.conn.waiting'),
        dot: 'idle',
        strip: null,
        body: (
          <FaceC
            icon={<LoaderCircle className={FACE_ICON} aria-hidden="true" />}
            title={t('progress.starting')}
          >
            <span>{t('panel.face.startingHint')}</span>
          </FaceC>
        ),
      };
    case 'waking':
      return { word: t('panel.conn.waiting'), dot: 'busy', strip: null, body: wakingFace };
    case 'updating':
      // The update delta, panel 4: the machine reboots onto the new image (or back);
      // the terminal and the chat reconnect when the agent is running again.
      return {
        word: t('panel.conn.reconnecting'),
        dot: 'busy',
        strip: null,
        body: (
          <FaceC
            icon={<LoaderCircle className={FACE_ICON} aria-hidden="true" />}
            title={t('update.updating.title', { to: agent.pendingImageVersion ?? '' })}
          >
            <span>{t('update.updating.body')}</span>
          </FaceC>
        ),
      };
    case 'hibernating':
      return {
        ...closed,
        body: (
          <FaceC
            icon={<Moon className={FACE_ICON} aria-hidden="true" />}
            title={t('progress.hibernating')}
          >
            <span>{t('panel.face.hibernatingHint')}</span>
          </FaceC>
        ),
      };
    case 'deleting':
      return {
        ...closed,
        body: (
          <FaceC
            icon={<Trash2 className={FACE_ICON} aria-hidden="true" />}
            title={t('progress.deleting')}
          >
            <span>{t('panel.face.deletingHint')}</span>
          </FaceC>
        ),
      };
    case 'hibernated': {
      if (wakeRefusal) return { ...closed, body: refused(wakeRefusal) };
      // The wake the open asked for is in flight: its face is waking's.
      if (waking)
        return { word: t('panel.conn.waiting'), dot: 'busy', strip: null, body: wakingFace };
      return {
        ...closed,
        body: (
          <FaceC
            icon={<Moon className={FACE_ICON} aria-hidden="true" />}
            title={t('panel.face.hibernatedTitle', { name: agent.name })}
          >
            {agent.stopReason ? <span>{t(`stop.${agent.stopReason}`)}</span> : null}
            <span>{t('panel.face.kept')}</span>
            {wakeButton}
          </FaceC>
        ),
      };
    }
    case 'failed': {
      if (wakeRefusal) return { ...closed, body: refused(wakeRefusal) };
      return {
        ...closed,
        body: (
          <FaceC icon={<CircleAlert className={FACE_ICON} aria-hidden="true" />}>
            {agent.failureReason ? (
              <span className="text-[0.8125rem] text-(--el-danger-on-surface)">
                {agent.failureReason}
              </span>
            ) : null}
            <span>{t('failedWayOut')}</span>
            {wakeButton}
          </FaceC>
        ),
      };
    }
    case 'running':
      return null;
  }
  return null;
}

/** Decide the connection word, the strip and the terminal area from ONE state. */
function useTerminalArea({
  agent,
  hasTerminal,
  lifecycle,
  everLive,
  reconnect,
  newShell,
  term,
  sink,
  onUpdate,
}: {
  agent: AgentInstanceListItemDto;
  hasTerminal: boolean;
  lifecycle: TabArea | null;
  everLive: boolean;
  reconnect: () => void;
  newShell: () => void;
  term: ReturnType<typeof useAgentTerminal>;
  sink: React.RefObject<TerminalSink | null>;
  /** Open the Update confirmation — the image-too-old face's way out (MOTIR-6953). */
  onUpdate: () => void;
}): TabArea {
  const t = useTranslations('myAgents');
  const conn: TerminalConn = term.conn;
  const stripIcon = STRIP_ICON;
  if (lifecycle) return lifecycle;

  // Q8: an image from before the terminal — the agent is fine, it just has no terminal.
  if (!hasTerminal || conn.kind === 'noTerminal') {
    return {
      word: t('panel.conn.unavailable'),
      dot: 'ended',
      strip: null,
      body: (
        <Face
          icon={<Package className={FACE_ICON} aria-hidden="true" />}
          title={t('panel.noTerminal.title')}
        >
          {agent.update && agent.update !== 'unknown' ? (
            // The update delta, panel 8: the way out is the update, where one is offered.
            <>
              <span className="max-w-[28rem]">
                {t('update.imageTooOld.body', { to: agent.update.version })}
              </span>
              <Button size="sm" leftIcon={<CircleArrowUp aria-hidden="true" />} onClick={onUpdate}>
                {t('update.actionTo', { to: agent.update.version })}
              </Button>
            </>
          ) : (
            <span className="max-w-[28rem]">{t('panel.noTerminal.body')}</span>
          )}
        </Face>
      ),
    };
  }

  let word = t('panel.conn.connecting');
  let dot: Dot = 'busy';
  let strip: ReactNode = null;
  let overlay: ReactNode = null;
  const again = (label: string, onClick: () => void) => (
    <Button
      variant="secondary"
      size="sm"
      className="flex-none bg-(--el-card)"
      leftIcon={<RotateCw aria-hidden="true" />}
      onClick={onClick}
    >
      {label}
    </Button>
  );
  switch (conn.kind) {
    case 'live':
      word = t('panel.conn.live');
      dot = 'live';
      break;
    case 'reconnecting':
      word = t('panel.conn.reconnecting');
      strip = (
        <Strip
          tone="sky"
          icon={<LoaderCircle className={stripIcon} aria-hidden="true" />}
          text={t('panel.strip.reconnecting')}
        />
      );
      break;
    case 'lost':
      word = t('panel.conn.lost');
      dot = 'lost';
      strip = (
        <Strip
          tone="rose"
          alert
          icon={<CircleAlert className={stripIcon} aria-hidden="true" />}
          text={conn.machine ? t('panel.strip.lostMachine') : t('panel.strip.lost')}
          action={again(t('panel.reconnect'), reconnect)}
        />
      );
      break;
    case 'exited':
      word = t('panel.conn.ended');
      dot = 'ended';
      strip = (
        <Strip
          tone="muted"
          icon={<SquareTerminal className={stripIcon} aria-hidden="true" />}
          text={t('panel.strip.exited')}
          action={again(t('panel.newShell'), newShell)}
        />
      );
      break;
    case 'takenOver':
      word = t('panel.conn.ended');
      dot = 'ended';
      strip = (
        <Strip
          tone="muted"
          icon={<SquareTerminal className={stripIcon} aria-hidden="true" />}
          text={t('panel.strip.takenOver')}
          action={again(t('panel.useHere'), reconnect)}
        />
      );
      break;
    case 'sessionLimit':
      word = t('panel.conn.unavailable');
      dot = 'ended';
      overlay = (
        <Face icon={<SquareTerminal className={FACE_ICON} aria-hidden="true" />}>
          <span>{t('panel.sessionLimit', { name: agent.name })}</span>
          {again(t('panel.tryAgain'), reconnect)}
        </Face>
      );
      break;
    default:
      // idle · connecting · notRunning (the wake is under way): the connecting face,
      // over a terminal that has never shown this agent's shell in this panel.
      if (!everLive) {
        overlay = (
          <Face icon={<LoaderCircle className={FACE_ICON} aria-hidden="true" />}>
            <span>{t('panel.face.connecting', { name: agent.name })}</span>
          </Face>
        );
      }
  }

  const paused = conn.kind === 'reconnecting' || conn.kind === 'lost' || conn.kind === 'takenOver';
  return {
    word,
    dot,
    strip,
    body: (
      <AgentTerminal
        sinkRef={sink}
        onData={term.sendInput}
        onResize={term.sendResize}
        inputEnabled={conn.kind === 'live'}
        dimmed={paused}
        label={t('panel.tabs.terminal')}
        jumpLabel={t('panel.jumpLatest')}
        sizeLabel={(cols, rows) => t('panel.size', { cols, rows })}
        overlay={overlay}
      />
    ),
  };
}
