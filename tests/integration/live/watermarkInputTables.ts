import { repositoryQueryModels, schemaMap } from '../../rls/contextArmScan';
import { ACCESS_ONLY_TABLES, LIVE_SIGNAL_TABLES } from '@/lib/live/liveSignalTables';

// THE READS, NOT A SECOND LIST (Story MOTIR-8542 · Subtask MOTIR-8727).
//
// The live-signal triggers are only as complete as the set of tables the live
// readings touch. Typing that set twice — once in the migration, once here —
// would let the two drift silently, so this helper DERIVES it: for each
// repository method a reading calls, the RLS scanner's `repositoryQueryModels`
// collects every model the method's query touches (the delegate it is issued
// on, every relation its argument literal names, every FROM / JOIN of its raw
// SQL), and `schemaMap` turns each model into its table.

/**
 * The repository methods behind the Workbench watermark (`readTabs`), the plan
 * revision hold it consults, and a plan's review version.
 */
export const LIVE_READING_METHODS = [
  'workItemRepository.watermarkByAssigneeOrReporterInWorkspace',
  'watcherRepository.watermarkByUser',
  'approvalGateRepository.watermarkAwaitingRoutedTo',
  'approvalGateRepository.findAwaitingRoutedReviewCarryingWorkItemIds',
  'reviewStateRepository.watermarkReviewsOfCards',
  'planChangeSessionRepository.watermarkFailedOpenForOwner',
  'planChangeSessionRepository.watermarkEndedWithWaitingPlanForOwner',
  'planChangeSessionRepository.listAwaitingPersonIdsInProjects',
  'planRepository.readReviewFingerprint',
  'planRepository.findRevisablePlanIdsWithTrailSince',
  'planRevisionRepository.listLeaseRowsByPlans',
] as const;

export interface UncoveredRead {
  method: string;
  table: string;
}

/** The tables each named method reads, keyed by method. A method that reads nothing is absent. */
export function tablesReadBy(
  methods: readonly string[],
  root = process.cwd(),
): Map<string, string[]> {
  const models = repositoryQueryModels(root);
  const { tableOf } = schemaMap(root);
  const out = new Map<string, string[]>();
  for (const method of methods) {
    const found = models.get(method);
    if (!found) continue;
    out.set(
      method,
      found.models.map((model) => tableOf.get(model) ?? model),
    );
  }
  return out;
}

/**
 * Every (method, table) whose table is in neither `covered` nor `accessOnly` —
 * a read no trigger hears. Empty is the passing answer.
 */
export function uncoveredReads(
  methods: readonly string[],
  root = process.cwd(),
  covered: ReadonlySet<string> = new Set(Object.keys(LIVE_SIGNAL_TABLES)),
  accessOnly: ReadonlySet<string> = new Set(Object.keys(ACCESS_ONLY_TABLES)),
): UncoveredRead[] {
  const out: UncoveredRead[] = [];
  for (const [method, tables] of tablesReadBy(methods, root)) {
    for (const table of tables) {
      if (!covered.has(table) && !accessOnly.has(table)) out.push({ method, table });
    }
  }
  return out;
}
