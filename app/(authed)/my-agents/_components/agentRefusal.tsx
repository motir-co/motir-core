'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { TriangleAlert } from 'lucide-react';
import { runsHref } from '@/lib/runs/runsAddress';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';

// EVERY REFUSAL, IN WORDS (MOTIR-6868 revision 3, panel 5). A route answers a
// refusal as `{ code, error, reason? }`; the page renders the DESIGN's localised
// sentence for it, never the server's English `error`. Create and Wake are refused
// before any machine boots, so each sentence says which rule refused and what to do.
// MOTIR-6916's delta (MOTIR-6918 builds it): the rules a person can act on with
// money or a count — the AI plan, credits, the per-person cap — open with a bold
// TITLE naming the rule, so two limits never read as one.

/** What the page knows about a refused request. */
export interface AgentRefusal {
  /** `busy` is a wait (the warning ground); everything else a refusal (rose). */
  kind: 'refusal' | 'busy';
  /** The bold line naming the rule (the delta's titled boxes); absent on the rest. */
  title?: string;
  message: ReactNode;
}

interface RefusalBody {
  code?: string;
  reason?: string;
  /** The figure a cap refusal applied (`user_cap`, `org_cap`). */
  limit?: number;
  /** The plan that figure is from, as motir-ai names it (MOTIR-9376). */
  planName?: string;
  /** `agent_instance_run_active` (MOTIR-7027): the run holding the agent, and its card. */
  runId?: string;
  workItemKey?: string | null;
  /** `agent_instance_up_to_date` (MOTIR-6953): the version the agent already runs. */
  version?: string | null;
}

/** The copy key a refused response maps to. Exported for the unit test. */
export function refusalKey(body: RefusalBody | null): string {
  switch (body?.reason) {
    case 'ai_plan_required':
      return 'aiPlanRequired';
    case 'ai_plan_unknown':
    // The plan's agent figures could not be read (MOTIR-9374): the same "could
    // not check your plan, try again" words, never the generic refusal.
    case 'plan_unknown':
      return 'aiPlanUnknown';
    case 'credits':
      return 'credits';
    case 'credits_unknown':
      return 'creditsUnknown';
    case 'user_cap':
      return 'userCap';
    case 'org_cap':
      return 'orgCap';
    case 'fleet_busy':
      return 'busy';
  }
  switch (body?.code) {
    case 'agent_instance_run_active':
      return 'runActive';
    case 'agent_instance_up_to_date':
      return 'upToDate';
    case 'agent_image_catalog_unavailable':
      return 'catalogUnknown';
    case 'agent_instance_name_taken':
      return 'nameTaken';
    case 'agent_instance_name_invalid':
      return 'nameInvalid';
    case 'agent_profile_not_offered':
      return 'notOffered';
    case 'agent_instances_unavailable':
      return 'unavailable';
    case 'agent_instance_state_conflict':
    case 'agent_instance_not_found':
      return 'conflict';
  }
  return 'generic';
}

/** The keys whose box opens with a title (the delta's table, MOTIR-6916). */
const TITLED = new Set(['aiPlanRequired', 'aiPlanUnknown', 'credits', 'userCap', 'orgCap']);

/** The keys whose sentence carries a link to Billing & plans. */
const BILLING_LINKED = new Set(['aiPlanRequired', 'credits']);

/**
 * A cap refusal's words (MOTIR-9376). The figure and the plan are the ones the
 * gate applied, read from the refusal body, so the page can never name a figure
 * the gate did not use. A body missing either (an older server mid-deploy) gets
 * the no-figure words: never a constant, never 0, never a default plan.
 */
function capValues(body: RefusalBody | null): { limit: number; plan: string } | null {
  return typeof body?.limit === 'number' && typeof body.planName === 'string' && body.planName
    ? { limit: body.limit, plan: body.planName }
    : null;
}

/** Build the refusal a failed response should show. */
export function useAgentRefusal() {
  const t = useTranslations('myAgents.refusal');
  const tt = useTranslations('myAgents.refusalTitle');
  const tRun = useTranslations('myAgents.panel.run');
  const tUpdate = useTranslations('myAgents.update.refused');
  const tState = useTranslations('myAgents.state');
  // The Start bar shares this with the Visitor tree's item page (MOTIR-6888).
  const routes = useReaderRoutes();
  const capWords = (key: 'userCap' | 'orgCap', values: ReturnType<typeof capValues>) =>
    values ? t(key, values) : t(`${key}NoFigure`);
  return (
    body: RefusalBody | null,
    name?: string,
    action: 'wake' | 'hibernate' | 'delete' | 'update' = 'hibernate',
    /** The agent's state as the page knew it — named by an Update's state refusal. */
    state?: string,
  ): AgentRefusal => {
    const key = refusalKey(body);
    // Update's own refusals (`agent-image-update.md` Q8, MOTIR-6953).
    if (key === 'upToDate') {
      return { kind: 'refusal', message: tUpdate('upToDate', { version: body?.version ?? '' }) };
    }
    if (key === 'catalogUnknown') return { kind: 'busy', message: tUpdate('unknown') };
    if (
      action === 'update' &&
      key === 'conflict' &&
      body?.code === 'agent_instance_state_conflict'
    ) {
      return {
        kind: 'refusal',
        message: tUpdate('state', { state: state ? tState(state).toLowerCase() : '' }),
      };
    }
    if (key === 'runActive') {
      // Hibernate / Delete during a run (MOTIR-7029 panel 2): name the run, link it.
      const runId = body?.runId ?? '';
      return {
        kind: 'refusal',
        message: tRun.rich(
          action === 'delete'
            ? 'refusedDelete'
            : action === 'update'
              ? 'refusedUpdate'
              : 'refusedHibernate',
          {
            name: name ?? '',
            key: body?.workItemKey ?? runId,
            link: (chunks) => (
              <Link
                href={routes.view(runsHref({ run: runId }))}
                className="text-(--el-link) underline"
              >
                {chunks}
              </Link>
            ),
          },
        ),
      };
    }
    const message = BILLING_LINKED.has(key)
      ? t.rich(key, {
          link: (chunks) => (
            <Link href="/settings/organization/billing" className="text-(--el-link) underline">
              {chunks}
            </Link>
          ),
        })
      : key === 'userCap' || key === 'orgCap'
        ? capWords(key, capValues(body))
        : key === 'nameTaken'
          ? t('nameTaken', { name: name ?? '' })
          : t(key);
    return {
      kind: key === 'busy' ? 'busy' : 'refusal',
      ...(TITLED.has(key) ? { title: tt(key) } : {}),
      message,
    };
  };
}

/** The refusal box — rose for a refusal, peach for a wait. */
export function RefusalBox({ refusal }: { refusal: AgentRefusal }) {
  return (
    <div
      role="alert"
      className={`flex items-start gap-2 rounded-(--radius-card) px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-strong) ${
        refusal.kind === 'busy' ? 'bg-(--el-tint-peach)' : 'bg-(--el-tint-rose)'
      }`}
    >
      <TriangleAlert className="mt-0.5 size-4 flex-none" aria-hidden="true" />
      {refusal.title ? (
        <span className="flex flex-col gap-0.5">
          <span className="font-semibold">{refusal.title}</span>
          <span>{refusal.message}</span>
        </span>
      ) : (
        <span>{refusal.message}</span>
      )}
    </div>
  );
}
