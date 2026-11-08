// The single source of truth for work-item priority presentation. The priority
// ENUM lives in the schema (Story 1.4) and its wire type is `WorkItemPriorityDto`;
// this module owns the human LABELS and the canonical display ORDER (highest →
// lowest) so the create modal (2.3.3), the edit form (2.3.6), and the detail
// fields panel (2.4.2) all read one list instead of re-declaring it three times.

import type { WorkItemPriority } from '@/generated/prisma/client';

import type { WorkItemPriorityDto } from '@/lib/dto/workItems';

/**
 * Every `WorkItemPriority` member, lowest first — the schema enum's own order,
 * and the closed set every write door checks a priority against (MOTIR-10656:
 * the plan path stored a model-written `"p2"` that only `materialize` refused).
 */
export const WORK_ITEM_PRIORITIES = [
  'lowest',
  'low',
  'medium',
  'high',
  'highest',
] as const satisfies readonly WorkItemPriorityDto[];

// TOTALITY, both ways, at compile time (the `difficulty.ts` precedent): the list
// covers every DTO member, and the DTO union is exactly the Prisma enum. The
// Prisma import is TYPE-ONLY, so client modules importing this file do not pull
// the generated client into their graphs.
type ListedPriority = (typeof WORK_ITEM_PRIORITIES)[number];
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _listCoversDto: Exactly<ListedPriority, WorkItemPriorityDto> = true;
const _dtoMatchesPrisma: Exactly<WorkItemPriorityDto, WorkItemPriority> = true;
void _listCoversDto;
void _dtoMatchesPrisma;

/** True when `value` is one of the {@link WORK_ITEM_PRIORITIES}. */
export function isWorkItemPriority(value: unknown): value is WorkItemPriorityDto {
  return typeof value === 'string' && (WORK_ITEM_PRIORITIES as readonly string[]).includes(value);
}

/** Human-facing label per priority value. Total over the enum (type-checked). */
export const PRIORITY_LABELS: Record<WorkItemPriorityDto, string> = {
  highest: 'Highest',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  lowest: 'Lowest',
};

/**
 * Priority options in canonical display order (highest first) — the shape the
 * `<select>` / picker UIs render directly.
 */
export const PRIORITY_OPTIONS: ReadonlyArray<{ value: WorkItemPriorityDto; label: string }> = [
  { value: 'highest', label: PRIORITY_LABELS.highest },
  { value: 'high', label: PRIORITY_LABELS.high },
  { value: 'medium', label: PRIORITY_LABELS.medium },
  { value: 'low', label: PRIORITY_LABELS.low },
  { value: 'lowest', label: PRIORITY_LABELS.lowest },
];
