'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { readProjectSettingsLink } from '@/lib/settings/projectSettingsLink';
import { openProjectLinkAction } from '../../../_project-actions';

// A PROJECT-SETTINGS LINK THAT NAMES ITS PROJECT (Bug MOTIR-12169).
//
// Every `/settings/project/*` room acts on the reader's ACTIVE project. A link
// that is about a project — a notification row whose subject is a project —
// carries its key as `?project=<KEY>`, and this gate, which the area layout
// wraps around every room, opens the room on that project.
//
// It is a CLIENT gate reading the URL's own search parameters, not a check in
// the server layout, because the App Router does not re-render a shared layout
// on a client navigation: a notification clicked while the reader is already
// in a settings room re-renders only the room, so a layout check would never
// see its `?project=`. The gate's `useSearchParams` sees every navigation.
//
// While a key is in the URL the room is NOT shown — what the server rendered
// for it is the active project's, which is exactly the wrong page. The gate
// calls `openProjectLinkAction`, a POST (so a prefetch never switches) that
// resolves the key browse-gated and alias-aware and, for another project the
// reader may enter, makes the switcher's switch and revalidates the whole
// layout tree. Then it replaces the URL with the same room minus `?project=`,
// so the shell and the room re-render against the opened project. A key the
// reader cannot enter — or a failed call — renders `refused`, the area's
// no-access state, and never falls back to the old project's room.

export function ProjectLinkGate({
  children,
  refused,
}: {
  children: ReactNode;
  refused: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const query = params.toString();
  const link = readProjectSettingsLink(query ? `${pathname}?${query}` : pathname);
  const key = link?.projectKey ?? null;
  const href = link?.href ?? null;

  const [refusedKey, setRefusedKey] = useState<string | null>(null);
  // The link being opened: React runs a mount effect twice in development, and
  // one link is one open.
  const opening = useRef<string | null>(null);

  useEffect(() => {
    if (key === null || href === null) {
      opening.current = null;
      return;
    }
    if (opening.current === key) return;
    opening.current = key;
    openProjectLinkAction(key).then(
      (outcome) => {
        if (outcome === 'refused') setRefusedKey(key);
        else router.replace(href);
      },
      () => setRefusedKey(key),
    );
  }, [key, href, router]);

  if (key === null) return children;
  if (refusedKey === key) return refused;
  return <div aria-busy="true" data-testid="project-link-switch" />;
}
