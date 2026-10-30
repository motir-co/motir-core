import { agentReviewStartService } from '@/lib/services/agentReviewStartService';
import { dispatchRunSweepService } from '@/lib/services/dispatchRunSweepService';
import { hostedRunService } from '@/lib/services/hostedRunService';
import { pullRequestReconcileService } from '@/lib/services/pullRequestReconcileService';
import { pullRequestAutoMergeService } from '@/lib/services/pullRequestAutoMergeService';
import { designAutoRerunService } from '@/lib/services/designAutoRerunService';
import { gateResumeService } from '@/lib/services/gateResumeService';
import { requirementPageSaveService } from '@/lib/services/requirementPageSaveService';
import { pullRequestMergeabilityService } from '@/lib/services/pullRequestMergeabilityService';
import { monitorIngestionService } from '@/lib/services/monitorIngestionService';
import { dlqStandingDepthService } from '@/lib/services/dlqStandingDepthService';
import { monitorSyncService } from '@/lib/services/monitorSyncService';
import { workspacesService } from '@/lib/services/workspacesService';
import { workspaceInvitesService } from '@/lib/services/workspaceInvitesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { emailService } from '@/lib/services/emailService';
import { mentionNotificationsService } from '@/lib/services/mentionNotificationsService';
import { watcherNotificationsService } from '@/lib/services/watcherNotificationsService';
import { notificationFanInService } from '@/lib/services/notificationFanInService';
import { attachmentsService } from '@/lib/services/attachmentsService';
import { publicAddressCertificatesService } from '@/lib/services/publicAddressCertificatesService';
import { rateLimitService } from '@/lib/services/rateLimitService';
import { oauthSweepService } from '@/lib/services/oauthSweepService';
import { workItemEmbeddingSweepService } from '@/lib/services/workItemEmbeddingSweepService';
import { savedFilterSubscriptionsService } from '@/lib/services/savedFilterSubscriptionsService';
import { publicFollowDigestService } from '@/lib/services/publicFollowDigestService';
import { automationEngineService } from '@/lib/services/automationEngineService';
import { billingService } from '@/lib/services/billingService';
import { platformMeterReportService } from '@/lib/services/platformMeterReportService';
import { aiBugTelemetryService } from '@/lib/services/aiBugTelemetryService';
import { monitorBugEnrichmentService } from '@/lib/services/monitorBugEnrichmentService';
import { codeGraphIndexService } from '@/lib/services/codeGraphIndexService';
import { codeGraphIndexDispatchService } from '@/lib/services/codeGraphIndexDispatchService';
import { codeGraphOffboardSweepService } from '@/lib/services/codeGraphOffboardSweepService';
import { firstAuditTriggerService } from '@/lib/services/firstAuditTriggerService';
import { autoPlanCadenceService } from '@/lib/services/autoPlanCadenceService';
import { ciMinutesReconciliationService } from '@/lib/services/ciMinutesReconciliationService';
import { fleetAttributionService } from '@/lib/services/fleetAttributionService';
import { fleetDebitMonitorService } from '@/lib/services/fleetDebitMonitorService';
import { fleetShardHeadroomService } from '@/lib/services/fleetShardHeadroomService';
import { capacityAlertJobService } from '@/lib/services/capacityAlertJobService';
import { fleetPoolGrowthPassService } from '@/lib/services/fleetPoolGrowthPassService';
import { hostAccountReconcileService } from '@/lib/services/hostAccountReconcileService';
import { hostAccountStateService } from '@/lib/services/hostAccountStateService';
import { hostingTenantAccountService } from '@/lib/services/hostingTenantAccountService';
import { previewEnablementService } from '@/lib/services/previewEnablementService';
import { previewLifecycleService } from '@/lib/services/previewLifecycleService';
import { ciPreviewUsageMeterService } from '@/lib/services/ciPreviewUsageMeterService';
import { ciLiveChargeService } from '@/lib/services/ciLiveChargeService';
import { ciActionsGateService } from '@/lib/services/ciActionsGateService';
import { ciRunnerBootService } from '@/lib/services/ciRunnerBootService';
import { ciRunnerReconcileService } from '@/lib/services/ciRunnerReconcileService';
import { jobScheduleHealthService } from '@/lib/services/jobScheduleHealthService';
import { fleetPreflightService } from '@/lib/services/fleetPreflightService';
import { indexRebuildStreakService } from '@/lib/services/indexRebuildStreakService';
import { monitorConfigPreflightService } from '@/lib/services/monitorConfigPreflightService';
import { credentialExpiryService } from '@/lib/services/credentialExpiryService';
import { hostedRunProbeService } from '@/lib/services/hostedRunProbeService';
import { parentStatusRollupService } from '@/lib/services/parentStatusRollupService';
import { childStatusCascadeService } from '@/lib/services/childStatusCascadeService';
import { planDriftService } from '@/lib/services/planDriftService';
import { migrateOnboardingService } from '@/lib/services/migrateOnboardingService';
import { workItemEmbeddingsService } from '@/lib/services/workItemEmbeddingsService';
import { pageEmbeddingsService } from '@/lib/services/pageEmbeddingsService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { planningSessionGateService } from '@/lib/services/planningSessionGateService';
import { impersonationService } from '@/lib/services/impersonationService';
import { codeGraphDriftService } from '@/lib/services/codeGraphDriftService';
import { codeGraphIndexCatchUpService } from '@/lib/services/codeGraphIndexCatchUpService';
import { abandonedPlanService } from '@/lib/services/abandonedPlanService';
import { jobRunsService } from '@/lib/services/jobRunsService';
import { jobQueueRetentionService } from '@/lib/services/jobQueueRetentionService';
import { dataExportService } from '@/lib/services/dataExportService';
import { publicHostnameReservationService } from '@/lib/services/publicHostnameReservationService';
import { accountErasureSweepService } from '@/lib/services/accountErasureSweepService';
import { organizationDeletionNotifier } from '@/lib/services/organizationDeletionNotifier';
import { organizationErasureSweepService } from '@/lib/services/organizationErasureSweepService';
import { organizationRetentionPurgeService } from '@/lib/services/organizationRetentionPurgeService';
import { supervisionSweepService } from '@/lib/services/supervisionSweepService';
import { agentInstanceSweepService } from '@/lib/services/agentInstanceSweepService';
import { agentInstanceRunService } from '@/lib/services/agentInstanceRunService';
import { agentInstanceBootService } from '@/lib/services/agentInstanceBootService';
import { agentTerminalRelayService } from '@/lib/services/agentTerminalRelayService';
import { agentInstanceStorageChargeService } from '@/lib/services/agentInstanceStorageChargeService';

