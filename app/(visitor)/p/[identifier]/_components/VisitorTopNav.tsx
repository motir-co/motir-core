import { getTranslations } from 'next-intl/server';
import { BrandMark } from '@/components/brand/BrandMark';
import { SidebarToggle } from '@/components/ui/SidebarToggle';
import { UserMenu } from '@/app/(authed)/_components/UserMenu';
import { ThemeToggle } from '@/app/(authed)/_components/ThemeToggle';

// THE VISITOR's top bar (Story MOTIR-6170 · MOTIR-6648; design MOTIR-6641 panel
// 3): the member bar with everything a Visitor cannot use REMOVED — not disabled.
// Gone: the org control, the workspace and project switchers, Plan with AI, the
// build-in-public slot, Create, ⌘K, Report and the notification bell. Kept: the
// brand mark (to the project's motir.co landing, a prop rather than an edit to
// `TopNav`), the project's name and key as plain read-only text, the theme
// toggle, and the reader's own account menu — every Visitor is signed in, and it
// is how they get back to their own workspace or sign out.

export async function VisitorTopNav({
  projectName,
  projectKey,
  landingHref,
  user,
}: {
  projectName: string;
  projectKey: string;
  /** The project's motir.co landing, `https://motir.co/p/<identifier>`. */
  landingHref: string;
  /** `image` is the RESOLVED profile-photo URL (`storedAssetUrl`), never the key. */
  user: { name: string | null; email: string; image?: string | null };
}) {
  const [t, tv] = await Promise.all([getTranslations('shell'), getTranslations('visitor.shell')]);
  return (
    <header
      data-surface="header"
      className="sticky top-0 z-30 border-b border-(--el-border) bg-(--el-page-bg)"
    >
      <nav
        aria-label={t('topNav.global')}
        className="flex h-14 items-center justify-between gap-2 px-4 sm:px-6"
      >
        <div className="flex min-w-0 items-center gap-2">
          <a
            href={landingHref}
            aria-label={tv('brandLabel', { project: projectName })}
            className="hidden h-(--height-control-32) w-8 flex-none items-center justify-center rounded-(--radius-control) border border-(--el-border) bg-(--el-surface) md:flex"
          >
            <BrandMark variant="mark" size={24} />
          </a>
          <div className="md:hidden">
            <SidebarToggle variant="hamburger" />
          </div>
          <span className="min-w-0 truncate font-serif text-base font-semibold text-(--el-text)">
            {projectName}
          </span>
          <span
            aria-label={tv('projectKey', { key: projectKey })}
            className="flex-none rounded-(--radius-badge) border border-(--el-chip-border) bg-(--el-chip-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) font-mono text-xs text-(--el-text-secondary)"
          >
            {projectKey}
          </span>
        </div>
        <div className="flex flex-none items-center gap-2">
          <ThemeToggle placement="bar" />
          <UserMenu name={user.name ?? ''} email={user.email} image={user.image} />
        </div>
      </nav>
    </header>
  );
}
