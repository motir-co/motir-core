'use client';

import { useRef, useState, useTransition, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Camera, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/utils/cn';
import { updateProfileAvatarAction } from '../profile/actions';

// The Photo row on the Account › Profile pane's Profile card (Story 8.8 ·
// Subtask 8.8.24a) — composed ABOVE the Name row inside `ProfileCard`, per
// `design/settings/profile.mock.html` (the `.srow.tall` Photo row). Renders the
// current avatar (uploaded image OR initials fallback) + a "Change" control
// (upload) and, when an image is set, a "Remove" control (revert to initials,
// behind a confirm modal).
//
// Backend wiring (8.8.21): "Change" POSTs the file to `/api/upload/avatar`
// (multipart, returns `{ key }` — the object KEY, since MOTIR-2404), then calls
// `updateProfileAvatarAction(key)` to persist it as the profile `image`;
// "Remove" calls the same action with `null`. We never render the key: the
// action returns the RESOLVED absolute URL, which is what `setImage` stores.
// The upload route gates size + MIME server-side; we ALSO pre-validate on the
// client to the design's stated rule (PNG/JPG, ≤ 2 MB) so a bad pick fails fast
// with a friendly toast instead of a round-trip.
//
// Page-state contract (CLAUDE.md): the avatar is a client island holding its own
// optimistic `image`, so on success we KEEP the new value here (no revert) AND
// call `router.refresh()` — the OTHER surfaces are the shell's top-bar account
// menu and the account rail's identity tile, both fed from the authed layout's
// re-read of `session.user.image` (MOTIR-10182). `router.refresh()` cannot reach
// this island's `useState`, so the optimistic value is safe.

// The design copy narrows the shared upload allowlist to PNG/JPG ≤ 2 MB for the
// avatar specifically (`profile.mock.html`: "PNG or JPG, up to 2 MB").
const ACCEPTED_TYPES = ['image/png', 'image/jpeg'];
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export interface AvatarFieldProps {
  initialImage: string | null;
  /** The user's display name — drives the initials fallback when no image. */
  name: string;
}

export function AvatarField({ initialImage, name }: AvatarFieldProps) {
  const t = useTranslations('settings.profile.photo');
  const router = useRouter();
  const { toast } = useToast();

  const [image, setImage] = useState<string | null>(initialImage);
  const [isUploading, setIsUploading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isRemoving, startRemove] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const busy = isUploading || isRemoving;
  const initial = name.trim().charAt(0).toUpperCase() || '?';

  function pickFile() {
    fileInputRef.current?.click();
  }

  async function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset the input so picking the SAME file again still fires onChange.
    event.target.value = '';
    if (!file) return;

    if (!ACCEPTED_TYPES.includes(file.type)) {
      toast({ variant: 'error', title: t('errors.invalidType') });
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      toast({ variant: 'error', title: t('errors.tooLarge') });
      return;
    }

    setIsUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/upload/avatar', { method: 'POST', body: form });
      if (!res.ok) {
        toast({ variant: 'error', title: t('errors.failed') });
        return;
      }
      const { key } = (await res.json()) as { key: string };

      const result = await updateProfileAvatarAction(key);
      if (!result.ok) {
        toast({ variant: 'error', title: t('errors.failed') });
        return;
      }

      setImage(result.image);
      toast({ variant: 'success', title: t('uploaded') });
      // Update the shell's avatar (top bar + rail head, read from user.image); the
      // island keeps its own optimistic `image` (router.refresh can't reach it).
      router.refresh();
    } catch {
      toast({ variant: 'error', title: t('errors.failed') });
    } finally {
      setIsUploading(false);
    }
  }

  function confirmRemove() {
    startRemove(async () => {
      const result = await updateProfileAvatarAction(null);
      if (!result.ok) {
        toast({ variant: 'error', title: t('errors.failed') });
        return;
      }
      setImage(null);
      setConfirmOpen(false);
      toast({ variant: 'success', title: t('removed') });
      router.refresh();
    });
  }

  return (
    <div className="flex items-center justify-between gap-4 pb-4">
      <div className="min-w-0">
        <div className="font-sans text-sm font-medium text-(--el-text)">{t('label')}</div>
        <div className="mt-0.5 max-w-[46ch] font-sans text-xs leading-snug text-(--el-text-muted)">
          {t('desc')}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {/* Circular avatar — uploaded image OR initials. `rounded-full` is a
            genuine circle (the sanctioned shape-token exception). */}
        <span
          className={cn(
            'inline-flex h-[52px] w-[52px] shrink-0 items-center justify-center overflow-hidden rounded-full',
            'bg-(--el-text) font-sans text-[19px] font-semibold text-(--el-text-inverted)',
          )}
        >
          {image ? (
            // A user-uploaded Blob URL, not a build-time asset; next/image adds
            // no value here (no known dimensions, external host).
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt={t('alt')} className="h-full w-full object-cover" />
          ) : (
            <span aria-hidden>{initial}</span>
          )}
        </span>

        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_TYPES.join(',')}
          className="hidden"
          onChange={onFileChange}
        />
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Camera className="h-3.5 w-3.5" aria-hidden />}
          onClick={pickFile}
          loading={isUploading}
          disabled={busy}
        >
          {t('change')}
        </Button>
        {image ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-(--el-danger) hover:bg-(--el-tint-rose)"
            leftIcon={<Trash2 className="h-3.5 w-3.5" aria-hidden />}
            onClick={() => setConfirmOpen(true)}
            disabled={busy}
          >
            {t('remove')}
          </Button>
        ) : null}
      </div>

      <Modal
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!isRemoving) setConfirmOpen(open);
        }}
        title={t('removeConfirm.title')}
        description={t('removeConfirm.body')}
        size="sm"
        role="alertdialog"
      >
        <Modal.Footer>
          <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={isRemoving}>
            {t('removeConfirm.cancel')}
          </Button>
          <Button variant="danger" onClick={confirmRemove} loading={isRemoving}>
            {t('removeConfirm.confirm')}
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
}
