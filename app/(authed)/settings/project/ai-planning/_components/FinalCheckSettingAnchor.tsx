'use client';

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { FINAL_CHECK_SETTING_ID } from '@/lib/settings/aiPlanningSettingsLinks';
import { usePrefersReducedMotion } from '@/lib/hooks/usePrefersReducedMotion';

// THE RUN THE FINAL CHECK ROW'S LANDING (MOTIR-11548), drawn to
// `design/ai-chat/design-notes.md` § "⭐ The final check, §3 amended" §3b and panels 9–10 of
// `planning-workspace--skip-final-check--settings-link.mock.html` (MOTIR-11547).
//
// The Skip the final check dialog opens `/settings/project/ai-planning#final-check` in a new
// tab. This wrapper carries that id, so the browser scrolls the row to the top of the viewport
// (`scroll-mt-6`), and rings the row on arrival so the person sees where to look: held 0.6 s,
// faded over 1.4 s, then removed. Under `prefers-reduced-motion` it shows for 2 s and goes
// without the fade.
//
// ⚠️ A RING, NOT A FILL. A tinted fill would put the row's label, hint and disabled ink on a new
// surface; a ring changes no ink pair. `-m-2 p-2` gives the ring room without moving anything.
//
// The hash is read as `AgentVerdictActivityRow` reads it — the address as an external store —
// so a later `hashchange` to the anchor rings the row again. Focus is not moved: the fragment
// already makes the row the sequential focus starting point.

/** How long the ring holds before it fades, and how long the fade takes. */
export const FINAL_CHECK_RING_HOLD_MS = 600;
export const FINAL_CHECK_RING_FADE_MS = 1400;
/** Under `prefers-reduced-motion`: shown this long, then removed with no fade. */
export const FINAL_CHECK_RING_REDUCED_MS = 2000;

type Stage = 'ring' | 'fading' | 'gone';

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function readAtAnchor(): boolean {
  return window.location.hash === `#${FINAL_CHECK_SETTING_ID}`;
}

/* v8 ignore next -- the server snapshot: a server render has no address hash. */
const serverAtAnchor = () => false;

const BASE = '-m-2 scroll-mt-6 rounded-(--radius-control) p-2';
const STAGE_CLASS: Record<Stage, string> = {
  ring: 'ring-2 ring-(--el-highlight)',
  fading: 'ring-2 ring-transparent transition-shadow duration-[1400ms] ease-out',
  gone: '',
};

export function FinalCheckSettingAnchor({ children }: { children: ReactNode }) {
  const atAnchor = useSyncExternalStore(subscribeToHash, readAtAnchor, serverAtAnchor);
  const reduceMotion = usePrefersReducedMotion();
  const [stage, setStage] = useState<Stage>('ring');
  // Arriving again (a later `hashchange` back to the anchor) starts the ring over. Adjusted
  // during render, React's pattern for state that follows a changed input.
  const [wasAtAnchor, setWasAtAnchor] = useState(atAnchor);
  if (wasAtAnchor !== atAnchor) {
    setWasAtAnchor(atAnchor);
    if (atAnchor) setStage('ring');
  }

  useEffect(() => {
    if (!atAnchor || stage === 'gone') return;
    const [next, delay]: [Stage, number] =
      stage === 'fading'
        ? ['gone', FINAL_CHECK_RING_FADE_MS]
        : reduceMotion
          ? ['gone', FINAL_CHECK_RING_REDUCED_MS]
          : ['fading', FINAL_CHECK_RING_HOLD_MS];
    const timer = window.setTimeout(() => setStage(next), delay);
    return () => window.clearTimeout(timer);
  }, [atAnchor, stage, reduceMotion]);

  const shown: Stage = atAnchor ? stage : 'gone';
  return (
    <div
      id={FINAL_CHECK_SETTING_ID}
      data-testid="ai-planning-final-check-row"
      data-arrival={shown === 'gone' ? undefined : shown}
      className={shown === 'gone' ? BASE : `${BASE} ${STAGE_CLASS[shown]}`}
    >
      {children}
    </div>
  );
}
