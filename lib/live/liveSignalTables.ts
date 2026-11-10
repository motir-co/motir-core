// Which tables emit a live signal (Story MOTIR-8542 · Subtask MOTIR-8727).
//
// Every table the Workbench watermark (`workbenchWatermarkService.readTabs`) or a
// plan's review version (`planRepository.readReviewFingerprint`, and the plan
// revision hold behind both) READS FROM carries a `trg_live_signal_<table>`
// trigger that notifies `LIVE_SIGNAL_CHANNEL` (`lib/live/liveNotification.ts`). The migration is
// `prisma/migrations/20261015230000_live_signal_triggers`.
//
// `tests/integration/live/liveSignalTriggers.test.ts` holds this file to the
// database in both directions: the triggers in `pg_trigger` are exactly
// `LIVE_SIGNAL_TABLES`, and every table those reads touch is in one of the two
// lists below — so a new read of an uncovered table fails a test, naming the
// table and the method, instead of shipping a tab that is never nudged.

/** The tables whose writes are heard, each with the reading that needs it. */
export const LIVE_SIGNAL_TABLES = {
  work_item: 'the five work tabs (workItemRepository.watermarkByAssigneeOrReporterInWorkspace)',
  watcher: 'Watching (watcherRepository.watermarkByUser)',
  approval_gate:
    'Waiting on you (approvalGateRepository.watermarkAwaitingRoutedTo) and a plan_approval gate in the review fingerprint',
  plan_change_session:
    'To resume and the planning holds (planChangeSessionRepository.watermark*), and the session turn count in the review fingerprint',
  plan: 'the plan revision hold (findRevisablePlanIdsWithTrailSince) and the review fingerprint',
  plan_item: 'the review fingerprint',
  plan_revision: 'the plan revision hold (listLeaseRowsByPlans) and the review fingerprint',
  plan_step: 'the review fingerprint',
  plan_narration: 'the review fingerprint',
  plan_narration_session: 'the review fingerprint',
  // The review rows behind a To approve row's review line and badge (Bug MOTIR-10504;
  // `20261106100000_live_signal_review_triggers`).
  review_verdict_record:
    'the review of the To approve rows (reviewStateRepository.watermarkReviewsOfCards)',
  review_dismissal:
    'the review of the To approve rows (reviewStateRepository.watermarkReviewsOfCards)',
  work_item_delivery:
    'the review of the To approve rows (reviewStateRepository.watermarkReviewsOfCards)',
  github_pull_request_review:
    'the review of the To approve rows (reviewStateRepository.watermarkReviewsOfCards)',
} as const satisfies Record<string, string>;

export type LiveSignalTable = keyof typeof LIVE_SIGNAL_TABLES;

/**
 * Tables the reads touch only to decide ACCESS — never a watermark input — each
 * with why no trigger is needed. A change in who may see what is healed by each
 * stream's 60 s backstop: a bounded delay, never a page that stays wrong.
 */
export const ACCESS_ONLY_TABLES = {
  workspace: 'the tenant boundary; the reads filter by its id and never read its columns',
  workspace_membership: 'who may read the workspace; a membership change is an access change',
  project: 'which projects the reader may see; a project change is an access change',
  project_membership: 'who may read a project; a membership change is an access change',
} as const satisfies Record<string, string>;
