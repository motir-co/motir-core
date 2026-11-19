'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { CheckCircle2, ChevronDown, ChevronRight, RotateCcw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import type { FailedUsageGroupDTO, FailedUsageReplayDTO } from '@/lib/dto/failedUsage';
import { replayFailedUsageAction } from '../actions';

/**
 * The Failed usage section's groups and their Replay (MOTIR-11794; design
 * MOTIR-11793, Panels 1–7, 10 and 11): a table from `sm` up, a list of group
 * cards below it, the confirm, and each group's busy state and result.
 *
 * ⚠️ THE RESULT OUTLIVES THE RE-READ. After a replay the page is re-read
 * (`router.refresh()`, as Jobs re-reads after Replay all), and a group whose
 * rows were all recorded is no longer in it. The island keeps that group's last
 * row and its result, drawn as Replayed, until the page is next loaded — so the
 * operator reads what happened where they pressed Replay. A group that failed
 * again with the SAME error is still in the read: it shows its new counts, its
 * result and its Replay.
 *
 * One group at a time per button, many at once on the page: a replaying group's
 * Replay is busy and every other group's stays enabled.
 */

type Outcome =
  | { kind: 'busy'; was: FailedUsageGroupDTO }
  | { kind: 'done'; replay: FailedUsageReplayDTO; was: FailedUsageGroupDTO }
  | { kind: 'unfinished'; was: FailedUsageGroupDTO };

interface Shown {
  group: FailedUsageGroupDTO;
  /** Replayed and no longer in the latest read: drawn as Replayed. */
  replayed: boolean;
}

const TH = 'px-(--spacing-control-x-12) py-(--spacing-control-y-8) font-medium';
const TD = 'px-(--spacing-control-x-12) py-(--spacing-control-y-8)';

/** The message on one line, as the cell shows it; the full text stays in `title`. */
const oneLine = (error: string) => error.replace(/\s+/g, ' ').trim();

/** Largest first, ties by newest — the order motir-ai answers in. */
function byWeight(a: Shown, b: Shown): number {
  if (b.group.rows !== a.group.rows) return b.group.rows - a.group.rows;
  return b.group.newestReceivedAt.localeCompare(a.group.newestReceivedAt);
}

