'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowLeft,
  CircleAlert,
  CircleArrowUp,
  CircleCheck,
  CircleHelp,
  Lock,
  Moon,
  Trash2,
  X,
} from 'lucide-react';
import { RunTonePill } from '@/components/runs/RunTonePill';
import { Button } from '@/components/ui/Button';
import { AGENT_STATE_TONE, allowedAgentMoves } from '@/lib/agentInstances/presentation';
import { agentSignInHint } from '@/lib/agentInstances/profiles';
import type { AgentInstanceListItemDto } from '@/lib/dto/agentInstances';
import { AgentImageVersion } from './AgentImageVersion';
import { AgentRunLine } from './AgentRunLine';
import type { TerminalSignIn } from './useAgentTerminal';

// THE PANEL'S HEADER (Story MOTIR-6861 · MOTIR-6941; `design/my-agents/design-notes.md`
// § the agent panel, panels 2, 3 and 7): the list row's facts promoted — name,
// the list's own state pill, coding agent · project — with Hibernate (running
// only), Delete… (disabled, never hidden, where §4 allows no Delete) and ×;
// then the sign-in status the terminal server pushed, and the §9 sentence.
//
// THE AGENT'S LIVE RUN (Story MOTIR-6864 · MOTIR-7029, `my-agents--run.mock.html`
// panels 1–4): the run line under the meta line (AgentRunLine), and while a run
// works in the agent Hibernate and Delete wear their disabled face with ONE line
// saying why — the server refuses both during a run (`agent_instance_run_active`),
// so the panel does not offer a press it knows will be refused.

/**
 * Is an update offered to this agent (`agent-image-update.md` Q1, Q5)? A newer
 * image, on a running or hibernated agent that has not already taken one.
 */
export function updateOffered(agent: AgentInstanceListItemDto): boolean {
  return (
    agent.update !== null &&
    agent.update !== 'unknown' &&
    (agent.state === 'running' || (agent.state === 'hibernated' && !agent.pendingImageVersion))
  );
}

/** How long a sign-in that just turned keeps its mint ground (panel 3). */
const JUST_TURNED_MS = 4_000;

export const ICON_BUTTON =
  'inline-flex h-(--height-btn-sm) w-(--height-btn-sm) flex-none items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';

