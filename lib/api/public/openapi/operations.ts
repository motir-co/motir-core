import { z } from 'zod/v4';
import type { PublicOperation } from '@/lib/api/public/openapi/operation';
import {
  ideaCategory,
  projectCategoriesSchema,
  projectSquarePageSchema,
  publicChangelogPageSchema,
  publicDuplicateMatchesSchema,
  publicErrorSchema,
  publicErrorWithMessageSchema,
  publicFollowBodySchema,
  publicFollowStateSchema,
  publicProjectOverviewSchema,
  publicRequestBodySchema,
  publicRequestResultSchema,
  publicAtomDocumentSchema,
  publicBoardSchema,
  publicHostResolutionSchema,
  publicIdeaListSchema,
  publicIdeaSchema,
  publicIdeaTagsSchema,
  publicProjectIndexPageSchema,
  publicRequestDetailSchema,
  publicRoadmapColumnPageSchema,
  publicRoadmapSchema,
  publicWorkItemDetailSchema,
  publicSubscribeBodySchema,
  publicTreeLevelSchema,
  publicWorkItemPageSchema,
  twoFactorRequiredSchema,
} from '@/lib/api/public/openapi/schemas';

// The public read surface's OPERATION REGISTRY (MOTIR-3946).
//
// One assembly point, the shape v1's per-resource `operations.ts` modules use:
// the declarations live beside the thing they describe and exactly one value
// knows the whole set.
//
// ⚠️ TOTAL SINCE MOTIR-3990: every method exported by every route under
// `app/api/public/` is declared here, and `tests/api/public/contract-coverage.test.ts`
// walks the filesystem and fails on one that is not. That guard is what makes
// this a contract rather than a snapshot — a route added in six months cannot
// ship undocumented, and nobody has to remember this file exists.
//
// ⚠️ FOUR OF THE TWELVE REQUIRE A SESSION, and they are marked. `follow`
// (POST/DELETE) answers 401 itself; `requests` (POST) and its `duplicates`
// pre-check go through `requireCompliantSession`, which answers 401 for no
// session and 403 for a held one. The same guard checks that flag against each
// route's own source, because a count taken by grepping `getSession` was wrong
// three times before it was derived (see AMENDMENT 1 §G).

const projectIdParam = {
  name: 'projectId',
  in: 'path',
  required: true,
  description:
    'The GLOBAL project id — NOT the `ACME` key. The two write paths address a public project ' +
    'by id; every read above addresses it by key.',
  schema: z.string(),
} as const;

const identifierParam = {
  name: 'identifier',
  in: 'path',
  required: true,
  description: "The project's key — the public URL segment, e.g. `ACME`.",
  schema: z.string(),
} as const;

