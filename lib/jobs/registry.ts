import { dailyHealthCheck } from './definitions/dailyHealthCheck';
import { emailSend } from './definitions/emailSend';
import {
  mentionNotifyOnCommentCreated,
  mentionNotifyOnWorkItemMentioned,
} from './definitions/mentionNotify';
import {
  watcherNotifyOnCommentCreated,
  watcherNotifyOnTransitioned,
} from './definitions/watcherNotify';
import {
  notificationFanInOnCommentCreated,
  notificationFanInOnWorkItemMentioned,
  notificationFanInOnTransitioned,
} from './definitions/notificationFanIn';
import { attachmentGc } from './definitions/attachmentGc';
import { publicAddressCertificateRefresh } from './definitions/publicAddressCertificateRefresh';
import { rateLimitSweep } from './definitions/rateLimitSweep';
import { oauthSweep } from './definitions/oauthSweep';
import { workItemEmbeddingSweep } from './definitions/workItemEmbeddingSweep';
import { codeGraphOffboardSweep } from './definitions/codeGraphOffboardSweep';
import { filterSubscriptionTick } from './definitions/filterSubscriptionTick';
import { filterSubscriptionDeliver } from './definitions/filterSubscriptionDeliver';
import { publicFollowDigestTick } from './definitions/publicFollowDigestTick';
import { publicFollowDigestDeliver } from './definitions/publicFollowDigestDeliver';
import {
  automationEngineOnCreated,
  automationEngineOnFieldChanged,
  automationEngineOnTransitioned,
  automationEngineOnCommented,
  automationRetentionSweep,
} from './definitions/automationEngine';
import { billingSeatSync } from './definitions/billingSeatSync';
import { platformMeterReport } from './definitions/platformMeterReport';
import { codeGraphIndex } from './definitions/codeGraphIndex';
import { codeGraphRefresh } from './definitions/codeGraphRefresh';
import { outwardBugTelemetryOnCreated } from './definitions/outwardBugTelemetry';
import { monitorBugEnrichOnCreated } from './definitions/monitorBugEnrich';
import { monitorBugEnrichBackfill } from './definitions/monitorBugEnrichBackfill';
import { autoPlanCadenceTick } from './definitions/autoPlanCadenceTick';
import { ciMinutesReconcile } from './definitions/ciMinutesReconcile';
import { ciLiveCharge } from './definitions/ciLiveCharge';
import { ciActionsGateSweep } from './definitions/ciActionsGateSweep';
import { ciRunnerProvisionSweep, ciRunnerBoot } from './definitions/ciRunnerFleet';
import { fleetAttribution } from './definitions/fleetAttribution';
import { fleetDebitMonitor } from './definitions/fleetDebitMonitor';
import { fleetShardHeadroom } from './definitions/fleetShardHeadroom';
import { capacityAlertEvaluation } from './definitions/capacityAlertEvaluation';
import { fleetPoolGrowth } from './definitions/fleetPoolGrowth';
import { hostAccountReconcile } from './definitions/hostAccountReconcile';
import { hostAccountState } from './definitions/hostAccountState';
import { hostingTenantAccountReconcile } from './definitions/hostingTenantAccountReconcile';
import { hostedRunAdmit } from './definitions/hostedRunAdmit';
import { hostedRunSupervise } from './definitions/hostedRunSupervise';
import {
  statusDerivationOnChildSetChanged,
  statusDerivationOnCreated,
  statusDerivationOnRequested,
  statusDerivationOnTransitioned,
} from './definitions/statusDerivation';
import { planDriftOnTransitioned } from './definitions/planDrift';
import { migrateOnboardingSweep } from './definitions/migrateOnboardingSweep';
import { workItemEmbeddingRequested } from './definitions/workItemEmbedding';
import { pageEmbeddingRequested } from './definitions/pageEmbedding';
import { planTargetLockSweep } from './definitions/planTargetLockSweep';
import { impersonationExpirySweep } from './definitions/impersonationExpirySweep';
import { supervisionSweep } from './definitions/supervisionSweep';
import { abandonedPlanSweep } from './definitions/abandonedPlanSweep';
import { codeGraphDriftSweep } from './definitions/codeGraphDriftSweep';
import { previewEnablementSweep } from './definitions/previewEnablementSweep';
import { previewEffect, previewReaper, previewStart } from './definitions/previewLifecycle';
import { previewUsageAccrual } from './definitions/previewUsageAccrual';
import { codeGraphIndexCatchUp } from './definitions/codeGraphIndexCatchUp';
import { jobRunReap } from './definitions/jobRunReap';
import { jobQueueRetention } from './definitions/jobQueueRetention';
import { dataExportBuild } from './definitions/dataExportBuild';
import { dataExportExpirySweep } from './definitions/dataExportExpirySweep';
import { publicHostnameReservationSweep } from './definitions/publicHostnameReservationSweep';
import { dispatchRunSweep } from './definitions/dispatchRunSweep';
import { runLivenessSweep } from './definitions/runLivenessSweep';
import { pullRequestReconcile } from './definitions/pullRequestReconcile';
import { pullRequestAutoMerge } from './definitions/pullRequestAutoMerge';
import { agentReviewRequested } from './definitions/agentReviewRequested';
import { designAutoRerun } from './definitions/designAutoRerun';
import { gateResume } from './definitions/gateResume';
import { pullRequestBaseMoved } from './definitions/pullRequestBaseMoved';
import { pullRequestHeadMoved } from './definitions/pullRequestHeadMoved';
import {
  monitorConnectionPoll,
  monitorIssueReconcileTick,
} from './definitions/monitorIssueReconcile';
import { monitorIssueResolveOnTransitioned } from './definitions/monitorIssueResolve';
import { accountErasureSweep } from './definitions/accountErasureSweep';
import { organizationDeletionReminders } from './definitions/organizationDeletionReminders';
import { organizationErasureSweep } from './definitions/organizationErasureSweep';
import { organizationRetentionPurge } from './definitions/organizationRetentionPurge';
import { dlqStandingDepthSweep } from './definitions/dlqStandingDepthSweep';
import { agentInstanceIdleCheck } from './definitions/agentInstanceIdleCheck';
import { agentInstanceBoot } from './definitions/agentInstanceBoot';
import { agentInstanceRunLaunch } from './definitions/agentInstanceRunLaunch';
import { agentInstanceRunSupervise } from './definitions/agentInstanceRunSupervise';
import { agentInstanceSweep } from './definitions/agentInstanceSweep';
import { agentInstanceStorageCharge } from './definitions/agentInstanceStorageCharge';