export function AgentPanelHeader({
  agent,
  projectName,
  signIn,
  onClose,
  onHibernate,
  onDelete,
  onUpdate,
  waiting = false,
}: {
  agent: AgentInstanceListItemDto;
  projectName: string;
  /** The last `signin` frame; null before the terminal connects (no guess, Q7). */
  signIn: TerminalSignIn | null;
  onClose: () => void;
  onHibernate: () => void;
  onDelete: () => void;
  /** Open the Update confirmation (MOTIR-6953). */
  onUpdate: () => void;
  /** The boot waits for room (MOTIR-9475): the pill reads _Waiting_, the neutral tone. */
  waiting?: boolean;
}) {
  const t = useTranslations('myAgents');
  const runActive = agent.activeRun !== null;
  // Delete… follows the row menu's own rule (panel 2), read from §4's table.
  const deleteOff = !allowedAgentMoves(agent.state).has('delete') || runActive;
  const updating = agent.state === 'updating';
  // The update delta, panel 1: Update is the FIRST action, shown while an update
  // is offered; while the agent updates it stays, disabled, with the other two.
  const showUpdate = updateOffered(agent) || updating;
  const offClass =
    'disabled:bg-(--el-surface) disabled:text-(--el-text-secondary) disabled:opacity-100';
  return (
    <div className="flex flex-col gap-2.5 border-b border-(--el-border-soft) p-(--spacing-card-padding)">
      <button
        type="button"
        onClick={onClose}
        className="inline-flex items-center gap-1 self-start text-[0.8125rem] text-(--el-link) hover:underline @5xl:hidden"
      >
        <ArrowLeft className="size-3.5" aria-hidden="true" />
        {t('panel.back')}
      </button>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <h2
            tabIndex={-1}
            data-agent-heading
            className="m-0 flex flex-wrap items-center gap-2 font-serif text-lg font-semibold text-(--el-text) focus-visible:outline-none"
          >
            {agent.name}
            <RunTonePill tone={waiting ? 'queued' : AGENT_STATE_TONE[agent.state]}>
              {waiting ? t('waiting.status') : t(`state.${agent.state}`)}
            </RunTonePill>
          </h2>
          <p className="mt-0.5 mb-0 text-[0.8125rem] text-(--el-text-secondary)">
            {agent.profileName} · {projectName}
          </p>
          <AgentImageVersion agent={agent} />
          {agent.updateFailureReason && agent.state === 'running' ? (
            <p
              data-testid="agent-update-failed"
              className="mt-1 mb-0 text-xs text-(--el-danger-on-surface)"
            >
              {agent.updateFailureReason}
            </p>
          ) : null}
        </div>
        <div className="order-last flex basis-full flex-wrap items-center gap-1.5 @5xl:order-none @5xl:basis-auto">
          {showUpdate ? (
            <Button
              size="sm"
              disabled={updating}
              aria-disabled={updating || undefined}
              className={offClass}
              leftIcon={<CircleArrowUp aria-hidden="true" />}
              onClick={onUpdate}
            >
              {t('update.action')}
            </Button>
          ) : null}
          {agent.state === 'running' || updating ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={runActive || updating}
              aria-disabled={runActive || updating || undefined}
              className={offClass}
              leftIcon={<Moon aria-hidden="true" />}
              onClick={onHibernate}
            >
              {t('panel.hibernate')}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            disabled={deleteOff}
            aria-disabled={deleteOff || undefined}
            className={`text-(--el-danger-on-surface) ${offClass}`}
            leftIcon={<Trash2 aria-hidden="true" />}
            onClick={onDelete}
          >
            {t('panel.delete')}
          </Button>
        </div>
        <button
          type="button"
          aria-label={t('panel.close', { name: agent.name })}
          onClick={onClose}
          className={ICON_BUTTON}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      {/* One polite region: the run line and the sign-in line both change under the reader. */}
      <div aria-live="polite" className="flex flex-col gap-2.5">
        <AgentRunLine activeRun={agent.activeRun} lastRun={agent.lastRun} />
        {runActive ? (
          <p data-testid="agent-run-off" className="m-0 text-xs text-(--el-text-secondary)">
            {t('panel.run.offWhy')}
          </p>
        ) : null}
        {signIn && agent.state === 'running' ? (
          <SignInLine profileId={agent.profileId} agentName={agent.profileName} signIn={signIn} />
        ) : null}
      </div>
      <p className="m-0 flex items-start gap-2 text-xs text-(--el-text-secondary)">
        <Lock className="mx-px mt-px size-3.5 flex-none" aria-hidden="true" />
        <span>{t('panel.privacy', { agent: agent.profileName })}</span>
      </p>
    </div>
  );
}

function Cmd({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-(--radius-badge) bg-(--el-code-bg) px-(--spacing-chip-x) font-mono text-xs whitespace-nowrap text-(--el-code-text)">
      {children}
    </code>
  );
}

/** Panel 3: the three sign-in states, with each coding agent's own command. */
function SignInLine({
  profileId,
  agentName,
  signIn,
}: {
  profileId: string;
  agentName: string;
  signIn: TerminalSignIn;
}) {
  const t = useTranslations('myAgents.panel.signin');
  const hint = agentSignInHint(profileId);
  const values = {
    agent: agentName,
    first: hint?.values[0] ?? '',
    second: hint?.values[1] ?? '',
    cmd: (chunks: ReactNode) => <Cmd>{chunks}</Cmd>,
  };

  // The turn lands once on the mint ground, then settles (panel 3).
  const previous = useRef(signIn.state);
  const [justTurned, setJustTurned] = useState(false);
  useEffect(() => {
    const was = previous.current;
    previous.current = signIn.state;
    if (was !== 'signed_in' && signIn.state === 'signed_in') {
      setJustTurned(true);
      const id = setTimeout(() => setJustTurned(false), JUST_TURNED_MS);
      return () => clearTimeout(id);
    }
  }, [signIn.state]);

  const line = 'flex items-start gap-2 text-[0.8125rem]';
  if (signIn.state === 'signed_in') {
    return (
      <div
        data-testid="agent-signin"
        data-state="signed_in"
        className={`${line} ${
          justTurned
            ? '-mx-2 -my-1 rounded-(--radius-control) bg-(--el-tint-mint) px-(--spacing-control-x-8) py-(--spacing-control-y-4) text-(--el-text-strong)'
            : 'text-(--el-text)'
        }`}
      >
        <CircleCheck className="mt-px size-4 flex-none text-(--el-success)" aria-hidden="true" />
        <span>{t('signedIn', { agent: agentName })}</span>
      </div>
    );
  }
  if (signIn.state === 'signed_out') {
    const outKey =
      hint && (profileId === 'claude' || profileId === 'codex' || profileId === 'opencode')
        ? profileId
        : 'generic';
    return (
      <div
        data-testid="agent-signin"
        data-state="signed_out"
        className={`${line} text-(--el-text)`}
      >
        <CircleAlert className="mt-px size-4 flex-none text-(--el-warning)" aria-hidden="true" />
        <span>{t.rich(`signedOut.${outKey}`, values)}</span>
      </div>
    );
  }
  // Never a tick for "can't be checked": the neutral question glyph is the point.
  const howKey =
    hint && (profileId === 'kimi' || profileId === 'aider' || profileId === 'goose')
      ? profileId
      : 'generic';
  return (
    <div data-testid="agent-signin" data-state="unknown" className={`${line} text-(--el-text)`}>
      <CircleHelp
        className="mt-px size-4 flex-none text-(--el-text-secondary)"
        aria-hidden="true"
      />
      <span>
        {t('unknown', { agent: agentName })}
        <span className="mt-0.5 block text-xs text-(--el-text-secondary)">
          {t.rich(`unknownHow.${howKey}`, values)}
        </span>
      </span>
    </div>
  );
}
