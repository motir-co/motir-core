'use client';

import { useRef, useState, useTransition, type DragEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import {
  Download,
  LayoutGrid,
  List,
  Paperclip,
  Pen,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/ErrorState';
import { Popover } from '@/components/ui/Popover';
import { Segmented } from '@/components/ui/Segmented';
import { Tooltip } from '@/components/ui/Tooltip';
import type { AttachmentDTO, AttachmentsPageDTO } from '@/lib/dto/attachments';
import { ALLOWED_UPLOAD_TYPES, MAX_UPLOAD_BYTES } from '@/lib/blob/allowlist';
import {
  postWorkItemAttachment as postAttachment,
  UPLOAD_ABORTED as ABORTED,
  UploadFailure,
  uploadFailureMessage,
} from '@/lib/blob/uploadClient';
import { useAttachmentsView } from '@/lib/hooks/useAttachmentsView';
import { formatBytes } from '@/lib/utils/bytes';
import { cn } from '@/lib/utils/cn';
import { triggerDownload } from './attachmentDownload';
import { AttachmentGlyph } from './AttachmentGlyph';
import { AttachmentPreview, isPreviewable } from './AttachmentPreview';
import { ContentSectionCard } from './ContentSectionCard';
import { useRelativeTime } from '@/lib/hooks/useRelativeTime';

// The Attachments panel in the detail page's reserved Epic-5 slot (Story 5.2 ·
// Subtask 5.2.5) — `design/work-items/attachments.mock.html` is the layout
// authority, panel for panel:
//
//   * header — total-count gloss · the strip/list `Segmented` toggle (the
//     chosen view persists per user, the 5.1.5 sort-preference pattern) · the
//     secondary Attach button (multi-select picker; OMITTED for read-only
//     actors — absent, never disabled, the 5.1 viewer grammar);
//   * strip view — thumbnail cards (image cover-fit, or the MIME-family glyph
//     on `--el-surface-soft`); list view — the same rows densified (adds size
//     + uploader). The card/row open target is its OWN button; the per-card
//     download/delete icon buttons are SIBLINGS revealed on hover/focus-within
//     (never nested interactives);
//   * editor-sourced rows (the embeds-ARE-attachments rule) carry the lavender
//     source chip and their delete is DISABLED with the points-at-source
//     tooltip — the Jira block that prevents the broken-embed hole. A row the
//     caller simply can't delete (not the uploader, not an admin) omits the
//     control entirely;
//   * upload — the Attach button is the always-present labelled affordance;
//     the whole-panel dropzone is the drag enhancement over it (drag-only
//     upload would be a keyboard hole). Per-file progress rows + cancel;
//     failures isolate per file as rose-tint banners with the localized
//     `errors.upload.*` copy the 2.3.7 uploadClient already maps (reused, not
//     forked). Successes become cards in place;
//   * the read is cursor-paged (50, newest first) + "Show more (N)" — never a
//     load-all (finding #57); tile skeletons / inviting empty / ErrorState.
//
// Activating a previewable card (the DTO's `isImage`/`isPdf` split) opens the
// 5.2.6 AttachmentPreview lightbox; non-previewable activations download (the
// Jira-verified split — images + PDF preview, the rest download).
// Mutations go through the 5.2.2 routes; this client component owns the loaded
// window, applies results in place, and calls `router.refresh()` so the
// server-rendered first page stays fresh (the CommentsSection pattern).

interface UploadingFile {
  key: number;
  filename: string;
  mimeType: string;
  /** 0–100 when the request reports progress; null → indeterminate. */
  progress: number | null;
}

interface UploadError {
  key: number;
  filename: string;
  message: string;
}

const iconButtonClass =
  'inline-flex items-center justify-center rounded-(--radius-control) border border-(--el-border) bg-(--el-page-bg) p-(--spacing-icon-btn) text-(--el-text-muted) shadow-(--shadow-card) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';
const dangerIconButtonClass =
  'inline-flex items-center justify-center rounded-(--radius-control) border border-(--el-border) bg-(--el-page-bg) p-(--spacing-icon-btn) text-(--el-text-muted) shadow-(--shadow-card) hover:border-(--el-tint-rose) hover:bg-(--el-tint-rose) hover:text-(--el-danger) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';

export function AttachmentsPanel({
  workItemId,
  canCreate,
  canDeleteAll,
  currentUserId,
  initialPage,
}: {
  workItemId: string;
  /** Jira's "Create attachments" on the 6.4 roles — gates Attach + dropzone. */
  canCreate: boolean;
  /** Jira's "Delete all attachments" — uploaders delete their OWN regardless. */
  canDeleteAll: boolean;
  currentUserId: string;
  /** The server-rendered first page (newest 50), or null when the server read
   * failed — the panel then renders ErrorState + retry. */
  initialPage: AttachmentsPageDTO | null;
}) {
  const t = useTranslations('attachments');
  const tErrors = useTranslations('errors');
  const router = useRouter();

  const [attachments, setAttachments] = useState<AttachmentDTO[]>(initialPage?.attachments ?? []);
  const [totalCount, setTotalCount] = useState(initialPage?.totalCount ?? 0);
  const [nextCursor, setNextCursor] = useState<string | null>(initialPage?.nextCursor ?? null);
  const [failed, setFailed] = useState(initialPage === null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [view, setView] = useAttachmentsView();
  const [uploads, setUploads] = useState<UploadingFile[]>([]);
  const [uploadErrors, setUploadErrors] = useState<UploadError[]>([]);
  // Drag depth, not a boolean — dragenter/dragleave fire per child element.
  const [dragDepth, setDragDepth] = useState(0);
  // The lightbox's focused attachment (5.2.6); null while closed.
  const [preview, setPreview] = useState<AttachmentDTO | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadSeq = useRef(0);
  const inflight = useRef(new Map<number, XMLHttpRequest>());

  async function fetchPage(cursor?: string): Promise<AttachmentsPageDTO> {
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    const query = params.size > 0 ? `?${params}` : '';
    const res = await fetch(`/api/work-items/${workItemId}/attachments${query}`);
    if (!res.ok) throw new Error(`Attachments read failed (${res.status})`);
    return (await res.json()) as AttachmentsPageDTO;
  }

  function retryInitial() {
    setFailed(false);
    setLoading(true);
    void fetchPage()
      .then((page) => {
        setAttachments(page.attachments);
        setTotalCount(page.totalCount);
        setNextCursor(page.nextCursor);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }

  // "Show more (N)" — extend the window toward older files; the page appends
  // at the older (bottom) edge, so scroll position is naturally kept.
  function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    void fetchPage(nextCursor)
      .then((page) => {
        setAttachments((current) => [...current, ...page.attachments]);
        setTotalCount(page.totalCount);
        setNextCursor(page.nextCursor);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoadingMore(false));
  }

  function uploadFiles(files: File[]) {
    for (const file of files) {
      uploadSeq.current += 1;
      const key = uploadSeq.current;

      // Client-side pre-check against the SAME shared policy the server
      // enforces (lib/blob/allowlist.ts) — same localized copy, no wasted
      // round-trip; the 5.2.2 route still re-enforces (413/415/429).
      const precheck =
        file.size > MAX_UPLOAD_BYTES
          ? 'FILE_TOO_LARGE'
          : !ALLOWED_UPLOAD_TYPES.includes(file.type)
            ? 'UNSUPPORTED_FILE_TYPE'
            : null;
      if (precheck) {
        setUploadErrors((current) => [
          ...current,
          { key, filename: file.name, message: tErrors(`upload.${precheck}`) },
        ]);
        continue;
      }

      setUploads((current) => [
        ...current,
        { key, filename: file.name, mimeType: file.type, progress: null },
      ]);
      void postAttachment(
        workItemId,
        file,
        (pct) =>
          setUploads((current) =>
            current.map((up) => (up.key === key ? { ...up, progress: pct } : up)),
          ),
        (xhr) => inflight.current.set(key, xhr),
      )
        .then((attachment) => {
          // The new file joins the window's newest edge ("successes become
          // cards in place") and the server-rendered first page refreshes.
          setAttachments((current) => [attachment, ...current]);
          setTotalCount((current) => current + 1);
          router.refresh();
        })
        .catch((err: unknown) => {
          const code = err instanceof UploadFailure ? err.code : undefined;
          if (code === ABORTED) return;
          // A cap refusal's words depend on WHICH cap (`uploadFailureMessage`).
          const message = uploadFailureMessage(tErrors, err instanceof UploadFailure ? err : {});
          setUploadErrors((current) => [...current, { key, filename: file.name, message }]);
        })
        .finally(() => {
          inflight.current.delete(key);
          setUploads((current) => current.filter((up) => up.key !== key));
        });
    }
  }

  function cancelUpload(key: number) {
    inflight.current.get(key)?.abort();
  }

  function handleDeleted(attachment: AttachmentDTO) {
    setAttachments((current) => current.filter((item) => item.id !== attachment.id));
    setTotalCount((current) => Math.max(0, current - 1));
    router.refresh();
  }

  // The card/row activation — the Jira-verified split (5.2.6): images + PDFs
  // open the preview lightbox, every other type downloads.
  function openAttachment(attachment: AttachmentDTO) {
    if (isPreviewable(attachment)) setPreview(attachment);
    else triggerDownload(attachment);
  }

  // ── Dropzone (drag enhancement over the Attach button) ──────────────────
  function hasFiles(event: DragEvent) {
    return Array.from(event.dataTransfer.types).includes('Files');
  }
  function onDragEnter(event: DragEvent) {
    if (!canCreate || !hasFiles(event)) return;
    event.preventDefault();
    setDragDepth((depth) => depth + 1);
  }
  function onDragOver(event: DragEvent) {
    if (!canCreate || !hasFiles(event)) return;
    event.preventDefault();
  }
  function onDragLeave(event: DragEvent) {
    if (!canCreate || !hasFiles(event)) return;
    setDragDepth((depth) => Math.max(0, depth - 1));
  }
  function onDrop(event: DragEvent) {
    if (!canCreate || !hasFiles(event)) return;
    event.preventDefault();
    setDragDepth(0);
    uploadFiles(Array.from(event.dataTransfer.files));
  }

  const populated = !failed && !loading && attachments.length > 0;
  const empty = !failed && !loading && totalCount === 0 && attachments.length === 0;
  const remaining = Math.max(0, totalCount - attachments.length);

  const attachButton = canCreate ? (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ALLOWED_UPLOAD_TYPES.join(',')}
        className="hidden"
        onChange={(event) => {
          uploadFiles(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
      <Button
        size="sm"
        variant="secondary"
        leftIcon={<Paperclip className="h-3.5 w-3.5" aria-hidden />}
        onClick={() => fileInputRef.current?.click()}
      >
        {t('attach')}
      </Button>
    </>
  ) : null;

  const viewToggle = populated ? (
    <Segmented
      label={t('viewAria')}
      value={view}
      onChange={setView}
      options={[
        {
          value: 'strip',
          label: t('viewStrip'),
          icon: <LayoutGrid className="h-3.5 w-3.5" aria-hidden />,
        },
        {
          value: 'list',
          label: t('viewList'),
          icon: <List className="h-3.5 w-3.5" aria-hidden />,
        },
      ]}
    />
  ) : null;

  return (
    <div
      className="relative"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <ContentSectionCard
        title={t('title')}
        subtitle={populated ? String(totalCount) : undefined}
        headerRight={
          failed || loading ? undefined : (
            <div className="flex items-center gap-2">
              {viewToggle}
              {attachButton}
            </div>
          )
        }
      >
        <div className="flex flex-col gap-3">
          {uploadErrors.length > 0 ? (
            <div role="alert" className="flex flex-col gap-2">
              {uploadErrors.map((error) => (
                <div
                  key={error.key}
                  className="bg-(--el-tint-rose) text-(--el-text-strong) flex items-start gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-xs leading-relaxed"
                >
                  <TriangleAlert
                    className="text-(--el-danger) mt-px h-3.5 w-3.5 shrink-0"
                    aria-hidden
                  />
                  <span className="min-w-0">
                    <span className="font-semibold">{error.filename}</span> — {error.message}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setUploadErrors((current) => current.filter((item) => item.key !== error.key))
                    }
                    aria-label={t('dismissErrorAria', { name: error.filename })}
                    className="text-(--el-text-secondary) hover:text-(--el-text) ml-auto shrink-0 rounded-(--radius-control) p-(--spacing-control-x-2) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          {uploads.length > 0 ? (
            <div className="flex flex-col gap-2">
              {uploads.map((upload) => (
                <div
                  key={upload.key}
                  className="border-(--el-border) bg-(--el-surface-soft) flex items-center gap-2.5 rounded-(--radius-control) border px-(--spacing-control-x) py-(--spacing-control-y)"
                >
                  <AttachmentGlyph mimeType={upload.mimeType} className="h-4 w-4 shrink-0" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-(--el-text) truncate font-sans text-xs font-medium">
                        {upload.filename}
                      </span>
                      <span className="text-(--el-text-secondary) ml-auto font-sans text-[11px] tabular-nums">
                        {upload.progress === null ? t('uploading') : `${upload.progress}%`}
                      </span>
                    </div>
                    <div
                      role="progressbar"
                      aria-label={t('uploadingAria', { name: upload.filename })}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={upload.progress ?? undefined}
                      aria-busy={upload.progress === null || undefined}
                      className="bg-(--el-muted) h-1 overflow-hidden rounded-(--radius-badge)"
                    >
                      <div
                        className={cn(
                          'bg-(--el-progress-fill) h-full rounded-(--radius-badge)',
                          upload.progress === null && 'w-1/3 animate-pulse',
                        )}
                        style={
                          upload.progress === null ? undefined : { width: `${upload.progress}%` }
                        }
                      />
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => cancelUpload(upload.key)}
                    aria-label={t('cancelUploadAria', { name: upload.filename })}
                    className={cn(iconButtonClass, 'shrink-0')}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          {failed ? (
            <ErrorState
              title={t('errorTitle')}
              description={t('errorDescription')}
              retry={retryInitial}
            />
          ) : loading ? (
            <AttachmentsSkeleton />
          ) : empty ? (
            <div className="flex flex-col items-center gap-1.5 py-6 text-center">
              <Paperclip className="text-(--el-text-faint) h-[22px] w-[22px]" aria-hidden />
              <p className="text-(--el-text-secondary) font-sans text-sm">
                {canCreate ? t('empty') : t('emptyReadOnly')}
              </p>
            </div>
          ) : view === 'strip' ? (
            <ul
              aria-label={t('listAria')}
              className="grid list-none grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-3"
            >
              {attachments.map((attachment) => (
                <AttachmentCard
                  key={attachment.id}
                  attachment={attachment}
                  canDeleteAll={canDeleteAll}
                  currentUserId={currentUserId}
                  onOpen={() => openAttachment(attachment)}
                  onDeleted={() => handleDeleted(attachment)}
                />
              ))}
            </ul>
          ) : (
            <ul aria-label={t('listAria')} className="flex list-none flex-col">
              {attachments.map((attachment) => (
                <AttachmentRow
                  key={attachment.id}
                  attachment={attachment}
                  canDeleteAll={canDeleteAll}
                  currentUserId={currentUserId}
                  onOpen={() => openAttachment(attachment)}
                  onDeleted={() => handleDeleted(attachment)}
                />
              ))}
            </ul>
          )}

          {populated && loadingMore ? <AttachmentsSkeleton /> : null}
          {populated && nextCursor ? (
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="border-(--el-border-strong) bg-(--el-surface-soft) text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-text) h-(--height-control) w-full rounded-(--radius-control) border border-dashed px-(--spacing-control-x) font-sans text-xs font-medium focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('showMore', { count: remaining })}
            </button>
          ) : null}
        </div>
      </ContentSectionCard>

      <AttachmentPreview attachment={preview} onClose={() => setPreview(null)} />

      {/* Drag-over — the whole panel is the dropzone (decorative; the drop
          handlers live on the wrapper, so this never intercepts events). */}
      {dragDepth > 0 ? (
        <div
          aria-hidden
          className="border-(--el-accent) bg-(--el-tint-lavender) pointer-events-none absolute inset-1.5 z-10 flex flex-col items-center justify-center gap-2 rounded-(--radius-card) border-2 border-dashed"
        >
          <Upload className="text-(--el-accent-on-surface) h-6 w-6" />
          <span className="text-(--el-text-strong) font-sans text-[13px] font-semibold">
            {t('dropTitle')}
          </span>
          <span className="text-(--el-text-secondary) font-sans text-xs">{t('dropSub')}</span>
        </div>
      ) : null}
    </div>
  );
}

// ── Strip card ─────────────────────────────────────────────────────────────

function AttachmentCard({
  attachment,
  canDeleteAll,
  currentUserId,
  onOpen,
  onDeleted,
}: {
  attachment: AttachmentDTO;
  canDeleteAll: boolean;
  currentUserId: string;
  /** Card activation — previewable types open the lightbox, others download. */
  onOpen: () => void;
  onDeleted: () => void;
}) {
  const t = useTranslations('attachments');
  const format = useFormatter();
  const relativeTime = useRelativeTime();
  const createdAt = new Date(attachment.createdAt);

  return (
    <li className="group border-(--el-border) bg-(--el-page-bg) hover:border-(--el-border-strong) hover:shadow-(--shadow-card) relative overflow-hidden rounded-(--radius-control) border">
      <button
        type="button"
        onClick={onOpen}
        aria-label={t(isPreviewable(attachment) ? 'previewAria' : 'downloadAria', {
          name: attachment.filename,
        })}
        className="block w-full cursor-pointer text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--focus-ring-color)"
      >
        {attachment.isImage ? (
          <div
            aria-hidden
            className="border-(--el-border-soft) h-[88px] border-b bg-cover bg-center"
            style={{ backgroundImage: `url(${JSON.stringify(attachment.blobUrl)})` }}
          />
        ) : (
          <div className="border-(--el-border-soft) bg-(--el-surface-soft) flex h-[88px] items-center justify-center border-b">
            <AttachmentGlyph mimeType={attachment.mimeType} className="h-7 w-7" />
          </div>
        )}
        <div className="flex min-w-0 flex-col gap-0.5 px-2.5 py-2">
          <span
            className="text-(--el-text) truncate font-sans text-xs font-medium"
            title={attachment.filename}
          >
            {attachment.filename}
          </span>
          <span
            className="text-(--el-text-muted) truncate font-sans text-[11px]"
            title={format.dateTime(createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
          >
            {relativeTime(createdAt)} · {formatBytes(attachment.sizeBytes)}
          </span>
        </div>
      </button>
      {attachment.source === 'editor' ? <SourceChip className="absolute top-1.5 left-1.5" /> : null}
      <div className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <DownloadButton attachment={attachment} />
        <DeleteControl
          attachment={attachment}
          canDeleteAll={canDeleteAll}
          currentUserId={currentUserId}
          onDeleted={onDeleted}
        />
      </div>
    </li>
  );
}

// ── List row ───────────────────────────────────────────────────────────────

function AttachmentRow({
  attachment,
  canDeleteAll,
  currentUserId,
  onOpen,
  onDeleted,
}: {
  attachment: AttachmentDTO;
  canDeleteAll: boolean;
  currentUserId: string;
  /** Row activation — previewable types open the lightbox, others download. */
  onOpen: () => void;
  onDeleted: () => void;
}) {
  const t = useTranslations('attachments');
  const format = useFormatter();
  const relativeTime = useRelativeTime();
  const createdAt = new Date(attachment.createdAt);

  return (
    <li className="group hover:bg-(--el-surface) border-(--el-border-soft) flex min-h-(--height-control) items-center gap-2.5 rounded-(--radius-control) border-t px-(--spacing-control-x) py-(--spacing-control-y) first:border-t-0">
      <button
        type="button"
        onClick={onOpen}
        aria-label={t(isPreviewable(attachment) ? 'previewAria' : 'downloadAria', {
          name: attachment.filename,
        })}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-(--radius-control) text-left focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        <AttachmentGlyph mimeType={attachment.mimeType} className="h-4 w-4 shrink-0" />
        <span
          className="text-(--el-text) truncate font-sans text-[13px] font-medium"
          title={attachment.filename}
        >
          {attachment.filename}
        </span>
      </button>
      {attachment.source === 'editor' ? <SourceChip className="shrink-0" /> : null}
      <span className="text-(--el-text-secondary) w-[58px] shrink-0 text-right font-sans text-xs tabular-nums">
        {formatBytes(attachment.sizeBytes)}
      </span>
      <span
        className="text-(--el-text-secondary) w-[76px] shrink-0 truncate font-sans text-xs"
        title={format.dateTime(createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
      >
        {relativeTime(createdAt)}
      </span>
      <span
        className="text-(--el-text-secondary) w-[92px] shrink-0 truncate font-sans text-xs"
        title={attachment.uploader.name}
      >
        {attachment.uploader.name}
      </span>
      <span className="flex shrink-0 gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <DownloadButton attachment={attachment} />
        <DeleteControl
          attachment={attachment}
          canDeleteAll={canDeleteAll}
          currentUserId={currentUserId}
          onDeleted={onDeleted}
        />
      </span>
    </li>
  );
}

// ── Shared bits ────────────────────────────────────────────────────────────

function SourceChip({ className }: { className?: string }) {
  const t = useTranslations('attachments');
  return (
    <span
      title={t('sourceTooltip')}
      className={cn(
        'bg-(--el-tint-lavender) text-(--el-text-strong) inline-flex items-center gap-1 rounded-(--radius-badge) px-(--spacing-kbd-x) py-(--spacing-kbd-y) font-sans text-[10px] leading-tight font-semibold whitespace-nowrap',
        className,
      )}
    >
      <Pen className="h-2.5 w-2.5" aria-hidden />
      {t('sourceChip')}
    </span>
  );
}

function DownloadButton({ attachment }: { attachment: AttachmentDTO }) {
  const t = useTranslations('attachments');
  return (
    <button
      type="button"
      onClick={() => triggerDownload(attachment)}
      aria-label={t('downloadAria', { name: attachment.filename })}
      className={iconButtonClass}
    >
      <Download className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}

/**
 * The per-row delete affordance, per the mockup's panel-1 grammar:
 *   * caller can't delete (not the uploader, not an admin) → OMITTED
 *     (absent, never disabled — the 5.1 role grammar);
 *   * editor-sourced → DISABLED with the points-at-source tooltip (the Jira
 *     block; the 5.2.2 service 409s regardless — the affordance isn't the gate);
 *   * otherwise → the RemoveLinkButton confirm-Popover pattern, naming the
 *     file and stating the hard-delete truth.
 */
function DeleteControl({
  attachment,
  canDeleteAll,
  currentUserId,
  onDeleted,
}: {
  attachment: AttachmentDTO;
  canDeleteAll: boolean;
  currentUserId: string;
  onDeleted: () => void;
}) {
  const t = useTranslations('attachments');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const canDelete = canDeleteAll || attachment.uploader.id === currentUserId;
  if (!canDelete) return null;

  if (attachment.source === 'editor') {
    return (
      <Tooltip content={t('sourceTooltip')}>
        <button
          type="button"
          aria-disabled="true"
          aria-label={t('deleteDisabledAria', { name: attachment.filename })}
          className={cn(dangerIconButtonClass, 'cursor-not-allowed opacity-45')}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden />
        </button>
      </Tooltip>
    );
  }

  function confirm() {
    setError(null);
    startTransition(async () => {
      let failure = t('errors.generic');
      try {
        const res = await fetch(`/api/attachments/${attachment.id}`, { method: 'DELETE' });
        if (res.status === 204) {
          setOpen(false);
          onDeleted();
          return;
        }
        let code: string | undefined;
        try {
          code = ((await res.json()) as { code?: string }).code;
        } catch {
          // non-JSON error body — keep the generic message
        }
        if (code === 'ATTACHMENT_NOT_FOUND') failure = t('errors.notFound');
        else if (code === 'ATTACHMENT_FORBIDDEN') failure = t('errors.forbidden');
        else if (code === 'ATTACHMENT_EDITOR_SOURCED') failure = t('errors.editorSourced');
      } catch {
        // network failure — keep the generic message
      }
      setError(failure);
    });
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <Popover.Trigger
        className={dangerIconButtonClass}
        aria-label={t('deleteAria', { name: attachment.filename })}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
      </Popover.Trigger>
      <Popover.Content width={300} align="end">
        <div className="flex flex-col gap-3 p-3.5">
          <p className="text-(--el-text) font-sans text-sm leading-snug">
            {t('deleteConfirm', { name: attachment.filename })}
          </p>
          {error ? (
            <p className="text-(--el-text-strong) bg-(--el-tint-rose) rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-xs">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={isPending}>
              {tc('cancel')}
            </Button>
            <Button size="sm" variant="danger" onClick={confirm} loading={isPending}>
              {t('delete')}
            </Button>
          </div>
        </div>
      </Popover.Content>
    </Popover>
  );
}

/** Tile-shaped pulse skeletons (panel 4 — the BacklogSkeleton grammar). */
function AttachmentsSkeleton() {
  return (
    <div
      aria-busy
      className="grid animate-pulse grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-3"
    >
      {Array.from({ length: 3 }, (_, index) => (
        <div
          key={index}
          className="border-(--el-border-soft) overflow-hidden rounded-(--radius-control) border"
        >
          <div className="bg-(--el-muted) h-[88px]" />
          <div className="flex flex-col gap-1.5 px-2.5 py-2">
            <span className="bg-(--el-muted) h-2.5 w-4/5 rounded-(--radius-control)" />
            <span className="bg-(--el-muted) h-2.5 w-1/2 rounded-(--radius-control)" />
          </div>
        </div>
      ))}
    </div>
  );
}
