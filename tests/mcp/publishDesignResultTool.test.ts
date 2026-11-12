import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shaFor } from '../helpers/commitShaFixtures';
import { randomBytes } from 'node:crypto';

// The blob STORE is the only thing faked, and it is faked as a STORE rather than
// as two independent stubs: `recordFromPathnames` HEADs every object it is asked
// to register, precisely so a lying, absent or cross-tenant pathname cannot be
// recorded. A `headPrivateBlob` that answered a fixed shape would make that
// check vacuous and quietly un-test the one guarantee the register half exists
// for. So `put` writes into a map and `head` reads out of it, and the size and
// media type the service acts on are the ones the bytes actually had.
const store = new Map<string, { size: number; contentType: string }>();

// ⚠️ AND THE MINT IS FAKED AS A GRANT, NOT AS A STRING (bug MOTIR-4750). The
// real `mintPrivateUploadToken` returns a presigned PUT bound to one exact key
// and one content type, and the new door's whole contract is that the agent
// uploads to the URL it was handed and publishes the pathname it was handed. So
// the fake derives the URL FROM the pathname, and `putUploaded` below refuses a
// pathname nobody granted — otherwise a test that publishes an ungranted
// pathname would pass here while the real service refused it.
const minted = new Map<string, { contentType: string; maxBytes: number }>();

// ⚠️ THE FAKE APPLIES THE SAME RANDOM SUFFIX THE REAL HELPER DOES, and that is
// not a detail. `putObject` calls `withRandomSuffix(pathname)` and
// `putPrivateAttachment` RETURNS the key it actually wrote, so a caller that
// registers the pathname it ASKED for names an object that does not exist. A
// fake returning `{ pathname }` unchanged reproduces the helper's contract
// WRONGLY and therefore agrees with that bug — which is exactly what happened
// here: these suites were green while the E2E failed on
// `DESIGN_EVIDENCE_BLOB_MISSING`. A fake that lies about a contract is worse
// than no fake.
vi.mock('@/lib/blob/uploader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/blob/uploader')>()),
  putPrivateAttachment: vi.fn(async (pathname: string, body: Buffer, contentType: string) => {
    const dot = pathname.lastIndexOf('.');
    const suffix = randomBytes(5).toString('hex');
    const written =
      dot <= pathname.lastIndexOf('/')
        ? `${pathname}-${suffix}`
        : `${pathname.slice(0, dot)}-${suffix}${pathname.slice(dot)}`;
    store.set(written, { contentType, size: body.byteLength });
    return { pathname: written };
  }),
  mintPrivateUploadToken: vi.fn(
    async (pathname: string, opts: { contentType: string; maxBytes: number }) => {
      minted.set(pathname, { contentType: opts.contentType, maxBytes: opts.maxBytes });
      return `https://store.example/signed/${encodeURIComponent(pathname)}`;
    },
  ),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  deleteAttachmentBlob: vi.fn(async () => {}),
}));

const {
  runPublishDesignResult,
  runCreateDesignUpload,
  PUBLISH_DESIGN_RESULT_TOOL_NAME,
  CREATE_DESIGN_UPLOAD_TOOL_NAME,
} = await import('@/lib/mcp/tools/publishDesignResult');
const { runAttachFile } = await import('@/lib/mcp/tools/attachFile');
const { CLI_TOKEN_GRANT, TOOL_PERMISSIONS } = await import('@/lib/mcp/toolPermissions');
const { TOOL_SCOPES } = await import('@/lib/mcp/scopes');
const { MCP_TOOL_NAMES } = await import('@/lib/mcp/registry');
const { MAX_UPLOAD_BYTES } = await import('@/lib/blob/allowlist');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { makeWorkItemFixture } = await import('../fixtures');
const { truncateAuthTables } = await import('../helpers/db');
const { adminDb } = await import('../helpers/adminDb');
const { makeWorkWaitOn } = await import('../helpers/designWaits');

// `publish_design_result` (Story MOTIR-3780 · Subtask MOTIR-3782) against real
// Postgres, with only the blob store faked.
//
// ⚠️ THE PERMISSION ASSERTION IS THE POINT OF THIS FILE, exactly as it is in
// `attachFileTool.test.ts`. A tool that publishes perfectly for an interactive
// operator and refuses the dispatched agent it was built for is an outage that
// ships green — MOTIR-3051's shape — and this whole story exists because the
// previous publisher failed in that same silent direction.

let fx: Awaited<ReturnType<typeof makeWorkItemFixture>>;

