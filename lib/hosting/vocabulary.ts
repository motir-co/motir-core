// The hosting vocabulary (Story MOTIR-9791): where a Motir repo's app runs, what
// it is for and how big it is. Decision of record: MOTIR-5769 (page
// cmvrcywwc00jkhpr1zvvnike8, version 1) fixes the targets; the requirement's D3
// (page cmvpt02mh02q3hmu1nc159ofq) names the use cases; MOTIR-9808 fixes the size
// scale, whose per-target machine sizes the adapters define. The Prisma enums
// `HostingTarget` / `HostingUseCase` / `HostingSize` carry the same values — a
// test pins the two lists together.

/** The three targets a Motir repo runs on (D3): serverless for small apps and
 *  internal tools, Fly for a long-running process, AWS for enterprise. */
export const HOSTING_TARGETS = ['serverless', 'fly', 'aws'] as const;
export type HostingTarget = (typeof HOSTING_TARGETS)[number];

/** What the app is for (R3, D4): a build-directly internal tool or MVP, or a
 *  planned product. */
export const HOSTING_USE_CASES = ['internal_tool', 'mvp', 'planned_product'] as const;
export type HostingUseCase = (typeof HOSTING_USE_CASES)[number];

/** The size the planner reads into a target and each adapter maps to machine
 *  sizes (MOTIR-5769 §4: production "by the row's size"). */
export const HOSTING_SIZES = ['small', 'medium', 'large'] as const;
export type HostingSize = (typeof HOSTING_SIZES)[number];

export function isHostingTarget(value: string): value is HostingTarget {
  return (HOSTING_TARGETS as readonly string[]).includes(value);
}

export function isHostingUseCase(value: string): value is HostingUseCase {
  return (HOSTING_USE_CASES as readonly string[]).includes(value);
}

export function isHostingSize(value: string): value is HostingSize {
  return (HOSTING_SIZES as readonly string[]).includes(value);
}
