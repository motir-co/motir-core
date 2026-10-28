import type { EmailDeliveryState } from '@/lib/dto/jobs';

// DTOs for the invite endpoints. These define EXACTLY what crosses the
// HTTP boundary — no Prisma model leaks. Add fields here when the UI
// needs them, never on raw Prisma rows in the service return type.

export interface SendInviteResultDTO {
  ok: true;
}

export interface ValidateInviteResultDTO {
  workspaceName: string;
  inviterName: string;
  email: string;
}

export interface AcceptInviteResultDTO {
  workspaceId: string;
  /**
   * The projects a Limited invite named that were ARCHIVED between the send and
   * the accept, so the person was not added to them (Story MOTIR-6169 ·
   * MOTIR-6546). Empty on every other accept.
   */
  skippedProjects: string[];
}

// Discriminated result for the acceptance UI's initial page load. Lets
// the page render the distinct mockup states (valid / expired / used)
// instead of collapsing them the way validateInvite() does for the
// public GET endpoint.
export type InspectInviteResultDTO =
  | { status: 'valid'; workspaceName: string; inviterName: string; email: string }
  | { status: 'expired' }
  | { status: 'used' };

/**
 * What became of a pending invitation's email (MOTIR-9995). The five provider
 * states are `EmailDeliveryState`'s, one to one; `queued` is a send with no
 * delivery record yet, and `failed` a send that died after its retries.
 *
 * ⚠️ `delivered` does NOT mean "in the inbox". A spam-foldered message is
 * delivered; the provider cannot see the recipient's folders.
 */
export type InviteDeliveryState = 'queued' | EmailDeliveryState | 'failed';

/** One pending invitation, as the Members card lists it. Never carries the token. */
export interface PendingInviteDTO {
  /** The invitation's own row id — what a Resend names. */
  id: string;
  email: string;
  accessScope: 'full' | 'limited';
  /** How many projects a Limited invitation joins on accept; 0 on a Full one. */
  projectCount: number;
  /** The ORIGINAL inviter; `name` is null when that account is gone. */
  invitedBy: { userId: string; name: string | null };
  sentAt: string;
  expiresAt: string;
  deliveryState: InviteDeliveryState;
  /** Whether the viewer may resend it — decided by the service, never the page. */
  canResend: boolean;
}
