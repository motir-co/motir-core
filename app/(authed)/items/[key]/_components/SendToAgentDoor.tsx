'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronDown, CircleAlert, CircleCheck, CircleHelp, SquareTerminal } from 'lucide-react';
import { RunTonePill } from '@/components/runs/RunTonePill';
import { Button, buttonVariants } from '@/components/ui/Button';
import { cn } from '@/lib/utils/cn';
import { Popover } from '@/components/ui/Popover';
import { Spinner } from '@/components/ui/Spinner';
import { AGENT_STATE_TONE } from '@/lib/agentInstances/presentation';
import { agentSignInHint } from '@/lib/agentInstances/profiles';
import type { AgentForCardDto } from '@/lib/dto/agentInstanceRuns';
import { runsHref } from '@/lib/runs/runsAddress';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import { agentPanelHref } from '@/app/(authed)/runs/_components/AgentRunParts';
import { useHostedRun } from './HostedRunProvider';

// SEND TO MY AGENT — the start bar's second option's control and the PICKER of
// the developer's own agents (Story MOTIR-6864 · MOTIR-7028;
// `design/runs/design-notes.md` § Run in my agent panels 1–4, § Revision 2 panel 2).
//
// ⚠️ THE LIST IS THE SERVER'S. The picker reads `GET …/agent-runs/agents` each time
// it opens and lists exactly what that answers — the caller's own agents on the
// card's project, never another member's. A row that cannot take the work STAYS
// listed, `aria-disabled`, with its reason in words: an agent that vanished from
// the list would read as an agent that is gone.
//
// ⚠️ THERE IS NO START BUTTON. Pressing a row that can take the work IS the send;
// the popover closes on the answer. Arrows skip a disabled row, Enter sends, Esc
// closes (the Popover's) and returns focus to the control.

type Load = { state: 'loading' } | { state: 'failed' } | { state: 'ok'; agents: AgentForCardDto[] };

/** Whether a row can take the work — the read already says why not, if not. */
const pickable = (a: AgentForCardDto): boolean => a.refusal === null && !a.waitingForRoom;

export function SendToAgentDoor() {
  const t = useTranslations('runs.agent');
  const door = useHostedRun();
  const agentDoor = door?.agentDoor ?? null;
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [active, setActive] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const itemKey = door?.itemKey ?? '';

  const read = useCallback(async (): Promise<void> => {
    setLoad({ state: 'loading' });
    try {
      const res = await fetch(`/api/work-items/${encodeURIComponent(itemKey)}/agent-runs/agents`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        setLoad({ state: 'failed' });
        return;
      }
      const body = (await res.json()) as { agents: AgentForCardDto[] };
      setLoad({ state: 'ok', agents: body.agents });
      setActive(body.agents.find(pickable)?.id ?? null);
    } catch {
      setLoad({ state: 'failed' });
    }
  }, [itemKey]);

  // Every opening reads the list afresh — so after a refusal the busy (or gone)
  // row says so the next time the picker opens.
  useEffect(() => {
    if (!open) return;
    void (async () => {
      await read();
    })();
  }, [open, read]);

  const sendingId = agentDoor?.sendingId ?? null;
  const send = agentDoor?.send;
  // Only a row that can take the work calls this: an off row has no press, and
  // the keys walk the free rows alone.
  const choose = useCallback(
    async (agent: AgentForCardDto): Promise<void> => {
      await send?.(agent);
      setOpen(false);
    },
    [send],
  );

  if (!door || !agentDoor) return null;

  const disabled = !door.ready || door.starting;
  const agents = load.state === 'ok' ? load.agents : [];
  const free = agents.filter(pickable);

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>): void => {
    if (free.length === 0) return;
    const at = free.findIndex((a) => a.id === active);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = free[(at + step + free.length) % free.length]!;
      setActive(next.id);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const chosen = free[at] ?? free[0]!;
      void choose(chosen);
    }
  };

  return (
    <Popover open={open} onOpenChange={(o) => (sendingId ? undefined : setOpen(o))}>
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          aria-haspopup="dialog"
          data-testid="send-to-agent"
          leftIcon={<SquareTerminal className="size-3.5" aria-hidden="true" />}
          rightIcon={<ChevronDown className="size-3.5" aria-hidden="true" />}
        >
          {sendingId ? t('door.starting') : t('door.send')}
        </Button>
      </Popover.Trigger>
      <Popover.Content
        align="end"
        width="25rem"
        className="max-w-[calc(100vw-2rem)]"
        aria-label={t('door.send')}
        data-testid="send-to-agent-picker"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          listRef.current?.focus();
        }}
      >
        {load.state === 'ok' && agents.length === 0 ? (
          <EmptyFace projectName={agentDoor.projectName} />
        ) : (
          <>
            <div className="border-b border-(--el-border-soft) px-(--spacing-control-x) pt-2.5 pb-2 font-sans">
              <p className="text-sm font-semibold text-(--el-text)">
                {t('picker.title', { key: itemKey })}
              </p>
              <p className="mt-0.5 text-xs text-(--el-text-secondary)">{t('picker.lead')}</p>
            </div>
            {load.state === 'loading' ? (
              <p
                role="status"
                className="px-(--spacing-control-x) py-3 font-sans text-xs text-(--el-text-secondary)"
                data-testid="send-to-agent-loading"
              >
                {t('picker.loading')}
              </p>
            ) : load.state === 'failed' ? (
              <div
                role="alert"
                className="flex items-center gap-2 px-(--spacing-control-x) py-3 font-sans text-xs text-(--el-text)"
                data-testid="send-to-agent-failed"
              >
                <span>{t('picker.failed')}</span>
                <Button type="button" variant="secondary" size="sm" onClick={() => void read()}>
                  {t('picker.retry')}
                </Button>
              </div>
            ) : (
              <ul
                ref={listRef}
                role="listbox"
                tabIndex={0}
                aria-label={t('picker.label')}
                aria-activedescendant={active ? `agent-row-${active}` : undefined}
                onKeyDown={onKeyDown}
                className="flex flex-col p-1 outline-none"
              >
                {agents.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    active={agent.id === active}
                    sending={agent.id === sendingId}
                    onChoose={() => void choose(agent)}
                    onHover={() => (pickable(agent) ? setActive(agent.id) : undefined)}
                  />
                ))}
              </ul>
            )}
            <div className="flex items-center gap-1.5 border-t border-(--el-border-soft) px-(--spacing-control-x) py-2 font-sans text-xs text-(--el-text-secondary)">
              <span>{t('picker.foot', { project: agentDoor.projectName })}</span>
              <Link
                href="/my-agents"
                className="ml-auto whitespace-nowrap text-(--el-link) underline"
              >
                {t('picker.manage')}
              </Link>
            </div>
          </>
        )}
      </Popover.Content>
    </Popover>
  );
}

