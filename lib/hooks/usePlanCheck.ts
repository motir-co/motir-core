'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useToast } from '@/components/ui/Toast';
import type { PlanBlockReasonDto } from '@/lib/dto/plannability';
import { useOpenPlanningWorkspaceLater } from '@/lib/hooks/useOpenPlanningWorkspace';
import { fetchPlannability } from '@/lib/planning/plannabilityClient';

// THE PLAN BUTTON'S CLICK, CHECKED FIRST (MOTIR-10544; design MOTIR-10543).
//
// One click, three outcomes, and nothing else may happen in between:
//   · CAN PLAN — the planning overlay opens on the card, exactly as the
//     un-checked button opened it (the shipped launcher's work-item context).
//   · CAN'T PLAN — the overlay does NOT open and no planning session is created;
//     the caller draws the can't-plan alert from `alert`.
//   · CHECK FAILED — the overlay does NOT open either; the shipped error toast
//     says so, and its Retry runs the check again and goes on as a click would.
//
// While the check runs `checking` is true: the caller draws the button's
// Checking state, and a second click is ignored (`inFlight`), so one press can
// never open two overlays or two alerts.
//
// `check(key)` takes the key so the alert's per-line Plan goes through this SAME
// path for a blocker — the blocker is checked too, never opened unchecked.

export interface PlanCheckAlert {
  /** The card the alert is about — the one whose Plan was pressed. */
  key: string;
  reasons: PlanBlockReasonDto[];
}

export interface PlanCheck {
  checking: boolean;
  alert: PlanCheckAlert | null;
  check: (key: string) => Promise<void>;
  closeAlert: () => void;
}

export function usePlanCheck(): PlanCheck {
  const t = useTranslations('roadmap.canvas.node.action');
  const { toast } = useToast();
  const openLater = useOpenPlanningWorkspaceLater();
  const [checking, setChecking] = useState(false);
  const [alert, setAlert] = useState<PlanCheckAlert | null>(null);
  const inFlight = useRef(false);

  const check = useCallback(
    (key: string): Promise<void> => {
      // Named, so the toast's Retry can run the same check again — and goes on
      // as a click would.
      const run = async (target: string): Promise<void> => {
        if (inFlight.current) return;
        inFlight.current = true;
        setChecking(true);
        setAlert(null);
        try {
          const answer = await fetchPlannability(target);
          if (answer.plannable) {
            openLater({ kind: 'work-item', itemKey: target, hasPlan: false, confirmStart: true });
          } else {
            setAlert({ key: target, reasons: answer.reasons });
          }
        } catch {
          toast({
            variant: 'error',
            title: t('checkFailedTitle', { key: target }),
            description: t('checkFailedBody'),
            action: { label: t('checkRetry'), onClick: () => void run(target) },
          });
        } finally {
          inFlight.current = false;
          setChecking(false);
        }
      };
      return run(key);
    },
    [openLater, t, toast],
  );

  const closeAlert = useCallback(() => setAlert(null), []);
  return { checking, alert, check, closeAlert };
}