beforeEach(async () => {
  store.clear();
  minted.clear();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "design_asset", "design_evidence", "attachment", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

/**
 * A card to publish onto. A `task` gets one OPEN work item `blocked_by` it by
 * default, because AMENDMENT 4 publishes a design result only while work waits
 * on the design; pass `{ waits: false }` for the card nothing depends on.
 */
async function makeItem(
  title: string,
  kind: 'task' | 'story' = 'task',
  { waits = kind === 'task' }: { waits?: boolean } = {},
): Promise<{ key: string; id: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title },
    fx.ctx,
  );
  if (waits) await makeWorkWaitOn(item.id, fx);
  return { key: item.identifier, id: item.id };
}

/** Move a work item to a status by key — the dependent-closing half of the gate. */
async function setStatus(id: string, status: string): Promise<void> {
  await adminDb.workItem.update({ where: { id }, data: { status } });
}

/** A container with one real child — the shape both container gates need. */
async function makeContainerWithChild(title: string): Promise<{ key: string; id: string }> {
  const container = await makeItem(title, 'story');
  await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', title: 'a child', parentId: container.id },
    fx.ctx,
  );
  return container;
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

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

/** The grants a `create_design_upload` result carries, in the order asked for. */
function targets(result: { structuredContent?: unknown }): Array<Record<string, unknown>> {
  return payload(result).targets as Array<Record<string, unknown>>;
}

/** What the STORE actually holds for an asset, reached the way the panel is —
 *  through the asset's `Attachment` row, which is where the pathname lives. */
async function storedSizeOf(attachmentId: string | null): Promise<number | undefined> {
  if (attachmentId === null) return undefined;
  const attachment = await adminDb.attachment.findFirstOrThrow({ where: { id: attachmentId } });
  return store.get(attachment.blobPathname)?.size;
}

const MOCK = {
  kind: 'mock' as const,
  sourcePath: 'design/work-items/detail.mock.html',
  contentType: 'text/html',
  contentBase64: b64('<p>detail</p>'),
};
const IMAGE = {
  kind: 'image' as const,
  sourcePath: 'design/work-items/detail.png',
  contentType: 'image/png',
  contentBase64: b64('PNG\r\n'),
};
const NOTE = {
  kind: 'note_file' as const,
  sourcePath: 'design/work-items/design-notes.md',
  contentType: 'text/markdown',
  contentBase64: b64('## Detail\n\nThe whole note.\n'),
};