export const PUBLIC_OPERATIONS: readonly PublicOperation[] = [
  {
    method: 'GET',
    path: '/api/public/p/{identifier}',
    operationId: 'getPublicProject',
    summary: "A public project's own subject",
    description:
      'The project a public page is ABOUT — its name, key, owning workspace, authored hero ' +
      '(tagline, tags, README) and computed stats. Anonymous: a session, when present, only ' +
      'personalises `viewerCanManage` and member visibility; it never authorises. A project that ' +
      'is not public answers 404 with no existence leak, exactly as an unknown key does.',
    parameters: [identifierParam],
    response: publicProjectOverviewSchema,
    errors: [
      {
        status: 404,
        description:
          'No PUBLIC project carries this key. Deliberately indistinguishable from an unknown key.',
        schema: publicErrorSchema,
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/public/explore',
    operationId: 'listPublicProjects',
    summary: 'The public project directory, one page at a time',
    description:
      'The directory of projects being built in public, cursor-paged. Every parameter is ' +
      'optional; omitting all of them returns the default ranking. Fully anonymous — this route ' +
      'makes no session call at all.',
    parameters: [
      {
        name: 'cursor',
        in: 'query',
        required: false,
        description: 'The `nextCursor` of a previous page.',
        schema: z.string(),
      },
      {
        name: 'rank',
        in: 'query',
        required: false,
        description: 'The ranking to apply.',
        schema: z.string(),
      },
      {
        name: 'window',
        in: 'query',
        required: false,
        description: 'The time window a ranking is computed over.',
        schema: z.string(),
      },
      {
        name: 'q',
        in: 'query',
        required: false,
        description: 'A free-text search over the directory.',
        schema: z.string(),
      },
      {
        name: 'category',
        in: 'query',
        required: false,
        description: 'Restrict to one topic, by slug.',
        schema: z.string(),
      },
    ],
    response: projectSquarePageSchema,
    errors: [
      {
        status: 400,
        description: 'An unparseable cursor or an out-of-range ranking parameter.',
        schema: publicErrorSchema,
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/public/categories',
    operationId: 'listPublicCategories',
    summary: 'The topics the directory can be filtered by',
    description:
      'Every topic with at least one public project, and how many each holds — the facet behind ' +
      "the directory's category filter. Fully anonymous.",
    parameters: [],
    response: projectCategoriesSchema,
    errors: [],
  },
  {
    method: 'GET',
    path: '/api/public/p/{identifier}/tree',
    operationId: 'getPublicProjectTreeLevel',
    deprecated: {
      reason: "motir.co's read pages moved into the app (MOTIR-6171)",
      replacement: 'the signed-in Visitor view at `app.motir.co/p/{identifier}/tree`',
    },
    summary: 'One level of the public work-item tree',
    description:
      "The lazy hierarchy read: the project's roots, or one parent's direct children on expand. " +
      'OFFSET-paged, not cursor-paged — a client tracks the loaded count and asks for the next ' +
      'offset. A private epic reports `hasChildren: false` and carries `childrenHidden`; its ' +
      'descendants are excluded server-side and never cross the wire.',
    parameters: [
      identifierParam,
      {
        name: 'parentId',
        in: 'query',
        required: false,
        description: "One parent's children. Omit for the project roots.",
        schema: z.string(),
      },
      {
        name: 'offset',
        in: 'query',
        required: false,
        description: "The level's paging offset. A non-positive or unparseable value reads as 0.",
        schema: z.number().int(),
      },
    ],
    response: publicTreeLevelSchema,
    errors: [
      {
        status: 404,
        description: 'No PUBLIC project carries this key.',
        schema: publicErrorSchema,
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/public/p/{identifier}/items',
    operationId: 'listPublicProjectWorkItems',
    deprecated: {
      reason: "motir.co's read pages moved into the app (MOTIR-6171)",
      replacement: 'the signed-in Visitor view at `app.motir.co/p/{identifier}/items`',
    },
    summary: "A page of a public project's work items",
    description:
      'The flat, cursor-paged list behind the Work items tab. Anonymous; a session, when present, ' +
      'only widens visibility for a member.',
    parameters: [
      identifierParam,
      {
        name: 'cursor',
        in: 'query',
        required: false,
        description: 'The `nextCursor` of a previous page.',
        schema: z.string(),
      },
    ],
    response: publicWorkItemPageSchema,
    errors: [
      {
        status: 404,
        description: 'No PUBLIC project carries this key.',
        schema: publicErrorSchema,
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/public/projects',
    operationId: 'listPublicProjectIndex',
    summary: 'The crawl ENUMERATION of every public project',
    description:
      'Identifier and last-updated for every public project, across every workspace, keyset-paged ' +
      'in a STABLE order. It is not `listPublicProjects` (`/api/public/explore`): that one is the ' +
      'human directory — ranked, with names, taglines, tags and demand stats, paged in ' +
      'screenfuls. This one is the machine list a sitemap is built from, and its order is fixed ' +
      'so that a walk over a mutating set cannot skip or duplicate a project. `updatedAt` is the ' +
      '`<lastmod>`, not the sort key. Anonymous, and no session could change the answer: every ' +
      "row is public by the read's own filter. A cursor past the tail is an empty page, not an " +
      'error (MOTIR-4111).',
    parameters: [
      {
        name: 'cursor',
        in: 'query',
        required: false,
        description: "A previous page's `nextCursor`. Opaque — do not construct or parse one.",
        schema: z.string(),
      },
    ],
    response: publicProjectIndexPageSchema,
    errors: [],
  },
  {
    method: 'GET',
    path: '/api/public/hosts/{host}',
    operationId: 'resolvePublicHost',
    summary: 'Resolve a HOST to the tenant content served at it',
    description:
      'Turns a `Host` header into what should be rendered at it — the one read a renderer makes ' +
      'before a page exists. Answers one of two shapes: a live workspace host with NO ' +
      'APPLICATION to serve yet, or a customer DOMAIN serving one project at its root. ' +
      '**Every other case is the same 404** — an unknown host, a renamed-away-from or released ' +
      'subdomain (it stops answering at once, with no redirect), a customer domain whose ' +
      'certificate has not issued, the base domain itself, and `motir.co`. That is deliberate: a ' +
      'caller must not be able to tell "no such tenant" from "a tenant exists but is not serving ' +
      'yet", because that difference is what would make walking hostnames worth doing. ' +
      'A 200 may be cached for 30 seconds with no revalidate window; a 404 is `no-store`. ' +
      'Anonymous, and no session could change the answer — every address it can resolve points ' +
      "at a public project by the read's own row-level filter (MOTIR-4217).",
    parameters: [
      {
        name: 'host',
        in: 'path',
        required: true,
        description:
          'The bare hostname, e.g. `acme.motir.site`. A port is stripped; a value carrying a ' +
          'scheme, a path or credentials is refused rather than repaired.',
        schema: z.string(),
      },
    ],
    response: publicHostResolutionSchema,
    errors: [],
  },
  {
    method: 'GET',
    path: '/api/public/p/{identifier}/changelog.xml',
    operationId: 'getPublicProjectChangelogFeed',
    summary: "A project's changelog as an ATOM feed",
    description:
      'The same shipped work `listPublicProjectChangelog` returns as JSON, serialised as an Atom ' +
      '1.0 document — the anonymous follower tier, and the only one that stores nothing about the ' +
      'person using it. ⚠️ THE ONLY OPERATION ON THIS SURFACE THAT DOES NOT ANSWER JSON: the ' +
      "media type is `application/atom+xml; charset=utf-8` and the body's schema is a STRING, " +
      'because there is no JSON structure to describe and describing one would tell a generated ' +
      'client to parse XML as JSON. Cached five minutes with `stale-while-revalidate`. No session ' +
      'is read — a feed is fetched by a daemon with no cookies, which is also what makes the ' +
      'response cacheable. The extension is `.xml` and the payload is Atom; a file extension has ' +
      'never been a media type, and there is deliberately no `.atom` alias, because a feed URL is ' +
      'copied into readers and outlives every redirect (MOTIR-4111).',
    parameters: [identifierParam],
    response: publicAtomDocumentSchema,
    responseMediaType: 'application/atom+xml',
    errors: [
      {
        status: 404,
        description:
          'No PUBLIC project carries this key. The ERROR body is JSON `{ code }` even though the ' +
          'success body is XML — one error shape across the whole surface.',
        schema: publicErrorSchema,
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/public/p/{identifier}/items/{key}',
    operationId: 'getPublicProjectWorkItem',
    deprecated: {
      reason: "motir.co's read pages moved into the app (MOTIR-6171)",
      replacement: 'the signed-in Visitor view at `app.motir.co/p/{identifier}/items/{key}`',
    },
    summary: 'ONE work item, as the public surface shows it',
    description:
      'The detail behind `/p/<identifier>/items/<key>` — the public projection plus the body, ' +
      'the resolved status label, the immediate parent, and the FIRST page of public-safe direct ' +
      'children. `children` is a page, not the child set: read `childrenHasMore` and continue ' +
      'through the tree operation. Anonymous; a session only applies member-visibility. FIVE ' +
      'conditions answer the same 404 with no existence leak — an unknown key, an item in ' +
      'another project, an archived item, a TRIAGE item (whose public surface is the request ' +
      "detail, not this one), and a private epic's hidden descendant.",
    parameters: [
      identifierParam,
      {
        name: 'key',
        in: 'path',
        required: true,
        description:
          "The work item's FULL identifier — `ACME-42`, not the bare number. The segment is " +
          'named `key` because that is the address the public URL has always used; the `key` ' +
          'FIELD in the response is the bare number, and the two are not the same thing.',
        schema: z.string(),
      },
    ],
    response: publicWorkItemDetailSchema,
    errors: [
      {
        status: 404,
        description:
          '`PROJECT_NOT_FOUND` when no PUBLIC project carries this key; ' +
          '`PUBLIC_WORK_ITEM_NOT_FOUND` when the project is public and the item is not reachable.',
        schema: publicErrorSchema,
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/public/p/{identifier}/requests/{requestKey}',
    operationId: 'getPublicProjectRequest',
    summary: 'ONE feature request, with its public thread and its vote count',
    description:
      'The detail behind `/p/<identifier>/requests/<requestKey>` — the request body, the upvote ' +
      'tally, and the PUBLIC comment thread oldest first. Anonymous; `voted` is false without a ' +
      'session, which is the only state a cross-origin consumer can produce ' +
      '(`public-surface-hosts.md` AMENDMENT 4 row 8). ⚠️ NOTE THE IDENTIFIER: this READ is keyed ' +
      "by the project key and the request's WORK-ITEM identifier, because that is the address in " +
      'a shared link; the WRITES beside it (`submitPublicRequest`, upvote, comment) are keyed by ' +
      'the global project id and the work-item id, because their caller has just read the ' +
      'resource and holds them.',
    parameters: [
      identifierParam,
      {
        name: 'requestKey',
        in: 'path',
        required: true,
        description: "The request's FULL work-item identifier — `ACME-42`, not the bare number.",
        schema: z.string(),
      },
    ],
    response: publicRequestDetailSchema,
    errors: [
      {
        status: 404,
        description:
          '`PROJECT_NOT_FOUND` when no PUBLIC project carries this key; ' +
          '`PUBLIC_REQUEST_NOT_FOUND` when the request is missing, archived, in another ' +
          'project, or hidden by the epic-privacy exclusion.',
        schema: publicErrorSchema,
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/public/p/{identifier}/board',
    operationId: 'getPublicProjectBoard',
    deprecated: {
      reason: "motir.co's read pages moved into the app (MOTIR-6171)",
      replacement: 'the signed-in Visitor view at `app.motir.co/p/{identifier}/board`',
    },
    summary: "The public project's BOARD tab",
    description:
      "The project's default board — its columns, the workflow statuses mapped into each, the " +
      "public-safe cards, and each column's full count above the loaded set. BOUNDED rather than " +
      'paged: the read stops at `cap` and reports `truncated`, because a board is a whole-shape ' +
      'read and the items list beside it is the paged surface. A project with no default board ' +
      'answers 200 with an empty board, not 404 — the project exists. Anonymous: a session, when ' +
      "present, only applies member-visibility (a non-member never receives a private epic's " +
      'descendants and sees that epic marked `childrenHidden`); it never authorises.',
    parameters: [identifierParam],
    response: publicBoardSchema,
    errors: [
      {
        status: 404,
        description: 'No PUBLIC project carries this key.',
        schema: publicErrorSchema,
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/public/p/{identifier}/roadmap',
    // ⚠️ THE ID DOES NOT CHANGE, THOUGH THE OPERATION GREW. `…RoadmapColumn` now
    // describes only one of two arms and reads narrow — and an `operationId` is
    // what a generated client names its METHOD after, so renaming it would break
    // every consumer that generated one, which AMENDMENT 1 §D forbids without a
    // new MAJOR. A slightly wrong name is the cheaper of the two, and this
    // comment is where the next reader finds out it was a decision.
    operationId: 'getPublicProjectRoadmapColumn',
    deprecated: {
      reason: "motir.co's read pages moved into the app (MOTIR-6171)",
      replacement: 'the signed-in Visitor view at `app.motir.co/p/{identifier}/roadmap`',
    },
    summary: 'The roadmap tab, or the next page of ONE of its columns',
    description:
      'TWO arms on one path, chosen by the parameters. With NEITHER `bucket` nor `cursor` it ' +
      'returns the whole tab — the four status-grouped columns in display order, each with its ' +
      "total and its first page (`PublicRoadmap`). With BOTH it returns that column's next page " +
      '(`PublicRoadmapColumnPage`) — the "load more". The arms are disjoint and the refusals are ' +
      'unchanged: an unknown bucket is `INVALID_ROADMAP_BUCKET`, a bucket with no cursor is ' +
      '`MISSING_ROADMAP_CURSOR`, and a malformed cursor is refused by the decoder — a pager that ' +
      'silently restarted at the top would be far harder to notice than an error. So a request ' +
      'that has an answer today keeps exactly that answer; only the both-absent case is new ' +
      '(MOTIR-4109).',
    parameters: [
      identifierParam,
      {
        name: 'bucket',
        in: 'query',
        required: false,
        description:
          'Which column: `submitted`, `planned`, `in_progress` or `done`. Omit it — together ' +
          'with `cursor` — for the whole tab.',
        schema: z.enum(['submitted', 'planned', 'in_progress', 'done']),
      },
      {
        name: 'cursor',
        in: 'query',
        required: false,
        description:
          "That column's `nextCursor` from the previous page. Required WITH `bucket`; omit both " +
          'for the whole tab.',
        schema: z.string(),
      },
    ],
    response: z
      .union([publicRoadmapSchema, publicRoadmapColumnPageSchema])
      .meta({ id: 'PublicRoadmapResponse' }),
    errors: [
      {
        status: 400,
        description: 'An unknown bucket, a bucket with no cursor, or a malformed cursor.',
        schema: publicErrorSchema,
      },
      {
        status: 404,
        description: 'No PUBLIC project carries this key.',
        schema: publicErrorSchema,
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/public/p/{identifier}/changelog',
    operationId: 'listPublicProjectChangelog',
    summary: 'A page of what the project has shipped',
    description:
      'Work items that entered a done-category status, newest first, dated by that transition. ' +
      'Cursor-paged on `(shippedAt, key)` — a timestamp alone is not a total order, so a page ' +
      'boundary landing on a tie would skip or repeat an entry.',
    parameters: [
      identifierParam,
      {
        name: 'cursor',
        in: 'query',
        required: false,
        description: 'The `nextCursor` of a previous page.',
        schema: z.string(),
      },
    ],
    response: publicChangelogPageSchema,
    errors: [
      {
        status: 400,
        description: 'A malformed cursor.',
        schema: publicErrorSchema,
      },
      {
        status: 404,
        description: 'No PUBLIC project carries this key.',
        schema: publicErrorSchema,
      },
    ],
  },
  {
    method: 'POST',
    path: '/api/public/p/{identifier}/subscribe',
    operationId: 'subscribeToPublicProject',
    summary: 'Subscribe an EMAIL address to the project digest',
    description:
      'The account-free tier, and the one write on this surface a signed-out visitor can perform ' +
      '— requiring sign-in here would delete the tier a launch funnel exists for.\n\n' +
      '⚠️ **The answer is 202 with NO body whatever happened** — already subscribed, newly ' +
      'subscribed, or unconfirmed and re-sent. Varying it would turn this into an oracle for ' +
      '"does this address follow this project", which an endpoint accepting arbitrary addresses ' +
      'must not be. The declared failures are about the REQUEST, never about the row.\n\n' +
      "Rate-limited on BOTH the caller's IP and the submitted address, because an accepted " +
      'request sends mail to an address the caller chose.',
    parameters: [identifierParam],
    requestBody: {
      description: 'The address to subscribe.',
      schema: publicSubscribeBodySchema,
      required: true,
    },
    successStatus: 202,
    response: null,
    errors: [
      {
        status: 404,
        description: 'No PUBLIC project carries this key.',
        schema: publicErrorSchema,
      },
      {
        status: 409,
        description: 'This deployment has no transactional-email backend, so there is no digest.',
        schema: publicErrorSchema,
      },
      {
        status: 422,
        description: 'The address is not one.',
        schema: publicErrorSchema,
      },
      {
        status: 429,
        description: 'The per-IP or per-address budget is exhausted.',
        schema: publicErrorWithMessageSchema,
      },
    ],
  },
  {
    method: 'POST',
    path: '/api/public/p/{identifier}/follow',
    operationId: 'followPublicProject',
    summary: 'Follow the project, or change the digest opt-in',
    description:
      'The ACCOUNT tier. IDEMPOTENT: a double-click or a retry answers the resulting STATE ' +
      'rather than a conflict, and a bodiless POST is the plain "follow".\n\n' +
      '⚠️ **Session required.** Following is a relationship between an account and a project, so ' +
      'a signed-out caller has nothing to create and gets 401. The session cookie is host-only ' +
      "on the application's origin, so a cross-origin consumer cannot invoke this at all.",
    parameters: [identifierParam],
    requestBody: {
      description: 'Optional. Omit to follow; send `digestOptIn` to set the digest preference.',
      schema: publicFollowBodySchema,
      required: false,
    },
    sessionRequired: true,
    response: publicFollowStateSchema,
    errors: [
      {
        status: 401,
        description: 'No session. `UNAUTHENTICATED`.',
        schema: publicErrorSchema,
      },
      {
        status: 404,
        description: 'No PUBLIC project carries this key.',
        schema: publicErrorSchema,
      },
      {
        status: 429,
        description: 'The per-IP budget is exhausted.',
        schema: publicErrorWithMessageSchema,
      },
    ],
  },
  {
    method: 'DELETE',
    path: '/api/public/p/{identifier}/follow',
    operationId: 'unfollowPublicProject',
    summary: 'Unfollow the project',
    description:
      'The other half of the toggle, idempotent on the same terms: unfollowing something you do ' +
      'not follow answers the resulting state. **Session required**, for the same reason the ' +
      'POST is.',
    parameters: [identifierParam],
    sessionRequired: true,
    response: publicFollowStateSchema,
    errors: [
      {
        status: 401,
        description: 'No session. `UNAUTHENTICATED`.',
        schema: publicErrorSchema,
      },
      {
        status: 404,
        description: 'No PUBLIC project carries this key.',
        schema: publicErrorSchema,
      },
      {
        status: 429,
        description: 'The per-IP budget is exhausted.',
        schema: publicErrorWithMessageSchema,
      },
    ],
  },
  {
    method: 'POST',
    path: '/api/public/projects/{projectId}/requests',
    operationId: 'submitPublicRequest',
    summary: 'Submit a request into a public project',
    description:
      'The cross-account intake: any signed-in account submits a bug report or feature request ' +
      "into a PUBLIC project's triage. The request is born in the `triage` state and is EXCLUDED " +
      'from every normal read until an admin promotes it, so it does not appear in the items, ' +
      'tree or changelog reads above.\n\n' +
      '⚠️ **Session required**, and addressed by the GLOBAL project id rather than the key: a ' +
      'public project is written to by id (`docs/decisions/public-api-conventions.md` §2.2). ' +
      'Rate-limited per IP before the session is even read, and again per account inside.',
    parameters: [projectIdParam],
    requestBody: {
      description: 'The request to file.',
      schema: publicRequestBodySchema,
      required: true,
    },
    sessionRequired: true,
    successStatus: 201,
    response: publicRequestResultSchema,
    errors: [
      {
        status: 400,
        description: 'The body is not JSON, or `kind` / `title` is missing or not a string.',
        schema: publicErrorWithMessageSchema,
      },
      {
        status: 401,
        description: 'No session. `UNAUTHENTICATED`.',
        schema: publicErrorSchema,
      },
      {
        status: 403,
        description:
          'The account is held by a two-factor requirement it has not satisfied. `enrolAt` is ' +
          'where a browser client sends the person to resolve it.',
        schema: twoFactorRequiredSchema,
      },
      {
        status: 404,
        description: 'No PUBLIC project carries this id.',
        schema: publicErrorWithMessageSchema,
      },
      {
        status: 409,
        description: "The project's intake is unavailable.",
        schema: publicErrorWithMessageSchema,
      },
      {
        status: 422,
        description: 'An unsupported `kind`, a blank or over-long title, or an over-long body.',
        schema: publicErrorWithMessageSchema,
      },
      {
        status: 429,
        description: 'The per-IP or per-account budget is exhausted.',
        schema: publicErrorWithMessageSchema,
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/public/projects/{projectId}/requests/duplicates',
    operationId: 'findPublicRequestDuplicates',
    summary: 'Existing requests that match a draft title',
    description:
      'The pre-check the submit form calls as somebody types, so the UI can offer "upvote this ' +
      'instead" before a duplicate is created. Deterministic title matching, bounded, no AI. A ' +
      'blank title returns no candidates rather than everything.\n\n' +
      '⚠️ **Session required** — the same gate as the submit it precedes, so the pre-check cannot ' +
      'be used to read a project the submit would refuse.',
    parameters: [
      projectIdParam,
      {
        name: 'title',
        in: 'query',
        required: false,
        description: 'The draft title. Blank or absent returns an empty candidate list.',
        schema: z.string(),
      },
    ],
    sessionRequired: true,
    response: publicDuplicateMatchesSchema,
    errors: [
      {
        status: 401,
        description: 'No session. `UNAUTHENTICATED`.',
        schema: publicErrorSchema,
      },
      {
        status: 403,
        description: 'The account is held by an unsatisfied two-factor requirement.',
        schema: twoFactorRequiredSchema,
      },
      {
        status: 404,
        description: 'No PUBLIC project carries this id.',
        schema: publicErrorWithMessageSchema,
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/public/ideas',
    operationId: 'listPublicIdeas',
    summary: "The idea store's active ideas",
    description:
      'Every ACTIVE idea in the store (MOTIR-7676), Motir-would-buy ideas first, then newest — ' +
      'narrowed by any combination of the parameters below, with per-category counts computed ' +
      'over every filter except `category`. Unpaginated by design: the store is curated. Fully ' +
      'anonymous — this route makes no session call. Cacheable: ' +
      '`Cache-Control: public, s-maxage=300, stale-while-revalidate=3300`.',
    parameters: [
      {
        name: 'category',
        in: 'query',
        required: false,
        description:
          'Restrict to one category, by slug. A slug outside the closed set is ' +
          '`400 INVALID_IDEA_FILTER`.',
        schema: ideaCategory,
      },
      {
        name: 'tag',
        in: 'query',
        required: false,
        description: 'A tag slug. Repeat it to require every one; an unknown tag matches nothing.',
        schema: z.string(),
      },
      {
        name: 'q',
        in: 'query',
        required: false,
        description: 'Free text over title, pitch, gap and tag labels (at most 200 characters).',
        schema: z.string(),
      },
      {
        name: 'kind',
        in: 'query',
        required: false,
        description: '`motir_buys` or `direction`.',
        schema: z.string(),
      },
    ],
    response: publicIdeaListSchema,
    errors: [
      {
        status: 400,
        description: 'A `category` or `kind` outside the closed set. `INVALID_IDEA_FILTER`.',
        schema: publicErrorSchema,
      },
      {
        status: 503,
        description:
          'The database connection was lost on the read and on its one retry. ' +
          '`IDEAS_UNAVAILABLE`, with `Retry-After`; never cached.',
        schema: publicErrorSchema,
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/public/ideas/tags',
    operationId: 'listPublicIdeaTags',
    summary: 'The tags the idea list can be filtered by',
    description:
      'Every tag carried by at least one ACTIVE idea, with that count — the facet behind the ' +
      'tag filter. Fully anonymous; cacheable like the list.',
    parameters: [],
    response: publicIdeaTagsSchema,
    errors: [
      {
        status: 503,
        description:
          'The database connection was lost on the read and on its one retry. ' +
          '`IDEAS_UNAVAILABLE`, with `Retry-After`; never cached.',
        schema: publicErrorSchema,
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/public/ideas/{slug}',
    operationId: 'getPublicIdea',
    summary: 'One active idea',
    description:
      'One ACTIVE idea with its evidence and tags. A retired idea answers exactly as an unknown ' +
      'slug does, so a public reader cannot tell it ever existed. Fully anonymous; cacheable ' +
      'like the list.',
    parameters: [
      {
        name: 'slug',
        in: 'path',
        required: true,
        description: "The idea's slug, e.g. `a-care-team-app-for-families`.",
        schema: z.string(),
      },
    ],
    response: publicIdeaSchema,
    errors: [
      {
        status: 404,
        description:
          'No ACTIVE idea carries this slug. `IDEA_NOT_FOUND`; a retired slug is indistinguishable.',
        schema: publicErrorSchema,
      },
      {
        status: 503,
        description:
          'The database connection was lost on the read and on its one retry. ' +
          '`IDEAS_UNAVAILABLE`, with `Retry-After`; never cached.',
        schema: publicErrorSchema,
      },
    ],
  },
];
