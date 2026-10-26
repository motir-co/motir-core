import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import {
  classifyApiV1Error,
  DOMAIN_ERROR_STATUS,
  INTERNAL_ERROR_BODY,
  InsufficientPermissionError,
  InvalidRequestError,
  UnauthenticatedError,
} from '@/lib/api/v1/errors';
import { RateLimitExceededError, resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { V1_COLLECTIONS } from '@/lib/api/v1/pagination';
import {
  v1CollectionSchema,
  v1CursorSchema,
  V1_PAGE_ENVELOPE_COMPONENT,
  V1_RANKED_PAGE_ENVELOPE_COMPONENT,
  v1PageEnvelopeSchema,
  v1RankedPageEnvelopeSchema,
} from '@/lib/api/v1/openapi/envelopes';
import {
  v1ErrorBodySchema,
  v1InternalErrorBodySchema,
  V1_ERROR_BODY_COMPONENT,
  V1_INTERNAL_ERROR_BODY_COMPONENT,
} from '@/lib/api/v1/openapi/errorResponse';
import {
  V1_RATE_LIMIT_HEADERS,
  V1_API_VERSION_HEADER,
  V1_REQUEST_ID_HEADER,
  V1_SHARED_RESPONSE_HEADERS,
} from '@/lib/api/v1/openapi/headers';
import { V1_CONTRACT_VERSION } from '@/lib/api/v1/contractVersion';
import {
  V1_EXPOSED_PERMISSIONS,
  V1_PERMISSION_DESCRIPTION_KEYS,
  V1_PERMISSION_EXTENSION,
  V1_SECURITY_SCHEME_NAME,
  V1_UNEXPOSED_PERMISSIONS,
  v1SecurityScheme,
} from '@/lib/api/v1/openapi/security';
import {
  isV1ErrorStatus,
  isV1Status,
  undocumentedStatuses,
  V1_ERROR_STATUSES,
  V1_STATUS_DESCRIPTIONS,
  V1_STATUSES,
  V1_SUCCESS_STATUSES,
} from '@/lib/api/v1/openapi/statuses';
import { PERMISSIONS, PERMISSION_CATALOG, isPermissionKey } from '@/lib/permissions/catalog';
import { GRANTABLE_PERMISSIONS, isGrantable } from '@/lib/tokens/grant';
import { V1_OPERATIONS } from '@/lib/api/v1/openapi/registry';
import { emitOpenApiDocument, toOpenApiSchema } from '@/lib/api/v1/openapi/emit';
import { createWorkItemBodySchema } from '@/lib/api/v1/workItems/schema';
import { WORK_ITEM_OBSOLESCENCES } from '@/lib/issues/obsolescence';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { createV1Caller, type V1Caller } from '../../fixtures/apiV1Fixtures';
import { truncateAuthTables } from '../../helpers/db';

// The SHARED v1 wire-schema layer (Story 11.4 · Subtask 11.4.3 — MOTIR-2184).
//
// Three things this suite refuses to do, each because the acceptance criteria
// name the failure it would hide:
//
//   1. It does NOT compare a schema to a fixture written from the same
//      assumption. The error schema is asserted against what
//      `classifyApiV1Error` and the SHIPPED wrapper actually produce — a real
//      401 off a real route with a real (absent) token.
//   2. It does NOT only show its guards passing. `undocumentedStatuses` is run
//      against a deliberately-violating synthetic map, the way
//      `tests/helpers/v1RouteAudit.ts` runs its rules against a violating
//      source: a guard that has only ever been shown to pass is not a guard.
//   3. It does NOT re-declare a per-resource shape. Amendment 2 gives those to
//      Stories 11.2 / 11.3; this layer is the envelope, the error, the headers
//      and the scheme, and nothing else.

describe('the v1 status vocabulary', () => {
  it('documents every status it declares, success and error alike', () => {
    for (const status of V1_STATUSES) {
      expect(V1_STATUS_DESCRIPTIONS[status], `status ${status} has no description`).toBeTruthy();
    }
    expect(Object.keys(V1_STATUS_DESCRIPTIONS).length).toBe(V1_STATUSES.length);
  });

  it('covers every status DOMAIN_ERROR_STATUS can produce', () => {
    expect(undocumentedStatuses(DOMAIN_ERROR_STATUS)).toEqual([]);
  });

  it('carries the ADR §4 table exactly — including every appended condition', () => {
    expect([...V1_ERROR_STATUSES]).toEqual([
      401, 402, 403, 404, 409, 412, 413, 415, 422, 429, 500, 503,
    ]);
    expect([...V1_SUCCESS_STATUSES]).toEqual([200, 201, 202, 204]);
    // Every status a later story APPENDED as a NEW condition (ADR §8 permits
    // that; it forbids an existing condition changing status). Named
    // explicitly, because "the list is right" is only meaningful if the rows
    // that were argued for are the rows that are there.
    expect(DOMAIN_ERROR_STATUS['DUPLICATE_LINK']).toBe(409); // 11.2.9
    expect(DOMAIN_ERROR_STATUS['STALE_WORK_ITEM']).toBe(412); // 11.2.6
    // Story 11.7: a job-submitting endpoint answers 202 (Amendment 6 Q3), an
    // exhausted balance answers 402, and an unreachable motir-ai answers 503.
    expect(DOMAIN_ERROR_STATUS['MOTIR_AI_OUT_OF_CREDITS']).toBe(402); // 11.7.5
    expect(DOMAIN_ERROR_STATUS['MOTIR_AI_UNAVAILABLE']).toBe(503); // 11.7.5
    // Story MOTIR-3000: the general attachment door appends TWO conditions the
    // vocabulary had no word for — a file over the plan's per-file limit, and a
    // media type off the allowlist. Both are NEW conditions rather than an
    // existing one changing status, which is exactly what §8 permits, and both
    // answer what the BROWSER upload route has always answered for that rule.
    expect(DOMAIN_ERROR_STATUS['FILE_TOO_LARGE']).toBe(413); // MOTIR-3057
    expect(DOMAIN_ERROR_STATUS['UNSUPPORTED_FILE_TYPE']).toBe(415); // MOTIR-3057
    // The org's TOTAL storage cap reuses 402 — an existing status taking a
    // second condition, not a condition changing status.
    expect(DOMAIN_ERROR_STATUS['ENTITLEMENT_EXCEEDED']).toBe(402); // MOTIR-3057
    // …and the two motir-ai codes deliberately left OUT of the map, so the
    // absence is a decision a test holds rather than an oversight: our own bad
    // request to motir-ai is §4's bare, code-less 500.
    expect(DOMAIN_ERROR_STATUS['MOTIR_AI_BAD_REQUEST']).toBeUndefined();
    expect(DOMAIN_ERROR_STATUS['MOTIR_AI_JOB_FAILED']).toBeUndefined();
  });

  it('FAILS on a status map carrying a status the vocabulary does not document', () => {
    // The guard, run against a deliberate violation. If this ever returns `[]`,
    // the check above proves nothing.
    const drifted = { ...DOMAIN_ERROR_STATUS, SOME_NEW_CONDITION: 418 };
    expect(undocumentedStatuses(drifted)).toEqual([418]);
  });

  it('reports every undocumented status, not just the first', () => {
    expect(undocumentedStatuses({ A: 418, B: 451, C: 404 })).toEqual([418, 451]);
  });

  it('splits membership between the success and error halves', () => {
    expect(isV1Status(200)).toBe(true);
    expect(isV1Status(418)).toBe(false);
    expect(isV1ErrorStatus(404)).toBe(true);
    expect(isV1ErrorStatus(200)).toBe(false);
  });

  it('carries a status the WRAPPER itself can raise, not only a domain one', () => {
    // The wrapper's own errors never pass through DOMAIN_ERROR_STATUS, so the
    // reconciliation above cannot see them.
    for (const err of [
      new UnauthenticatedError(),
      new InsufficientPermissionError('read'),
      new InvalidRequestError('INVALID_CURSOR', 'nope'),
      new RateLimitExceededError(30),
    ]) {
      expect(isV1Status(err.status), `${err.name} raises undocumented ${err.status}`).toBe(true);
    }
  });
});

describe('the v1 error-response schema', () => {
  it('parses what classifyApiV1Error actually returns for a wrapper error', () => {
    const classified = classifyApiV1Error(new UnauthenticatedError());
    expect(classified).toBeDefined();
    expect(v1ErrorBodySchema.parse(classified?.body)).toEqual({
      code: 'UNAUTHENTICATED',
      error: 'Authentication required.',
    });
  });

  it('parses what classifyApiV1Error returns for a DOMAIN error', () => {
    const domainError = Object.assign(new Error('Work item not found.'), {
      code: 'WORK_ITEM_NOT_FOUND',
    });
    const classified = classifyApiV1Error(domainError);
    expect(classified?.status).toBe(404);
    expect(() => v1ErrorBodySchema.parse(classified?.body)).not.toThrow();
  });

  it('is CLOSED — an extra field is a parse failure, not a silent pass', () => {
    expect(v1ErrorBodySchema.safeParse({ code: 'X', error: 'y', detail: 'leaked' }).success).toBe(
      false,
    );
  });

  it('refuses an empty code or message', () => {
    expect(v1ErrorBodySchema.safeParse({ code: '', error: 'y' }).success).toBe(false);
    expect(v1ErrorBodySchema.safeParse({ code: 'X', error: '' }).success).toBe(false);
  });

  it('gives the 500 body its OWN schema — no code, and code is not optional', () => {
    expect(() => v1InternalErrorBodySchema.parse(INTERNAL_ERROR_BODY)).not.toThrow();
    // The 500 body must NOT satisfy the coded envelope: if it did, a client
    // could not tell "an error with a contract" from "an unexpected fault".
    expect(v1ErrorBodySchema.safeParse(INTERNAL_ERROR_BODY).success).toBe(false);
  });

  it('names its components', () => {
    expect(V1_ERROR_BODY_COMPONENT).toBe('ErrorBody');
    expect(V1_INTERNAL_ERROR_BODY_COMPONENT).toBe('InternalErrorBody');
  });
});

describe('the error schema against a REAL response off the shipped wrapper', () => {
  beforeEach(async () => {
    await truncateAuthTables();
    resetRateLimitStore();
  });

  it('parses the 401 an unauthenticated request actually gets', async () => {
    const { GET } = await import('@/app/api/v1/me/route');
    const res = await GET(new Request('http://localhost:3000/api/v1/me'));

    expect(res.status).toBe(401);
    expect(isV1Status(res.status)).toBe(true);
    const body: unknown = await res.json();
    expect(() => v1ErrorBodySchema.parse(body)).not.toThrow();
  });

  it('parses the 403 a scope-less token actually gets, and both headers ride it', async () => {
    // A token with a real scope that is NOT the one `/me` requires would be
    // ideal, but `/me` is `read` and `read` is the narrowest scope — so use a
    // route whose scope this caller lacks.
    const caller: V1Caller = await createV1Caller({ scopes: ['read'] });
    const { POST } = await import('@/app/api/v1/work-items/[key]/transitions/route');
    const res = await POST(
      new Request('http://localhost:3000/api/v1/work-items/MOTIR-1/transitions', {
        method: 'POST',
        headers: { ...caller.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      }),
      { params: Promise.resolve({ key: 'MOTIR-1' }) },
    );

    expect(res.status).toBe(403);
    const parsed = v1ErrorBodySchema.parse(await res.json());
    expect(parsed.code).toBe('INSUFFICIENT_PERMISSION');

    // The declared shared headers are on an ERROR response, which is the
    // property that put them in the shared layer rather than on an operation.
    for (const header of V1_SHARED_RESPONSE_HEADERS) {
      const value = res.headers.get(header.wireName);
      expect(value, `${header.name} missing from a 403`).not.toBeNull();
      expect(header.schema.safeParse(value).success, `${header.name} = ${value}`).toBe(true);
    }
  });
});

describe('the two v1 page envelopes', () => {
  const row = z.object({ key: z.string() });

  it('accepts a plain page and rejects one carrying totalCount', () => {
    const plain = v1PageEnvelopeSchema(row);
    expect(plain.parse({ items: [{ key: 'MOTIR-1' }], nextCursor: null })).toEqual({
      items: [{ key: 'MOTIR-1' }],
      nextCursor: null,
    });
    // The collapsed shape the ADR rejected by name: a plain collection that
    // starts reporting a count is a DIFFERENT envelope, and this is where that
    // becomes visible rather than silently tolerated.
    expect(plain.safeParse({ items: [], nextCursor: null, totalCount: 0 }).success).toBe(false);
  });

  it('requires totalCount on the ranked page — it is never optional', () => {
    const ranked = v1RankedPageEnvelopeSchema(row);
    expect(ranked.safeParse({ items: [], nextCursor: null }).success).toBe(false);
    expect(ranked.parse({ items: [], nextCursor: null, totalCount: 7 }).totalCount).toBe(7);
    expect(ranked.safeParse({ items: [], nextCursor: null, totalCount: -1 }).success).toBe(false);
    expect(ranked.safeParse({ items: [], nextCursor: null, totalCount: 1.5 }).success).toBe(false);
  });

  it('keeps nextCursor NULL on the last page — never absent', () => {
    const plain = v1PageEnvelopeSchema(row);
    expect(plain.safeParse({ items: [] }).success).toBe(false);
    expect(plain.parse({ items: [], nextCursor: 'abc' }).nextCursor).toBe('abc');
  });

  it('validates the ITEM schema it was composed with', () => {
    expect(
      v1PageEnvelopeSchema(row).safeParse({ items: [{ nope: 1 }], nextCursor: null }).success,
    ).toBe(false);
  });

  it('emits two DISTINCT component names', () => {
    expect(V1_PAGE_ENVELOPE_COMPONENT).not.toBe(V1_RANKED_PAGE_ENVELOPE_COMPONENT);
  });

  it('keeps V1_COLLECTIONS as the cursor’s scope vocabulary', () => {
    expect(v1CollectionSchema.options).toEqual([...V1_COLLECTIONS]);
    expect(v1CollectionSchema.safeParse('backlog').success).toBe(true);
    expect(v1CollectionSchema.safeParse('not-a-collection').success).toBe(false);
  });

  it('leaves the cursor OPAQUE — the document describes no payload', () => {
    expect(v1CursorSchema.safeParse('any-signed-blob').success).toBe(true);
    expect(v1CursorSchema.safeParse('').success).toBe(false);
  });
});

describe('the shared response headers', () => {
  it('declares the request id, the contract version and the three rate-limit headers', () => {
    expect(V1_SHARED_RESPONSE_HEADERS.map((h) => h.name)).toEqual([
      'X-Request-Id',
      'X-Motir-Api-Version',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
    ]);
  });

  it('pairs each display name with the lower-case name the wrapper writes', () => {
    for (const header of V1_SHARED_RESPONSE_HEADERS) {
      expect(header.wireName).toBe(header.name.toLowerCase());
      expect(header.description.length).toBeGreaterThan(0);
    }
  });

  it('types the rate-limit values as the digit strings they are on the wire', () => {
    for (const header of V1_RATE_LIMIT_HEADERS) {
      expect(header.schema.safeParse('42').success).toBe(true);
      expect(header.schema.safeParse('not-a-number').success).toBe(false);
    }
    expect(V1_REQUEST_ID_HEADER.schema.safeParse('req-1').success).toBe(true);
  });

  it('types the api-version value as the MAJOR.MINOR.PATCH it is, and accepts the shipped one', () => {
    // Read FROM the constant, never restated: a bump must not need this test
    // edited, and a header value that stopped matching the contract version
    // must fail here (MOTIR-2275).
    expect(V1_API_VERSION_HEADER.schema.safeParse(V1_CONTRACT_VERSION).success).toBe(true);
    expect(V1_API_VERSION_HEADER.schema.safeParse('1.2').success).toBe(false);
    expect(V1_API_VERSION_HEADER.schema.safeParse('v1.2.3').success).toBe(false);
    // It reports the CONTRACT, not the deployment — Amendment 4 Q6, and the one
    // thing the description must not let a reader mistake it for.
    expect(V1_API_VERSION_HEADER.description).toMatch(/contract/i);
    expect(V1_API_VERSION_HEADER.description).toMatch(/release number/i);
  });
});

describe('the v1 security scheme', () => {
  it('is the bearer PAT and nothing else', () => {
    expect(V1_SECURITY_SCHEME_NAME).toBe('bearerPat');
    expect(v1SecurityScheme.type).toBe('http');
    expect(v1SecurityScheme.scheme).toBe('bearer');
    expect(v1SecurityScheme.bearerFormat).toContain('motir_pat_');
  });

  it('describes EVERY catalog permission — the totality guard, at runtime', () => {
    for (const key of PERMISSIONS) {
      expect(
        V1_PERMISSION_DESCRIPTION_KEYS[key],
        `permission "${key}" has no published description`,
      ).toBeTruthy();
    }
    expect(Object.keys(V1_PERMISSION_DESCRIPTION_KEYS).length).toBe(PERMISSIONS.length);
  });

  it('reads its descriptions FROM the catalog — no hand-written second copy', () => {
    // The drift this replaces: `V1_SCOPE_DESCRIPTIONS` was a table of prose
    // maintained beside the one on Roles & permissions. Now both resolve the
    // SAME i18n key, so they cannot say different things about one capability.
    for (const key of PERMISSIONS) {
      expect(V1_PERMISSION_DESCRIPTION_KEYS[key]).toBe(PERMISSION_CATALOG[key].descriptionKey);
    }
  });

  it('has no description for a permission the catalog does not define', () => {
    for (const described of Object.keys(V1_PERMISSION_DESCRIPTION_KEYS)) {
      expect(isPermissionKey(described), `stale permission "${described}"`).toBe(true);
    }
  });

  it('exposes exactly what v1 declares — derived, not filtered off a vocabulary', () => {
    expect(V1_EXPOSED_PERMISSIONS.length + V1_UNEXPOSED_PERMISSIONS.length).toBe(
      GRANTABLE_PERMISSIONS.length,
    );
    for (const key of V1_EXPOSED_PERMISSIONS) expect(isGrantable(key)).toBe(true);
    for (const operation of V1_OPERATIONS) {
      expect(V1_EXPOSED_PERMISSIONS).toContain(operation.permission);
    }
  });

  // ⚠️ RESTORED BY MOTIR-3629. This rule has now been stated three ways, and the
  // third is the first one again. It began as "v1 does not expose the delete
  // key"; the archive/delete merge falsified that, because v1 legitimately
  // exposes archive and the two shared one key, so it was restated over
  // OPERATIONS — "expose no operation that cascade-deletes, whatever permission
  // it names". That was the honest expression available at the time and it is
  // strictly weaker: it can only check what the operations DO, never what the
  // document SAYS a caller must hold. With `work_item:archive` in the catalog
  // the original form is true again, and both halves are worth asserting.
  it('exposes work_item:archive and NOT work_item:delete — the key AND the operations', () => {
    expect(V1_EXPOSED_PERMISSIONS).toContain('work_item:archive');
    expect(V1_EXPOSED_PERMISSIONS).not.toContain('work_item:delete');
    expect(V1_UNEXPOSED_PERMISSIONS).toContain('work_item:delete');
    expect(V1_OPERATIONS.filter((o) => o.permission === 'work_item:delete')).toEqual([]);
    const archiving = V1_OPERATIONS.filter((o) => o.permission === 'work_item:archive').map(
      (o) => o.operationId,
    );
    expect([...archiving].sort()).toEqual(['archiveWorkItem', 'restoreWorkItem']);
    // The operation-shaped half of the old form, kept: the document saying the
    // right thing and the surface doing the right thing are two properties.
    expect(
      V1_OPERATIONS.some((o) => o.method === 'DELETE' && o.path === '/api/v1/work-items/{key}'),
    ).toBe(false);
  });

  it('names the extension an operation carries its permission on', () => {
    expect(V1_PERMISSION_EXTENSION).toBe('x-motir-permission');
    expect(V1_PERMISSION_EXTENSION.startsWith('x-')).toBe(true);
  });
});

describe('the operation → permission map is checked against the CODE (MOTIR-2577)', () => {
  // The card's load-bearing guard: each declaration must name the permission the
  // route's own service asserts, not the one its old scope happened to carry.
  //
  // The check runs through the MCP surface, which is the only mechanically
  // readable second opinion the repo has: a v1 operation and its MCP counterpart
  // call the SAME service method, so they must ask for the same key. A pairing
  // written down here and disagreeing at runtime means one of the two was filed
  // from the old vocabulary.
  const MIRRORED: ReadonlyArray<[operationId: string, tool: string]> = [
    ['getWorkItem', 'get_work_item'],
    ['getWorkItemActivity', 'get_work_item_activity'],
    ['createWorkItem', 'create_work_item'],
    ['updateWorkItem', 'update_work_item'],
    ['transitionWorkItem', 'transition_status'],
    ['createWorkItemLink', 'link_work_items'],
    ['deleteWorkItemLink', 'unlink_work_items'],
    ['createWorkItemComment', 'add_comment'],
    ['archiveWorkItem', 'archive_work_item'],
    ['restoreWorkItem', 'unarchive_work_item'],
    ['createSprint', 'create_sprint'],
    ['updateSprint', 'update_sprint'],
    ['startSprint', 'start_sprint'],
    ['completeSprint', 'complete_sprint'],
    ['moveWorkItemsToSprint', 'move_to_sprint'],
    ['moveWorkItemsToBacklog', 'move_to_backlog'],
    ['listProjects', 'list_projects'],
    ['listProjectSprints', 'list_sprints'],
    // MOTIR-6832 — the lanes serve the same set the tool's `lane` argument reads.
    ['getProjectReadyLeaves', 'list_ready'],
    ['getProjectReadyContainers', 'list_ready'],
    ['getProjectReadyBugs', 'list_ready'],
    ['getWorkItemDispatchPrompt', 'dispatch_prompt'],
    ['recordWorkItemIntegration', 'mark_integrated'],
    ['completeSession', 'complete_session'],
    ['submitWorkItemExpansion', 'expand_item'],
    ['getPlanStatus', 'get_plan_status'],
    ['getPlan', 'get_plan'],
    ['openPlanSession', 'open_plan_session'],
    ['appendPlanTurn', 'append_plan_turn'],
    ['submitPlanSession', 'submit_plan_session'],
    // MOTIR-2961 — the keyed claim ships on BOTH surfaces over one service
    // method, so the two must ask for the same permission.
    ['claimWorkItem', 'claim_work_item'],
  ];

  it.each(MIRRORED)('%s asks for the same permission as the %s tool', (operationId, tool) => {
    const operation = V1_OPERATIONS.find((o) => o.operationId === operationId);
    expect(operation, `${operationId} is declared`).toBeDefined();
    expect(operation?.permission).toBe(TOOL_PERMISSIONS[tool as keyof typeof TOOL_PERMISSIONS]);
  });

  it('every one of the 64 declarations names a GRANTABLE permission', () => {
    // 52: 41, plus MOTIR-2961's `POST …/work-items/{key}/claim`, MOTIR-3017's
    // `POST …/work-items/{key}/plan-approval`, MOTIR-3049's
    // `POST …/scope-claims`, MOTIR-3586's
    // `GET …/projects/{projectKey}/repositories`, MOTIR-1792's THREE
    // dispatch-run ingest operations (`POST …/dispatch-runs`, `…/{id}/events`,
    // `…/{id}/close`), MOTIR-4085's `GET …/work-items/{key}/plan-approval`, and
    // MOTIR-5048's `POST …/work-items/{key}/pull-requests` — and 57 with
    // MOTIR-5408's FIVE folder operations (`listFolders`, `createFolder`,
    // `getFolder`, `updateFolder`, `deleteFolder`) — and 58 with MOTIR-5464's
    // `POST …/work-items/{key}/repair` (`claimWorkItemRepair`).
    // NINE branches independently wrote the count for their own addition alone,
    // which is exactly what this number exists to catch — read it on
    // `origin/main` before merging, exactly as `V1_CONTRACT_VERSION` is.
    // 61 with MOTIR-5560's THREE design reads (`listWorkItemDesigns`,
    // `getWorkItemDesign`, `listProjectDesigns`), all on `project:browse`.
    // 62 with MOTIR-6191's `GET …/work-items/{key}/approval-gate`
    // (`getWorkItemApprovalGate`), also `project:browse` — a READ of a decision a
    // person made. It is NOT `approval:decide_any`, which no operation in this
    // registry names and which no token can hold by derivation
    // (`docs/decisions/approval-gates.md` §2); an operation that named it would
    // fail the `isGrantable` loop below, which is the check standing between this
    // registry and a decide door nobody argued for.
    // 63 with MOTIR-6558's `GET …/dispatch-runs/{id}` (`getDispatchRun`, on
    // `project:browse`) and 64 with MOTIR-6538's
    // `POST …/dispatch-runs/{id}/git-credential` (`issueDispatchRunGitCredentials`,
    // on `work_item:edit`) — both answered to a hosted run's own credential.
    // 65 with MOTIR-6528's `POST …/dispatch-runs/{id}/heartbeat`
    // (`heartbeatDispatchRun`) and 66 with MOTIR-6532's
    // `POST …/work-items/{key}/continue` (`claimWorkItemContinue`), both
    // `work_item:edit`. 69 with MOTIR-6832's THREE ready lanes
    // (`getProjectReadyLeaves`, `getProjectReadyContainers`,
    // `getProjectReadyBugs`), all `project:browse`. 68 once MOTIR-6841 deleted
    // the flat `GET …/ready` the lanes replaced.
    // 70 with MOTIR-6821's review run's two routes — `getWorkItemReviewPrompt`
    // (`project:browse`) and `submitWorkItemAgentReview` (`work_item:edit`).
    // 71 with MOTIR-8698's `POST …/dispatch-runs/{id}/unbuildable`
    // (`reportDispatchRunUnbuildable`, `work_item:edit`) — the run-found report,
    // answered to a hosted run's own credential.
    // 73 with MOTIR-8722's `…/discrepancy` (`recordDispatchRunDiscrepancy`) and `…/stop`
    // (`reportDispatchRunStop`), both `work_item:edit` — a run's own credential's doors for
    // what its agent cannot call over MCP.
    // 74 with MOTIR-9029's `GET /api/v1/section-sets` (`getSectionSets`, `project:browse`) —
    // the section registry read, the same for every tenant.
    // 76 with MOTIR-9493's page create and read (`createPage` on `page:edit`, `getPage` on
    // `page:view`) — the first operations to name a `page:*` key — and 77 with MOTIR-9494's
    // `updatePage` (`page:edit`) and 78 with MOTIR-9495's `movePage` (`page:edit`).
    // 79 with MOTIR-9552's `searchPages` (`page:view`), and 83 with MOTIR-9488's
    // `archivePage`, `restorePage`, `linkPageWorkItem` and `unlinkPageWorkItem`
    // (all `page:edit`).
    expect(V1_OPERATIONS.length).toBe(83);
    for (const operation of V1_OPERATIONS) {
      expect(
        isGrantable(operation.permission),
        `${operation.operationId} requires "${operation.permission}", which no token can hold`,
      ).toBe(true);
    }
  });

  it('no declaration still names a RETIRED scope string', () => {
    const retired = [
      'read',
      'work_items:write',
      'work_items:archive',
      'work_items:delete',
      'sprints:write',
      'integration',
    ];
    for (const operation of V1_OPERATIONS) {
      expect(retired, `${operation.operationId}`).not.toContain(operation.permission as string);
    }
  });

  it('the AI-planning operations no longer hide under work-item editing', () => {
    // The narrowing this story is FOR, stated where it can fail: submitting a
    // planning job spends the owner's credits, and a token wired to file work
    // items must be able to withhold it.
    for (const id of [
      'submitWorkItemExpansion',
      'openPlanSession',
      'appendPlanTurn',
      'submitPlanSession',
    ]) {
      expect(V1_OPERATIONS.find((o) => o.operationId === id)?.permission).toBe('ai:plan');
    }
  });

  it('commenting is withholdable on its own', () => {
    expect(V1_OPERATIONS.find((o) => o.operationId === 'createWorkItemComment')?.permission).toBe(
      'comment:add',
    );
  });

  // ADR §3 had ONE exception pinned here by name —
  // `reportWorkItemImplementation`, whose declaration said `work_item:edit`
  // while its service asserted only `project:browse`. MOTIR-2603 fixed the gate
  // instead of the declaration, so the row is no longer special and its pin is
  // deleted rather than left drifting: the property it stood in for (the service
  // refuses a browse-only ACTOR) is now asserted where it actually lives, in
  // `tests/work-items/report-implementation-gate.test.ts`, against real
  // Postgres. §3's rule is total again — no exception list.
});

// MOTIR-6581 — a FIELD VOCABULARY named once. Asserted against the EMITTED
// document by literal component and property name, for the reason the header
// gives: a check that maps over the same registry the emitter reads would pass
// on a document that referenced nothing.
describe('the WorkItemObsolescence shared schema', () => {
  const document = emitOpenApiDocument();
  const schemas = (document['components'] as { schemas: Record<string, Record<string, unknown>> })
    .schemas;
  const REF = { $ref: '#/components/schemas/WorkItemObsolescence' };

  function requestBody(path: string, method: string): Record<string, unknown> {
    const paths = document['paths'] as unknown as Record<
      string,
      Record<
        string,
        { requestBody: { content: Record<string, { schema: Record<string, unknown> }> } }
      >
    >;
    return paths[path]![method]!.requestBody.content['application/json']!.schema;
  }

  it('is ONE named component carrying exactly the service’s list', () => {
    expect(schemas['WorkItemObsolescence']).toEqual({
      type: 'string',
      enum: [...WORK_ITEM_OBSOLESCENCES],
    });
    // Named ONCE: the members appear as an enum nowhere else in the document.
    const serialized = JSON.stringify(document);
    expect(serialized.split('"enum":["outdated","deprecated"]').length - 1).toBe(1);
  });

  it('is $ref’d, nullable, from the detail, the collection row and the ready row', () => {
    for (const carrier of ['WorkItemDetail', 'WorkItemSummary', 'ReadyItem']) {
      const properties = schemas[carrier]!['properties'] as Record<string, unknown>;
      expect(properties['obsolescence'], carrier).toEqual({ anyOf: [REF, { type: 'null' }] });
      expect(properties['obsolescenceNoteMd'], carrier).toEqual({
        anyOf: [{ type: 'string' }, { type: 'null' }],
      });
      // Required-and-nullable on a response: always present, `null` when unset.
      expect(schemas[carrier]!['required'], carrier).toEqual(
        expect.arrayContaining(['obsolescence', 'obsolescenceNoteMd']),
      );
    }
  });

  it('is $ref’d, optional and nullable, from the create and update bodies', () => {
    for (const [path, method] of [
      ['/api/v1/projects/{projectKey}/work-items', 'post'],
      ['/api/v1/work-items/{key}', 'patch'],
    ] as const) {
      const body = requestBody(path, method);
      const properties = body['properties'] as Record<string, unknown>;
      expect(properties['obsolescence'], path).toEqual({ anyOf: [REF, { type: 'null' }] });
      expect(properties['obsolescenceNoteMd'], path).toEqual({
        anyOf: [{ type: 'string' }, { type: 'null' }],
      });
      expect((body['required'] as string[] | undefined) ?? []).not.toContain('obsolescence');
    }
  });

  it('stays INLINED for a caller that renders a schema outside the document', () => {
    // `lib/apiDocs/reference.ts` renders request bodies on their own, with no
    // `components` to resolve a `$ref` against — the substitution is opt-in.
    const standalone = toOpenApiSchema(createWorkItemBodySchema, 'input');
    const properties = standalone['properties'] as Record<string, unknown>;
    expect(properties['obsolescence']).toEqual({
      anyOf: [{ type: 'string', enum: [...WORK_ITEM_OBSOLESCENCES] }, { type: 'null' }],
    });
  });
});