describe('the tool is reachable by the caller it was built for', () => {
  it('asserts its permission is one CLI_TOKEN_GRANT actually carries', () => {
    const permission = TOOL_PERMISSIONS[PUBLISH_DESIGN_RESULT_TOOL_NAME];
    expect(permission).toBe('work_item:edit');
    expect(
      CLI_TOKEN_GRANT,
      `publish_design_result requires "${permission}", which a dispatched run's token does not ` +
        'hold — the MOTIR-3051 shape, and the one this story cannot afford: the agent that just ' +
        'drew the asset is the only actor standing where the publish is possible.',
    ).toContain(permission);
  });

  it('needs NO widening of the grant — the key was already there', () => {
    // The whole argument for moving the publish out of CI rests on this: the
    // design-publish route has asserted `work_item:edit` since MOTIR-2667 and
    // the grant has carried it the whole time, so this tool adds no credential
    // and no trust. If a later diff has to widen `CLI_TOKEN_GRANT` to make this
    // tool reachable, that argument was wrong and the change deserves its own
    // justification rather than arriving inside an unrelated edit.
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

  it('is registered, and carries a WRITE scope', () => {
    expect(MCP_TOOL_NAMES).toContain(PUBLISH_DESIGN_RESULT_TOOL_NAME);
    expect(TOOL_SCOPES[PUBLISH_DESIGN_RESULT_TOOL_NAME]).toBe('work_items:write');
  });

  it('the MINT half asks for the same key and is registered too', () => {
    // ⚠️ The mint is a WRITE even though it persists no row: it hands back a
    // presigned PUT into the workspace's own object store, under this item's
    // design prefix. Declaring it a read would give out store grants on a
    // browse permission.
    expect(MCP_TOOL_NAMES).toContain(CREATE_DESIGN_UPLOAD_TOOL_NAME);
    expect(TOOL_SCOPES[CREATE_DESIGN_UPLOAD_TOOL_NAME]).toBe('work_items:write');
    expect(TOOL_PERMISSIONS[CREATE_DESIGN_UPLOAD_TOOL_NAME]).toBe(
      TOOL_PERMISSIONS[PUBLISH_DESIGN_RESULT_TOOL_NAME],
    );
    expect(
      CLI_TOKEN_GRANT,
      'the door added for the assets an agent cannot emit must be reachable by that agent',
    ).toContain(TOOL_PERMISSIONS[CREATE_DESIGN_UPLOAD_TOOL_NAME]);
  });
});

describe('one call publishes a complete result — the mock and its note file', () => {
  it('the mock and the note file land as the item’s current design result, with no inline note', async () => {
    const { key } = await makeItem('Design the detail page');

    const result = await runPublishDesignResult(
      { key, assets: [MOCK, NOTE], commitSha: shaFor('abc123'), producedByKey: key },
      fx.ctx,
    );

    expect(result.isError, JSON.stringify(result)).toBeFalsy();

    const evidence = await adminDb.designEvidence.findFirstOrThrow({
      include: { assets: true },
    });
    // AMENDMENT 4: the note is SHOWN as a link to the `note_file`, so a new row
    // stores no inline copy.
    expect(evidence.noteMd).toBeNull();
    expect(evidence.noteTruncated).toBe(false);
    expect(payload(result).noteTruncated).toBe(false);
    expect(evidence.commitSha).toBe(shaFor('abc123'));
    expect(evidence.assets.map((a) => a.kind).sort()).toEqual(['mock', 'note_file']);

    // The bytes reached the store under THIS item's design prefix — the
    // property `recordFromPathnames` refuses a publish without.
    expect(store.size).toBe(2);
    for (const pathname of store.keys()) {
      expect(pathname).toContain(`/${evidence.workItemId}/`);
      expect(pathname.startsWith('design/')).toBe(true);
    }
  });

  it('accepts SEVERAL delta mocks with their one note file', async () => {
    const { key } = await makeItem('Design a change');
    const delta = {
      ...MOCK,
      sourcePath: 'design/work-items/detail--review.mock.html',
      contentBase64: b64('<p>delta</p>'),
    };
    const result = await runPublishDesignResult({ key, assets: [MOCK, delta, NOTE] }, fx.ctx);
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    expect(await adminDb.designAsset.count({ where: { kind: 'mock' } })).toBe(2);
  });

  it('accepts a lower-cased key, like every other work-item tool', async () => {
    const { key } = await makeItem('Design');
    const result = await runPublishDesignResult(
      { key: key.toLowerCase(), assets: [MOCK, NOTE] },
      fx.ctx,
    );
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    expect(await adminDb.designEvidence.count()).toBe(1);
  });

  it('a second publish SUPERSEDES rather than accumulating a second current row', async () => {
    const { key } = await makeItem('Design');
    await runPublishDesignResult({ key, assets: [MOCK, NOTE], commitSha: shaFor('one') }, fx.ctx);
    await runPublishDesignResult({ key, assets: [MOCK, NOTE], commitSha: shaFor('two') }, fx.ctx);

    const rows = await adminDb.designEvidence.findMany();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.isCurrent)).toHaveLength(1);
    expect(rows.find((r) => r.isCurrent)!.commitSha).toBe(shaFor('two'));
  });

  it('is idempotent on the commit — a retry returns the existing result', async () => {
    const { key } = await makeItem('Design');
    await runPublishDesignResult(
      { key, assets: [MOCK, NOTE], commitSha: shaFor('same'), producedByKey: key },
      fx.ctx,
    );
    await runPublishDesignResult(
      { key, assets: [MOCK, NOTE], commitSha: shaFor('same'), producedByKey: key },
      fx.ctx,
    );
    expect(await adminDb.designEvidence.count()).toBe(1);
  });
});

