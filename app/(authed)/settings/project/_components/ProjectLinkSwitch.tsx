'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { setActiveProjectAction } from '../../../_project-actions';

// THE SWITCH A PROJECT-SETTINGS LINK ASKS FOR (Bug MOTIR-12169).
//
// The area layout renders this in place of the room when the link names a
// project the reader can enter but that is not their active one. It makes the
// project switcher's own switch — `setActiveProjectAction`, a POST, which
// re-checks that the reader may enter the project and revalidates the whole
// layout tree — and then replaces the URL with the same room minus `?project=`,
// so the app shell and the room both render against the switched project.
//
// It is a client step, not a server-side write during the GET that rendered the
// layout, for two reasons. A render that wrote state would write on every Next
// PREFETCH of the link, and a prefetch is not a reader asking to switch. And a
// layout cannot revalidate the shell above it: a soft navigation re-renders only
// the segments below the one that changed, so the rail and the project switcher
// would keep showing the old project. The action's `revalidatePath('/', 'layout')`
// is what reaches them — the same two-liner the switcher runs.
//
// While the switch runs the room shows nothing: nothing it could render belongs
// to the project being opened yet. A refused switch (the reader lost access
// between the layout's check and this call) renders `refused` — the area's
// no-access state — and never falls back to the old project's room.

export function ProjectLinkSwitch({
  projectId,
  href,
  refused,
}: {
  projectId: string;
  href: string;
  refused: ReactNode;
}) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  // React runs a mount effect twice in development; the switch is one write.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    setActiveProjectAction(projectId).then(
      () => router.replace(href),
      () => setFailed(true),
    );
  }, [projectId, href, router]);

  if (failed) return refused;
  return <div aria-busy="true" data-testid="project-link-switch" />;
}
