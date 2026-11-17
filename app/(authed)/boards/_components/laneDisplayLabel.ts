'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { BOARD_SWIMLANE_NO_VALUE, type BoardSwimlaneDto } from '@/lib/dto/boards';

// The words a lane is NAMED by (MOTIR-11585) — its header text and the lane half
// of every accessible name that names it (collapse, scroll, Load more, retry, the
// drag announcements). The shipped dimensions keep the projection's own label,
// exactly as before: a person's name, an epic's key and title, the priority, and
// their catch-alls. The field dimensions whose lane keys are enum values (type,
// difficulty, executor, kind) read the shared `labels.*` glosses the item page
// uses, and every new dimension's catch-all reads its own translated name, so no
// lane shows a raw value or an untranslated "No …".

const NEW_CATCH_ALL = {
  type: 'laneNoType',
  difficulty: 'laneNoDifficulty',
  executor: 'laneNoExecutor',
  label: 'laneNoLabel',
  component: 'laneNoComponent',
  repository: 'laneNoRepository',
} as const;

/** The glossary namespace each enum dimension's lane key resolves in. */
const ENUM_GLOSS = {
  type: 'workItemType',
  difficulty: 'difficulty',
  executor: 'executor',
  kind: 'issueType',
} as const;

/**
 * `(lane) => whether its key is a value the client knows` — true for every lane
 * whose dimension is not an enum; for an enum dimension, true only when the
 * glossary names the value. A lane header draws a value's chip or icon only when
 * it is known, so a newer server's value reads as plain text instead of breaking.
 */
export function useLaneValueKnown(): (lane: BoardSwimlaneDto) => boolean {
  const tl = useTranslations('labels');
  return useCallback(
    (lane: BoardSwimlaneDto) => {
      const gloss = ENUM_GLOSS[lane.kind as keyof typeof ENUM_GLOSS];
      return !gloss || tl.has(`${gloss}.${lane.key}` as Parameters<typeof tl>[0]);
    },
    [tl],
  );
}

/** `(lane) => the words it is named by`, in the reader's locale. */
export function useLaneDisplayLabel(): (lane: BoardSwimlaneDto) => string {
  const t = useTranslations('boards');
  const tl = useTranslations('labels');
  return useCallback(
    (lane: BoardSwimlaneDto) => {
      if (lane.key === BOARD_SWIMLANE_NO_VALUE) {
        const key = NEW_CATCH_ALL[lane.kind as keyof typeof NEW_CATCH_ALL];
        return key ? t(key) : lane.label;
      }
      const gloss = ENUM_GLOSS[lane.kind as keyof typeof ENUM_GLOSS];
      // A value the glossary does not know (a newer server) falls back to the label.
      if (!gloss) return lane.label;
      const key = `${gloss}.${lane.key}` as Parameters<typeof tl>[0];
      return tl.has(key) ? tl(key) : lane.label;
    },
    [t, tl],
  );
}
