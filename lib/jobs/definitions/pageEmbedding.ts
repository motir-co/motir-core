import { defineJob } from '../defineJob';
import type { PageEmbeddingRequestedData } from '../types';

// The page semantic index's WRITER (Story MOTIR-9490 · MOTIR-9571) — the
// background half of the page embedding write path, and the page twin of
// `work-item/embedding.requested`. A job rather than an inline call because
// embedding is an external network call: it runs after the page save has
// committed and can never fail, delay or roll that save back.
//
// `retryPolicy: 'idempotent'`: the service recomputes the content hash and skips
// a page whose row already matches, and the repository upserts on the page's PK,
// so a retry is cheap and can never double-write. A deployment with no AI backend
// short-circuits inside the service (no call, no throw).
//
// ⚠️ DEBOUNCED, UNLIKE THE WORK-ITEM JOB, and that is the difference between the
// two write paths. A work item is saved by discrete edits; a page is saved by
// `savePageUpdate`, the collaborative editor's door, which fires as a member
// types. Each of those saves emits, and without a debounce a typing burst would
// queue one run per keystroke batch. Keyed on the page, so one page's burst
// becomes ONE run with the latest event after 30 s of quiet — and never more than
// 5 minutes after the first arrival, so a page edited non-stop is still embedded.
// The other doors are discrete saves; the debounce costs them only latency.

export const pageEmbeddingRequested = defineJob(
  {
    id: 'page/embedding.requested',
    retryPolicy: 'idempotent',
    debounce: {
      key: 'event.data.pageId',
      period: '30s',
      timeout: '5m',
    },
  },
  async (ctx, services) => {
    const payload = ctx.event.data as PageEmbeddingRequestedData;
    return ctx.step.run('embed-page', () =>
      services.pageEmbeddings.embedPage({
        workspaceId: payload.workspaceId,
        pageId: payload.pageId,
      }),
    );
  },
);
