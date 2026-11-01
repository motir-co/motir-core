'use client';

import PageEditorHost from '@/components/pages/PageEditorHost';

// The client half of `/health/warm-up` (Bug MOTIR-10142). The page loads its
// editor with `lazy()`, so the server evaluates `PageEditorHost` — and the
// Tiptap and Yjs graph under it — only on the first request that renders a page.
// A STATIC import here makes the warm-up's server render evaluate that graph
// instead, in the same registry `/pages/<id>`'s server render later reads.
// It renders nothing.
export function PagesEditorWarmUp() {
  void PageEditorHost;
  return null;
}
