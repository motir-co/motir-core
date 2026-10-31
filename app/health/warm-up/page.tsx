import type { Metadata } from 'next';
import { pagesService } from '@/lib/services/pagesService';
import { PagesEditorWarmUp } from './PagesEditorWarmUp';

// GET /health/warm-up (Bug MOTIR-10142) — the page RUNTIME's half of the warm-up
// `/api/health/ready` runs before a fresh process is sent traffic.
//
// Next evaluates a route handler, a page's server components and its
// server-rendered client components in three separate module registries, and it
// evaluates a module the first time a request reaches it. The readiness check is
// a route handler, so its own imports warm only the route-handler registry
// (MOTIR-8231). The page at `/pages/<id>` was still cold: a rehearsal web task
// five minutes into serving froze its loop for 2231 ms on the first request that
// opened a page, the minute Yjs logged it had been imported again — once in this
// page's server components, once more in the editor it server-renders.
//
// So the readiness warm-up requests THIS page over loopback, and the two imports
// below are the whole of its job. Rendering it evaluates, in the page runtime:
//   • the server components' graph a page read reaches — `pagesService`, and
//     `@motir/pages`' document code under it (Yjs, y-prosemirror, the Tiptap
//     schema, the Markdown parser);
//   • the client graph the page's editor server-renders — `PageEditorHost`, the
//     Tiptap editor and their own Yjs — through `PagesEditorWarmUp`.
// A module is evaluated once per registry, so `/pages/<id>` reuses both.
//
// ⚠️ PUBLIC AND INERT ON PURPOSE. It sits outside `(authed)` and the proxy's
// matcher, so the loopback request needs no session, and it renders nothing and
// reads no data — there is nothing on it to protect. Once a process has rendered
// it, rendering it again costs a render of an empty page.
//
// ⚠️ `force-dynamic` IS LOAD-BEARING. A prerendered page would be served from the
// build's output and evaluate nothing in the running process.

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function PagesWarmUpPage() {
  // A reference, not a call: evaluating the service's module graph is the point,
  // and it reads nothing.
  void pagesService;
  return <PagesEditorWarmUp />;
}