/** Panel 4: no agent on the project — what an agent is, and where to make one. */
function EmptyFace({ projectName }: { projectName: string }) {
  const t = useTranslations('runs.agent.empty');
  return (
    <div
      className="flex flex-col gap-1 px-(--spacing-control-x) py-3.5 font-sans"
      data-testid="send-to-agent-empty"
    >
      <p className="text-sm font-semibold text-(--el-text)">
        {t('title', { project: projectName })}
      </p>
      <p className="mb-2 text-xs text-(--el-text-secondary)">{t('body')}</p>
      <Link
        href="/my-agents"
        className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'self-start')}
        data-testid="send-to-agent-create"
      >
        <SquareTerminal className="size-3.5" aria-hidden="true" />
        {t('create')}
      </Link>
    </div>
  );
}

/** One agent — its name, its state (or *Working*), its sub-line and, when it
 *  cannot take the work, why (design panels 1–3). */
function AgentRow({
  agent,
  active,
  sending,
  onChoose,
  onHover,
}: {
  agent: AgentForCardDto;
  active: boolean;
  sending: boolean;
  onChoose: () => void;
  onHover: () => void;
}) {
  const t = useTranslations('runs.agent.picker');
  const tState = useTranslations('myAgents.state');
  const tWaiting = useTranslations('myAgents.waiting');
  const off = !pickable(agent);
  const busy = agent.refusal === 'agent_instance_run_active';
  const moving = agent.state === 'hibernating' || agent.state === 'deleting';
  const next =
    agent.state === 'running'
      ? t('next.now')
      : agent.state === 'hibernated'
        ? t('next.wakes')
        : agent.state === 'failed'
          ? t('next.failed')
          : t('next.whenUp');
  return (
    <li
      id={`agent-row-${agent.id}`}
      role="option"
      aria-selected={active}
      aria-disabled={off || undefined}
      data-testid="send-to-agent-row"
      data-agent={agent.name}
      data-refusal={agent.refusal ?? ''}
      onClick={off ? undefined : onChoose}
      onMouseEnter={onHover}
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-sm text-(--el-text) ${
        off ? '' : 'cursor-pointer'
      } ${active && !off ? 'bg-(--el-option-active-bg)' : ''}`}
    >
      <span
        className={`flex min-w-0 items-center gap-2 truncate font-semibold ${off ? 'text-(--el-text-secondary)' : ''}`}
      >
        <span className="truncate">{agent.name}</span>
        {sending ? <Spinner size="sm" aria-label={t('label')} /> : null}
      </span>
      {busy ? (
        <RunTonePill tone="running">{t('busyPill')}</RunTonePill>
      ) : agent.waitingForRoom ? (
        // The waiting delta (MOTIR-9475): the neutral tone, as in My agents.
        <RunTonePill tone="queued">{tWaiting('status')}</RunTonePill>
      ) : (
        <RunTonePill tone={AGENT_STATE_TONE[agent.state]}>{tState(agent.state)}</RunTonePill>
      )}
      <span className="col-span-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-(--el-text-secondary)">
        <span>{agent.profileName}</span>
        {moving ? null : (
          <>
            <span aria-hidden="true">·</span>
            <SignIn state={agent.signInState} />
          </>
        )}
        {off ? null : (
          <>
            <span aria-hidden="true">·</span>
            <span>{next}</span>
          </>
        )}
      </span>
      {busy ? <BusyLine agent={agent} /> : off ? <WhyLine agent={agent} /> : null}
    </li>
  );
}

function SignIn({ state }: { state: AgentForCardDto['signInState'] }) {
  const t = useTranslations('runs.agent.picker.signin');
  if (state === 'signed_in') {
    return (
      <span className="inline-flex items-center gap-1">
        <CircleCheck className="size-3.5 text-(--el-success)" aria-hidden="true" />
        {t('signedIn')}
      </span>
    );
  }
  if (state === 'signed_out') {
    return (
      <span className="inline-flex items-center gap-1">
        <CircleAlert className="size-3.5 text-(--el-warning)" aria-hidden="true" />
        {t('signedOut')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <CircleHelp className="size-3.5 text-(--el-text-secondary)" aria-hidden="true" />
      {t('unknown')}
    </span>
  );
}

/** Panel 2: the agent is already working on a work item — which one, and its run. */
function BusyLine({ agent }: { agent: AgentForCardDto }) {
  const t = useTranslations('runs.agent.picker');
  const routes = useReaderRoutes();
  const busy = agent.runningRun;
  const run = (chunks: ReactNode) => (
    <Link href={routes.view(runsHref({ run: busy?.id }))} className="text-(--el-link) underline">
      {chunks}
    </Link>
  );
  const key = busy?.workItemKey;
  let line: ReactNode;
  if (!key) {
    line = t.rich('busyUnknown', { run });
  } else {
    const k = (chunks: ReactNode) => (
      <Link href={routes.item(key)} className="font-mono font-semibold text-(--el-link) underline">
        {chunks}
      </Link>
    );
    line = busy.workItemTitle
      ? t.rich('busy', { key, k, run, title: busy.workItemTitle })
      : t.rich('busyNoTitle', { key, k, run });
  }
  return (
    <span
      className="col-span-2 block rounded-(--radius-control) bg-(--el-tint-sky) px-(--spacing-control-x) py-(--spacing-control-y) text-xs text-(--el-text-strong)"
      data-testid="send-to-agent-busy"
    >
      {line}
    </span>
  );
}

/** The inline sign-in command a coding agent is signed in with, as code. */
export function SignInCommand({ profileId }: { profileId: string }) {
  const t = useTranslations('runs.agent.command');
  const hint = agentSignInHint(profileId);
  const c = (chunks: ReactNode) => (
    <code className="rounded-(--radius-badge) bg-(--el-code-bg) px-(--spacing-chip-x-4) font-mono text-xs whitespace-nowrap text-(--el-code-text)">
      {chunks}
    </code>
  );
  const [first, second] = hint?.values ?? [];
  if (first === undefined) return <>{t('generic')}</>;
  return second !== undefined ? (
    <>{t.rich('two', { c, first, second })}</>
  ) : (
    <>{t.rich('one', { c, first })}</>
  );
}

/** Panel 3: why a row cannot take the work, and where to fix it. */
function WhyLine({ agent }: { agent: AgentForCardDto }) {
  const t = useTranslations('runs.agent.picker.off');
  const text = (() => {
    // A boot waiting for room is shown disabled with its reason (the waiting delta, panel 5).
    if (agent.waitingForRoom) return t('waitingForRoom');
    switch (agent.refusal) {
      case 'agent_instance_state_conflict':
        return agent.state === 'deleting' ? t('deleting') : t('hibernating');
      case 'agent_not_signed_in':
        return t.rich('signedOut', {
          name: agent.name,
          cmd: () => <SignInCommand profileId={agent.profileId} />,
          link: (chunks) => (
            <Link href={agentPanelHref(agent.id)} className="text-(--el-link) underline">
              {chunks}
            </Link>
          ),
        });
      case 'agent_instance_image_too_old':
        return t('imageTooOld');
      default:
        return t('cannotRun', { agent: agent.profileName });
    }
  })();
  return (
    <span className="col-span-2 block text-xs text-(--el-text)" data-testid="send-to-agent-why">
      {text}
    </span>
  );
}
