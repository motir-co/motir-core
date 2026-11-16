import type { PlatformPrincipal } from '@/lib/platform/auth';

/**
 * The acting staff member on a `/api/platform/planner-findings/**` route (Story
 * MOTIR-11455 · MOTIR-11458): the platform principal PLUS the credential that
 * carried the request, so every audit row names both the person and the
 * credential (`docs/decisions/platform-staff-auth.md` §2, the 2026-11-16
 * amendment) — the ideas store's `IdeaActor`, for the findings store.
 */

/**
 * The credential a staff request arrived with. Never the token's secret.
 * `workspaceId` is the workspace the token was minted in: where a `projectKey`
 * is resolved when a record names no plan. It is not a scope.
 */
export type PlannerFindingCredential =
  | { kind: 'session' }
  | { kind: 'token'; apiTokenId: string; workspaceId: string };

export interface PlannerFindingActor extends PlatformPrincipal {
  credential: PlannerFindingCredential;
}