// ── AMENDMENT 4 (MOTIR-5491): what a result IS, and when it may exist ───────
describe('a result is the mock(s) and ONE note file — the retired inputs are refused BY NAME', () => {
  it('refuses an `image` asset, naming it, having written nothing', async () => {
    const { key } = await makeItem('Design');
    const result = await runPublishDesignResult({ key, assets: [MOCK, IMAGE, NOTE] }, fx.ctx);
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result);
    expect(text).toContain('DESIGN_EVIDENCE_IMAGE_RETIRED');
    expect(text).toContain('design/work-items/detail.png');
    expect(store.size, 'refused before the upload').toBe(0);
    expect(await adminDb.designEvidence.count()).toBe(0);
  });

  it('refuses a `noteMd` — even an empty one — rather than ignoring it', async () => {
    const { key } = await makeItem('Design');
    for (const noteMd of ['## Detail\n\nWhat changed.\n', '']) {
      const result = await runPublishDesignResult({ key, assets: [MOCK, NOTE], noteMd }, fx.ctx);
      expect(result.isError, `noteMd=${JSON.stringify(noteMd)}`).toBe(true);
      expect(JSON.stringify(result)).toContain('DESIGN_EVIDENCE_NOTE_MD_RETIRED');
    }
    expect(await adminDb.designEvidence.count()).toBe(0);
  });

  it('refuses a publish with no mock', async () => {
    const { key } = await makeItem('Design');
    const result = await runPublishDesignResult({ key, assets: [NOTE] }, fx.ctx);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('DESIGN_EVIDENCE_MOCK_REQUIRED');
  });

  it('refuses zero note files, and two', async () => {
    const { key } = await makeItem('Design');
    const none = await runPublishDesignResult({ key, assets: [MOCK] }, fx.ctx);
    expect(JSON.stringify(none)).toContain('DESIGN_EVIDENCE_NOTE_FILE_REQUIRED');
    const two = await runPublishDesignResult(
      { key, assets: [MOCK, NOTE, { ...NOTE, sourcePath: 'design/x/other.design-notes.md' }] },
      fx.ctx,
    );
    expect(JSON.stringify(two)).toContain('DESIGN_EVIDENCE_NOTE_FILE_REQUIRED');
    expect(await adminDb.designEvidence.count()).toBe(0);
  });

  it('the MINT refuses an `image` grant, granting nothing', async () => {
    const item = await makeItem('Design');
    const result = await runCreateDesignUpload(
      {
        key: item.key,
        files: [
          { kind: 'mock', sourcePath: 'design/x/x.mock.html', contentType: 'text/html' },
          { kind: 'image', sourcePath: 'design/x/x.png', contentType: 'image/png' },
        ],
      },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('DESIGN_EVIDENCE_IMAGE_RETIRED');
    expect(minted.size).toBe(0);
  });
});

