import { z } from 'zod/v4';
import type { IdeaCategory } from '@/generated/prisma/client';
import { IDEA_CATEGORIES } from '@/lib/ideas/categories';

// The RESPONSE SCHEMAS of the published public read surface (MOTIR-3946).
//
// ⚠️ THESE DESCRIBE THE WIRE, AND THE TYPES DESCRIBE THE CODE — the two must
// agree, and `tests/api/public/contract-schemas.test.ts` is what makes them.
// Every schema below is validated against the DTO its route actually returns,
// so a field added to `lib/dto/*` without being declared here fails a test
// rather than silently leaving the contract behind its own API.
//
// `.strict()` throughout, deliberately: an undeclared field reaching a consumer
// is exactly the drift this contract exists to prevent, and a permissive schema
// would document a subset while promising the whole.

/** `{ code }` — what every route on this surface returns on a refusal. */
export const publicErrorSchema = z
  .object({ code: z.string().meta({ description: 'A stable, machine-readable error code.' }) })
  .strict()
  .meta({
    id: 'PublicError',
    description: 'A refusal, addressed to a client rather than a reader.',
  });

const publicProjectStats = z
  .object({
    publicRequests: z.number().int(),
    upvotes: z.number().int(),
    planned: z.number().int(),
    shipped: z.number().int(),
    inProgress: z.number().int(),
  })
  .strict()
  .meta({ id: 'PublicProjectStats' });

const publicProjectLinks = z
  .object({
    website: z.string().optional(),
    repo: z.string().optional(),
    docs: z.string().optional(),
    changelog: z.string().optional(),
  })
  .strict()
  .meta({
    id: 'PublicProjectLinks',
    description: 'Author-supplied outbound links; every field optional.',
  });

/** The SUBJECT of `/p/{identifier}` — the endpoint MOTIR-3945 added. */
/**
 * A project's canonical address and its alternates (Story MOTIR-3878 · the ADR §7).
 *
 * `primary` is what a renderer names in `<link rel="canonical">`, `og:url`, the
 * JSON-LD `@id`, its sitemap entry and its feed. `alternates` is every OTHER
 * live address for the same project, each of which 301s to the primary — so a
 * consumer never has to decide which of two addresses is canonical, and two
 * addresses for one page can never compete.
 */
/**
 * What `GET /api/public/hosts/{host}` answers (Story MOTIR-3878 · MOTIR-4217;
 * reshaped by Story MOTIR-4528 · MOTIR-9511 in 2.0.0).
 *
 * A DISCRIMINATED UNION on `kind`, not one shape with nullable halves. The cases
 * share nothing but the discriminator, and a consumer that has to check which
 * fields are present is a consumer that will one day check the wrong one.
 *
 * There is no redirect outcome: a renamed or released name is the same 404 as
 * an unknown one (ADR §8 Amendment 3 rule 2).
 */
export const publicHostResolutionSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('no_application'),
        workspace: z.object({ name: z.string() }).strict(),
      })
      .strict()
      .meta({
        id: 'PublicHostNoApplication',
        description:
          'A live workspace host with no application to serve yet. The bare workspace host ' +
          "belongs to the workspace's default application (MOTIR-9790); it no longer lists " +
          'projects, which live at `motir.co/p/<identifier>`.',
      }),
    z
      .object({
        kind: z.literal('project'),
        project: z.object({ identifier: z.string(), name: z.string() }).strict(),
        primary: z.boolean().meta({
          description: "Whether this address is the project's canonical one (ADR §7).",
        }),
      })
      .strict()
      .meta({ id: 'PublicHostProject' }),
  ])
  .meta({ id: 'PublicHostResolution' });

export const publicProjectAddressesSchema = z
  .object({
    primary: z.string().meta({
      description:
        'The ONE canonical absolute URL. Always present: a project with no claimed address ' +
        'still has `motir.co/p/<identifier>`.',
    }),
    alternates: z.array(z.string()).meta({
      description: 'Every other live address for this project. Each redirects to `primary`.',
    }),
  })
  .strict()
  .meta({ id: 'PublicProjectAddresses' });

