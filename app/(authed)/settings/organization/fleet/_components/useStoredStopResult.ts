'use client';

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { OrgFleetStopResultDTO } from '@/lib/dto/orgFleetStop';

// The Stop everything result, mirrored into sessionStorage so a re-read AND a
// reload keep it until Dismiss (MOTIR-10369 criterion 4). Read through
// `useSyncExternalStore`, so the server render and hydration see no result and
// the stored one appears straight after, with no hydration mismatch.
//
// ⚠️ Per tab and per organization: the key carries the org id, and
// sessionStorage dies with the tab. Storage that throws (a private window, a
// blocked origin) degrades to in-memory only.

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function storedStopResultKey(orgId: string): string {
  return `motir.orgFleet.stopResult.${orgId}`;
}

const memory = new Map<string, string>();

function readRaw(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

function writeRaw(key: string, value: string | null) {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    if (value === null) memory.delete(key);
    else memory.set(key, value);
  }
  notify();
}

function parse(raw: string | null): OrgFleetStopResultDTO | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<OrgFleetStopResultDTO> | null;
    return value && typeof value.stoppedAt === 'string' && value.failures
      ? (value as OrgFleetStopResultDTO)
      : null;
  } catch {
    return null;
  }
}

export function useStoredStopResult(orgId: string) {
  const key = storedStopResultKey(orgId);
  const raw = useSyncExternalStore(
    subscribe,
    () => readRaw(key),
    () => null,
  );
  const result = useMemo(() => parse(raw), [raw]);
  const setResult = useCallback(
    (next: OrgFleetStopResultDTO | null) => writeRaw(key, next ? JSON.stringify(next) : null),
    [key],
  );
  return [result, setResult] as const;
}