describe('a result is published ONLY while an open work item is `blocked_by` the design', () => {
  it('refuses a card nothing waits on — publish AND mint', async () => {
    const { key } = await makeItem('A design fixed in place', 'task', { waits: false });

    const published = await runPublishDesignResult({ key, assets: [MOCK, NOTE] }, fx.ctx);
    expect(published.isError).toBe(true);
    expect(JSON.stringify(published)).toContain('DESIGN_EVIDENCE_NOTHING_WAITS');
    expect(store.size, 'refused before any upload').toBe(0);

    const grant = await runCreateDesignUpload(
      {
        key,
        files: [{ kind: 'mock', sourcePath: 'design/x/x.mock.html', contentType: 'text/html' }],
      },
      fx.ctx,
    );
    expect(grant.isError).toBe(true);
    expect(JSON.stringify(grant)).toContain('DESIGN_EVIDENCE_NOTHING_WAITS');
    expect(minted.size).toBe(0);
    expect(await adminDb.designEvidence.count()).toBe(0);
    expect(await adminDb.approvalGate.count()).toBe(0);
  });

  it('refuses when every dependent is `done` or `cancelled` — the done CATEGORY', async () => {
    const design = await makeItem('Design', 'task', { waits: false });
    const done = await makeWorkWaitOn(design.id, fx, { title: 'shipped' });
    const cancelled = await makeWorkWaitOn(design.id, fx, { title: 'abandoned' });
    await setStatus(done.id, 'done');
    await setStatus(cancelled.id, 'cancelled');

    const result = await runPublishDesignResult({ key: design.key, assets: [MOCK, NOTE] }, fx.ctx);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('DESIGN_EVIDENCE_NOTHING_WAITS');
  });

  it('refuses when the only dependent is ARCHIVED', async () => {
    const design = await makeItem('Design', 'task', { waits: false });
    const archived = await makeWorkWaitOn(design.id, fx);
    await adminDb.workItem.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });

    const result = await runPublishDesignResult({ key: design.key, assets: [MOCK, NOTE] }, fx.ctx);
    expect(JSON.stringify(result)).toContain('DESIGN_EVIDENCE_NOTHING_WAITS');
  });

  it('accepts a `todo` dependent under ANOTHER story, and raises the gate as before', async () => {
    // The design hangs under a story of its own, so the dependent under ANOTHER
    // story sits at its depth — a same-level edge across parents (MOTIR-6411).
    const designStory = await makeItem('Design story', 'story');
    const designDto = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Design', parentId: designStory.id },
      fx.ctx,
    );
    const design = { key: designDto.identifier, id: designDto.id };
    const otherStory = await makeItem('Another story', 'story');
    await makeWorkWaitOn(design.id, fx, {
      kind: 'task',
      parentId: otherStory.id,
      title: 'Build it, elsewhere',
    });

    const result = await runPublishDesignResult({ key: design.key, assets: [MOCK, NOTE] }, fx.ctx);
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    expect(
      await adminDb.approvalGate.count({
        where: { workItemId: design.id, kind: 'design_result', state: 'awaiting' },
      }),
    ).toBe(1);
  });

  it('refuses a REPUBLISH once the last dependent has closed, leaving the earlier result alone', async () => {
    const design = await makeItem('Design', 'task', { waits: false });
    const dependent = await makeWorkWaitOn(design.id, fx);
    const first = await runPublishDesignResult(
      { key: design.key, assets: [MOCK, NOTE], commitSha: shaFor('one') },
      fx.ctx,
    );
    expect(first.isError, JSON.stringify(first)).toBeFalsy();

    await setStatus(dependent.id, 'done');
    const again = await runPublishDesignResult(
      { key: design.key, assets: [MOCK, NOTE], commitSha: shaFor('two') },
      fx.ctx,
    );
    expect(JSON.stringify(again)).toContain('DESIGN_EVIDENCE_NOTHING_WAITS');
    const rows = await adminDb.designEvidence.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isCurrent).toBe(true);
    expect(rows[0]!.commitSha).toBe(shaFor('one'));
  });

  it('a dependent that closes BETWEEN the mint and the publish is seen — the refusal wins', async () => {
    const design = await makeItem('Design', 'task', { waits: false });
    const dependent = await makeWorkWaitOn(design.id, fx);
    const grant = await runCreateDesignUpload(
      {
        key: design.key,
        files: [
          { kind: 'mock', sourcePath: 'design/x/x.mock.html', contentType: 'text/html' },
          {
            kind: 'note_file',
            sourcePath: 'design/x/design-notes.md',
            contentType: 'text/markdown',
          },
        ],
      },
      fx.ctx,
    );
    expect(grant.isError, JSON.stringify(grant)).toBeFalsy();
    const [mockTarget, noteTarget] = targets(grant);
    putUploaded(mockTarget!.pathname as string, 1_000);
    putUploaded(noteTarget!.pathname as string, 100);

    await setStatus(dependent.id, 'done');
    const result = await runPublishDesignResult(
      {
        key: design.key,
        assets: [
          {
            kind: 'mock',
            sourcePath: 'design/x/x.mock.html',
            pathname: mockTarget!.pathname as string,
          },
          {
            kind: 'note_file',
            sourcePath: 'design/x/design-notes.md',
            pathname: noteTarget!.pathname as string,
          },
        ],
      },
      fx.ctx,
    );
    expect(JSON.stringify(result)).toContain('DESIGN_EVIDENCE_NOTHING_WAITS');
    expect(await adminDb.designEvidence.count()).toBe(0);
  });
});