export const publicProjectOverviewSchema = z
  .object({
    id: z.string().meta({ description: 'The global id the public WRITE endpoints take.' }),
    name: z.string(),
    identifier: z.string().meta({ description: 'The project key — the public URL segment.' }),
    workspaceName: z.string(),
    publicOverviewMd: z.string().nullable().meta({ description: 'The authored README, or null.' }),
    publicTagline: z.string().nullable(),
    publicTags: z.array(z.string()),
    stats: publicProjectStats,
    links: publicProjectLinks,
    viewerCanManage: z.boolean().meta({
      description: 'Always false for an anonymous caller; the session only personalises.',
    }),
    addresses: publicProjectAddressesSchema,
  })
  .strict()
  .meta({ id: 'PublicProjectOverview' });

const projectSquareOrg = z
  .object({ name: z.string(), slug: z.string() })
  .strict()
  .meta({ id: 'ProjectSquareOrg' });

const projectSquareStats = z
  .object({ upvotes: z.number().int(), lastActivityAt: z.string().nullable() })
  .strict()
  .meta({ id: 'ProjectSquareStats' });

const projectSquareCard = z
  .object({
    identifier: z.string(),
    name: z.string(),
    org: projectSquareOrg,
    description: z.string().nullable(),
    stats: projectSquareStats,
  })
  .strict()
  .meta({ id: 'ProjectSquareCard' });

/** One page of the directory. Cursor-paged; `nextCursor` null at the end. */
export const projectSquarePageSchema = z
  .object({ items: z.array(projectSquareCard), nextCursor: z.string().nullable() })
  .strict()
  .meta({ id: 'ProjectSquarePage' });

const projectCategory = z
  .object({ slug: z.string(), label: z.string(), projectCount: z.number().int() })
  .strict()
  .meta({ id: 'ProjectCategory' });

/**
 * ⚠️ The categories route answers `{ categories }`, NOT a bare array — read off
 * `app/api/public/categories/route.ts`, which returns
 * `NextResponse.json({ categories })`. Declaring the array would have been the
 * natural guess and would have documented a shape no client receives.
 */
export const projectCategoriesSchema = z
  .object({ categories: z.array(projectCategory) })
  .strict()
  .meta({ id: 'ProjectCategories' });

// ── MOTIR-3990: the remaining nine operations ──────────────────────────────
//
// Everything below was read off the DTO the service returns AND the route that
// serialises it, in that order — `lib/dto/publicProjects.ts`, then the handler.
// The DTO alone is not the wire: `/api/public/categories` returns
// `{ categories }` around its array, and only the handler says so.

/** `{ code, error }` — the shape every WRITE refusal carries. */
export const publicErrorWithMessageSchema = z
  .object({
    code: z.string().meta({ description: 'A stable, machine-readable error code.' }),
    error: z.string().meta({ description: 'A human-readable sentence. Never parse it.' }),
  })
  .strict()
  .meta({ id: 'PublicWriteError' });

/**
 * The 403 a signed-in caller gets when their organization or workspace requires
 * a second factor they have not enrolled.
 *
 * Declared because it is REACHABLE on every session-required operation here:
 * `requireCompliantSession` answers 401 for no session and this for a held one.
 * A consumer that treats it as a generic 403 sends a person nowhere; `enrolAt`
 * is the address that resolves it.
 */
export const twoFactorRequiredSchema = z
  .object({
    code: z.literal('TWO_FACTOR_REQUIRED'),
    tier: z.enum(['organization', 'workspace']),
    tierName: z.string(),
    enrolAt: z.string(),
  })
  .strict()
  .meta({ id: 'TwoFactorRequired' });

const workItemKind = z
  .enum(['epic', 'story', 'task', 'bug', 'subtask'])
  .meta({ id: 'PublicWorkItemKind' });