// EVERY JOB THIS IMAGE KNOWS (Story 1.6 · Subtask 1.6.2; re-based onto the
// Postgres engine by Story MOTIR-3418).
//
// Adding a new job = define it under `definitions/` and add it here. There is no
// serve route to mount them on any more — what this list does is FORCE THE
// MODULE EVALUATION that populates the engine's own tables. `defineJob` registers
// a definition as its module is evaluated (`lib/jobs/engine/registry.ts`,
// `lib/jobs/engine/manifest.ts`, `lib/jobs/schedules.ts`), so those tables hold
// only the jobs something has imported — and importing THIS module is what makes
// them complete. `scripts/worker.ts` does exactly that, for the side effect
// rather than the value.
//
// ⚠️ THE ARRAY IS NOT A SECOND SOURCE OF TRUTH. Its members are the very objects
// `registerEngineJob` recorded, returned by `defineJob`; `engineJobs()` is the
// same set read back out of the registry. The array survives the retirement
// because it is the RITUAL — a new job that nobody adds here is a job the worker
// never evaluates — and because a test asserting "this job ships" has something
// to name.
export const jobDefinitions = [
  dailyHealthCheck,
  emailSend,
  mentionNotifyOnCommentCreated,
  mentionNotifyOnWorkItemMentioned,
  watcherNotifyOnCommentCreated,
  watcherNotifyOnTransitioned,
  notificationFanInOnCommentCreated,
  notificationFanInOnWorkItemMentioned,
  notificationFanInOnTransitioned,
  attachmentGc,
  publicAddressCertificateRefresh,
  rateLimitSweep,
  oauthSweep,
  workItemEmbeddingSweep,
  codeGraphOffboardSweep,
  filterSubscriptionTick,
  filterSubscriptionDeliver,
  publicFollowDigestTick,
  publicFollowDigestDeliver,
  automationEngineOnCreated,
  automationEngineOnFieldChanged,
  automationEngineOnTransitioned,
  automationEngineOnCommented,
  automationRetentionSweep,
  billingSeatSync,
  platformMeterReport,
  codeGraphIndex,
  codeGraphRefresh,
  outwardBugTelemetryOnCreated,
  monitorBugEnrichOnCreated,
  monitorBugEnrichBackfill,
  autoPlanCadenceTick,
  ciMinutesReconcile,
  ciLiveCharge,
  ciActionsGateSweep,
  ciRunnerProvisionSweep,
  ciRunnerBoot,
  fleetAttribution,
  fleetDebitMonitor,
  fleetShardHeadroom,
  capacityAlertEvaluation,
  fleetPoolGrowth,
  hostAccountReconcile,
  hostAccountState,
  hostingTenantAccountReconcile,
  hostedRunAdmit,
  hostedRunSupervise,
  planDriftOnTransitioned,
  statusDerivationOnTransitioned,
  statusDerivationOnCreated,
  statusDerivationOnChildSetChanged,
  statusDerivationOnRequested,
  migrateOnboardingSweep,
  workItemEmbeddingRequested,
  pageEmbeddingRequested,
  planTargetLockSweep,
  impersonationExpirySweep,
  supervisionSweep,
  abandonedPlanSweep,
  codeGraphDriftSweep,
  // The preview enablement sweep (Story MOTIR-5766 · MOTIR-5775).
  previewEnablementSweep,
  // The preview lifecycle (Story MOTIR-5766 · MOTIR-5776).
  previewEffect,
  previewStart,
  previewReaper,
  // Preview usage metered into the CI pool (Story MOTIR-5766 · MOTIR-5777).
  previewUsageAccrual,
  codeGraphIndexCatchUp,
  jobRunReap,
  jobQueueRetention,
  dataExportBuild,
  dataExportExpirySweep,
  publicHostnameReservationSweep,
  dispatchRunSweep,
  runLivenessSweep,
  accountErasureSweep,
  organizationDeletionReminders,
  organizationErasureSweep,
  organizationRetentionPurge,
  pullRequestReconcile,
  pullRequestAutoMerge,
  // The review run's start (Story MOTIR-1626 · MOTIR-6820).
  agentReviewRequested,
  designAutoRerun,
  // The automatic hosted resume after a held gate is approved (MOTIR-7710).
  gateResume,
  pullRequestBaseMoved,
  // The head-push re-read beside it (MOTIR-7063): a push onto a base already moved.
  pullRequestHeadMoved,
  // The monitor-issue reconciler (Story MOTIR-4929 · MOTIR-5581): the tick and
  // its per-connection fan-out.
  monitorIssueReconcileTick,
  monitorConnectionPoll,
  // Resolve-back (Story MOTIR-4931 · MOTIR-5703): a done bug resolves its
  // linked monitor issues, off `work-item/transitioned`.
  monitorIssueResolveOnTransitioned,
  // The DLQ standing-depth filer (MOTIR-5869): one bug per job function whose
  // dead letters have stood seven days, re-armed only when that depth drains.
  dlqStandingDepthSweep,
  // Agent instances (Story MOTIR-6860 · MOTIR-6873): the per-instance idle timer
  // and the 30-minute sweep beneath it.
  agentInstanceIdleCheck,
  agentInstanceBoot,
  agentInstanceRunLaunch,
  agentInstanceRunSupervise,
  agentInstanceSweep,
  // Agent storage (Story MOTIR-6914 · MOTIR-6919): one debit per agent per UTC day.
  agentInstanceStorageCharge,
];
