'use client';

import { createContext, useContext, useEffect, useState, useTransition } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Activity, CircleAlert, Plus, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Pill } from '@/components/ui/Pill';
import { Popover } from '@/components/ui/Popover';
import { useLinkCandidateSearch } from '@/hooks/useLinkCandidateSearch';
import type {
  MonitorIssueCandidateDto,
  MonitorIssueSearchFailureDto,
} from '@/lib/dto/monitorIssueLink';
import { linkMonitorIssueAction, searchMonitorIssuesAction } from '../actions';
import { levelPillProps } from './MonitorErrorsSection';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import { useRelativeTime } from '@/lib/hooks/useRelativeTime';

// LINK an error from the work-item page (Story MOTIR-4932 · Subtask MOTIR-5744),
// drawn by `design/monitoring/work-item-errors.mock.html` §14 panels 5b–5c, 6
// and 7 — the header door, the picker, the move confirmation, and the ⋯-menu
// door for a work item with NO link yet.
//
// ⚠️ IT IS `DevelopmentLinkControl`'S GRAMMAR WITH A DIFFERENT SOURCE: the same
// door, the same inline form on `--el-surface-soft`, the same query-driven
// `Combobox` through `useLinkCandidateSearch`, the same rose banner — and the
// `RemoveLinkButton` popover shape for the one confirmation this surface adds.
//
// ⚠️ TWO PROVIDERS, BECAUSE THE DOORS SIT IN TWO PAGE TIERS. The ⋯ menu is in the
// page HEADER (tier one); the Errors section is in the LATE stack. A work item
// with no link renders no section (§14 Decision 1), so its door is a ⋯-menu row
// — which cannot know, at tier one, whether the late read found a link. So:
//
//   • `MonitorErrorsDoorProvider` wraps the WHOLE page. The late section TELLS it
//     whether the no-link door applies (editor + monitored project + no link),
//     and the ⋯ menu reads that to show its row. Choosing the row REQUESTS the
//     section, which then mounts with the picker open.
//   • `MonitorErrorsLinkProvider` is the section's own: the form's open state,
//     the submit, and the move confirmation.
//
// Outside the page provider (every other surface that renders the shared ⋯ menu)
// the door context is `null` and nothing here draws — the row belongs to the
// detail page only.
//
// ⚠️ THE SEARCH NEVER RUNS ON PAGE LOAD. It lives in the FORM, which mounts only
// when a person opens the picker; opening the page asks the monitor nothing.

// ── The page-level door (the ⋯-menu row ↔ the late section) ────────────────

interface DoorContextValue {
  /** The no-link door applies: editor + monitored project + no link. Set by the
   *  late section once its read has settled; `false` until then. */
  available: boolean;
  setAvailable: (available: boolean) => void;
  /** The ⋯ row was chosen — the section should mount with the picker open. */
  requested: boolean;
  request: () => void;
  clearRequest: () => void;
}

const DoorContext = createContext<DoorContextValue | null>(null);

export function MonitorErrorsDoorProvider({ children }: { children: ReactNode }) {
  const [available, setAvailable] = useState(false);
  const [requested, setRequested] = useState(false);
  return (
    <DoorContext.Provider
      value={{
        available,
        setAvailable,
        requested,
        request: () => setRequested(true),
        clearRequest: () => setRequested(false),
      }}
    >
      {children}
    </DoorContext.Provider>
  );
}

/** The page's door, or `null` outside the detail page. */
export function useMonitorErrorsDoor(): DoorContextValue | null {
  return useContext(DoorContext);
}

/**
 * The late section's half of the handshake: it says whether the ⋯ row applies.
 * An effect, because the value comes from a late read that settles after the
 * header has rendered — the row appears in the menu once the page knows.
 */
export function useAnnounceNoLinkDoor(available: boolean): void {
  const door = useMonitorErrorsDoor();
  const setAvailable = door?.setAvailable;
  useEffect(() => {
    setAvailable?.(available);
    return () => setAvailable?.(false);
  }, [available, setAvailable]);
}

