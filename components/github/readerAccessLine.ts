import type { LinkedPullRequestDto } from '@/lib/dto/github';
import { previewRowState } from './PreviewLine';

// THE PULL-REQUEST ROW PER READER (Story MOTIR-4881 · MOTIR-12116; design
// `design/github/design-notes.md` § 35, `github--pr-row-reader-access.mock.html`).
//
// ONE pure mapping from the row's `readerAccess` (and its preview) to what the row draws:
// whether the code link-out is shown, and which access-line variant sits under the preview
// line. The row renders the answer and derives nothing — the access itself is the data
// read's (`projectRepoAccessService.readReaderAccessForRepos`, MOTIR-12115).

/** The access line's variants — `data-access-variant` on the element, and the key under
 *  `github.development.access` that carries its sentence. */
export type ReaderAccessVariant =
  | 'invited'
  | 'invitedNoLink'
  | 'notInvited'
  | 'roleCannotEdit'
  | 'noGithubPreview'
  | 'noGithubNoPreview';

export interface ReaderAccessView {
  /** Whether the row draws its code link-out. Withheld is NOT RENDERED — never a disabled
   *  icon (§ 35.3). */
  showLinkOut: boolean;
  /** The access line's variant, or null for no line at all. */
  line: ReaderAccessVariant | null;
}

/** The row as it shipped before this story: link-out drawn, no access line. */
const AS_TODAY: ReaderAccessView = { showLinkOut: true, line: null };

/**
 * § 35.4's rule, total over the reader states.
 *
 * - `readerAccess` null (a connected repository, one outside the project's set, or an
 *   access fact that could not be read) — the row exactly as today.
 * - A non-null `reason` WINS over `state`, and only a reason withholds the link-out:
 *   `role_cannot_edit` on any state (an accepted record included), and
 *   `no_github_identity`, which names the preview above only when it is READY. "Ready"
 *   is `PreviewLine`'s own total mapping, so a `starting` record — which the preview line
 *   draws as building — never counts.
 * - With no reason: `invited` keeps the link-out and points at the stored invitation (or
 *   at the Code access page when GitHub returned no invitation address, so the line never
 *   carries a dead link); `not_invited` keeps it and points at the Code access page;
 *   `accepted` is the row as today.
 */
export function readerAccessView(
  pr: Pick<LinkedPullRequestDto, 'readerAccess' | 'preview'>,
): ReaderAccessView {
  const access = pr.readerAccess;
  if (access === null) return AS_TODAY;
  if (access.reason === 'role_cannot_edit') return { showLinkOut: false, line: 'roleCannotEdit' };
  if (access.reason === 'no_github_identity') {
    const ready = pr.preview !== null && previewRowState(pr.preview.state).word === 'ready';
    return { showLinkOut: false, line: ready ? 'noGithubPreview' : 'noGithubNoPreview' };
  }
  switch (access.state) {
    case 'invited':
      return { showLinkOut: true, line: access.invitationUrl ? 'invited' : 'invitedNoLink' };
    case 'not_invited':
      return { showLinkOut: true, line: 'notInvited' };
    case 'accepted':
      return AS_TODAY;
  }
}
