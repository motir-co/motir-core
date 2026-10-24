'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Clock, Plus, SquareTerminal, TriangleAlert } from 'lucide-react';
import { RunTonePill } from '@/components/runs/RunTonePill';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  AGENT_STATES_IN_MOTION,
  AGENT_STATE_TONE,
  formatMachineTime,
  MY_AGENTS_LIST_LIMIT,
  type AgentMove,
} from '@/lib/agentInstances/presentation';
import type {
  AgentInstanceDto,
  AgentInstanceListItemDto,
  AgentInstanceListPageDto,
} from '@/lib/dto/agentInstances';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import type { Locale } from '@/lib/i18n/locales';
import { formatDate } from '@/lib/utils/datetime';
import { AgentPanel, TAB_PARAM, type AgentPanelActions, type AgentPanelTab } from './AgentPanel';
import { AgentRowMenu } from './AgentRowMenu';
import { bootRowLine } from './AgentBootReadout';
import { CreateAgentDialog, type OfferedProfile } from './CreateAgentDialog';
import { AgentImageVersion } from './AgentImageVersion';
import { DeleteAgentDialog } from './DeleteAgentDialog';
import { UpdateAgentDialog } from './UpdateAgentDialog';
import { RefusalBox, useAgentRefusal, type AgentRefusal } from './agentRefusal';

// THE MY AGENTS ROOM (Story MOTIR-6860 · MOTIR-6874) — the client island behind
// `design/my-agents/my-agents.mock.html` (MOTIR-6868 revision 3).
//
// ⚠️ IT OWNS ITS LIST, SO IT REFETCHES ITSELF (the page-state-after-mutation
// contract, case 3). It is seeded from the server's first read and never relies on
// `router.refresh()`, which cannot reach a `useState` seed: every create, wake,
// hibernate and delete re-reads the list, and while any row is in motion
// (starting, hibernating, waking, deleting) it polls until that row settles, so a
// transition resolves on screen without a reload. Reads are sequence-guarded, so an
// older response never overwrites a newer one.
//
// THE AGENT PANEL (Story MOTIR-6861 · MOTIR-6941, `my-agents--panel.mock.html`):
// the row is the door. Opening an agent puts `?agent=<id>` in the address with
// `shallowPush` (the panel's body is already in the browser — CLAUDE.md § URL
// state the CLIENT reads), so a reload or a shared link reopens it and Back
// closes it. Open, the page is two columns: the list, in its card form and still
// usable, beside the panel. The panel's Hibernate / Delete / Wake run through
// THIS island's own handlers, so the list re-reads itself after every one — the
// same page-state contract (case 3) the row menu follows.

/** The query parameter that names the open agent. */
const AGENT_PARAM = 'agent';

