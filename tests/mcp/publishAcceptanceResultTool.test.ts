import { beforeEach, describe, expect, it, vi } from 'vitest';

// The object STORE is the only thing faked, and it is faked as a STORE — a map a
// `PUT` writes into and `head` reads out of — for the reason
// `publishDesignResultTool.test.ts` spells out one artifact over:
// `recordFromPathnames` HEADs every pathname it is asked to register, precisely
// so a lying, absent or cross-tenant one cannot be recorded. A `headPrivateBlob`
// answering a fixed shape would make that check vacuous and quietly un-test the
// guarantee the register half exists for.
//
// ⚠️ AND THE MINT IS FAKED AS A GRANT, NOT AS A STRING. The real
// `mintPrivateUploadToken` returns a presigned PUT URL bound to one exact key
// and one content type; the tool's whole contract is that the agent uploads to
// the URL it was handed and registers the pathname it was handed. So the fake
// derives the URL FROM the pathname, and `putUploaded` below only accepts a
// pathname that was actually minted — a test that registers a pathname nobody
// granted would otherwise pass while the real service refused it.
const store = new Map<string, { size: number; contentType: string }>();
const minted = new Map<string, { contentType: string; maxBytes: number }>();

vi.mock('@/lib/blob/uploader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/blob/uploader')>()),
  mintPrivateUploadToken: vi.fn(
    async (pathname: string, opts: { contentType: string; maxBytes: number }) => {
      minted.set(pathname, { contentType: opts.contentType, maxBytes: opts.maxBytes });
      return `https://store.example/signed/${encodeURIComponent(pathname)}`;
    },
  ),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  signedDownloadUrl: vi.fn(async (pathname: string) => `https://store.example/get/${pathname}`),
  deleteAttachmentBlob: vi.fn(async () => {}),
}));

const {
  runCreateAcceptanceUpload,
  runPublishAcceptanceResult,
  CREATE_ACCEPTANCE_UPLOAD_TOOL_NAME,
  PUBLISH_ACCEPTANCE_RESULT_TOOL_NAME,
} = await import('@/lib/mcp/tools/publishAcceptanceResult');
const { CLI_TOKEN_GRANT, TOOL_PERMISSIONS } = await import('@/lib/mcp/toolPermissions');
const { TOOL_SCOPES } = await import('@/lib/mcp/scopes');
const { MCP_TOOL_NAMES } = await import('@/lib/mcp/registry');
const { ACCEPTANCE_PUBLISH_PERMISSION } = await import('@/lib/tokens/grant');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { makeWorkItemFixture } = await import('../fixtures');
const { truncateAuthTables } = await import('../helpers/db');
const { adminDb } = await import('../helpers/adminDb');

// `create_acceptance_upload` + `publish_acceptance_result` (bug MOTIR-4704)
// against real Postgres, with only the object store faked.
//
// ⚠️ THE PERMISSION ASSERTION IS THE POINT OF THIS FILE, exactly as it is for
// the design publisher. This whole bug is an outage that shipped green — the
// documents said the agent publishes over MCP and there was nothing on MCP to
// publish with — so a tool that works for an interactive operator and refuses
// the dispatched runner it exists for would reproduce the same failure one
// layer in.

let fx: Awaited<ReturnType<typeof makeWorkItemFixture>>;

