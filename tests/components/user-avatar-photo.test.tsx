// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { UserAvatarFace, avatarInitial } from '@/app/(authed)/_components/UserAvatarFace';
import { UserMenu } from '@/app/(authed)/_components/UserMenu';
import { AccountSidebarHeader } from '@/app/(authed)/_components/AccountSidebarHeader';

// MOTIR-10182 — the uploaded profile photo is drawn wherever the shell draws
// the signed-in user: the top bar's account-menu trigger (authed AND visitor
// bars — both render `UserMenu`) and the account-settings rail's identity tile,
// expanded and collapsed. With no photo, each surface keeps drawing the initial
// exactly as before. The upload itself always worked; what was missing is that
// no shell surface was ever handed `user.image`.
//
// The last block reads the two server call sites, because a render of the
// components alone cannot prove the layouts pass the RESOLVED URL rather than
// the stored object key (or nothing at all, which is the defect).

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/auth/client', () => ({ signOut: vi.fn(async () => undefined) }));

afterEach(cleanup);

const PHOTO = 'https://assets.example.com/avatars/u1/photo.png';
const OTHER_PHOTO = 'https://assets.example.com/avatars/u1/photo-2.png';

function trigger() {
  return screen.getByRole('button', { name: /account menu/i });
}

describe('UserAvatarFace', () => {
  it('draws the photo, decorative and cropped to its box, when there is one', () => {
    const { container } = render(<UserAvatarFace image={PHOTO} name="Ada" />);
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe(PHOTO);
    expect(img?.getAttribute('alt')).toBe('');
    expect(img?.className).toContain('object-cover');
    expect(img?.className).toContain('rounded-full');
    expect(container.textContent).toBe('');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
  ])('draws the initial when the image is %s', (_label, image) => {
    const { container } = render(<UserAvatarFace image={image} name="ada" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('A');
  });

  it('falls back to the initial when the photo fails to load, and retries a NEW photo', () => {
    const { container, rerender } = render(<UserAvatarFace image={PHOTO} name="Ada" />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('A');

    // A re-upload is a new URL: it is tried, not suppressed by the old failure.
    rerender(<UserAvatarFace image={OTHER_PHOTO} name="Ada" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(OTHER_PHOTO);
  });

  it('avatarInitial upper-cases the first letter, and is "?" for a blank name', () => {
    expect(avatarInitial('  yue ')).toBe('Y');
    expect(avatarInitial('   ')).toBe('?');
  });
});

describe('the top-bar account menu trigger', () => {
  it('shows the photo inside the circle when the user has one', () => {
    renderWithIntl(<UserMenu name="Ada" email="ada@example.com" image={PHOTO} />);
    const button = trigger();
    expect(button.querySelector('img')?.getAttribute('src')).toBe(PHOTO);
    expect(button.textContent).toBe('');
    // The circle crops the photo, and the box stays the `--height-control`
    // square of the bar's below-`md` slot.
    expect(button.className).toContain('overflow-hidden');
    expect(button.className).toContain('rounded-full');
    expect(button.className).toContain('h-(--height-control)');
    expect(button.className).toContain('w-(--height-control)');
  });

  it('shows the initial exactly as before when the user has no photo', () => {
    renderWithIntl(<UserMenu name="Ada" email="ada@example.com" image={null} />);
    expect(trigger().querySelector('img')).toBeNull();
    expect(trigger().textContent).toBe('A');
  });

  it('falls back to the email’s initial when there is no name and no photo', () => {
    renderWithIntl(<UserMenu name="" email="riya@example.com" />);
    expect(trigger().textContent).toBe('R');
  });
});

describe('the account-settings rail identity tile', () => {
  it.each([
    ['expanded', false],
    ['collapsed', true],
  ])('%s — shows the photo when the user has one', (_label, collapsed) => {
    renderWithIntl(
      <AccountSidebarHeader
        user={{ name: 'Yue', email: 'yue@example.com', image: PHOTO }}
        collapsed={collapsed}
      />,
    );
    const tile = screen.getByTestId('account-rail-avatar');
    expect(tile.querySelector('img')?.getAttribute('src')).toBe(PHOTO);
    expect(tile.className).toContain('overflow-hidden');
    expect(tile.textContent).toBe('');
  });

  it.each([
    ['expanded', false],
    ['collapsed', true],
  ])('%s — shows the initial when the user has no photo', (_label, collapsed) => {
    renderWithIntl(
      <AccountSidebarHeader
        user={{ name: 'Yue', email: 'yue@example.com' }}
        collapsed={collapsed}
      />,
    );
    const tile = screen.getByTestId('account-rail-avatar');
    expect(tile.querySelector('img')).toBeNull();
    expect(tile.textContent).toBe('Y');
  });
});

describe('the server call sites pass the RESOLVED photo URL', () => {
  const read = (path: string) => readFileSync(resolve(import.meta.dirname, '../..', path), 'utf8');

  it('the authed layout resolves `session.user.image` once and hands it to every shell user', () => {
    const layout = read('app/(authed)/layout.tsx');
    expect(layout).toContain('image: storedAssetUrl(session.user.image)');
    // The bar and both rails (rail + drawer) all take the same resolved user;
    // none rebuilds a `{ name, email }` that drops the photo.
    const topNav = /<TopNav\b[\s\S]*?\/>/.exec(layout)?.[0] ?? '';
    expect(topNav).toContain('user={shellUser}');
    const rails = layout.match(/<SidebarNav\b[\s\S]*?\/>/g) ?? [];
    expect(rails).toHaveLength(2);
    for (const rail of rails) expect(rail).toContain('user={shellUser}');
    expect(layout).not.toContain('user={{ name: session.user.name');
  });

  it('the visitor gate resolves the photo and the visitor layout hands it to the bar', () => {
    expect(read('lib/visitor/pageGate.ts')).toContain(
      'actorImage: storedAssetUrl(session.user.image)',
    );
    expect(read('app/(visitor)/p/[identifier]/layout.tsx')).toContain(
      'user={{ name: actorName, email: actorEmail, image: actorImage }}',
    );
  });
});
