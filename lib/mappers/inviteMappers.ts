import type {
  EmailDeliveryState as EmailDeliveryRowState,
  User,
  Workspace,
} from '@/generated/prisma/client';
import type {
  InviteDeliveryState,
  PendingInviteDTO,
  ValidateInviteResultDTO,
} from '@/lib/dto/invites';

export function toValidateInviteResultDTO(args: {
  workspace: Workspace;
  inviter: User | null;
  email: string;
}): ValidateInviteResultDTO {
  return {
    workspaceName: args.workspace.name,
    // Defensive fallback when the inviter has been deleted between
    // sending the invite and the recipient opening it. We could 404 in
    // that case, but a leftover "A teammate" string is more
    // user-friendly than failing the acceptance UI.
    inviterName: args.inviter?.name ?? 'A teammate',
    email: args.email,
  };
}

/**
 * A pending invitation's delivery state (MOTIR-9995). A delivery record wins
 * whatever else exists, and its state passes through one to one — `accepted`
 * is never reported as `delivered`. With no record, a dead-lettered send is
 * `failed`; otherwise the email is still `queued`.
 */
export function toInviteDeliveryState(args: {
  delivery: { state: EmailDeliveryRowState } | null;
  sendFailed: boolean;
}): InviteDeliveryState {
  if (args.delivery) return args.delivery.state;
  return args.sendFailed ? 'failed' : 'queued';
}

export function toPendingInviteDTO(args: {
  id: string;
  email: string;
  accessScope: 'full' | 'limited';
  projectIds: readonly string[];
  inviterUserId: string;
  inviterName: string | null;
  createdAt: Date;
  expiresAt: Date;
  deliveryState: InviteDeliveryState;
  canResend: boolean;
}): PendingInviteDTO {
  return {
    id: args.id,
    email: args.email,
    accessScope: args.accessScope,
    projectCount: args.projectIds.length,
    invitedBy: { userId: args.inviterUserId, name: args.inviterName },
    sentAt: args.createdAt.toISOString(),
    expiresAt: args.expiresAt.toISOString(),
    deliveryState: args.deliveryState,
    canResend: args.canResend,
  };
}
