'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { DispatchRunOrigin, DispatchRunStatus } from '@/lib/dto/dispatchRuns';
import type { WorkItemContinueViewDto } from '@/lib/dto/workItemContinue';
import {
  HostedModelsProvider,
  reReadAfter,
  useHostedModels,
} from '@/components/hosted/HostedModelsProvider';
import { useContinueHosted } from '@/components/hosted/useContinueHosted';
import { useRunsChangedSignal } from '@/components/hosted/runsChangedSignal';
import {
  refusalOf,
  standingRefusal,
  type ContinueHostedRefusal,
  type HostedModelsState,
  type HostedRunRefusal,
} from '@/components/hosted/hostedModels';
import { useAgentSend, type AgentSendState } from './useAgentSend';

// THE HOSTED-RUN DOOR'S STATE on a work item (Story MOTIR-683 · MOTIR-691;
// `design/runs/design-notes.md` § Hosted runs).
//
// ⚠️ ONE STATE, TWO PLACES ON THE PAGE. The door (the model picker and Run hosted,
// or Cancel run) sits in the Run section's HEADER, and what it answers — a
// refusal, the picker's unavailable/empty notice, the not-ready reason — is drawn
// in the section's BODY. The header is a slot of the server-rendered section
// card, so the two are siblings; this provider is what they share.
//
// ⚠️ THE PAGE-STATE CONTRACT (CLAUDE.md § Page state after a mutation). A start
// and a cancel change two kinds of surface: the Run section's run history is a
// CLIENT island (`useState(initialRuns)`), which `router.refresh()` cannot reach,
// so it watches `runsChangedAt` and refetches; the card's status and the scope
// run are SERVER-rendered, so the same mutation also calls `router.refresh()`.
//
// ⚠️ AND A SECOND DOOR, CONTINUE HOSTED (Story MOTIR-6527 · MOTIR-6796;
// `design/runs/design-notes.md` § Continue hosted). It lives in the Development
// block's continue part, reads the SAME model list — the provider wraps both
// sections, so the page reads it once — and keeps its OWN start and refusal
// state: a refused continue is answered beside its button, never in the Run
// section's body. The continue view it is handed decides both where the door is
// offered and, on a died card, that Run hosted is not (C7).

export type {
  ContinueHostedRefusal,
  HostedModelsState,
  HostedRepositoryRefusal,
  HostedRunRefusal,
} from '@/components/hosted/hostedModels';
export {
  continueRefusalOf,
  continueStateMoved,
  preselectedModel,
} from '@/components/hosted/hostedModels';

/** The run the door is about: the section's current run, as the section reports it. */
export interface HostedDoorRun {
  id: string;
  origin: DispatchRunOrigin;
  status: DispatchRunStatus;
  /** Who started it — for a run in an agent, the agent's OWNER, the one who may
   *  cancel it (`agent-instance-run.md` §6; MOTIR-7028). */
  createdById?: string | null;
  /** The agent a run in an agent works in, for Cancel's words. */
  agentName?: string | null;
}

/**
 * SEND TO MY AGENT's state (Story MOTIR-6864 · MOTIR-7028) — offered beside Run
 * where the reader may use agents on the project. The start bar draws it; the Run
 * section's timeline reads `started` for the new run's *Waking* / *Starting in*.
 */
export interface AgentDoorValue extends AgentSendState {
  /** The project's name — the picker's footer and the empty face name it. */
  projectName: string;
}

export interface HostedRunContextValue {
  itemKey: string;
  /** The card's OWN readiness — the door's disabled reason. The server re-checks. */
  ready: boolean;
  openBlockers: number;
  models: HostedModelsState;
  selectedModel: string | null;
  selectModel: (id: string) => void;
  reloadModels: () => void;
  refusal: HostedRunRefusal | null;
  starting: boolean;
  start: () => Promise<void>;
  /** The run the door is about, reported by the Run section; null before it does. */
  currentRun: HostedDoorRun | null;
  reportCurrentRun: (run: HostedDoorRun | null) => void;
  /** Bumped by a start or a cancel — the Run section refetches its history on it. */
  runsChangedAt: number;
  /** A run was cancelled from the door or the section. */
  notifyRunsChanged: () => void;
  /** The key Continue hosted continues — the item's, or its dead parent run's —
   *  or null where the part offers no Continue hosted (C6). */
  continueTarget: string | null;
  viewerId: string | null;
  /** The item's run died and a continue, not a fresh run, is its way forward:
   *  Run hosted and its notices are not drawn (C7). */
  runDoorHidden: boolean;
  continueRefusal: ContinueHostedRefusal | null;
  continueStarting: boolean;
  startContinue: () => Promise<void>;
  /** Send to my agent, or null where the reader is not offered it. */
  agentDoor: AgentDoorValue | null;
}

const HostedRunContext = createContext<HostedRunContextValue | null>(null);

/** The door's state, or null where no door is mounted (a reader who may not run it). */
export function useHostedRun(): HostedRunContextValue | null {
  return useContext(HostedRunContext);
}

/** Where the continue view leaves the two doors (design § Continue hosted, C6/C7). */
export function continueDoorOf(view: WorkItemContinueViewDto | null | undefined): {
  continueTarget: (itemKey: string) => string | null;
  runDoorHidden: boolean;
} {
  if (!view || view.state !== 'died') {
    return { continueTarget: () => null, runDoorHidden: false };
  }
  return {
    continueTarget: (itemKey) =>
      view.refusal === null && view.branches.length > 0
        ? itemKey
        : view.refusal === 'continue_the_parent' && view.parentKey
          ? view.parentKey
          : null,
    runDoorHidden: view.refusal !== 'not_in_progress',
  };
}