export function FailedUsageGroups({
  groups,
  canReplay,
}: {
  groups: FailedUsageGroupDTO[];
  canReplay: boolean;
}) {
  const t = useTranslations('platformAdmin.usage.failed');
  const format = useFormatter();
  const router = useRouter();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, Outcome>>>({});
  const [confirming, setConfirming] = useState<FailedUsageGroupDTO | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const cancel = useRef<HTMLButtonElement | null>(null);

  const listed = new Set(groups.map((g) => g.error));
  const shown: Shown[] = groups.map((group) => ({ group, replayed: false }));
  for (const [error, outcome] of Object.entries(outcomes)) {
    // A group the latest read no longer lists stays where it was: a replayed
    // group as Replayed; one still replaying (its rows are pending while a
    // re-read lands from ANOTHER group's replay) or one whose replay did not
    // finish, as itself with its busy state or its Replay.
    if (!listed.has(error)) {
      shown.push({ group: outcome.was, replayed: outcome.kind === 'done' });
    }
  }
  shown.sort(byWeight);

  const num = (n: number) => format.number(n);
  const time = (iso: string) =>
    format.dateTime(new Date(iso), {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    });

  const toggle = (error: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(error)) next.delete(error);
      else next.add(error);
      return next;
    });

  const ask = (group: FailedUsageGroupDTO, from: HTMLElement) => {
    opener.current = from;
    setConfirming(group);
  };

  const replay = async (group: FailedUsageGroupDTO) => {
    setConfirming(null);
    setOutcomes((prev) => ({ ...prev, [group.error]: { kind: 'busy', was: group } }));
    let outcome: Outcome;
    try {
      const answer = await replayFailedUsageAction(group.error);
      outcome = answer.ok
        ? { kind: 'done', replay: answer.replay, was: group }
        : { kind: 'unfinished', was: group };
    } catch {
      outcome = { kind: 'unfinished', was: group };
    }
    setOutcomes((prev) => ({ ...prev, [group.error]: outcome }));
    // The counts above and every group move with the replay: re-read the page.
    router.refresh();
  };

  const view = shown.map(({ group, replayed }) => {
    const outcome = outcomes[group.error];
    return {
      group,
      replayed,
      key: group.error,
      busy: outcome?.kind === 'busy',
      isOpen: open.has(group.error),
      result:
        outcome?.kind === 'done' ? (
          <ResultLines replay={outcome.replay} stillListed={listed.has(group.error)} />
        ) : outcome?.kind === 'unfinished' ? (
          <ul role="status" className="flex flex-col gap-1">
            <Line ok={false} text={t('result.unfinished')} />
          </ul>
        ) : null,
    };
  });

  const disclosure = (error: string, isOpen: boolean, ink: string) => (
    <div className="flex min-w-0 items-start gap-1">
      <button
        type="button"
        aria-expanded={isOpen}
        aria-label={isOpen ? t('hideError') : t('showError')}
        onClick={() => toggle(error)}
        className="mt-0.5 inline-flex shrink-0 rounded-(--radius-control) text-(--el-text-secondary) focus-visible:outline-2 focus-visible:outline-(--focus-ring-color)"
      >
        {isOpen ? (
          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
        )}
      </button>
      <span title={error} className={`block max-w-[26rem] truncate font-mono text-xs ${ink}`}>
        {oneLine(error)}
      </span>
    </div>
  );

  const action = (group: FailedUsageGroupDTO, replayed: boolean, busy: boolean) => {
    if (replayed) {
      return <Pill tone="neutral">{t('replayed')}</Pill>;
    }
    return (
      <>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
          loading={busy}
          aria-label={busy ? undefined : t('replayAria', { rows: group.rows })}
          onClick={(e) => ask(group, e.currentTarget)}
          data-testid="failed-group-replay"
        >
          {busy ? t('replaying') : t('replay')}
        </Button>
        {busy ? (
          <span role="status" className="sr-only">
            {t('replayingStatus', { rows: group.rows })}
          </span>
        ) : null}
      </>
    );
  };

  const columns = canReplay ? 6 : 5;

  return (
    <>
      <Card className="hidden overflow-x-auto p-0 sm:block">
        <table className="w-full font-sans text-sm" data-testid="usage-failed-groups">
          <caption className="sr-only">{t('caption')}</caption>
          <thead>
            <tr className="text-left text-xs text-(--el-text-secondary)">
              <th scope="col" className={TH}>
                {t('col.error')}
              </th>
              <th scope="col" className={`${TH} text-right`}>
                {t('col.rows')}
              </th>
              <th scope="col" className={`${TH} text-right`}>
                {t('col.orgs')}
              </th>
              <th scope="col" className={TH}>
                {t('col.oldest')}
              </th>
              <th scope="col" className={TH}>
                {t('col.newest')}
              </th>
              {canReplay ? (
                <th scope="col" className={TH}>
                  <span className="sr-only">{t('col.replay')}</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {view.map(({ group, replayed, key, busy, isOpen, result }) => {
              const ink = replayed ? 'text-(--el-text-secondary)' : 'text-(--el-text)';
              return [
                <tr
                  key={`${key}:row`}
                  className="border-t border-(--el-border)"
                  aria-busy={busy || undefined}
                  data-testid="failed-group"
                  data-replayed={replayed || undefined}
                >
                  <td className={TD}>{disclosure(group.error, isOpen, ink)}</td>
                  <td className={`${TD} text-right tabular-nums ${ink}`}>{num(group.rows)}</td>
                  <td className={`${TD} text-right tabular-nums ${ink}`}>
                    {num(group.organizations)}
                  </td>
                  <td className={`${TD} whitespace-nowrap tabular-nums ${ink}`}>
                    {time(group.oldestReceivedAt)}
                  </td>
                  <td className={`${TD} whitespace-nowrap tabular-nums ${ink}`}>
                    {time(group.newestReceivedAt)}
                  </td>
                  {canReplay ? (
                    <td className={`${TD} text-right whitespace-nowrap`}>
                      {action(group, replayed, busy)}
                    </td>
                  ) : null}
                </tr>,
                isOpen ? (
                  <tr
                    key={`${key}:error`}
                    className="bg-(--el-surface-soft)"
                    data-testid="failed-group-full-error"
                  >
                    <td colSpan={columns} className={TD}>
                      <pre className="font-mono text-xs break-words whitespace-pre-wrap text-(--el-text)">
                        {group.error}
                      </pre>
                    </td>
                  </tr>
                ) : null,
                result ? (
                  <tr
                    key={`${key}:result`}
                    className="bg-(--el-surface-soft)"
                    data-testid="failed-group-result"
                  >
                    <td colSpan={columns} className={TD}>
                      {result}
                    </td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
        </table>
      </Card>

      <ul className="flex flex-col gap-3 sm:hidden" data-testid="usage-failed-list">
        {view.map(({ group, replayed, key, busy, isOpen, result }) => {
          const ink = replayed ? 'text-(--el-text-secondary)' : 'text-(--el-text)';
          const facts = [
            { label: t('col.rows'), value: num(group.rows) },
            { label: t('col.orgs'), value: num(group.organizations) },
            { label: t('col.oldest'), value: time(group.oldestReceivedAt) },
            { label: t('col.newest'), value: time(group.newestReceivedAt) },
          ];
          return (
            <li
              key={key}
              aria-busy={busy || undefined}
              data-testid="failed-group-card"
              data-replayed={replayed || undefined}
            >
              <Card>
                <div className="flex flex-col gap-3">
                  {disclosure(group.error, isOpen, ink)}
                  {isOpen ? (
                    <pre className="rounded-(--radius-control) bg-(--el-surface-soft) px-(--spacing-control-x-8) py-(--spacing-control-y-8) font-mono text-xs break-words whitespace-pre-wrap text-(--el-text)">
                      {group.error}
                    </pre>
                  ) : null}
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 font-sans text-sm">
                    {facts.map((f) => (
                      <div key={f.label} className="flex flex-col">
                        <dt className="text-xs text-(--el-text-secondary)">{f.label}</dt>
                        <dd className={`tabular-nums ${ink}`}>{f.value}</dd>
                      </div>
                    ))}
                  </dl>
                  {result ? (
                    <div className="rounded-(--radius-control) bg-(--el-surface-soft) px-(--spacing-control-x-8) py-(--spacing-control-y-8)">
                      {result}
                    </div>
                  ) : null}
                  {canReplay ? (
                    <div className="flex justify-end">{action(group, replayed, busy)}</div>
                  ) : null}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>

      <Modal
        open={confirming !== null}
        onOpenChange={(next) => {
          if (!next) setConfirming(null);
        }}
        role="alertdialog"
        size="md"
        title={confirming ? t('confirm.title', { rows: confirming.rows }) : undefined}
        description={t('confirm.body')}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancel.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          opener.current?.focus();
        }}
      >
        {confirming ? (
          <>
            <div className="flex flex-col gap-2" data-testid="failed-usage-confirm">
              <p className="font-sans text-xs text-(--el-text-secondary)">{t('confirm.error')}</p>
              <div className="rounded-(--radius-control) bg-(--el-surface-soft) px-(--spacing-control-x-8) py-(--spacing-control-y-8)">
                <p className="line-clamp-3 font-mono text-xs break-words text-(--el-text)">
                  {oneLine(confirming.error)}
                </p>
              </div>
              <p className="font-sans text-sm text-(--el-text)">
                {t('confirm.scope', { rows: confirming.rows, orgs: confirming.organizations })}
              </p>
            </div>
            <Modal.Footer>
              <Button ref={cancel} variant="ghost" onClick={() => setConfirming(null)}>
                {t('confirm.cancel')}
              </Button>
              <Button variant="primary" onClick={() => void replay(confirming)}>
                {t('confirm.go', { rows: confirming.rows })}
              </Button>
            </Modal.Footer>
          </>
        ) : null}
      </Modal>
    </>
  );
}

function Line({ ok, text }: { ok: boolean; text: string }) {
  return (
    <li className="flex items-start gap-2 font-sans text-sm text-(--el-text)">
      {ok ? (
        <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-(--el-success)" />
      ) : (
        <XCircle
          aria-hidden="true"
          className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger-on-surface)"
        />
      )}
      <span>{text}</span>
    </li>
  );
}

/** What one replay did, under its group. `stillListed`: the re-read still has the group. */
function ResultLines({
  replay,
  stillListed,
}: {
  replay: FailedUsageReplayDTO;
  stillListed: boolean;
}) {
  const t = useTranslations('platformAdmin.usage.failed');
  return (
    <ul role="status" className="flex flex-col gap-1">
      <Line ok text={t('result.applied', { count: replay.applied })} />
      {replay.failedAgain === 0 ? (
        <Line ok text={t('result.none')} />
      ) : (
        <Line
          ok={false}
          text={`${t('result.failedAgain', { count: replay.failedAgain })} ${
            stillListed ? t('result.sameGroup') : t('result.newGroup')
          }`}
        />
      )}
    </ul>
  );
}