beforeEach(async () => {
  store.clear();
  minted.clear();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "acceptance_evidence", "attachment", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

async function makeItem(
  title: string,
  kind: 'story' | 'subtask' | 'task' | 'bug' = 'story',
  parentId?: string,
): Promise<{ key: string; id: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
  return { key: item.identifier, id: item.id };
}

/** Simulate the agent's own PUT: it may only write to a pathname that was
 *  actually granted, and the object it leaves is what `head` will report. */
function putUploaded(pathname: string, size: number): void {
  const grant = minted.get(pathname);
  if (!grant) throw new Error(`no grant was minted for ${pathname}`);
  store.set(pathname, { contentType: grant.contentType, size });
}

/** The structured payload of a successful tool result. */
function payload(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

describe('the tools are reachable by the caller they were built for', () => {
  it('assert a permission CLI_TOKEN_GRANT actually carries', () => {
    for (const name of [
      CREATE_ACCEPTANCE_UPLOAD_TOOL_NAME,
      PUBLISH_ACCEPTANCE_RESULT_TOOL_NAME,
    ] as const) {
      const permission = TOOL_PERMISSIONS[name];
      expect(permission).toBe('work_item:edit');
      expect(
        CLI_TOKEN_GRANT,
        `${name} requires "${permission}", which a dispatched run's token does not hold — the ` +
          'MOTIR-3051 shape, and the one this bug cannot afford twice: the agent that just ' +
          'recorded the run is the only actor standing where the publish is possible.',
      ).toContain(permission);
    }
  });

  it('ask for exactly the key the HTTP door asks for', () => {
    // Not an analogy: `ACCEPTANCE_PUBLISH_PERMISSION` IS the constant the
    // CI-authed routes gate on, so a later diff that changes one door's
    // permission and not the other's fails here rather than being discovered by
    // an agent whose publish 403s at the end of a run.
    expect(TOOL_PERMISSIONS[PUBLISH_ACCEPTANCE_RESULT_TOOL_NAME]).toBe(
      ACCEPTANCE_PUBLISH_PERMISSION,
    );
    expect(TOOL_PERMISSIONS[CREATE_ACCEPTANCE_UPLOAD_TOOL_NAME]).toBe(
      ACCEPTANCE_PUBLISH_PERMISSION,
    );
  });

  it('need NO widening of the grant — the key was already there', () => {
    // The argument for publishing from the agent rests on this. If a later diff
    // has to widen `CLI_TOKEN_GRANT` to make these tools reachable, that
    // argument was wrong and deserves its own justification rather than
    // arriving inside an unrelated edit.
    expect([...CLI_TOKEN_GRANT]).toEqual([
      'project:browse',
      'lesson:view',
      'lesson:reinforce',
      'work_item:edit',
      'comment:add',
      // MOTIR-6329 — the Plans and Runs rooms' view keys; the argument is at
      // the constant (a stated widening, not an unrelated one).
      'plan:view_any',
      'run:view_any',
      // MOTIR-7412 — the page keys, for `get_page` / `create_page` / `update_page`;
      // the argument is at the constant. `page:delete` stays out.
      'page:view',
      'page:edit',
      // MOTIR-11038 — `repository:manage`, for `create_project_repository`; the
      // argument is at the constant (a stated widening, not an unrelated one).
      'repository:manage',
      'ai:plan',
    ]);
  });

  it('are registered, and carry WRITE scopes', () => {
    for (const name of [
      CREATE_ACCEPTANCE_UPLOAD_TOOL_NAME,
      PUBLISH_ACCEPTANCE_RESULT_TOOL_NAME,
    ] as const) {
      expect(MCP_TOOL_NAMES).toContain(name);
      // ⚠️ The MINT is a write even though it persists no row: it hands back a
      // presigned PUT into the workspace's object store.
      expect(TOOL_SCOPES[name]).toBe('work_items:write');
    }
  });
});

describe('mint → upload → register puts a receipt on the story', () => {
  it('publishes the recording as the story’s current acceptance evidence', async () => {
    const story = await makeItem('Search spend reaches both surfaces');

    const grant = await runCreateAcceptanceUpload({ key: story.key }, fx.ctx);
    expect(grant.isError, JSON.stringify(grant)).toBeFalsy();
    const video = payload(grant).video as Record<string, unknown>;
    expect(video.contentType).toBe('video/webm');
    expect(video.uploadUrl).toContain('https://store.example/signed/');
    // The trace is opt-in, and not asking for one mints nothing.
    expect(payload(grant).trace).toBeNull();

    putUploaded(video.pathname as string, 5_049_987);

    const published = await runPublishAcceptanceResult(
      {
        key: story.key,
        videoPathname: video.pathname as string,
        chapters: [
          { label: 'Open the item', tSeconds: 0 },
          { label: 'Read the spend', tSeconds: 12 },
        ],
        commitSha: '1807bacd',
        producedByKey: story.key,
      },
      fx.ctx,
    );
    expect(published.isError, JSON.stringify(published)).toBeFalsy();

    const evidence = await adminDb.acceptanceEvidence.findFirstOrThrow();
    expect(evidence.workItemId).toBe(story.id);
    expect(evidence.commitSha).toBe('1807bacd');
    expect(evidence.isCurrent).toBe(true);

    // ⚠️ `pending`, and the tool SAYS so. Publishing is not accepting — a person
    // still watches it — and a caller that reads this field learns the publish
    // succeeded AND the story is not accepted, which is the whole shape of the
    // gate. The `id` is the confirmation somebody else can check.
    expect(evidence.status).toBe('pending');
    expect(payload(published).status).toBe('pending');
    expect(payload(published).id).toBe(evidence.id);
    expect(payload(published).chapterCount).toBe(2);
    expect(payload(published).workItemKey).toBe(story.key);

    // The size is the store's, never the caller's — nothing in either call
    // reported it.
    expect(payload(published).sizeBytes).toBe(5_049_987);
  });

  it('mints a second grant for the trace only when one is asked for', async () => {
    const story = await makeItem('A story with a trace');
    const grant = await runCreateAcceptanceUpload({ key: story.key, hasTrace: true }, fx.ctx);

    const trace = payload(grant).trace as Record<string, unknown>;
    expect(trace.contentType).toBe('application/zip');
    expect(trace.pathname).not.toBe((payload(grant).video as Record<string, unknown>).pathname);
  });

  it('reports the per-file cap the grant was minted with', async () => {
    // MOTIR-1911: the cap was invisible to the only caller that has to respect
    // it, which is how a receipt over the limit failed with the object store's
    // opaque error instead of a sentence. Carrying it through this tool is what
    // lets a runner refuse an over-cap clip by name.
    const story = await makeItem('A story with a big clip');
    const grant = await runCreateAcceptanceUpload({ key: story.key }, fx.ctx);
    const video = payload(grant).video as Record<string, unknown>;
    expect(video.maxBytes).toBeGreaterThan(0);
    expect(minted.get(video.pathname as string)?.maxBytes).toBe(video.maxBytes);
  });
});

describe('the receipt hangs on the STORY, whichever card recorded it', () => {
  it('resolves an E2E SUBTASK up to its parent story', async () => {
    // The card an agent is running is the E2E leaf, and that is the key it
    // holds. A receipt is a story-level artifact (Principle #18), so the leaf
    // resolves UP — the same hop the CI routes make, from the same helper.
    const story = await makeItem('The parent story');
    const leaf = await makeItem('Story E2E + acceptance video', 'subtask', story.id);

    const grant = await runCreateAcceptanceUpload({ key: leaf.key }, fx.ctx);
    const video = payload(grant).video as Record<string, unknown>;
    expect(payload(grant).workItemKey).toBe(story.key);
    putUploaded(video.pathname as string, 1024);

    const published = await runPublishAcceptanceResult(
      { key: leaf.key, videoPathname: video.pathname as string, producedByKey: leaf.key },
      fx.ctx,
    );
    expect(published.isError, JSON.stringify(published)).toBeFalsy();

    const evidence = await adminDb.acceptanceEvidence.findFirstOrThrow();
    expect(evidence.workItemId).toBe(story.id);
    expect(evidence.producedByKey).toBe(leaf.key);
    expect(payload(published).workItemKey).toBe(story.key);
  });

  it('hangs the receipt on a parentless bug that has children — a parent run on a bug (MOTIR-9209)', async () => {
    const bug = await makeItem('A bug run as a parent', 'bug');
    await makeItem('Its first subtask', 'subtask', bug.id);
    const grant = await runCreateAcceptanceUpload({ key: bug.key }, fx.ctx);
    expect(grant.isError, JSON.stringify(grant)).toBeFalsy();
    const video = payload(grant).video as Record<string, unknown>;
    expect(payload(grant).workItemKey).toBe(bug.key);
    putUploaded(video.pathname as string, 1024);

    const published = await runPublishAcceptanceResult(
      { key: bug.key, videoPathname: video.pathname as string, producedByKey: bug.key },
      fx.ctx,
    );
    expect(published.isError, JSON.stringify(published)).toBeFalsy();
    const evidence = await adminDb.acceptanceEvidence.findFirstOrThrow();
    expect(evidence.workItemId).toBe(bug.id);
  });

  it('a subtask of that bug resolves UP to the bug', async () => {
    const bug = await makeItem('A bug run as a parent', 'bug');
    const leaf = await makeItem('Its subtask', 'subtask', bug.id);
    const grant = await runCreateAcceptanceUpload({ key: leaf.key }, fx.ctx);
    expect(grant.isError, JSON.stringify(grant)).toBeFalsy();
    expect(payload(grant).workItemKey).toBe(bug.key);
  });

  it('refuses a card with no story to hang the receipt on', async () => {
    const orphan = await makeItem('A parentless task', 'task');
    const result = await runCreateAcceptanceUpload({ key: orphan.key }, fx.ctx);

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('ACCEPTANCE_EVIDENCE_NOT_A_STORY');
    // ⚠️ AND NOTHING WAS MINTED. The refusal lands before any grant is handed
    // out, which is what keeps a bad key from producing a usable presigned PUT
    // into the workspace's object store.
    expect(minted.size).toBe(0);
  });
});

describe('the register half trusts the store, not the caller', () => {
  it('refuses a pathname whose object was never uploaded', async () => {
    const story = await makeItem('A story whose upload never happened');
    const grant = await runCreateAcceptanceUpload({ key: story.key }, fx.ctx);
    const video = payload(grant).video as Record<string, unknown>;

    // The grant was minted; the PUT never happened. This is the exact shape of
    // an agent that called the second tool without doing the upload in between,
    // and it must be a sentence it can act on rather than an opaque failure.
    const result = await runPublishAcceptanceResult(
      { key: story.key, videoPathname: video.pathname as string },
      fx.ctx,
    );

    expect(result.isError).toBe(true);
    expect(await adminDb.acceptanceEvidence.count()).toBe(0);
  });

  it('refuses a pathname outside the story’s own acceptance prefix', async () => {
    const story = await makeItem('A story someone aimed at');
    await runCreateAcceptanceUpload({ key: story.key }, fx.ctx);

    // A real object, at a key this story was never granted — the cross-tenant
    // and the typo case at once.
    store.set('acceptance/somebody-else/clip.webm', {
      contentType: 'video/webm',
      size: 2048,
    });
    const result = await runPublishAcceptanceResult(
      { key: story.key, videoPathname: 'acceptance/somebody-else/clip.webm' },
      fx.ctx,
    );

    expect(result.isError).toBe(true);
    expect(await adminDb.acceptanceEvidence.count()).toBe(0);
  });

  it('is idempotent on the same commit + producer', async () => {
    const story = await makeItem('A story published twice');
    const first = await runCreateAcceptanceUpload({ key: story.key }, fx.ctx);
    const firstVideo = payload(first).video as Record<string, unknown>;
    putUploaded(firstVideo.pathname as string, 4096);
    const published = await runPublishAcceptanceResult(
      {
        key: story.key,
        videoPathname: firstVideo.pathname as string,
        commitSha: 'deadbeef',
        producedByKey: story.key,
      },
      fx.ctx,
    );

    // A retry of the SAME publish — a redelivery, or an agent unsure whether the
    // first call landed — must not leave the story with two receipts.
    const second = await runCreateAcceptanceUpload({ key: story.key }, fx.ctx);
    const secondVideo = payload(second).video as Record<string, unknown>;
    putUploaded(secondVideo.pathname as string, 4096);
    const again = await runPublishAcceptanceResult(
      {
        key: story.key,
        videoPathname: secondVideo.pathname as string,
        commitSha: 'deadbeef',
        producedByKey: story.key,
      },
      fx.ctx,
    );

    expect(again.isError, JSON.stringify(again)).toBeFalsy();
    expect(payload(again).id).toBe(payload(published).id);
    expect(await adminDb.acceptanceEvidence.count()).toBe(1);
  });
});

describe('the two allowlists do not grow toward each other', () => {
  it('refuses a design mock’s media type on the acceptance path', async () => {
    // `text/html` has exactly one entrance in the whole product — the design
    // publish — and the acceptance grant is bound to `video/webm` at mint time,
    // so there is no argument shape that could carry HTML through here. Asserted
    // in this direction as well as the other so a later widening of either list
    // fails a test rather than opening a second HTML door.
    const story = await makeItem('A story nobody may put HTML on');
    const grant = await runCreateAcceptanceUpload({ key: story.key }, fx.ctx);
    const video = payload(grant).video as Record<string, unknown>;

    expect(minted.get(video.pathname as string)?.contentType).toBe('video/webm');

    // An object that landed as HTML at that key is rejected on its AUTHORITATIVE
    // media type, read from the store rather than from the caller.
    store.set(video.pathname as string, { contentType: 'text/html', size: 64 });
    const result = await runPublishAcceptanceResult(
      { key: story.key, videoPathname: video.pathname as string },
      fx.ctx,
    );

    expect(result.isError).toBe(true);
    expect(await adminDb.acceptanceEvidence.count()).toBe(0);
  });
});

// ── The commit CITATION, on the MCP door (MOTIR-5619) ────────────────────────
// The refusal lives on the SERVICE and `toToolError` maps the abstract
// `AcceptanceEvidenceError`, so this asserts the tool surfaces it. The HTTP
// door's half is `tests/acceptance-evidence-publish-route.test.ts`.

describe('publish_acceptance_result — commitSha', () => {
  const SHA = '832026b77b2b276ae9ba028b47e603274a4072cd';

  async function grantFor(story: { key: string }) {
    const created = await runCreateAcceptanceUpload({ key: story.key }, fx.ctx);
    const video = payload(created).video as Record<string, unknown>;
    putUploaded(video.pathname as string, 4096);
    return video.pathname as string;
  }

  it('refuses a commitSha that is not a commit id, and writes no receipt', async () => {
    const story = await makeItem('A story with a bogus citation');
    const pathname = await grantFor(story);

    const result = await runPublishAcceptanceResult(
      { key: story.key, videoPathname: pathname, commitSha: 'not-a-commit' },
      fx.ctx,
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('commitSha');
    expect(await adminDb.acceptanceEvidence.count()).toBe(0);
  });

  it('stores a whitespace-padded, upper-case commitSha NORMALISED', async () => {
    const story = await makeItem('A story whose citation needs normalising');
    const pathname = await grantFor(story);

    const result = await runPublishAcceptanceResult(
      { key: story.key, videoPathname: pathname, commitSha: `  ${SHA.toUpperCase()}\n` },
      fx.ctx,
    );

    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    const row = await adminDb.acceptanceEvidence.findFirstOrThrow({
      where: { id: payload(result).id as string },
    });
    expect(row.commitSha).toBe(SHA);
  });

  // The two spellings are ONE key, so a redelivery is a no-op rather than a
  // supersede. This is the same assertion the service test makes on real
  // Postgres, made through the door an agent actually calls.
  it('a redelivery spelling the same commit differently returns the SAME receipt', async () => {
    const story = await makeItem('A story redelivered with a newline');
    const first = await runPublishAcceptanceResult(
      {
        key: story.key,
        videoPathname: await grantFor(story),
        commitSha: SHA,
        producedByKey: story.key,
      },
      fx.ctx,
    );
    expect(first.isError, JSON.stringify(first)).toBeFalsy();

    const again = await runPublishAcceptanceResult(
      {
        key: story.key,
        videoPathname: await grantFor(story),
        commitSha: `${SHA}\n`,
        producedByKey: story.key,
      },
      fx.ctx,
    );

    expect(again.isError, JSON.stringify(again)).toBeFalsy();
    expect(payload(again).id).toBe(payload(first).id);
    expect(await adminDb.acceptanceEvidence.count()).toBe(1);
  });
});
