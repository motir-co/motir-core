'use client';

import { useEffect, useRef, useState } from 'react';
import { parseWorkItemTokenIds } from '@/lib/mentions/workItemRefs';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import { resolveChatWorkItemRefsAction } from '../../_actions';
import type { ChatRow } from './transcriptModel';

/**
 * The chips of every `[KEY](motir:<id>)` in a transcript's text rows (bug MOTIR-10023).
 * Each id is asked for ONCE, when a row first carries it — a token is only parsed once
 * its closing `)` has streamed in — and a transcript that links nothing asks nothing.
 */
export function useChatWorkItemRefs(rows: readonly ChatRow[]): WorkItemRefMap {
  const [refs, setRefs] = useState<WorkItemRefMap>({});
  const asked = useRef(new Set<string>());
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.type === 'text') for (const id of parseWorkItemTokenIds(row.text)) ids.add(id);
  }
  const linked = [...ids].join(',');

  useEffect(() => {
    const wanted = linked ? linked.split(',').filter((id) => !asked.current.has(id)) : [];
    if (wanted.length === 0) return;
    for (const id of wanted) asked.current.add(id);
    void resolveChatWorkItemRefsAction(wanted).then(
      (map) => setRefs((prev) => ({ ...prev, ...map })),
      // A failed read leaves the ids asked: the chips stay as drawn, never retried in a loop.
      () => undefined,
    );
  }, [linked]);

  return refs;
}
