import type { PlannerFindingDetailDTO } from '@/lib/dto/plannerFindings';
import type { PlatformLessonMistakeType } from '@/lib/dto/platformLessons';

/**
 * The PROMOTE-TO-LESSON form's opening values, computed from the finding —
 * design MOTIR-10362 Panel 13, card MOTIR-10525.
 *
 * Title from the site; why from the finding's why, else its evidence; how to
 * apply from its fix direction, else its correction. A source that is null or
 * blank gives an empty field, so the form's blank-field refusal shows rather
 * than a lesson built from whitespace. The lesson BODY is not here: the triage
 * service sets it from `whatHappened`.
 */
export interface PromoteDraft {
  title: string;
  why: string;
  howToApply: string;
  mistakeType: PlatformLessonMistakeType;
}

type PrefillSource = Pick<
  PlannerFindingDetailDTO,
  'site' | 'why' | 'evidence' | 'fixDirection' | 'correction'
>;

function firstPresent(...values: (string | null | undefined)[]): string {
  for (const value of values) {
    if (value && value.trim().length > 0) return value.trim();
  }
  return '';
}

export function toPromoteDraft(detail: PrefillSource): PromoteDraft {
  return {
    title: firstPresent(detail.site),
    why: firstPresent(detail.why, detail.evidence),
    howToApply: firstPresent(detail.fixDirection, detail.correction),
    mistakeType: 'regular_planning',
  };
}
