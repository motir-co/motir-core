'use client';

import { useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CircleAlert, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';

// DISMISS THE REVIEW (Story MOTIR-10327 · MOTIR-10342; `design/github/design-notes.md`
// § 32.6, `approve-and-merge--review-path.mock.html` G5–G7) — the control under the Sent back
// band, for the routed person only and only with the review gate OFF, and its dialog:
//
//   empty      Dismiss the review disabled; the reason is required
//   filled     enabled
//   submitting textarea and Cancel disabled, the primary shows the spinner and Dismissing…
//   error      a role=alert line; the reason is kept
//
// ⚠️ THE ANSWER IS THE SERVER'S. On success the host re-reads the card (the page-state
// contract — a server-rendered surface refreshes), and until it lands the control is gone
// and the dialog is closed. A press that a newer one replaced is ignored (`seq`), so two
// quick presses cannot leave the older answer on screen.

export type DismissOutcome =
  | { ok: true }
  | { ok: false; refusal: 'stale' | 'already' | 'notStanding' | 'error' };

/** POST the dismissal through the session door. */
export async function dismissReviewRequest(
  identifier: string,
  input: { subjectVersion: string; reason: string },
): Promise<DismissOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/work-items/${encodeURIComponent(identifier)}/review-dismissal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, refusal: 'error' };
  }
  if (res.ok) return { ok: true };
  const code = await res
    .json()
    .then((body: { code?: string }) => body.code ?? '')
    .catch(() => '');
  if (code === 'REVIEW_DISMISSAL_STALE') return { ok: false, refusal: 'stale' };
  if (code === 'REVIEW_SENDBACK_ALREADY_DISMISSED') return { ok: false, refusal: 'already' };
  if (code === 'NO_STANDING_REVIEW_SENDBACK') return { ok: false, refusal: 'notStanding' };
  return { ok: false, refusal: 'error' };
}

export function DismissReviewControl({
  identifier,
  subjectVersion,
  onDismissed,
  request = dismissReviewRequest,
}: {
  identifier: string;
  /** The version the send-back stands at — the card's current one. */
  subjectVersion: string;
  /** Re-read the card: `router.refresh()` on the item page, the overlay's own fetch. */
  onDismissed: () => void;
  /** Injected by tests. */
  request?: typeof dismissReviewRequest;
}) {
  const t = useTranslations('approvalGate.reviewPath.dismiss');
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  if (done) return null;
  return (
    <div className="flex flex-col items-start gap-2" data-testid="dismiss-review">
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Undo2 className="h-4 w-4" aria-hidden />
        {t('button')}
      </Button>
      <p className="m-0 text-xs text-(--el-text-secondary)">{t('toFixNote')}</p>
      {open ? (
        <DismissReviewDialog
          identifier={identifier}
          subjectVersion={subjectVersion}
          request={request}
          onClose={() => setOpen(false)}
          onDismissed={() => {
            setOpen(false);
            setDone(true);
            onDismissed();
          }}
          onReread={() => {
            setOpen(false);
            onDismissed();
          }}
        />
      ) : null}
    </div>
  );
}

export function DismissReviewDialog({
  identifier,
  subjectVersion,
  request,
  onClose,
  onDismissed,
  onReread,
}: {
  identifier: string;
  subjectVersion: string;
  request: typeof dismissReviewRequest;
  onClose: () => void;
  onDismissed: () => void;
  onReread: () => void;
}) {
  const t = useTranslations('approvalGate.reviewPath.dismiss');
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [refusal, setRefusal] = useState<Exclude<DismissOutcome, { ok: true }>['refusal'] | null>(
    null,
  );
  const seq = useRef(0);
  const trimmed = reason.trim();

  async function submit() {
    if (!trimmed || submitting) return;
    const mine = ++seq.current;
    setSubmitting(true);
    setRefusal(null);
    const outcome = await request(identifier, { subjectVersion, reason: trimmed });
    if (mine !== seq.current) return;
    setSubmitting(false);
    if (outcome.ok) onDismissed();
    else setRefusal(outcome.refusal);
  }

  return (
    <Modal
      open
      onOpenChange={(o) => (!o && !submitting ? onClose() : undefined)}
      title={t('title')}
      size="md"
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Modal.Body className="gap-4">
          <p className="m-0 text-sm text-(--el-text-secondary)">{t('body')}</p>
          <Textarea
            id={reasonId}
            label={t('reasonLabel')}
            placeholder={t('reasonPlaceholder')}
            helperText={t('reasonHint')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            required
            aria-required
            disabled={submitting}
            autoFocus
          />
          {refusal ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-(--radius-control) bg-(--el-danger-surface) px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-strong)"
            >
              <CircleAlert
                className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger-on-surface)"
                aria-hidden
              />
              <span className="flex flex-col items-start gap-1">
                <span>{t(refusal)}</span>
                {refusal === 'error' ? null : (
                  <button
                    type="button"
                    onClick={onReread}
                    className="text-(--el-link) underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
                  >
                    {t('reread')}
                  </button>
                )}
              </span>
            </div>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={submitting} disabled={!trimmed}>
            {submitting ? t('submitting') : t('confirm')}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
