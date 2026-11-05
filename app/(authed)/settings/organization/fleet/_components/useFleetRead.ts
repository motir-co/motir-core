'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { OrgFleetDTO } from '@/lib/dto/orgFleet';

/** How often the page re-reads while the tab is visible (design panel 4b). */
export const FLEET_POLL_MS = 30_000;

export interface FleetReadState {
  /** The last data read — kept on screen while a re-read runs or fails. */
  fleet: OrgFleetDTO;
  /** When `fleet` was read, ISO-8601. */
  readAt: string;
  refreshing: boolean;
  /** The last re-read failed; `fleet` is the one before it. */
  refreshFailed: boolean;
  /** The org can no longer be read by this person (403 / 404): stop polling. */
  gone: boolean;
}

function isFleet(value: unknown): value is { fleet: OrgFleetDTO } {
  const body = value as { fleet?: Partial<OrgFleetDTO> } | null;
  return Boolean(body?.fleet?.tiles && body.fleet.hostedRuns && body.fleet.agentInstances);
}

/**
 * The page's one read, re-run every 30 seconds WHILE THE TAB IS VISIBLE and once
 * on becoming visible again, and on demand (Refresh, a section's Retry, after a
 * stop). The `seq` guard is `FleetUseSection`'s: a stale answer never overwrites
 * a newer one. A re-read keeps the previous data on screen and never blanks it.
 */
export function useFleetRead(orgId: string, initialFleet: OrgFleetDTO, initialReadAt: string) {
  const [state, setState] = useState<FleetReadState>({
    fleet: initialFleet,
    readAt: initialReadAt,
    refreshing: false,
    refreshFailed: false,
    gone: false,
  });
  const seq = useRef(0);

  const read = useCallback(async () => {
    const mySeq = ++seq.current;
    setState((s) => ({ ...s, refreshing: true }));
    try {
      const res = await fetch(`/api/organizations/${encodeURIComponent(orgId)}/fleet`, {
        cache: 'no-store',
      });
      if (mySeq !== seq.current) return;
      if (res.status === 403 || res.status === 404) {
        setState((s) => ({ ...s, refreshing: false, gone: true }));
        return;
      }
      const body: unknown = res.ok ? await res.json() : null;
      if (mySeq !== seq.current) return;
      if (!isFleet(body)) {
        setState((s) => ({ ...s, refreshing: false, refreshFailed: true }));
        return;
      }
      setState({
        fleet: body.fleet,
        readAt: new Date().toISOString(),
        refreshing: false,
        refreshFailed: false,
        gone: false,
      });
    } catch {
      if (mySeq === seq.current) {
        setState((s) => ({ ...s, refreshing: false, refreshFailed: true }));
      }
    }
  }, [orgId]);

  const gone = state.gone;
  useEffect(() => {
    if (gone) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(() => void read(), FLEET_POLL_MS);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void read();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [read, gone]);

  return { ...state, read };
}
