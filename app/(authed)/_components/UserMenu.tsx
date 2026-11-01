'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { LogOut, Shield, UserCog } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import { Popover } from '@/components/ui/Popover';
import { cn } from '@/lib/utils/cn';
import { signOut } from '@/lib/auth/client';
import { UserAvatarFace } from './UserAvatarFace';

export interface UserMenuProps {
  name: string;
  email: string;
  /**
   * The RESOLVED absolute URL of the user's profile photo
   * (`storedAssetUrl(user.image)`), or null/absent when they have none — the
   * trigger then draws their initial, exactly as before MOTIR-10182.
   */
  image?: string | null;
  /**
   * The acting user is platform staff — renders the staff-only "Platform admin"
   * row, the single door into the operator console (design
   * `platform-admin/console.mock.html` Panel 1).
   *
   * ⚠️ ABSENT for non-staff, not disabled and not CSS-hidden: the row is not
   * RENDERED, so no markup anywhere names `/admin`. That is half of the
   * 404-not-403 posture (`docs/decisions/platform-staff-auth.md` §2 / §4) — the
   * other half is the route itself answering 404 — and a hidden-but-present row
   * would defeat it in the one place a curious tenant would look first.
   *
   * Resolved SERVER-side in the authed layout from the `platformRole` column;
   * this component receives a boolean and trusts nothing else. A client that
   * flipped it would see a menu row leading to a route that 404s them.
   */
  platformStaff?: boolean;
}

// ⚠️ `workspaceTierRevealed` USED TO BE A PROP HERE, and it is GONE (Story
// MOTIR-4843 · MOTIR-4847). It gated the `Workspace settings` row — the one
// entry point in this menu that NAMED the workspace tier — and that row has
// moved to the workspace SWITCHER, the control that already carries the tier's
// name. With it goes this menu's ONLY reader of the reveal, so the prop is
// removed rather than left threaded and unread: `platformStaff` is the only
// conditional left, and the menu no longer varies by workspace count at all.
//
// The design of record is `design/shell/account-menu.mock.html`, whose Panel B
// drew FOUR state frames and now draws TWO for exactly this reason.

export function UserMenu({ name, email, image = null, platformStaff = false }: UserMenuProps) {
  const t = useTranslations('shell');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleSignOut() {
    startTransition(async () => {
      await signOut();
      // Drop the in-memory router cache and bounce to sign-in; the proxy
      // would redirect anyway once the session cookie is gone.
      router.push('/sign-in');
      router.refresh();
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={t('userMenu.account')}
          // SLOT 4 of the bar's four-slot below-`md` budget (MOTIR-2373). The
          // box is `--height-control` square, not `h-9`: at 375px the avatar
          // used to measure 28px wide against a 36px height and render as an
          // ELLIPSE, because a shrinking flex row squeezed a fixed `w-9`.
          // `overflow-hidden` crops a profile photo to the circle (MOTIR-10182).
          className="bg-(--el-text) text-(--el-text-inverted) focus-visible:ring-(--focus-ring-color) inline-flex h-(--height-control) w-(--height-control) items-center justify-center overflow-hidden rounded-full font-sans text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <UserAvatarFace image={image} name={name || email} />
        </button>
      </Popover.Trigger>
      {/* 336px is DERIVED from the widest row, not chosen (MOTIR-4270). The
          `Platform admin` row is the only one carrying a hint line, and its
          pill is a flex sibling of the whole label+hint stack, so it reserves
          its width down the row's FULL height — the hint can never use it:

            hint `Operator console · the whole estate` @ 12px Inter 400   200px
            `Staff only` Pill                                             78px
            row chrome: px-1 (8) + px-2 (16) + glyph (16) + 2 gaps (16)    56px
                                                                         -----
                                                                         334px

          This shipped at `width={240}` from 1.2.6 (when every row was one
          line) through MOTIR-2896 (which added the hint row and did not
          re-derive it), so the hint wrapped to two lines — a 68px row where
          `design/shell/account-menu.mock.html` draws 52px.

          ⚠️ Measure in INTER before changing this. That asset's frames are
          319px because it renders without `--font-sans-source`, and the
          fallback face needs only 320px; Inter needs 336. A row added here,
          or a longer `platformAdminHint`, re-derives the number — happy-dom
          component tests have no layout engine and will not catch a wrap. */}
      <Popover.Content align="end" width={336} className="py-1">
        <div className="border-(--el-border) mb-1 border-b px-3 pb-2 pt-2">
          <p className="truncate font-sans text-sm font-medium text-(--el-text)">{name || email}</p>
          {name ? (
            <p className="text-(--el-text-muted) truncate font-sans text-xs">{email}</p>
          ) : null}
        </div>
        <div className="px-1">
          <a
            href="/settings/account"
            onClick={() => setOpen(false)}
            className="hover:bg-(--el-surface) focus-visible:bg-(--el-surface) flex w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x-8) py-(--spacing-control-y-8) text-left font-sans text-sm text-(--el-text) focus-visible:outline-none"
          >
            <UserCog className="text-(--el-text-muted) h-4 w-4" aria-hidden />
            {t('userMenu.accountSettings')}
          </a>
          {platformStaff ? (
            <>
              <div role="separator" className="my-1 border-t border-(--el-border)" />
              <a
                href="/admin"
                onClick={() => setOpen(false)}
                className="hover:bg-(--el-surface) focus-visible:bg-(--el-surface) flex w-full items-start gap-2 rounded-(--radius-control) px-(--spacing-control-x-8) py-(--spacing-control-y-8) text-left font-sans text-sm text-(--el-text) focus-visible:outline-none"
              >
                <Shield className="mt-0.5 h-4 w-4 shrink-0 text-(--el-info)" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block">{t('userMenu.platformAdmin')}</span>
                  <span className="block text-xs text-(--el-text-secondary)">
                    {t('userMenu.platformAdminHint')}
                  </span>
                </span>
                <Pill tone="neutral" className="mt-0.5 shrink-0">
                  {t('userMenu.staffOnly')}
                </Pill>
              </a>
              <div role="separator" className="my-1 border-t border-(--el-border)" />
            </>
          ) : null}
          <button
            type="button"
            onClick={handleSignOut}
            disabled={isPending}
            className={cn(
              'hover:bg-(--el-surface) focus-visible:bg-(--el-surface) flex w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x-8) py-(--spacing-control-y-8) text-left font-sans text-sm text-(--el-text) focus-visible:outline-none',
              'disabled:pointer-events-none disabled:opacity-50',
            )}
          >
            <LogOut className="text-(--el-text-muted) h-4 w-4" aria-hidden />
            {isPending ? t('userMenu.signingOut') : t('account.signOut')}
          </button>
        </div>
      </Popover.Content>
    </Popover>
  );
}