function agentHref(id: string | null): string {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set(AGENT_PARAM, id);
  else url.searchParams.delete(AGENT_PARAM);
  // An agent opens on Terminal (MOTIR-7011 panel 1): switching or closing drops `&tab=`.
  url.searchParams.delete(TAB_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** How often a row in motion is re-read. */
const POLL_MS = 2_000;
/**
 * How often the list is re-read while a run works in any agent (MOTIR-7029): the
 * panel's run line gives way to its "Last run" face when the record closes, with
 * no reload. The run's session exiting re-reads at once; this is the backstop for
 * a run that ends while nobody watches it.
 */
export const RUN_POLL_MS = 5_000;

type Action =
  | { kind: 'create' }
  | { kind: 'move'; id: string }
  | { kind: 'delete'; id: string }
  | { kind: 'update'; id: string };

export function MyAgentsRoom({
  projectKey,
  projectName,
  initial,
  profiles,
  storageCreditsPerDay = null,
  openAgentId = null,
  openTab = 'terminal',
}: {
  projectKey: string;
  projectName: string;
  /** The server's first read; `null` when it failed (panel 7's failure face). */
  initial: AgentInstanceListPageDto | null;
  profiles: readonly OfferedProfile[];
  /** The daily storage rate on a cloud build, `null` where storage is free (self-hosted). */
  storageCreditsPerDay?: number | null;
  /** The agent the address names (`?agent=`), read by the page; null when none. */
  openAgentId?: string | null;
  /** The tab the address names for that agent (`&tab=chat`), read by the page. */
  openTab?: AgentPanelTab;
}) {
  const t = useTranslations('myAgents');
  const refusalFor = useAgentRefusal();
  const [data, setData] = useState<AgentInstanceListPageDto | null>(initial);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AgentInstanceListItemDto | null>(null);
  const [pending, setPending] = useState<Action | null>(null);
  const [createRefusal, setCreateRefusal] = useState<AgentRefusal | null>(null);
  const [deleteRefusal, setDeleteRefusal] = useState<AgentRefusal | null>(null);
  const [updateTarget, setUpdateTarget] = useState<AgentInstanceListItemDto | null>(null);
  const [updateRefusal, setUpdateRefusal] = useState<AgentRefusal | null>(null);
  const [listRefusal, setListRefusal] = useState<AgentRefusal | null>(null);
  /** The agent the list's refusal is about: shown in its panel when that one is open. */
  const [listRefusalFor, setListRefusalFor] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(openAgentId);
  // The address's tab applies to the agent the page opened with, once: an agent
  // the reader opens from the list starts on Terminal.
  const [landingTab, setLandingTab] = useState<{ id: string; tab: AgentPanelTab } | null>(
    openAgentId ? { id: openAgentId, tab: openTab } : null,
  );
  const returnFocusTo = useRef<string | null>(null);
  /** A just-created agent: its panel's name heading takes focus once it renders (boot delta, panel 1). */
  const focusHeadingOf = useRef<string | null>(null);
  const seq = useRef(0);
  const base = `/api/projects/${encodeURIComponent(projectKey)}/instances`;

  // Back / forward move the address; the panel follows it.
  useEffect(() => {
    const onPop = () => {
      setOpenId(new URLSearchParams(window.location.search).get(AGENT_PARAM));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const openAgent = useCallback((id: string) => {
    setLandingTab(null);
    setOpenId(id);
    shallowPush(agentHref(id));
  }, []);

  const closeAgent = useCallback(() => {
    setLandingTab(null);
    setOpenId((current) => {
      returnFocusTo.current = current;
      return null;
    });
    shallowPush(agentHref(null));
  }, []);

  // Closing returns focus to the row that was open (panel 1 C).
  useEffect(() => {
    if (openId !== null || !returnFocusTo.current) return;
    const id = returnFocusTo.current;
    returnFocusTo.current = null;
    // The table row on a wide page, the card on a narrow one — whichever is shown.
    const doors = [
      ...document.querySelectorAll<HTMLElement>(
        `[data-agent-id="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id}"]`,
      ),
    ];
    (doors.find((el) => el.getClientRects().length > 0) ?? doors[0])?.focus();
  }, [openId]);

  useEffect(() => {
    if (!focusHeadingOf.current || openId !== focusHeadingOf.current) return;
    focusHeadingOf.current = null;
    document
      .querySelector<HTMLElement>('[data-testid="agent-panel"] [data-agent-heading]')
      ?.focus();
  }, [openId]);

  const load = useCallback(async (): Promise<AgentInstanceListPageDto | null> => {
    const mine = ++seq.current;
    try {
      const res = await fetch(`${base}?limit=${MY_AGENTS_LIST_LIMIT}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as AgentInstanceListPageDto;
      if (mine === seq.current) setData(body);
      return body;
    } catch {
      // A failed re-read keeps the last good list on screen; only a failed FIRST
      // read shows the failure face.
      return null;
    }
  }, [base]);

  const rows = data?.instances ?? [];
  const inMotion = rows.some((r) => AGENT_STATES_IN_MOTION.has(r.state));
  const anyRun = rows.some((r) => r.activeRun !== null);
  const pollMs = inMotion ? POLL_MS : anyRun ? RUN_POLL_MS : null;
  useEffect(() => {
    if (pollMs === null) return;
    const id = setInterval(() => void load(), pollMs);
    return () => clearInterval(id);
  }, [pollMs, load]);

  async function send(
    url: string,
    init: RequestInit,
  ): Promise<
    | { ok: true; body: { instance?: AgentInstanceDto } | null }
    | { ok: false; body: { code?: string; reason?: string } | null }
  > {
    try {
      const res = await fetch(url, init);
      if (res.ok) return { ok: true, body: (await res.json().catch(() => null)) as never };
      return { ok: false, body: (await res.json().catch(() => null)) as never };
    } catch {
      return { ok: false, body: null };
    }
  }

  async function onCreate(input: { name: string; profileId: string }) {
    setPending({ kind: 'create' });
    setCreateRefusal(null);
    const result = await send(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    setPending(null);
    if (!result.ok) {
      setCreateRefusal(refusalFor(result.body, input.name));
      return;
    }
    // THE BOOT DELTA, panel 1: the create answers at `starting`, so the dialog
    // closes on the answer and the new agent's panel opens. The list is a client
    // island, so the row goes in from the answer itself (newest first) — a stale
    // in-flight re-read is retired by the sequence bump — and the poll that runs
    // while it boots carries it from there.
    setCreateOpen(false);
    const instance = result.body?.instance;
    if (instance) {
      seq.current += 1;
      const row: AgentInstanceListItemDto = {
        ...instance,
        profileName: profiles.find((p) => p.id === instance.profileId)?.name ?? instance.profileId,
        machineSecondsThisMonth: 0,
        creditsThisMonth: 0,
        stopReason: null,
        scheduledDeletionAt: null,
        activeRun: null,
        lastRun: null,
        bootStep: null,
      };
      setData((prev) =>
        prev
          ? {
              ...prev,
              total: prev.total + 1,
              instances: [row, ...prev.instances.filter((r) => r.id !== row.id)],
            }
          : prev,
      );
      focusHeadingOf.current = instance.id;
      openAgent(instance.id);
    }
    await load();
  }

  async function onMove(row: AgentInstanceListItemDto, move: AgentMove) {
    setListRefusal(null);
    if (move === 'delete') {
      setDeleteRefusal(null);
      setDeleteTarget(row);
      return;
    }
    setPending({ kind: 'move', id: row.id });
    const result = await send(`${base}/${encodeURIComponent(row.id)}/${move}`, { method: 'POST' });
    setPending(null);
    if (!result.ok) {
      setListRefusal(refusalFor(result.body, row.name, move));
      setListRefusalFor(row.id);
    }
    await load();
  }

  async function onConfirmDelete() {
    if (!deleteTarget) return;
    setPending({ kind: 'delete', id: deleteTarget.id });
    const result = await send(`${base}/${encodeURIComponent(deleteTarget.id)}`, {
      method: 'DELETE',
    });
    setPending(null);
    if (!result.ok) {
      setDeleteRefusal(refusalFor(result.body, deleteTarget.name, 'delete'));
      return;
    }
    // Deleting closes the panel; the list keeps the row in Deleting until it is gone.
    if (deleteTarget.id === openId) closeAgent();
    setDeleteTarget(null);
    await load();
  }

  /**
   * UPDATE (MOTIR-6953, `agent-image-update.md` Q2–Q8): one call, then the
   * server's answer. The dialog closes and the list re-reads itself; while the
   * agent is `updating` the page polls it (AGENT_STATES_IN_MOTION) until it is
   * back — never an optimistic "updated".
   */
  async function onConfirmUpdate() {
    if (!updateTarget) return;
    const target = updateTarget;
    setPending({ kind: 'update', id: target.id });
    const result = await send(`${base}/${encodeURIComponent(target.id)}/update`, {
      method: 'POST',
    });
    setPending(null);
    if (!result.ok) {
      setUpdateRefusal(refusalFor(result.body, target.name, 'update', target.state));
      await load();
      return;
    }
    setUpdateTarget(null);
    await load();
  }

  const openUpdate = useCallback((row: AgentInstanceListItemDto) => {
    setUpdateRefusal(null);
    setUpdateTarget(row);
  }, []);

  // The panel's own doors, all through this island so the list re-reads itself.
  const onMoveRef = useRef(onMove);
  useLayoutEffect(() => {
    onMoveRef.current = onMove;
  });
  const panelActions = useMemo<AgentPanelActions>(
    () => ({
      onClose: closeAgent,
      onHibernate: (row) => void onMoveRef.current(row, 'hibernate'),
      onDelete: (row) => void onMoveRef.current(row, 'delete'),
      onUpdate: openUpdate,
      onWake: async (row) => {
        const result = await send(`${base}/${encodeURIComponent(row.id)}/wake`, {
          method: 'POST',
        });
        const fresh = await load();
        if (result.ok) return null;
        // Already woken — by the row's menu a moment before the panel opened on a
        // list still reading hibernated, or by another tab. The wake asked for is
        // under way, so there is nothing to refuse, and a refusal would hide the
        // boot read-out (MOTIR-7393).
        const now = fresh?.instances.find((r) => r.id === row.id)?.state;
        if (
          result.body?.code === 'agent_instance_state_conflict' &&
          (now === 'waking' || now === 'starting' || now === 'running')
        )
          return null;
        return refusalFor(result.body, row.name);
      },
      onRefresh: () => void load(),
    }),
    // `refusalFor` is rebuilt each render from the same translator; the doors
    // need only the routes and the list's reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, closeAgent, load, openUpdate],
  );

  const total = data?.total ?? 0;
  const newAgent = (
    <Button
      leftIcon={<Plus aria-hidden="true" />}
      onClick={() => {
        setCreateRefusal(null);
        setCreateOpen(true);
      }}
    >
      {t('newAgent')}
    </Button>
  );

  const openRow = openId ? (rows.find((r) => r.id === openId) ?? null) : null;
  const list =
    data === null ? (
      <div
        role="alert"
        className="flex items-center gap-2 rounded-(--radius-card) bg-(--el-tint-rose) px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-strong)"
      >
        <TriangleAlert className="size-4 flex-none" aria-hidden="true" />
        {t('loadFailed')}
      </div>
    ) : total === 0 ? (
      // The shipped empty state — the same component the Runs page uses, so the
      // title, copy and action carry the design system's own type and spacing.
      <EmptyState
        icon={<SquareTerminal className="h-12 w-12" aria-hidden="true" />}
        title={t('emptyTitle')}
        description={t(storageCreditsPerDay === null ? 'emptyBody' : 'emptyBodyWithStorage')}
        action={newAgent}
      />
    ) : openId ? (
      // Open: the list column is below the table's width, so its rows take the
      // page's own card form (base panel 8), with the open one marked.
      <AgentCards
        rows={rows}
        projectName={projectName}
        onMove={onMove}
        onOpen={openAgent}
        selectedId={openRow?.id ?? null}
        always
      />
    ) : (
      <>
        <AgentTable
          rows={rows}
          projectName={projectName}
          pending={pending}
          onMove={onMove}
          onOpen={openAgent}
        />
        <AgentCards rows={rows} projectName={projectName} onMove={onMove} onOpen={openAgent} />
      </>
    );

  return (
    <div className="@container flex flex-col gap-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('title')}</h1>
          <p className="text-sm text-(--el-text-secondary)">
            <span className="hidden sm:inline">{t('subtitle', { project: projectName })}</span>
            <span className="sm:hidden">{t('subtitleNarrow', { project: projectName })}</span>
          </p>
        </div>
        <div className="self-start sm:self-auto">{newAgent}</div>
      </header>

      {data?.planLapse ? <PlanLapseBanner deletesOn={data.planLapse.deletesOn} /> : null}

      {listRefusal && !(openId && listRefusalFor === openId) ? (
        <RefusalBox refusal={listRefusal} />
      ) : null}

      {openId && data !== null ? (
        // Two columns from 1024px of content; below it the open agent takes the
        // whole view and the header's crumb returns to the list (panel 7).
        <div className="grid items-start gap-4 @5xl:grid-cols-[340px_minmax(0,1fr)]">
          <div className="hidden min-w-0 @5xl:block">{list}</div>
          <AgentPanel
            projectKey={projectKey}
            projectName={projectName}
            agent={openRow}
            actions={panelActions}
            initialTab={landingTab && landingTab.id === openRow?.id ? landingTab.tab : 'terminal'}
            refusal={listRefusal && listRefusalFor === openId ? listRefusal : null}
          />
        </div>
      ) : (
        list
      )}

      <CreateAgentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectName={projectName}
        profiles={profiles}
        pending={pending?.kind === 'create'}
        refusal={createRefusal}
        storageCreditsPerDay={storageCreditsPerDay}
        onCreate={(input) => void onCreate(input)}
      />
      <UpdateAgentDialog
        agent={updateTarget}
        onOpenChange={(open) => {
          if (!open) setUpdateTarget(null);
        }}
        pending={pending?.kind === 'update'}
        refusal={updateRefusal}
        onConfirm={() => void onConfirmUpdate()}
      />
      <DeleteAgentDialog
        name={deleteTarget?.name ?? null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        pending={pending?.kind === 'delete'}
        refusal={deleteRefusal}
        onConfirm={() => void onConfirmDelete()}
      />
    </div>
  );
}

/** The line under a row's name: progress in motion, the failure, or why Motir stopped it. */
function useRowLine() {
  const t = useTranslations('myAgents');
  const tb = useTranslations('myAgents.boot');
  return (row: AgentInstanceListItemDto): { text: string; danger: boolean } | null => {
    if (row.state === 'failed') {
      const reason = row.failureReason ?? '';
      const wayOut = t('failedWayOut');
      return {
        text: reason.includes(wayOut) ? reason : `${reason} ${wayOut}`.trim(),
        danger: true,
      };
    }
    if (row.state === 'updating') {
      return {
        text: t('update.updating.title', { to: row.pendingImageVersion ?? '' }),
        danger: false,
      };
    }
    // The update delta, panel 2: a rolled-back agent says why, under its name.
    if (row.state === 'running' && row.updateFailureReason) {
      return { text: row.updateFailureReason, danger: true };
    }
    if (row.state === 'hibernated' && row.stopReason) {
      return { text: t(`stop.${row.stopReason}`), danger: false };
    }
    // The boot delta, panel 10: a booting row names the step it is on.
    if ((row.state === 'starting' || row.state === 'waking') && row.bootStep) {
      return { text: bootRowLine(row.bootStep, tb), danger: false };
    }
    if (
      row.state === 'starting' ||
      row.state === 'hibernating' ||
      row.state === 'waking' ||
      row.state === 'deleting'
    ) {
      return { text: t(`progress.${row.state}`), danger: false };
    }
    return null;
  };
}

/** Why a booting row waits for room (MOTIR-9475), or null while it does not. */
function waitingOf(row: AgentInstanceListItemDto): 'pool' | 'account' | null {
  return row.state === 'starting' || row.state === 'waking'
    ? (row.bootStep?.waiting ?? null)
    : null;
}

/** The row's state pill: _Waiting_, in the neutral tone, while its boot waits for room. */
function AgentStatePill({ row }: { row: AgentInstanceListItemDto }) {
  const t = useTranslations('myAgents');
  return waitingOf(row) ? (
    <RunTonePill tone="queued">{t('waiting.status')}</RunTonePill>
  ) : (
    <RunTonePill tone={AGENT_STATE_TONE[row.state]}>{t(`state.${row.state}`)}</RunTonePill>
  );
}

function RowLine({ line }: { line: { text: string; danger: boolean } | null }) {
  if (!line) return null;
  return (
    <span
      className={`block text-xs ${line.danger ? 'text-(--el-danger-on-surface)' : 'text-(--el-text-secondary)'}`}
    >
      {line.text}
    </span>
  );
}

/**
 * The org's AI plan has ended (MOTIR-6916 delta, panel E; MOTIR-6921): between
 * the header and the list, the date every agent will be deleted and the way to
 * stop it. The date is Billing & plans' format, in UTC — the deletion happens at
 * the start of that UTC day.
 */
function PlanLapseBanner({ deletesOn }: { deletesOn: string }) {
  const t = useTranslations('myAgents.lapse');
  const locale = useLocale() as Locale;
  return (
    <div
      role="status"
      className="flex items-start gap-2.5 rounded-(--radius-card) border border-(--el-warning) bg-(--el-tint-peach) p-(--spacing-card-padding) text-sm text-(--el-text-strong)"
    >
      <TriangleAlert
        className="mt-px size-[18px] flex-none text-(--el-warning)"
        aria-hidden="true"
      />
      <span>
        <strong className="block">{t('bannerLead')}</strong>
        {t('bannerBody', { date: formatDate(deletesOn, locale) })}{' '}
        <Link href="/settings/organization/billing" className="font-semibold text-(--el-link)">
          {t('renew')}
        </Link>
      </span>
    </div>
  );
}

/** A row scheduled for deletion: its date, in danger ink on a surface, as its last line. */
function DeletionLine({ at }: { at: string | null }) {
  const t = useTranslations('myAgents.lapse');
  const locale = useLocale() as Locale;
  if (!at) return null;
  return (
    <span className="mt-1 flex items-center gap-1 text-xs text-(--el-danger-on-surface)">
      <Clock className="size-3 flex-none" aria-hidden="true" />
      {t('rowLine', { date: formatDate(at, locale) })}
    </span>
  );
}

/**
 * The row is the door (panel 1): a click or Enter opens the agent. The row menu
 * keeps its own click — its cell swallows the event, including the menu's
 * portalled items, whose React events bubble through this tree.
 */
function doorProps(id: string, onOpen: (id: string) => void) {
  return {
    tabIndex: 0,
    'data-agent-id': id,
    onClick: () => onOpen(id),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' && event.target === event.currentTarget) onOpen(id);
    },
  };
}

const stop = {
  onClick: (event: React.MouseEvent) => event.stopPropagation(),
  onKeyDown: (event: React.KeyboardEvent) => event.stopPropagation(),
};

function AgentTable({
  rows,
  projectName,
  pending,
  onMove,
  onOpen,
}: {
  rows: AgentInstanceListItemDto[];
  projectName: string;
  pending: Action | null;
  onMove: (row: AgentInstanceListItemDto, move: AgentMove) => void;
  onOpen: (id: string) => void;
}) {
  const t = useTranslations('myAgents');
  const lineFor = useRowLine();
  const th =
    'px-(--spacing-control-x) py-(--spacing-control-y) text-left text-xs font-semibold whitespace-nowrap text-(--el-text-secondary)';
  const td = 'px-(--spacing-control-x) py-(--spacing-control-y) align-middle';
  return (
    <div className="hidden overflow-x-auto rounded-(--radius-card) border border-(--el-border) md:block">
      <table className="w-full border-collapse">
        <thead className="border-b border-(--el-border) bg-(--el-surface)">
          <tr>
            <th scope="col" className={th}>
              {t('col.name')}
            </th>
            <th scope="col" className={th}>
              {t('col.codingAgent')}
            </th>
            <th scope="col" className={th}>
              {t('col.project')}
            </th>
            <th scope="col" className={th}>
              {t('col.state')}
            </th>
            <th scope="col" className={`${th} text-right`}>
              {t('col.machineTime')}
            </th>
            <th scope="col" className={`${th} text-right`}>
              {t('col.credits')}
            </th>
            <th scope="col" className={th}>
              <span className="sr-only">{t('col.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              data-testid="agent-row"
              data-state={row.state}
              aria-busy={pending?.kind !== 'create' && pending?.id === row.id ? true : undefined}
              {...doorProps(row.id, onOpen)}
              className="cursor-pointer border-b border-(--el-border-soft) last:border-b-0 hover:bg-(--el-surface-soft) focus-visible:bg-(--el-surface-soft) focus-visible:shadow-[inset_3px_0_0_var(--el-accent)] focus-visible:outline-none"
            >
              <td className={td}>
                <strong className="text-sm text-(--el-text)">{row.name}</strong>
                <RowLine line={lineFor(row)} />
                <DeletionLine at={row.scheduledDeletionAt} />
              </td>
              <td className={`${td} text-sm whitespace-nowrap text-(--el-text)`}>
                {row.profileName}
                <AgentImageVersion agent={row} />
              </td>
              <td className={`${td} text-sm whitespace-nowrap text-(--el-text-secondary)`}>
                {projectName}
              </td>
              <td className={`${td} whitespace-nowrap`}>
                <AgentStatePill row={row} />
              </td>
              <td
                className={`${td} text-right text-sm whitespace-nowrap text-(--el-text) tabular-nums`}
              >
                {formatMachineTime(row.machineSecondsThisMonth)}
              </td>
              <td
                className={`${td} text-right text-sm whitespace-nowrap text-(--el-text) tabular-nums`}
              >
                {row.creditsThisMonth}
              </td>
              <td className={`${td} text-right`} {...stop}>
                <AgentRowMenu
                  name={row.name}
                  state={row.state}
                  wakeNeedsPlan={row.scheduledDeletionAt !== null}
                  waiting={waitingOf(row)}
                  onMove={(m) => onMove(row, m)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Panel 8: below the table's width each agent is a card. */
function AgentCards({
  rows,
  projectName,
  onMove,
  onOpen,
  selectedId = null,
  always = false,
}: {
  rows: AgentInstanceListItemDto[];
  projectName: string;
  onMove: (row: AgentInstanceListItemDto, move: AgentMove) => void;
  onOpen: (id: string) => void;
  /** The open agent's card carries the "this one" mark (panel 1). */
  selectedId?: string | null;
  /** The list column beside the panel is always cards, whatever the viewport. */
  always?: boolean;
}) {
  const t = useTranslations('myAgents');
  const lineFor = useRowLine();
  return (
    <ul
      data-testid={always ? 'agent-list-column' : undefined}
      className={`m-0 flex list-none flex-col gap-2 p-0 ${always ? '' : 'md:hidden'}`}
    >
      {rows.map((row) => (
        <li
          key={row.id}
          {...doorProps(row.id, onOpen)}
          aria-current={row.id === selectedId ? 'true' : undefined}
          className={`flex cursor-pointer flex-col gap-1 rounded-(--radius-card) border px-(--spacing-control-x) py-(--spacing-control-y) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none ${
            row.id === selectedId
              ? 'border-(--el-accent) bg-(--el-tint-lavender)'
              : 'border-(--el-border) hover:bg-(--el-surface-soft)'
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <strong className="text-sm text-(--el-text)">{row.name}</strong>
            <span {...stop}>
              <AgentRowMenu
                name={row.name}
                state={row.state}
                wakeNeedsPlan={row.scheduledDeletionAt !== null}
                waiting={waitingOf(row)}
                onMove={(m) => onMove(row, m)}
              />
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 text-sm text-(--el-text-secondary)">
            <span>
              {row.profileName} · {projectName}
            </span>
            <AgentStatePill row={row} />
          </div>
          <AgentImageVersion agent={row} />
          <div className="flex items-center justify-between gap-2 text-sm text-(--el-text-secondary)">
            <span>{t('thisMonth', { time: formatMachineTime(row.machineSecondsThisMonth) })}</span>
            <span>{t('creditsCount', { count: row.creditsThisMonth })}</span>
          </div>
          <RowLine line={lineFor(row)} />
          <DeletionLine at={row.scheduledDeletionAt} />
        </li>
      ))}
    </ul>
  );
}