// The service-layer injection bag handed to every job handler as its 2nd arg
// (Story 1.6 · Subtask 1.6.2). This is the seam that keeps the 4-layer rule
// intact for background work: a job handler is the "service caller" for a
// background trigger, so instead of importing service singletons ad-hoc it
// receives them here. That makes handlers unit-testable with a stubbed bag and
// gives `defineJob` one explicit dependency surface.
//
// It aggregates the EXISTING domain-service singletons — no new logic, just
// references — so it stays a thin DI seam (anti-overplanning, notes #20). New
// services join the bag as jobs come to need them (1.6.3's email.send is the
// first real consumer).
export const jobServices = {
  workspaces: workspacesService,
  workspaceInvites: workspaceInvitesService,
  projects: projectsService,
  workItems: workItemsService,
  users: usersService,
  email: emailService,
  mentionNotifications: mentionNotificationsService,
  watcherNotifications: watcherNotificationsService,
  notificationFanIn: notificationFanInService,
  attachments: attachmentsService,
  publicAddressCertificates: publicAddressCertificatesService,
  rateLimit: rateLimitService,
  // The daily OAuth sweep (MOTIR-6984).
  oauthSweep: oauthSweepService,
  // The hourly work-item embedding sweep (MOTIR-8227).
  workItemEmbeddingSweep: workItemEmbeddingSweepService,
  savedFilterSubscriptions: savedFilterSubscriptionsService,
  publicFollowDigest: publicFollowDigestService,
  automationEngine: automationEngineService,
  billing: billingService,
  // The platform meter report (MOTIR-5286) — a settled container to motir-ai's rollup.
  platformMeterReport: platformMeterReportService,
  aiBugTelemetry: aiBugTelemetryService,
  // The bug ENRICHMENT dispatch (MOTIR-5849) — a monitor-filed bug is planned by
  // motir-ai's `author_bug` job, dispatched post-commit.
  monitorBugEnrichment: monitorBugEnrichmentService,
  codeGraph: codeGraphIndexService,
  codeGraphIndexDispatch: codeGraphIndexDispatchService,
  codeGraphOffboardSweep: codeGraphOffboardSweepService,
  firstAuditTrigger: firstAuditTriggerService,
  autoPlanCadence: autoPlanCadenceService,
  ciMinutesReconciliation: ciMinutesReconciliationService,
  // The live CI charge (MOTIR-6910): every debit period, live CI containers are charged.
  ciLiveCharge: ciLiveChargeService,
  fleetAttribution: fleetAttributionService,
  // The fleet debit monitor (Story MOTIR-6905 · MOTIR-7318).
  fleetDebitMonitor: fleetDebitMonitorService,
  fleetShardHeadroom: fleetShardHeadroomService,
  // The capacity alert pass (Story MOTIR-9539 · MOTIR-9612).
  capacityAlertJob: capacityAlertJobService,
  // The pool growth pass (Story MOTIR-9362 · MOTIR-9462).
  fleetPoolGrowthPass: fleetPoolGrowthPassService,
  // The Host account reconcile (Story MOTIR-9365 · MOTIR-9582).
  hostAccountReconcile: hostAccountReconcileService,
  hostAccountState: hostAccountStateService,
  // The enterprise tenant account reconcile (Story MOTIR-9792 · MOTIR-9942).
  hostingTenantAccountReconcile: hostingTenantAccountService,
  // The preview enablement sweep (Story MOTIR-5766 · MOTIR-5775).
  previewEnablement: previewEnablementService,
  previewLifecycle: previewLifecycleService,
  // Preview usage metered into the CI pool (Story MOTIR-5766 · MOTIR-5777).
  ciPreviewUsageMeter: ciPreviewUsageMeterService,
  ciActionsGate: ciActionsGateService,
  ciRunnerBoot: ciRunnerBootService,
  // The GitHub-side reconcile of the fleet's queue (MOTIR-8976).
  ciRunnerReconcile: ciRunnerReconcileService,
  // A hosted run's supervision (Story MOTIR-683 · MOTIR-690).
  hostedRun: hostedRunService,
  jobScheduleHealth: jobScheduleHealthService,
  fleetPreflight: fleetPreflightService,
  // The rebuild-streak probe (MOTIR-5027) — the daily check's fifth, and the
  // only one that reads the LEDGER rather than a registry or an address.
  indexRebuildStreak: indexRebuildStreakService,
  // The monitor-configuration probe (MOTIR-5831) — the daily check's sixth, and
  // the only one that asserts something about this process's OWN ENVIRONMENT
  // rather than about a registry, an address or the ledger.
  monitorConfigPreflight: monitorConfigPreflightService,
  // The credential-expiry probe (MOTIR-1933) — the daily check's seventh, and the
  // only one that reads a DECLARED date rather than a live system.
  credentialExpiry: credentialExpiryService,
  // The hosted-run probe (MOTIR-1934) — a metered run in a Motir-owned org that
  // ran on anything but the fleet.
  hostedRunProbe: hostedRunProbeService,
  parentStatusRollup: parentStatusRollupService,
  childStatusCascade: childStatusCascadeService,
  planDrift: planDriftService,
  migrateOnboarding: migrateOnboardingService,
  workItemEmbeddings: workItemEmbeddingsService,
  pageEmbeddings: pageEmbeddingsService,
  planTargetLock: planTargetLockService,
  planSessionEnd: planSessionEndService,
  planningSessionGate: planningSessionGateService,
  // Staff "View as" sessions (MOTIR-749): the expiry sweep records the end of a
  // session nobody came back to.
  impersonation: impersonationService,
  abandonedPlan: abandonedPlanService,
  codeGraphDrift: codeGraphDriftService,
  codeGraphIndexCatchUp: codeGraphIndexCatchUpService,
  // The ledger itself is a job's subject exactly once: the abandoned-run reap
  // (MOTIR-3683), which closes rows no completion write will ever reach.
  jobRuns: jobRunsService,
  // The queue retention pass (Story MOTIR-8540): bounds `job_queue`, `job_step`
  // and `job_event` beside the ledger's own retention.
  jobQueueRetention: jobQueueRetentionService,
  supervisionSweep: supervisionSweepService,
  // The personal-data export (Story 8.4 · MOTIR-3701) — the build job and
  // the retention sweep are both its callers.
  dataExport: dataExportService,
  // The expired name-hold sweep (Story MOTIR-4528 · MOTIR-9509): deletes the
  // public-hostname reservations whose hold has lapsed.
  publicHostnameReservation: publicHostnameReservationService,
  // The nightly erasure of accounts whose grace period has run out (MOTIR-3702).
  accountErasureSweep: accountErasureSweepService,
  // The 7-day and 1-day reminders before an organization is erased (MOTIR-6395).
  organizationDeletionNotifier,
  // The erasure of organizations whose 30-day window has ended (MOTIR-6400).
  organizationErasureSweep: organizationErasureSweepService,
  // The seven-year purge of an erased organization's tombstone (MOTIR-6401).
  organizationRetentionPurge: organizationRetentionPurgeService,
  // The dispatch-run housekeeping (Story MOTIR-1789 · MOTIR-1792): the 30-day
  // log-body retention window, and the reap that closes a run nothing is
  // holding. One service because they share a cadence and a tenancy shape.
  dispatchRunSweep: dispatchRunSweepService,
  // The open-delivery reconcile (MOTIR-5390): re-reads open, delivering pull
  // requests from GitHub and replays a close whose webhook delivery was lost.
  pullRequestReconcile: pullRequestReconcileService,
  pullRequestAutoMerge: pullRequestAutoMergeService,
  // The review run's start (Story MOTIR-1626 · MOTIR-6820): one hosted `review` run per
  // request for an awaiting `agent_review` gate.
  agentReviewStart: agentReviewStartService,
  // The automatic hosted re-run after a design Revise (MOTIR-700).
  designAutoRerun: designAutoRerunService,
  // The automatic hosted resume after a held gate is approved (MOTIR-7710).
  gateResume: gateResumeService,
  // The confirmed plan offer's requirement page, saved after the start (MOTIR-10091).
  requirementPageSave: requirementPageSaveService,
  // The base-branch mergeability re-read (MOTIR-5914): a push to a default branch
  // withdraws the approve-and-merge question over any pull request it put in conflict.
  pullRequestMergeability: pullRequestMergeabilityService,
  // The monitor-issue reconciler (Story MOTIR-4929 · MOTIR-5581): the tick's
  // discovery, one binding's poll, and the terminal write onto that binding.
  monitorIngestion: monitorIngestionService,
  // Resolve-back (Story MOTIR-4931 · MOTIR-5703): the transitioned consumer's
  // one call. The poll's backstop sweep reaches the same service directly.
  monitorSync: monitorSyncService,
  // The DLQ standing-depth filer (MOTIR-5869): the dead-letter queue is a job's
  // subject a second time, read for what nobody has disposed of.
  dlqStandingDepth: dlqStandingDepthService,
  // Agent instances (Story MOTIR-6860 · MOTIR-6873): the idle timer's check and
  // the sweep that reconciles, hibernates, cleans orphans and charges.
  agentInstanceSweep: agentInstanceSweepService,
  // A card's run in a developer's agent (Story MOTIR-6864 · MOTIR-7026): the
  // launch job's wait for the agent and its launcher exec; and (MOTIR-7027) the
  // supervise job's pass.
  agentInstanceRun: agentInstanceRunService,
  // An agent's boot (Story MOTIR-7393 · MOTIR-7398): one pass of the boot driver.
  agentInstanceBoot: agentInstanceBootService,
  // The agent terminal (Story MOTIR-6861 · MOTIR-6940): the sweep's second step
  // deletes terminal tickets past their 60-second life; the third (MOTIR-6959)
  // closes connections a dead relay left open.
  agentTerminalRelay: agentTerminalRelayService,
  // Agent storage (Story MOTIR-6914 · MOTIR-6919): the per-day storage charge.
  agentInstanceStorageCharge: agentInstanceStorageChargeService,
};

export type JobServices = typeof jobServices;
