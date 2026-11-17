'use client';

import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Check, Info, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { looksLikeBugKey, normalizeBugKey } from './bugKeyShape';
import { linkKey, removeKey, type FindingKeyResult } from './findingKeyActions';

/**
 * One finding's PLANNING-BUG cell — design MOTIR-11591 § Elements: the key value,
 * then (writer form only) the labelled key input prefilled with the stored key,
 * the Link button, the Remove control when the finding carries a key, and the
 * row's own message slot (an alert region for a refusal, a status region for a
 * notice), stacked in that order.
 *
 * ⚠️ `canWrite` is decided by the page: operator or above on an attributed
 * record. Without it the cell is the key value alone — no input, no button and
 * no tab stop where they would be (the reader and open-record forms).
 *
 * ⚠️ THE KEY IS TEXT, resolved by nothing here: a key whose work item has since
 * been deleted draws exactly like a live one. An empty key is not a defect: no
 * dash, no placeholder, only a visually hidden label.
 *
 * ⚠️ ONE MESSAGE, IN THIS CELL. A refusal keeps the typed key in the input and
 * leaves every other row as it was; a success re-renders the page from the store
 * (the action revalidates) and says so quietly; a link of the key the row already
 * carries is the nothing-changed notice, never a refusal.
 */

type Act = 'link' | 'remove';

type Message =
  | { kind: 'invalid' }
  | { kind: 'notAWorkItem'; key: string }
  | { kind: 'failed'; act: Act }
  | { kind: 'linked'; key: string }
  | { kind: 'removed' }
  | { kind: 'unchanged'; key: string };