// ── The section's link state ────────────────────────────────────────────────

interface LinkContextValue {
  open: boolean;
  openForm: () => void;
  cancel: () => void;
  /** Link the picked candidate; `move` re-sends taking it from its holder. */
  submit: (candidate: MonitorIssueCandidateDto, move: boolean) => void;
  /** The holder named by an `already_linked` refusal — the move confirmation is
   *  open while this is set. */
  moveFrom: { identifier: string; candidate: MonitorIssueCandidateDto } | null;
  dismissMove: () => void;
  error: string | null;
  pending: boolean;
  workItemId: string;
}

const LinkContext = createContext<LinkContextValue | null>(null);

function useLinkControl(): LinkContextValue {
  const ctx = useContext(LinkContext);
  if (!ctx) throw new Error('LinkErrorDoor/Form must render inside MonitorErrorsLinkProvider');
  return ctx;
}

export function MonitorErrorsLinkProvider({
  workItemId,
  identifier,
  initiallyOpen = false,
  onClosed,
  children,
}: {
  workItemId: string;
  identifier: string;
  /** Mount with the picker open — the ⋯-menu row's path (§14 panel 5c). */
  initiallyOpen?: boolean;
  /** Fired when the picker closes WITHOUT a link (Cancel) — the no-link mount
   *  takes the section away again. */
  onClosed?: () => void;
  children: ReactNode;
}) {
  const t = useTranslations('monitorErrors');
  const router = useRouter();
  const [open, setOpen] = useState(initiallyOpen);
  const [error, setError] = useState<string | null>(null);
  const [moveFrom, setMoveFrom] = useState<LinkContextValue['moveFrom']>(null);
  const [pending, startTransition] = useTransition();

  function cancel() {
    setOpen(false);
    setError(null);
    setMoveFrom(null);
    onClosed?.();
  }

  function submit(candidate: MonitorIssueCandidateDto, move: boolean) {
    setError(null);
    startTransition(async () => {
      const res = await linkMonitorIssueAction({
        workItemId,
        identifier,
        connectionId: candidate.connectionId,
        externalIssueId: candidate.externalIssueId,
        move,
      });
      if (res.ok) {
        setOpen(false);
        setMoveFrom(null);
        // The request is NOT cleared here: the refreshed read has not landed yet,
        // and clearing it now would drop the no-link section before its new row
        // arrives. The section host clears it once the read returns a link.
        // The section is server-rendered from the late read — re-run it so the
        // new row appears (the page-state contract's case 2, as Development's
        // link does).
        router.refresh();
        return;
      }
      if (res.code === 'already_linked') {
        setMoveFrom({ identifier: res.holderIdentifier, candidate });
        return;
      }
      setMoveFrom(null);
      setError(
        res.code === 'issue_gone'
          ? t('error.issueGone')
          : res.code === 'forbidden'
            ? t('error.forbidden')
            : res.code === 'provider_failed'
              ? // The monitor's OWN words, verbatim — data, not new copy.
                res.reason
              : t('error.notFound'),
      );
    });
  }

  return (
    <LinkContext.Provider
      value={{
        open,
        openForm: () => {
          setOpen(true);
          setError(null);
        },
        cancel,
        submit,
        moveFrom,
        dismissMove: () => setMoveFrom(null),
        error,
        pending,
        workItemId,
      }}
    >
      {children}
    </LinkContext.Provider>
  );
}

/** The header door — `+ Link error` (§14 panels 1, 6a). Hidden while the form is
 *  open, exactly as Development's is. */
export function LinkErrorDoor() {
  const t = useTranslations('monitorErrors');
  const { open, openForm } = useLinkControl();
  if (open) return null;
  return (
    <button
      type="button"
      onClick={openForm}
      className="inline-flex items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x-6) py-(--spacing-control-y-4) font-sans text-sm font-semibold text-(--el-link) hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
    >
      <Plus className="h-4 w-4" aria-hidden />
      {t('link')}
    </button>
  );
}