export function HostedRunProvider({
  itemKey,
  ready,
  openBlockers,
  continueView = null,
  viewerId = null,
  agents = null,
  children,
}: {
  itemKey: string;
  ready: boolean;
  openBlockers: number;
  /** The Development block's continue view (MOTIR-6534) — where Continue hosted is
   *  offered, and whether Run hosted is. Null where it was not read. */
  continueView?: WorkItemContinueViewDto | null;
  /** The session's user — a `taken` answer naming them reads *you*. */
  viewerId?: string | null;
  /** Send to my agent's inputs (MOTIR-7028) — offered where the reader holds
   *  `instance:use` on the project — or null where it is not offered. */
  agents?: { projectName: string } | null;
  children: ReactNode;
}) {
  // ⚠️ THE MODEL LIST IS ITS OWN CONTEXT (MOTIR-6879): both doors read the one list
  // `HostedModelsProvider` fetches, so the state below is mounted INSIDE it. It
  // reads THIS card's resolved model too (MOTIR-6996), which Run hosted opens on.
  return (
    // It polls the capacity verdict while the page is visible (MOTIR-9630), so a held
    // model's label appears and clears without a reload.
    <HostedModelsProvider workItemKey={itemKey} pollCapacity>
      <HostedRunState
        itemKey={itemKey}
        ready={ready}
        openBlockers={openBlockers}
        continueView={continueView}
        viewerId={viewerId}
        agents={agents}
      >
        {children}
      </HostedRunState>
    </HostedModelsProvider>
  );
}

function HostedRunState({
  itemKey,
  ready,
  openBlockers,
  continueView,
  viewerId,
  agents,
  children,
}: {
  itemKey: string;
  ready: boolean;
  openBlockers: number;
  continueView: WorkItemContinueViewDto | null;
  viewerId: string | null;
  agents: { projectName: string } | null;
  children: ReactNode;
}) {
  const router = useRouter();
  // Always mounted: `HostedRunProvider` renders this inside `HostedModelsProvider`.
  const hosted = useHostedModels()!;
  const { models, selectedModel, setChosen, reloadModels } = hosted;
  const [refusal, setRefusal] = useState<HostedRunRefusal | null>(null);
  const [starting, setStarting] = useState(false);
  const [currentRun, setCurrentRun] = useState<HostedDoorRun | null>(null);
  const [runsChangedAt, setRunsChangedAt] = useState(0);
  const doors = continueDoorOf(continueView);
  const continueTarget = doors.continueTarget(itemKey);

  const notifyRunsChanged = useCallback(() => {
    setRunsChangedAt((n) => n + 1);
    router.refresh();
  }, [router]);
  // A start made by the To fix banner's *Fix on the hosted agent* (MOTIR-6930), which sits
  // outside this provider: it refreshed the server surfaces itself, so only the Run
  // section's island is owed its tick.
  const bumpRuns = useCallback(() => setRunsChangedAt((n) => n + 1), []);
  useRunsChangedSignal(itemKey, bumpRuns);

  const start = useCallback(async (): Promise<void> => {
    if (!selectedModel || starting) return;
    setStarting(true);
    setRefusal(null);
    try {
      const res = await fetch(`/api/work-items/${encodeURIComponent(itemKey)}/hosted-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ model: selectedModel }),
      });
      if (res.ok) {
        notifyRunsChanged();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const refused = refusalOf(res.status, body, selectedModel);
      setRefusal(refused);
      // The model was withdrawn, or lost its capacity, between page load and click:
      // re-read the list in place, so the person chooses again without a reload.
      reReadAfter(refused, hosted);
      // A boot failure OPENED a run and ended it: the history now holds it.
      if (refused.kind === 'bootFailed') notifyRunsChanged();
    } catch {
      setRefusal({ kind: 'failed' });
    } finally {
      setStarting(false);
    }
  }, [hosted, itemKey, notifyRunsChanged, selectedModel, starting]);

  // The continue press is the shared control's (`useContinueHosted`). A start
  // changes a SERVER read (the part) and a client island (the run history), so
  // both a start and a stale-page refusal re-read both.
  const continuePress = useContinueHosted(continueTarget, {
    onStarted: notifyRunsChanged,
    onStateMoved: notifyRunsChanged,
  });

  // SEND TO MY AGENT (MOTIR-7028): a start moves the section to the new run on the
  // same tick a Run press bumps.
  const send = useAgentSend(itemKey, notifyRunsChanged);
  const projectName = agents?.projectName ?? null;
  const agentDoor = useMemo<AgentDoorValue | null>(
    () => (projectName === null ? null : { ...send, projectName }),
    [send, projectName],
  );

  const value = useMemo<HostedRunContextValue>(
    () => ({
      itemKey,
      ready,
      openBlockers,
      models,
      selectedModel,
      selectModel: setChosen,
      reloadModels,
      // A no-capacity refusal clears when the person picks another model.
      refusal: standingRefusal(refusal, selectedModel),
      starting,
      start,
      currentRun,
      reportCurrentRun: setCurrentRun,
      runsChangedAt,
      notifyRunsChanged,
      continueTarget,
      viewerId,
      runDoorHidden: doors.runDoorHidden,
      continueRefusal: continuePress.refusal,
      continueStarting: continuePress.starting,
      startContinue: continuePress.start,
      agentDoor,
    }),
    [
      agentDoor,
      continueTarget,
      viewerId,
      doors.runDoorHidden,
      continuePress.refusal,
      continuePress.starting,
      continuePress.start,
      itemKey,
      ready,
      openBlockers,
      models,
      selectedModel,
      setChosen,
      reloadModels,
      refusal,
      starting,
      start,
      currentRun,
      runsChangedAt,
      notifyRunsChanged,
    ],
  );

  return <HostedRunContext.Provider value={value}>{children}</HostedRunContext.Provider>;
}