const workItemPriority = z
  .enum(['lowest', 'low', 'medium', 'high', 'highest'])
  .meta({ id: 'PublicWorkItemPriority' });
const statusCategory = z.enum(['todo', 'in_progress', 'done']).meta({ id: 'PublicStatusCategory' });

/**
 * One public-safe work item.
 *
 * ⚠️ WHAT IS ABSENT IS THE POINT. No assignee, no `estimateMinutes`, no
 * `storyPoints`, no internal comments — the public projection does not HAVE
 * those fields, so a mapper that forgets to drop one is a compile error rather
 * than a leak. Declaring them here would document an exposure that does not
 * exist; `.strict()` means a future one fails the drift guard.
 */
const publicWorkItem = z
  .object({
    id: z.string(),
    identifier: z.string().meta({ description: 'The work-item key, e.g. `ACME-42`.' }),
    key: z.number().int().meta({ description: 'The per-project number (ACME-**42**).' }),
    title: z.string(),
    kind: workItemKind,
    status: z.string().meta({ description: 'The workflow status KEY, e.g. `in_progress`.' }),
    statusCategory,
    priority: workItemPriority,
    childrenHidden: z
      .boolean()
      .optional()
      .meta({
        description:
          'Present and true ONLY on a private epic seen by a non-member. Its descendants are ' +
          'excluded server-side, not hidden client-side.',
      }),
  })
  .strict()
  .meta({ id: 'PublicWorkItem' });

const publicTreeRow = publicWorkItem
  .extend({
    parentId: z.string().nullable(),
    hasChildren: z
      .boolean()
      .meta({ description: 'Whether the node has PUBLICLY visible children.' }),
  })
  .strict()
  .meta({ id: 'PublicWorkItemTreeRow' });

/** One lazily-loaded LEVEL of the public tree. Offset-paged, not cursor-paged. */
export const publicTreeLevelSchema = z
  .object({
    rows: z.array(publicTreeRow),
    hasMore: z.boolean(),
    total: z
      .number()
      .int()
      .meta({ description: "The level's full sibling count, independent of paging." }),
  })
  .strict()
  .meta({ id: 'PublicTreeLevel' });

/** A cursor-paginated page of public-safe work items. */
export const publicWorkItemPageSchema = z
  .object({ items: z.array(publicWorkItem), nextCursor: z.string().nullable() })
  .strict()
  .meta({ id: 'PublicWorkItemPage' });

const roadmapBucket = z
  .enum(['submitted', 'planned', 'in_progress', 'done'])
  .meta({ id: 'PublicRoadmapBucket' });

const roadmapCard = z
  .object({
    id: z.string(),
    identifier: z.string(),
    key: z.number().int(),
    title: z.string(),
    kind: workItemKind,
    voteCount: z.number().int(),
    voted: z
      .boolean()
      .meta({ description: 'Whether the CURRENT viewer upvoted it; false anonymously.' }),
  })
  .strict()
  .meta({ id: 'PublicRoadmapCard' });

/** One roadmap column's next page. `bucket` echoes which column it belongs to. */
export const publicRoadmapColumnPageSchema = z
  .object({ bucket: roadmapBucket, cards: z.array(roadmapCard), nextCursor: z.string().nullable() })
  .strict()
  .meta({ id: 'PublicRoadmapColumnPage' });

/** One roadmap COLUMN as the tab first draws it: its total, its first page, its cursor. */
const roadmapColumn = z
  .object({
    key: roadmapBucket,
    totalCount: z.number().int().meta({
      description: "The bucket's full card count — the header number, not `cards.length`.",
    }),
    cards: z.array(roadmapCard),
    nextCursor: z
      .string()
      .nullable()
      .meta({ description: 'Feed this back as `?bucket=<key>&cursor=<this>` for the next page.' }),
  })
  .strict()
  .meta({ id: 'PublicRoadmapColumn' });

