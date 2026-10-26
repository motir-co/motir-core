'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import {
  preselectedModel,
  readModels,
  withoutResolution,
  type HostedModelsState,
} from './hostedModels';

// THE HOSTED MODEL LIST, ONCE PER PAGE (MOTIR-6879; `design/runs/design-notes.md`
// § The model picker and § Continue hosted).
//
// ⚠️ ONE LIST, MANY PRESSES. A page may hold one hosted door (the item page) or
// twenty (the Workbench To fix tab, one per dead-run row); every door reads the
// list and the chosen model from here, so the page makes ONE
// `GET /api/hosted-runs/models` however many doors it draws — MOTIR-6796's
// *fetched once per page*. What each door does with a press is its own
// (`useContinueHosted`).
//
// ⚠️ THE CARD'S OWN MODEL (Story MOTIR-6989 · MOTIR-6996). Given the page's
// `workItemKey`, the one read also carries that card's resolved preselection, and
// Run hosted opens on it. Continue hosted keeps the preselect it always had
// (`continueModel`): a continuation is not re-resolved. A person's own pick is
// `chosen`, and no read — early, late or a reload — ever overwrites it while the
// list still offers it.
//
// ⚠️ THE CAPACITY VERDICT IS KEPT FRESH QUIETLY (Story MOTIR-9541 · MOTIR-9630;
// `design/runs/design-notes.md` § The label clearing in place). Every model carries
// `capacity` on the same read, so there is no separate face for it. `refreshModels`
// re-reads WITHOUT passing through `loading`, so a held option clears (or a free one
// is held) in place: no spinner, no skeleton, the menu stays open. The item page
// polls it (`pollCapacity`) while the document is visible; every door also calls it
// once after a no-capacity refusal. Both reads share `loadSeq`, so the newest wins.

/** How often the item page re-reads the verdict — the verdict service's own cache
 *  window (`MOTIR_AGENT_CAPACITY_CACHE_MS`' default), so a poll costs at most one
 *  gateway read per window across every viewer. */
export const HOSTED_CAPACITY_REFRESH_MS = 5000;

export interface HostedModelsValue {
  models: HostedModelsState;
  /** The model the person picked, or null while the preselection stands. */
  chosen: string | null;
  setChosen: (id: string) => void;
  /** The chosen model, else the list's preselection (the card's resolved model
   *  first) — what Run hosted sends. */
  selectedModel: string | null;
  /** The chosen model, else the preselection WITHOUT the card's resolution —
   *  what Continue hosted sends (MOTIR-6996 leaves the continue path as it was). */
  continueModel: string | null;
  /** Re-read the list in place (a retry, or a model withdrawn since page load). */
  reloadModels: () => void;
  /** Re-read the list QUIETLY — never through `loading` — for the capacity verdict. */
  refreshModels: () => void;
}

/** After a refused start, re-read the list the way the refusal calls for: a model
 *  withdrawn since page load reloads it (through `loading`); a model that lost its
 *  capacity re-reads it QUIETLY, so its option reads held at once (MOTIR-9630). */
export function reReadAfter(refusal: { kind: string }, hosted: HostedModelsValue | null): void {
  if (refusal.kind === 'modelNotOffered') hosted?.reloadModels();
  if (refusal.kind === 'noCapacity') hosted?.refreshModels();
}

const HostedModelsContext = createContext<HostedModelsValue | null>(null);

/** The page's model list, or null where no `HostedModelsProvider` is mounted. */
export function useHostedModels(): HostedModelsValue | null {
  return useContext(HostedModelsContext);
}

/** Call `refresh` every {@link HOSTED_CAPACITY_REFRESH_MS} while the document is
 *  visible; stopped while it is hidden and on unmount. */
function useVisibleInterval(enabled: boolean, refresh: () => void): void {
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const sync = () => {
      const visible = document.visibilityState === 'visible';
      if (visible && timer === null) timer = setInterval(refresh, HOSTED_CAPACITY_REFRESH_MS);
      if (!visible && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      if (timer !== null) clearInterval(timer);
    };
  }, [enabled, refresh]);
}

export function HostedModelsProvider({
  workItemKey = null,
  pollCapacity = false,
  children,
}: {
  /** The card the page is about — its resolved model is preselected. Null on a
   *  surface of many cards (the Workbench), which reads the list alone. */
  workItemKey?: string | null;
  /** Re-read the capacity verdict quietly while the page is visible — the item
   *  page's door does; a surface of many doors refreshes only after a refusal. */
  pollCapacity?: boolean;
  children: ReactNode;
}) {
  const [models, setModels] = useState<HostedModelsState>({ state: 'loading' });
  const [chosen, setChosenState] = useState<string | null>(null);
  // A reload that resolves after a newer one must not win (CLAUDE.md § the app side).
  const loadSeq = useRef(0);
  // The list as last drawn — a failed quiet re-read keeps it (below).
  const shown = useRef<HostedModelsState>(models);
  useEffect(() => {
    shown.current = models;
  }, [models]);

  const loadModels = useCallback(
    async (quiet = false): Promise<void> => {
      const seq = ++loadSeq.current;
      const read = await readModels(workItemKey);
      if (seq !== loadSeq.current) return;
      // A quiet re-read that failed keeps a list it had: the verdict fails open,
      // and a poll never turns the picker into its unavailable face.
      if (quiet && read.state !== 'ok' && shown.current.state === 'ok') return;
      setModels(read);
      // A model the new list no longer offers is dropped; the preselection takes over.
      setChosenState((prev) =>
        prev && read.state === 'ok' && read.models.some((m) => m.id === prev) ? prev : null,
      );
    },
    [workItemKey],
  );

  useEffect(() => {
    void (async () => {
      await loadModels();
    })();
  }, [loadModels]);

  const reloadModels = useCallback(() => {
    setModels({ state: 'loading' });
    void loadModels();
  }, [loadModels]);

  const refreshModels = useCallback(() => void loadModels(true), [loadModels]);
  useVisibleInterval(pollCapacity, refreshModels);

  const setChosen = useCallback((id: string) => setChosenState(id), []);

  const selectedModel = chosen ?? preselectedModel(models);
  const continueModel = chosen ?? preselectedModel(withoutResolution(models));

  const value = useMemo<HostedModelsValue>(
    () => ({
      models,
      chosen,
      setChosen,
      selectedModel,
      continueModel,
      reloadModels,
      refreshModels,
    }),
    [models, chosen, setChosen, selectedModel, continueModel, reloadModels, refreshModels],
  );

  return <HostedModelsContext.Provider value={value}>{children}</HostedModelsContext.Provider>;
}