function connectionLabel(c: { orgSlug: string | null; projectSlug: string }): string {
  return c.orgSlug ? `${c.orgSlug} / ${c.projectSlug}` : c.projectSlug;
}

/**
 * The inline picker (§14 panels 6a–6b, 7). The SEARCH lives here, so it runs
 * only while the form is mounted — before typing it lists the most recently
 * seen issues (an empty query), and each option shows its connection, count,
 * last seen and level. A connection whose search failed is a status line inside
 * the open results; the other connections' candidates still list.
 */
export function LinkErrorForm() {
  const { open } = useLinkControl();
  // ⚠️ THE SEARCH MUST NOT EXIST UNTIL THE PICKER IS OPEN. Its hook fetches the
  // empty query the moment it mounts, so it lives in a component that mounts
  // only when a person opens the picker — calling it above an `if (!open)`
  // early return searched the monitor on every page load an editor made
  // (found by the story's E2E, MOTIR-5734), and remounting per open is also
  // what keeps a reopened picker from showing a previous search's results.
  if (!open) return null;
  return <OpenLinkErrorForm />;
}

function OpenLinkErrorForm() {
  const routes = useReaderRoutes();
  const t = useTranslations('monitorErrors');
  const tc = useTranslations('common');
  const relativeTime = useRelativeTime();
  const { cancel, submit, moveFrom, dismissMove, error, pending, workItemId } = useLinkControl();
  const [selected, setSelected] = useState<string | null>(null);
  const [failures, setFailures] = useState<MonitorIssueSearchFailureDto[]>([]);
  const search = useLinkCandidateSearch<MonitorIssueCandidateDto>({
    minLength: 0,
    fetcher: async (query) => {
      const res = await searchMonitorIssuesAction({ workItemId, query });
      if (!res.ok) {
        setFailures([]);
        return {
          ok: false,
          error: res.code === 'forbidden' ? t('error.forbidden') : t('error.notFound'),
        };
      }
      setFailures(res.result.failures);
      return { ok: true, candidates: res.result.candidates };
    },
  });
  const keyOf = (c: MonitorIssueCandidateDto) => `${c.connectionId}\u0000${c.externalIssueId}`;
  const picked = search.candidates.find((c) => keyOf(c) === selected) ?? null;

  const options: ComboboxOption<string>[] = search.candidates.map((c) => {
    const pill = levelPillProps(c.level);
    return {
      value: keyOf(c),
      label: c.title,
      secondary: t('candidate', {
        connection: connectionLabel(c),
        count: c.eventCount,
        when: relativeTime(new Date(c.lastSeenAt)),
      }),
      icon: <Activity className="h-4 w-4 text-(--el-icon-muted)" />,
      // Decision 4: an issue another work item holds shows `Linked to <KEY>` in the
      // pill slot — TEXT, not a link (an interactive element inside an option is
      // an a11y defect); the key IS a link in the move confirmation. An issue
      // linked HERE shows `Linked here` and cannot be picked.
      trailing:
        c.linkedTo === 'this' ? (
          <Pill tone="neutral">{t('linkedHere')}</Pill>
        ) : c.linkedTo ? (
          <Pill tone="neutral">{t('linkedTo', { key: c.linkedTo.identifier })}</Pill>
        ) : pill ? (
          <Pill {...pill}>{c.level}</Pill>
        ) : undefined,
      disabled: c.linkedTo === 'this',
    };
  });

  // SPANS, not divs: `Combobox` renders its `footer` inside a `<p>`, where a block
  // element is invalid HTML (the browser closes the paragraph early). Each line is
  // a `note` — a named, a11y-tree-visible statement inside the open results.
  const failureLines =
    failures.length > 0 ? (
      <span className="flex flex-col gap-1.5">
        {failures.map((f) => (
          <span
            key={f.connectionId}
            role="note"
            className="flex items-start gap-1.5 rounded-(--radius-control) bg-(--el-warning-surface) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-xs text-(--el-warning-text)"
            data-testid="search-failure"
          >
            <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-(--el-warning)" aria-hidden />
            <span>
              {t.rich('searchFailed', {
                b: (chunks) => <b className="font-semibold">{chunks}</b>,
                connection: connectionLabel(f),
                reason: f.reason,
              })}
            </span>
          </span>
        ))}
      </span>
    ) : undefined;

  return (
    <div className="mb-3 flex flex-col gap-2.5 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) p-(--spacing-card-padding-12)">
      <div className="flex flex-col gap-1.5">
        {/* `--el-text-secondary`, not the shipped form's `--el-text-eyebrow`, which
            is under AA on `--el-surface-soft` (§14 Tokens). */}
        <span className="font-mono text-[11px] font-semibold tracking-wider text-(--el-text-secondary) uppercase">
          {t('field')}
        </span>
        <Combobox
          label={t('field')}
          options={options}
          value={selected}
          onChange={(v) => {
            setSelected(v);
            dismissMove();
          }}
          searchable
          query={search.query}
          onQueryChange={(q) => {
            setSelected(null);
            search.setQuery(q);
          }}
          placeholder={t('searchPlaceholder')}
          searchPlaceholder={t('searchPlaceholder')}
          loading={search.loading}
          loadingText={t('searching')}
          emptyText={
            <>
              <span className="block">{t('noMatches')}</span>
              <span className="mt-1 block text-(--el-text-identifier)">{t('noMatchesHint')}</span>
            </>
          }
          footer={failureLines}
        />
      </div>
      <div className="flex items-center gap-2">
        <Popover
          open={moveFrom !== null}
          // An ANCHOR, not a trigger: nothing but an `already_linked` answer opens
          // this popover, so Radix only ever reports a CLOSE (Escape, outside).
          onOpenChange={() => dismissMove()}
        >
          <Popover.Anchor asChild>
            <span className="inline-flex">
              <Button
                size="sm"
                onClick={() => picked && submit(picked, false)}
                disabled={!picked || pending}
                loading={pending && moveFrom === null}
              >
                {t('linkAction')}
              </Button>
            </span>
          </Popover.Anchor>
          {moveFrom ? (
            <Popover.Content width={300} align="start">
              <div className="flex flex-col gap-3 p-3.5" data-testid="move-confirm">
                <p className="font-sans text-sm leading-snug font-semibold text-(--el-text)">
                  {t.rich('move.title', {
                    key: moveFrom.identifier,
                    // Decision 4: the key IS a link here, at the moment the reader
                    // decides whether to take the error off that work item.
                    link: (chunks) => (
                      <Link
                        href={routes.item(moveFrom.identifier)}
                        className="font-mono text-(--el-link) hover:underline"
                      >
                        {chunks}
                      </Link>
                    ),
                  })}
                </p>
                <p className="font-sans text-sm leading-snug text-(--el-text-secondary)">
                  {t('move.body', { key: moveFrom.identifier })}
                </p>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={dismissMove} disabled={pending}>
                    {tc('cancel')}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => submit(moveFrom.candidate, true)}
                    loading={pending}
                  >
                    {t('move.action')}
                  </Button>
                </div>
              </div>
            </Popover.Content>
          ) : null}
        </Popover>
        <Button size="sm" variant="ghost" onClick={cancel} disabled={pending}>
          {tc('cancel')}
        </Button>
      </div>
      {(error ?? search.error) ? (
        <div
          className="flex items-start gap-2 rounded-(--radius-control) bg-(--el-tint-rose) px-(--spacing-control-x-12) py-(--spacing-control-y-8)"
          role="alert"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger)" aria-hidden />
          <span className="font-sans text-[13px] text-(--el-text-strong)">
            {error ?? search.error}
          </span>
        </div>
      ) : null}
    </div>
  );
}