/**
 * The whole roadmap TAB — the four status-grouped columns in display order, each
 * carrying its first page (MOTIR-4109).
 *
 * The counterpart of `PublicRoadmapColumnPage`: this is what the tab loads, that
 * is what "Load more" appends. Both are served by `GET …/roadmap`, on disjoint
 * parameter arms.
 */
export const publicRoadmapSchema = z
  .object({ columns: z.array(roadmapColumn) })
  .strict()
  .meta({ id: 'PublicRoadmap' });

/**
 * One public BOARD column — its name, the workflow statuses mapped into it, its
 * cards and its full count.
 *
 * `statusKeys` is what lets a column header say which statuses it holds without
 * the consumer re-reading the workflow, which it has no endpoint for.
 */
const publicBoardColumn = z
  .object({
    id: z.string(),
    name: z.string(),
    statusKeys: z
      .array(z.string())
      .meta({ description: 'The workflow status KEYS mapped into this column.' }),
    cards: z.array(publicWorkItem),
    totalCount: z.number().int().meta({
      description: "The column's full card count — the denominator above the loaded set.",
    }),
  })
  .strict()
  .meta({ id: 'PublicBoardColumn' });

/**
 * One page of the public-project INDEX (MOTIR-4111) — the crawl enumeration.
 *
 * Two fields per row and nothing else: `identifier` is the URL, `updatedAt` is
 * the sitemap's `<lastmod>`. The rich human directory is `listPublicProjects`
 * (`/api/public/explore`), which is a different read for a different reader.
 */
export const publicProjectIndexPageSchema = z
  .object({
    projects: z.array(
      z
        .object({
          identifier: z.string().meta({ description: "The project's key — the URL segment." }),
          updatedAt: z.string().meta({ description: "ISO 8601 — the sitemap's `<lastmod>`." }),
          primaryHost: z.string().meta({
            description:
              "The HOST the project's canonical address lives on. A sitemap may list only " +
              "URLs on its own host, so `motir.co`'s sitemap omits a project whose canonical " +
              "has moved to a tenant or customer host, and that host's own sitemap lists it.",
          }),
        })
        .strict()
        .meta({ id: 'PublicProjectIndexEntry' }),
    ),
    nextCursor: z
      .string()
      .nullable()
      .meta({ description: 'Echo it back as `?cursor=`; null on the last page.' }),
  })
  .strict()
  .meta({ id: 'PublicProjectIndexPage' });

/**
 * The changelog FEED's body: an Atom 1.0 document, as text (MOTIR-4111).
 *
 * ⚠️ A STRING IS THE HONEST SCHEMA. The response is XML, so there is no JSON
 * structure to describe; declaring an object here would tell a generator to
 * parse a document that is not JSON. What a consumer needs to know — that it is
 * Atom — is carried by the operation's `responseMediaType`, which is where a
 * media type belongs.
 */
export const publicAtomDocumentSchema = z
  .string()
  .meta({ id: 'PublicAtomDocument', description: 'An Atom 1.0 feed document.' });

/**
 * One public COMMENT on a feature request (MOTIR-4110).
 *
 * The shared `CommentDTO` shape, restated here rather than imported from an
 * internal schema: this is a published contract, and a public document that
 * moved whenever an internal DTO grew a field would not be one. `.strict()`
 * means a field ADDED to `CommentDTO` and returned by the request-detail read
 * fails the drift guard in THIS repository rather than reaching `motir.co`
 * undeclared — which is exactly what `public-surface-hosts.md` §3 asks the
 * producing repository to own.
 *
 * `mentionedUserIds` is always EMPTY on this surface: public-request comments
 * carry no mention scoping, and an empty array is the correct answer rather
 * than a leak of an internal mention set.
 */