export function FindingKeyCell({
  findingId,
  site,
  bugKey,
  canWrite,
}: {
  findingId: string;
  site: string;
  bugKey: string | null;
  canWrite: boolean;
}) {
  const t = useTranslations('platformAdmin.plannerFindings');
  const id = useId();
  const [value, setValue] = useState(bugKey ?? '');
  const [message, setMessage] = useState<Message | null>(null);
  const [pending, setPending] = useState<Act | null>(null);
  const [, startTransition] = useTransition();
  const lastStored = useRef(bugKey);

  // A fresh read (this row's own write, or another tab's) re-seeds the input,
  // unless the admin is mid-edit of a refused key they still need.
  useEffect(() => {
    if (lastStored.current !== bugKey) {
      lastStored.current = bugKey;
      setValue(bugKey ?? '');
    }
  }, [bugKey]);

  const keyValue = bugKey ? (
    <span
      data-testid={`finding-key-value-${findingId}`}
      className="font-mono text-xs break-all text-(--el-text)"
    >
      {bugKey}
    </span>
  ) : (
    <span data-testid={`finding-key-value-${findingId}`} className="min-h-px">
      <span className="sr-only">{t('recordPage.findingKey.a11y.empty')}</span>
    </span>
  );

  if (!canWrite) return <div className="flex flex-col gap-1.5">{keyValue}</div>;

  const inputId = `${id}-input`;
  const hintId = `${id}-hint`;
  const alertId = `${id}-alert`;
  const busy = pending !== null;

  function settle(act: Act, typed: string, result: FindingKeyResult) {
    if (result.ok) {
      const now = result.finding.bugKey;
      setValue(now ?? '');
      if (act === 'remove') setMessage({ kind: 'removed' });
      else if (bugKey !== null && normalizeBugKey(bugKey) === normalizeBugKey(typed)) {
        setMessage({ kind: 'unchanged', key: now ?? normalizeBugKey(typed) });
      } else setMessage({ kind: 'linked', key: now ?? normalizeBugKey(typed) });
      return;
    }
    if (result.code === 'REFUSED' && result.reason === 'not_a_work_item') {
      setMessage({ kind: 'notAWorkItem', key: normalizeBugKey(typed) });
    } else if (result.code === 'INVALID') {
      setMessage({ kind: 'invalid' });
    } else {
      // `record_open` cannot arise from a drawn control (the page draws none on
      // an open record); with GONE and FAILED it is the unexpected failure.
      setMessage({ kind: 'failed', act });
    }
  }

  function run(act: Act) {
    const typed = act === 'link' ? value : (bugKey ?? '');
    if (act === 'link' && !looksLikeBugKey(typed)) {
      setMessage({ kind: 'invalid' });
      return;
    }
    setMessage(null);
    setPending(act);
    startTransition(async () => {
      const result =
        act === 'link'
          ? await linkKey(findingId, normalizeBugKey(typed))
          : await removeKey(findingId, typed);
      settle(act, typed, result);
      setPending(null);
    });
  }

  const refusal =
    message?.kind === 'invalid'
      ? t('bug.invalid')
      : message?.kind === 'notAWorkItem'
        ? t('recordPage.findingKey.notAWorkItem', { key: message.key })
        : message?.kind === 'failed'
          ? t('refused.failed')
          : null;
  const notice =
    message?.kind === 'linked'
      ? { glyph: Check, text: t('recordPage.findingKey.linked', { key: message.key }) }
      : message?.kind === 'removed'
        ? { glyph: Check, text: t('recordPage.findingKey.removed') }
        : message?.kind === 'unchanged'
          ? { glyph: Info, text: t('recordPage.findingKey.unchanged', { key: message.key }) }
          : null;

  return (
    <div
      className="flex min-w-[14rem] flex-col gap-1.5"
      data-testid={`finding-key-cell-${findingId}`}
    >
      {keyValue}
      <div className="flex flex-col gap-1">
        <label htmlFor={inputId} className="font-sans text-xs font-medium text-(--el-text)">
          {t('bug.label')}
          <span className="sr-only"> {t('recordPage.findingKey.labelFinding', { site })}</span>
        </label>
        <input
          id={inputId}
          value={value}
          placeholder={t('bug.placeholder')}
          readOnly={busy}
          aria-readonly={busy || undefined}
          aria-describedby={`${hintId} ${alertId}`}
          aria-invalid={refusal !== null || undefined}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) {
              e.preventDefault();
              run('link');
            }
          }}
          className={`h-(--height-input) w-full rounded-(--radius-input) border border-(--el-border-strong) px-(--spacing-input-x) py-(--spacing-input-y) font-mono text-xs text-(--el-text) placeholder:text-(--el-text-secondary) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none ${
            busy ? 'bg-(--el-surface-soft)' : 'bg-(--el-page-bg)'
          }`}
        />
        <p id={hintId} className="font-sans text-xs text-(--el-text-secondary)">
          {t('recordPage.findingKey.hint')}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          aria-busy={pending === 'link' || undefined}
          onClick={() => run('link')}
        >
          {pending === 'link'
            ? t('recordPage.findingKey.linking')
            : t('recordPage.findingKey.link')}
        </Button>
        {bugKey ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-busy={pending === 'remove' || undefined}
            aria-label={t('recordPage.findingKey.removeFinding', { site })}
            leftIcon={<X aria-hidden className="h-3.5 w-3.5" />}
            onClick={() => run('remove')}
          >
            {pending === 'remove'
              ? t('recordPage.findingKey.removing')
              : t('recordPage.findingKey.remove')}
          </Button>
        ) : null}
      </div>
      <div id={alertId} role="alert" data-testid={`finding-key-alert-${findingId}`}>
        {refusal ? (
          <span className="flex items-start gap-1.5 font-sans text-xs text-(--el-danger-on-surface)">
            <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="flex flex-col items-start gap-1">
              <span>{refusal}</span>
              {message?.kind === 'failed' ? (
                <Button size="sm" variant="ghost" onClick={() => run(message.act)}>
                  {t('triage.retry')}
                </Button>
              ) : null}
            </span>
          </span>
        ) : null}
      </div>
      <div role="status" data-testid={`finding-key-status-${findingId}`}>
        {notice ? (
          <span className="flex items-start gap-1.5 font-sans text-xs text-(--el-text-secondary)">
            <notice.glyph aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{notice.text}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}