// ── bug MOTIR-4750: the door for an asset an agent cannot emit ──────────────
//
// The inline form is fine for a note file and a small mock and stays the
// default. It is not reachable for a large asset: the MCP route is a serverless
// function capped around 4.5 MB, base64 is 1.37x the file, and — the limit no cap
// change can lift — the bytes have to be EMITTED by a model as a tool argument, at
// ~0.4 base64 characters per token.
describe('mint → upload → publish carries an asset the inline form cannot', () => {
  it('the two forms reach the SAME panel — one uploaded, one inline', async () => {
    const uploaded = await makeItem('Design, published from grants');
    const inline = await makeItem('Design, published inline');

    const grant = await runCreateDesignUpload(
      {
        key: uploaded.key,
        files: [
          {
            kind: 'mock',
            sourcePath: 'design/ai-chat/planning-workspace.mock.html',
            contentType: 'text/html',
          },
          {
            kind: 'note_file',
            sourcePath: 'design/ai-chat/design-notes.md',
            contentType: 'text/markdown',
          },
        ],
      },
      fx.ctx,
    );
    expect(grant.isError, JSON.stringify(grant)).toBeFalsy();
    const [mockTarget, noteTarget] = targets(grant);

    // One grant per file, in the order asked for, each bound to its own media
    // type and carrying the cap up front.
    expect(targets(grant)).toHaveLength(2);
    expect(mockTarget!.contentType).toBe('text/html');
    expect(noteTarget!.contentType).toBe('text/markdown');
    expect(mockTarget!.uploadUrl).toContain('https://store.example/signed/');
    expect(mockTarget!.maxBytes).toBe(MAX_UPLOAD_BYTES);
    // Under THIS item's design prefix, which is what makes the register half's
    // prefix check meaningful rather than decorative.
    expect(mockTarget!.pathname as string).toContain(`/${uploaded.id}/`);

    // The agent's own PUT. Nothing about this step goes through Motir.
    putUploaded(mockTarget!.pathname as string, 3_929_899);
    putUploaded(noteTarget!.pathname as string, 48_120);

    const published = await runPublishDesignResult(
      {
        key: uploaded.key,
        assets: [
          {
            kind: 'mock',
            sourcePath: 'design/ai-chat/planning-workspace.mock.html',
            pathname: mockTarget!.pathname as string,
          },
          {
            kind: 'note_file',
            sourcePath: 'design/ai-chat/design-notes.md',
            pathname: noteTarget!.pathname as string,
          },
        ],
        commitSha: 'ba5eba11',
      },
      fx.ctx,
    );
    expect(published.isError, JSON.stringify(published)).toBeFalsy();

    // …and the inline form still publishes, unchanged.
    const inlineResult = await runPublishDesignResult(
      { key: inline.key, assets: [MOCK, NOTE] },
      fx.ctx,
    );
    expect(inlineResult.isError, JSON.stringify(inlineResult)).toBeFalsy();

    // BOTH reached the panel's read — the same current row, the same asset kinds.
    for (const item of [uploaded, inline]) {
      const evidence = await adminDb.designEvidence.findFirstOrThrow({
        where: { workItemId: item.id, isCurrent: true },
        include: { assets: true },
      });
      expect(evidence.assets.map((a) => a.kind).sort()).toEqual(['mock', 'note_file']);
    }

    // The store holds the mock as `text/html` on the UPLOADED path too — §5's
    // one-entrance guarantee is a property of the design path, not of the
    // inline form.
    expect(store.get(mockTarget!.pathname as string)!.contentType).toBe('text/html');
  });

  it('publishes an asset whose INLINE argument would be larger than the per-file cap ITSELF', async () => {
    // ⚠️ ASSERTED BY SIZE, against the repository's own constant: base64 inflates
    // by 4/3, so an asset whose ENCODED form exceeds `MAX_UPLOAD_BYTES` could not
    // be sent as a tool argument under any reading of the limits.
    const item = await makeItem('Design a large mock');
    const sizeBytes = Math.ceil((MAX_UPLOAD_BYTES * 3) / 4) + 1_024;
    expect(
      Math.ceil(sizeBytes / 3) * 4,
      'the fixture must be one the inline form genuinely cannot carry',
    ).toBeGreaterThan(MAX_UPLOAD_BYTES);

    const grant = await runCreateDesignUpload(
      {
        key: item.key,
        files: [
          { kind: 'mock', sourcePath: 'design/ai-chat/board.mock.html', contentType: 'text/html' },
          {
            kind: 'note_file',
            sourcePath: 'design/ai-chat/design-notes.md',
            contentType: 'text/markdown',
          },
        ],
      },
      fx.ctx,
    );
    const [target, note] = targets(grant);
    putUploaded(target!.pathname as string, sizeBytes);
    putUploaded(note!.pathname as string, 1_000);

    const published = await runPublishDesignResult(
      {
        key: item.key,
        assets: [
          {
            kind: 'mock',
            sourcePath: 'design/ai-chat/board.mock.html',
            pathname: target!.pathname as string,
          },
          {
            kind: 'note_file',
            sourcePath: 'design/ai-chat/design-notes.md',
            pathname: note!.pathname as string,
          },
        ],
      },
      fx.ctx,
    );
    expect(published.isError, JSON.stringify(published)).toBeFalsy();

    // The size recorded is the STORE's, and nothing in either call reported it.
    const asset = await adminDb.designAsset.findFirstOrThrow({ where: { kind: 'mock' } });
    const attachment = await adminDb.attachment.findFirstOrThrow({
      where: { id: asset.attachmentId! },
    });
    expect(attachment.sizeBytes).toBe(sizeBytes);
    expect(attachment.sizeBytes).toBeLessThanOrEqual(MAX_UPLOAD_BYTES);
  });

  it('refuses a pathname NOBODY granted — a lying key cannot be published', async () => {
    // The register half checks every pathname against this item's prefix, so a
    // pathname outside it is refused before any row is written.
    const item = await makeItem('Design');
    const result = await runPublishDesignResult(
      {
        key: item.key,
        assets: [
          {
            kind: 'mock',
            sourcePath: 'design/x/x.mock.html',
            pathname: 'design/some-other-workspace/some-other-item/stolen.mock.html',
          },
          {
            kind: 'note_file',
            sourcePath: 'design/x/design-notes.md',
            pathname: 'design/some-other-workspace/some-other-item/stolen.md',
          },
        ],
      },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('DESIGN_EVIDENCE');
    expect(await adminDb.designEvidence.count()).toBe(0);
  });

  it('the mint re-uses the publish’s own gates — a CONTAINER target is refused', async () => {
    const container = await makeContainerWithChild('A story');
    const result = await runCreateDesignUpload(
      {
        key: container.key,
        files: [{ kind: 'mock', sourcePath: 'design/x/x.mock.html', contentType: 'text/html' }],
      },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('DESIGN_EVIDENCE_NOT_A_LEAF');
    expect(minted.size, 'no grant may be minted for a target that cannot own a result').toBe(0);
  });

  it('the mint refuses a media type outside the design allowlist, granting nothing', async () => {
    const item = await makeItem('Design');
    const result = await runCreateDesignUpload(
      {
        key: item.key,
        files: [
          { kind: 'mock', sourcePath: 'design/x/x.exe', contentType: 'application/x-msdownload' },
        ],
      },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('UNSUPPORTED_FILE_TYPE');
    expect(minted.size).toBe(0);
  });
});

describe('one publish uses ONE form for all of its assets', () => {
  it('refuses a MIX of inline and uploaded assets, naming the counts', async () => {
    const item = await makeItem('Design');
    const grant = await runCreateDesignUpload(
      {
        key: item.key,
        files: [
          {
            kind: 'note_file',
            sourcePath: 'design/x/design-notes.md',
            contentType: 'text/markdown',
          },
        ],
      },
      fx.ctx,
    );
    const [target] = targets(grant);
    putUploaded(target!.pathname as string, 2_000);

    const result = await runPublishDesignResult(
      {
        key: item.key,
        assets: [
          MOCK,
          {
            kind: 'note_file',
            sourcePath: 'design/x/design-notes.md',
            pathname: target!.pathname as string,
          },
        ],
      },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('MIXED_ASSET_SOURCES');
    expect(JSON.stringify(result), 'the refusal must name the fix').toContain(
      CREATE_DESIGN_UPLOAD_TOOL_NAME,
    );
    expect(await adminDb.designEvidence.count()).toBe(0);
  });

  it('refuses an asset carrying BOTH forms, naming which one', async () => {
    const item = await makeItem('Design');
    const result = await runPublishDesignResult(
      { key: item.key, assets: [{ ...MOCK, pathname: 'design/a/b/c.mock.html' }, NOTE] },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result);
    expect(text).toContain('AMBIGUOUS_ASSET_SOURCE');
    expect(text).toContain('design/work-items/detail.mock.html');
  });

  it('refuses an asset carrying NEITHER form, and points at the mint', async () => {
    const item = await makeItem('Design');
    const result = await runPublishDesignResult(
      {
        key: item.key,
        assets: [{ kind: 'mock', sourcePath: 'design/x/x.mock.html', contentType: 'text/html' }],
      },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result);
    expect(text).toContain('MISSING_ASSET_SOURCE');
    expect(text).toContain(CREATE_DESIGN_UPLOAD_TOOL_NAME);
  });

  it('refuses inline bytes with no declared media type — the store cannot be asked', async () => {
    const item = await makeItem('Design');
    const result = await runPublishDesignResult(
      {
        key: item.key,
        assets: [
          { kind: 'mock', sourcePath: 'design/x/x.mock.html', contentBase64: b64('<p>x</p>') },
          NOTE,
        ],
      },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('MISSING_CONTENT_TYPE');
    expect(store.size).toBe(0);
  });
});

describe('`text/html` reaches the design path and ONLY the design path', () => {
  // §5 of `design-result.md`: a mock is HTML rendered to a signed-in user, so
  // the whole posture rests on that media type being reachable through exactly
  // one path. Both halves are asserted together, in one file, because the risk
  // is not that either changes — it is that they drift APART.
  it('the design publisher ACCEPTS it', async () => {
    const { key } = await makeItem('Design');
    const result = await runPublishDesignResult({ key, assets: [MOCK, NOTE] }, fx.ctx);
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    expect(await adminDb.designAsset.count({ where: { kind: 'mock' } })).toBe(1);
  });

  it('`attach_file` STILL refuses it — this card did not widen the generic allowlist', async () => {
    const { key } = await makeItem('Research');
    const result = await runAttachFile(
      {
        key,
        filename: 'sneaky.mock.html',
        contentType: 'text/html',
        contentBase64: b64('<p>x</p>'),
      },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    expect(await adminDb.attachment.count()).toBe(0);
  });
});

describe('it re-implements no gate — the service refuses and the tool REPORTS', () => {
  it('a CONTAINER target is a typed refusal, not a 500', async () => {
    const parent = await makeContainerWithChild('A story');

    const result = await runPublishDesignResult({ key: parent.key, assets: [MOCK, NOTE] }, fx.ctx);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('DESIGN_EVIDENCE_NOT_A_LEAF');
    expect(await adminDb.designEvidence.count()).toBe(0);
  });

  it('a key that is not a CHILD of the declared container is refused', async () => {
    const container = await makeContainerWithChild('The parent run’s story');
    const stranger = await makeItem('Somebody else’s card');

    const result = await runPublishDesignResult(
      { key: stranger.key, assets: [MOCK, NOTE], withinParentKey: container.key },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('DESIGN_EVIDENCE_NOT_A_CHILD');
    expect(await adminDb.designEvidence.count()).toBe(0);
  });

  it('a media type outside the DESIGN allowlist is refused, having written nothing', async () => {
    const { key } = await makeItem('Design');
    const result = await runPublishDesignResult(
      {
        key,
        assets: [
          {
            kind: 'mock',
            sourcePath: 'design/x/x.exe',
            contentType: 'application/x-msdownload',
            contentBase64: b64('MZ'),
          },
          NOTE,
        ],
      },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('UNSUPPORTED_FILE_TYPE');
    // The refusal came BEFORE the upload — the property the minted path cannot
    // have, because a presigned PUT is bounded only after the object lands.
    expect(store.size).toBe(0);
  });

  it('an EMPTY asset list is a typed refusal', async () => {
    const { key } = await makeItem('Design');
    const result = await runPublishDesignResult({ key, assets: [] }, fx.ctx);
    expect(result.isError).toBe(true);
    expect(await adminDb.designEvidence.count()).toBe(0);
  });

  it('an unknown key reads not-found, and writes nothing anywhere', async () => {
    const result = await runPublishDesignResult(
      { key: 'PROD-99999', assets: [MOCK, NOTE] },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    expect(store.size).toBe(0);
    expect(await adminDb.designEvidence.count()).toBe(0);
  });
});

describe('the base64 argument is validated, not salvaged', () => {
  // ⚠️ `Buffer.from(s, 'base64')` never throws — it DISCARDS characters outside
  // the alphabet. Salvaging here is worse than on an attachment: the garbage
  // would publish as a real design result, with a real evidence id, under a
  // green check, and fail only when a reviewer opens the panel.
  it('refuses a payload that is not base64, naming WHICH asset', async () => {
    const { key } = await makeItem('Design');
    const result = await runPublishDesignResult(
      { key, assets: [NOTE, { ...MOCK, contentBase64: '<p>not base64 !!' }] },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result);
    expect(text).toContain('INVALID_BASE64');
    expect(text, 'a several-asset publish should not have to be bisected').toContain(
      'design/work-items/detail.mock.html',
    );
    // Refused before ANY asset was written, including the valid one ahead of it.
    expect(store.size).toBe(0);
    expect(await adminDb.designEvidence.count()).toBe(0);
  });

  it('round-trips bytes EXACTLY — the stored size is the sent size', async () => {
    const { key } = await makeItem('Design');
    const bytes = 'binary bytesÿ';
    await runPublishDesignResult(
      {
        key,
        assets: [
          {
            kind: 'mock',
            sourcePath: 'design/x/x.mock.html',
            contentType: 'text/html',
            contentBase64: Buffer.from(bytes, 'binary').toString('base64'),
          },
          NOTE,
        ],
      },
      fx.ctx,
    );
    const asset = await adminDb.designAsset.findFirstOrThrow({ where: { kind: 'mock' } });
    expect(await storedSizeOf(asset.attachmentId)).toBe(Buffer.from(bytes, 'binary').length);
  });
});