const publicRequestComment = z
  .object({
    id: z.string(),
    workItemId: z.string(),
    parentCommentId: z
      .string()
      .nullable()
      .meta({ description: "Null on a root comment; the root's id on a single-level reply." }),
    author: z
      .object({ id: z.string(), name: z.string(), image: z.string().nullable() })
      .strict()
      .meta({ id: 'PublicCommentAuthor' }),
    bodyMd: z.string(),
    editedAt: z
      .string()
      .nullable()
      .meta({ description: 'ISO 8601 — set on a body edit, null when never edited.' }),
    createdAt: z.string().meta({ description: 'ISO 8601.' }),
    mentionedUserIds: z
      .array(z.string())
      .meta({ description: 'Always empty here — public-request comments carry no mentions.' }),
  })
  .strict()
  .meta({ id: 'PublicRequestComment' });

/**
 * ONE FEATURE REQUEST in full (MOTIR-4110) — the public projection plus the body,
 * the upvote demand signal and the PUBLIC comment thread, oldest first.
 *
 * ⚠️ WHAT IS ABSENT IS THE POINT, as everywhere on this surface: no assignee, no
 * estimate, no story points. `comments` is the request's `isPublic` thread ONLY —
 * a work item's internal discussion is not in the shape at all.
 */
export const publicRequestDetailSchema = z
  .object({
    id: z.string(),
    identifier: z.string().meta({ description: 'The work-item key, e.g. `ACME-42`.' }),
    key: z.number().int(),
    title: z.string(),
    kind: workItemKind,
    status: z.string().meta({ description: 'The workflow status KEY.' }),
    statusLabel: z.string().meta({ description: "The status's display label." }),
    statusCategory,
    descriptionMd: z.string().nullable(),
    openedByName: z
      .string()
      .meta({ description: 'The submitter\'s display name — the "opened by" meta.' }),
    createdAt: z.string().meta({ description: 'ISO 8601 — when the request was opened.' }),
    voteCount: z.number().int().meta({ description: 'Upvotes across every account.' }),
    voted: z
      .boolean()
      .meta({ description: 'Whether the CURRENT viewer upvoted it; false anonymously.' }),
    comments: z.array(publicRequestComment),
  })
  .strict()
  .meta({ id: 'PublicRequestDetail' });

/** The item's parent, for the detail page's breadcrumb and its sidebar link. */
const publicWorkItemDetailParent = z
  .object({
    identifier: z.string(),
    key: z.number().int(),
    title: z.string(),
    kind: workItemKind,
  })
  .strict()
  .meta({ id: 'PublicWorkItemDetailParent' });

/**
 * ONE WORK ITEM in full (MOTIR-4110) — the public projection plus the body, the
 * resolved status label, the immediate parent, and the FIRST page of public-safe
 * direct children.
 *
 * ⚠️ `children` IS A FIRST PAGE, NOT THE CHILD SET. `childrenHasMore` says
 * whether more exist, and the rest are loaded through the tree operation — the
 * at-scale rule. A consumer that treats `children` as complete renders a
 * truncated tree with no error anywhere.
 *
 * `childrenHidden` is the epic-privacy display signal, not its enforcement: when
 * it is true the descendants have ALREADY been excluded server-side, so
 * `children` is empty and `childCount` is 0.
 */
export const publicWorkItemDetailSchema = z
  .object({
    id: z.string(),
    identifier: z.string().meta({ description: 'The work-item key, e.g. `ACME-42`.' }),
    key: z.number().int(),
    title: z.string(),
    kind: workItemKind,
    status: z.string(),
    statusLabel: z.string(),
    statusCategory,
    descriptionMd: z.string().nullable(),
    parent: publicWorkItemDetailParent
      .nullable()
      .meta({ description: 'Null at a root — an epic, or a parentless item.' }),
    childrenHidden: z.boolean().meta({
      description:
        'True ONLY on a private epic seen by a non-member. The display signal; the exclusion ' +
        'already happened server-side.',
    }),
    childCount: z
      .number()
      .int()
      .meta({ description: 'Total public-safe DIRECT children; 0 when hidden.' }),
    children: z.array(publicTreeRow),
    childrenHasMore: z
      .boolean()
      .meta({ description: 'Whether more children exist past this first page.' }),
  })
  .strict()
  .meta({ id: 'PublicWorkItemDetail' });

