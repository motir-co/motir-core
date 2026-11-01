'use client';

import { useState } from 'react';

// What the signed-in user's circle DRAWS (MOTIR-10182): their uploaded profile
// photo, or the initial of their name when there is none. It renders only the
// CONTENTS — the circle itself (box size, `rounded-full`, the `--el-text` ink
// fill) stays with each surface that owns it: the top bar's `UserMenu` trigger,
// which is the `--height-control` square slot 4 of the bar's below-`md` budget,
// and the account rail's identity tile. Each of those boxes carries
// `overflow-hidden`, so the photo is cropped to the circle rather than drawn
// behind it.
//
// `image` is the RESOLVED absolute URL (`storedAssetUrl(user.image)`), never
// the stored object key — the same contract as every other user-image DTO
// (`lib/mappers/commentMappers.ts`). A photo that fails to load (a deleted
// object, an expired third-party avatar) falls back to the initial instead of
// leaving the browser's broken-image glyph inside the circle. The failure is
// remembered PER URL, so a new upload is tried again without a remount.
//
// Accessibility: DECORATIVE (`alt=""`). Both owners already name the user —
// the trigger by its `aria-label`, the rail tile by the name printed beside it
// — so an accessible name here would announce them twice.

export interface UserAvatarFaceProps {
  /** The resolved absolute URL of the profile photo, or null/undefined for none. */
  image?: string | null;
  /** The user's display name (or email) — its first letter is the fallback. */
  name: string;
}

/** The first letter of `name`, upper-cased; `?` when there is none. */
export function avatarInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?';
}

export function UserAvatarFace({ image, name }: UserAvatarFaceProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (image && image !== failedSrc) {
    return (
      // A user-uploaded asset on an external host with no known dimensions —
      // next/image adds nothing (the same call every avatar site makes).
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={image}
        alt=""
        className="h-full w-full rounded-full object-cover"
        onError={() => setFailedSrc(image)}
      />
    );
  }

  return <>{avatarInitial(name)}</>;
}
