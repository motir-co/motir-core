import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { allSettledOrThrow } from '@/lib/async/allSettledOrThrow';
import { approvalGateSettingsService } from '@/lib/services/approvalGateSettingsService';
import { acceptanceVideoEligibilityService } from '@/lib/services/acceptanceVideoEligibilityService';
import { projectPrMergeModeService } from '@/lib/services/projectPrMergeModeService';
import { DesignApprovalGateCard } from './_components/DesignApprovalGateCard';
import { AcceptanceVideoGateCard } from './_components/AcceptanceVideoGateCard';
import { MergeModeAndReviewAgentCards } from './_components/MergeModeAndReviewAgentCards';
import { guardSettingsPage } from '../_guard';
import { NO_PROJECT_PATH } from '@/lib/navigation/landing';

// `Project settings ▸ Approvals` — server component (Story MOTIR-4925 · Subtask
// MOTIR-5170), built to `design/projects/approvals.mock.html` panel 0 (the door)
// and panels 1–3 (On, Off, and Unavailable when the organisation has no paid AI
// plan — MOTIR-5171). Its second card, the MERGE MODE (Story MOTIR-4880 · Subtask
// MOTIR-5181), is panels 6–8.
//
// THE ROOM, not a card bolted onto an existing page, and the design argues it from
// the switch's readers and writers rather than from resemblance: a second
// project-tier gate switch is already decided (`docs/decisions/approval-gates.md`
// §7 moves the pull-request merge mode here, where `manual` raises a gate and
// `auto` raises none), and §7 also asks for a deep link from the approval surface
// to the switch that stops asking — which needs somewhere to land.
//
// Sibling of the Workflow / Board / Estimation rooms, and deliberately NEXT to
// Workflow in the rail: a status graph and an approval gate are the two things in
// Motir that decide when work may move.

export default async function ProjectApprovalsPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('settings');

  const ctx = await getActiveProject();
  // No active project: the reader can enter none of the workspace's projects
  // (MOTIR-6548) — the no-project landing, never `/sign-in`, which would
  // bounce a signed-in reader straight back.
  if (!ctx) redirect(NO_PROJECT_PATH);

  // THE DESTINATION GUARD (MOTIR-2469). Hiding is presentation and never
  // protection: this page is one typed URL away once its rail row is gone. The
  // key comes from the registry entry `approvals` and is never re-declared here,
  // so the row that hides the page and the page that refuses the actor cannot
  // gate on different keys.
  const refused = await guardSettingsPage('approvals', ctx);
  if (refused) return refused;

  // THREE reads, and the room owns two of them. The switch's stored value and the
  // merge mode are this room's SETTINGS; whether the organisation may publish
  // acceptance video at all is the eligibility service's verdict, read off its DTO
  // and never re-derived here — that service is the one place the entitlement AND
  // is computed. `no_plan` is the only reason that makes the switch moot:
  // `not_applicable` (self-host / the meta org) is UNGATED, so it is entitled.
  // `allSettledOrThrow`, not `Promise.all`: the eligibility read runs an org-access
  // gate that rejects on an ordinary path, and a sibling read must not be left
  // running unobserved when it does (MOTIR-3077).
  const serviceCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const [settings, eligibility, { prMergeMode }] = await allSettledOrThrow([
    approvalGateSettingsService.getSettings(ctx.projectId, serviceCtx),
    acceptanceVideoEligibilityService.resolve({
      actorUserId: ctx.userId,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
    }),
    projectPrMergeModeService.getPrMergeMode(ctx.projectId, serviceCtx),
  ]);

  return (
    <div className="mx-auto flex max-w-[42rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">
          {t('approvals.title')}
        </h1>
        <p className="text-(--el-text-secondary) font-sans text-sm">
          {t('approvals.pageDescription')}
        </p>
      </header>

      <AcceptanceVideoGateCard
        projectKey={ctx.project.identifier}
        initialEnabled={settings.acceptanceVideoEnabled}
        entitled={eligibility.reason !== 'no_plan'}
      />

      {/* The two approval switches together (MOTIR-702; `approvals--design-gate.mock.html`
          panel 3), then the merge settings that follow every approval. */}
      <DesignApprovalGateCard
        projectKey={ctx.project.identifier}
        initialEnabled={settings.designApprovalGate}
      />

      {/* Merge mode, then the REVIEW AGENT (MOTIR-6823) — third, because its copy
          reads the merge mode above it. One client island holds the pair, since
          the two exclude each other (approval-gates.md §12.2a). */}
      <MergeModeAndReviewAgentCards
        projectKey={ctx.project.identifier}
        initialPrMergeMode={prMergeMode}
        initialReviewAgentEnabled={settings.reviewAgentEnabled}
        initialReviewAgentSource={settings.reviewAgentSource}
        initialReviewBotPostsEnabled={settings.reviewBotPostsEnabled}
      />
    </div>
  );
}