/**
 * The public BOARD (MOTIR-4109) — the project's default board, bounded.
 *
 * ⚠️ BOUNDED, NOT PAGED, and that is a contract fact rather than an omission.
 * The read stops at `cap` and reports `truncated` (`PUBLIC_BOARD_CAP`,
 * MOTIR-2789); there is no cursor, because a board is a whole-shape read and the
 * Items tab beside it is the paged surface. A project with no default board
 * answers 200 with an empty `boardId`, an empty `name` and no columns — an empty
 * board rather than a 404, because the PROJECT exists.
 */
export const publicBoardSchema = z
  .object({
    boardId: z.string(),
    name: z.string(),
    columns: z.array(publicBoardColumn),
    cap: z
      .number()
      .int()
      .meta({ description: 'The board-level load cap this response was bounded by.' }),
    truncated: z
      .boolean()
      .meta({ description: 'True when the board\'s total exceeds `cap` — the "refine" hint.' }),
  })
  .strict()
  .meta({ id: 'PublicBoard' });

const changelogEntry = z
  .object({
    identifier: z.string(),
    key: z.number().int(),
    title: z.string(),
    kind: z.string(),
    status: z.string(),
    priority: z.string(),
    shippedAt: z
      .string()
      .meta({ description: 'ISO 8601 — the MOST RECENT transition into a done-category status.' }),
    epic: z
      .object({ identifier: z.string(), title: z.string() })
      .strict()
      .nullable()
      .meta({ id: 'PublicChangelogEpicChip' }),
    descriptionMd: z
      .string()
      .nullable()
      .optional()
      .meta({ description: 'Present on the FEED read only; absent on the page read.' }),
  })
  .strict()
  .meta({ id: 'PublicChangelogEntry' });

/** One page of the changelog. Cursor-paged on `(shippedAt, key)`. */
export const publicChangelogPageSchema = z
  .object({ entries: z.array(changelogEntry), nextCursor: z.string().nullable() })
  .strict()
  .meta({ id: 'PublicChangelogPage' });

/**
 * The follow control's state.
 *
 * ⚠️ `following` reports the ACCOUNT tier ONLY, and the omission is deliberate:
 * saying whether an ADDRESS follows a project would make this an enumeration
 * oracle, which is the same reason `/subscribe` answers 202 to everything.
 */
export const publicFollowStateSchema = z
  .object({
    following: z.boolean(),
    digestOptIn: z.boolean(),
    followerCount: z.number().int().meta({ description: 'Both stored tiers.' }),
    digestAvailable: z
      .boolean()
      .meta({ description: 'False where the deployment has no transactional-email backend.' }),
  })
  .strict()
  .meta({ id: 'PublicFollowState' });

/** The body of `POST …/follow`. Bodiless is the plain "follow" case. */
export const publicFollowBodySchema = z
  .object({ digestOptIn: z.boolean().optional() })
  .strict()
  .meta({ id: 'PublicFollowBody' });

/** The body of `POST …/subscribe`. */
export const publicSubscribeBodySchema = z
  .object({
    email: z.string().meta({ description: 'The address to send the digest to.' }),
    locale: z.string().optional().meta({
      description:
        "The language of the page the visitor subscribed from, one of the app's locale codes. Recorded so the follow's emails are written in it; when absent or unknown, the request's language is recorded.",
    }),
  })
  .strict()
  .meta({ id: 'PublicSubscribeBody' });

/** The body of `POST …/requests`. */
export const publicRequestBodySchema = z
  .object({
    kind: z.string().meta({ description: '`bug` or `task`; anything else is refused 422.' }),
    title: z.string(),
    descriptionMd: z.string().nullable().optional(),
  })
  .strict()
  .meta({ id: 'PublicRequestBody' });

/** What a submitted request answers with — the allocated item. */
export const publicRequestResultSchema = z
  .object({
    id: z.string(),
    kind: workItemKind,
    identifier: z.string(),
    title: z.string(),
  })
  .strict()
  .meta({ id: 'PublicRequestResult' });

const requestMatch = z
  .object({
    id: z.string(),
    kind: workItemKind,
    identifier: z.string(),
    title: z.string(),
    status: z.string(),
    voteCount: z.number().int(),
  })
  .strict()
  .meta({ id: 'PublicRequestMatch' });

/** The duplicate pre-check's answer. Empty `candidates` means "submit as new". */
export const publicDuplicateMatchesSchema = z
  .object({ candidates: z.array(requestMatch) })
  .strict()
  .meta({ id: 'PublicDuplicateMatches' });

// ── MOTIR-7676: the idea store's public reads (Story MOTIR-7662) ───────────
//
// Read off `lib/dto/ideas.ts` (the PUBLIC contract, which carries no status, no
// retirement record and no id) and then the three handlers under
// `app/api/public/ideas/`.

const ideaKind = z
  .enum(['motir_buys', 'direction'])
  .meta({ id: 'IdeaKind', description: '`motir_buys`: a team Motir itself would buy.' });

/**
 * The fixed category list (Story MOTIR-8273 widened it to 34). DERIVED from
 * `IDEA_CATEGORIES` — the key order of `IDEA_CATEGORY_LABELS` — rather than
 * retyped, so the published enum can never drift from the Prisma enum.
 */
export const ideaCategory = z.enum(IDEA_CATEGORIES as [IdeaCategory, ...IdeaCategory[]]).meta({
  id: 'IdeaCategory',
  description:
    'One of the fixed idea categories, in their grouped order. A slug is never translated; ' +
    'its `label` is returned in the requested locale.',
});

const ideaCategoryRef = z
  .object({ slug: ideaCategory, label: z.string() })
  .strict()
  .meta({ id: 'IdeaCategoryRef' });

const ideaTagRef = z
  .object({ slug: z.string(), label: z.string() })
  .strict()
  .meta({ id: 'IdeaTagRef' });

const ideaEvidence = z
  .object({
    claim: z.string(),
    sourceName: z.string(),
    url: z.string(),
    sourceDate: z.string().nullable().meta({ description: '`YYYY-MM-DD`, or null.' }),
  })
  .strict()
  .meta({ id: 'IdeaEvidence' });

/** One active idea — what `/api/public/ideas/{slug}` answers and the list carries. */
export const publicIdeaSchema = z
  .object({
    slug: z.string(),
    title: z.string(),
    pitch: z.string(),
    kind: ideaKind,
    category: ideaCategoryRef,
    tags: z.array(ideaTagRef),
    capabilities: z.array(z.string()),
    evidence: z.array(ideaEvidence),
    gap: z.string().nullable(),
    whyNow: z.string().nullable(),
    whyMotir: z.string().nullable(),
    whoElse: z.string().nullable(),
    addedAt: z.string(),
    lastReviewedAt: z.string().nullable(),
  })
  .strict()
  .meta({ id: 'PublicIdea' });

const publicIdeaCategoryCount = z
  .object({ slug: ideaCategory, label: z.string(), count: z.number().int() })
  .strict()
  .meta({ id: 'PublicIdeaCategoryCount' });

/** The filtered list. Unpaginated by design: the store is curated. */
export const publicIdeaListSchema = z
  .object({
    items: z.array(publicIdeaSchema),
    categories: z.array(publicIdeaCategoryCount).meta({
      description: 'Counts over every filter EXCEPT `category`, so each chip stays choosable.',
    }),
    total: z.number().int(),
  })
  .strict()
  .meta({ id: 'PublicIdeaList' });

/** `{ tags }` — the route wraps the array, like `/api/public/categories`. */
export const publicIdeaTagsSchema = z
  .object({
    tags: z.array(
      z
        .object({ slug: z.string(), label: z.string(), count: z.number().int() })
        .strict()
        .meta({ id: 'PublicIdeaTag' }),
    ),
  })
  .strict()
  .meta({ id: 'PublicIdeaTags' });
