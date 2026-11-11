import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/blob/uploader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/blob/uploader')>()),
  putPrivateAttachment: vi.fn(async (pathname: string) => ({ pathname })),
  deleteAttachmentBlob: vi.fn(async () => {}),
}));

const { runAttachFile, ATTACH_FILE_TOOL_NAME } = await import('@/lib/mcp/tools/attachFile');
const { CLI_TOKEN_GRANT, TOOL_PERMISSIONS } = await import('@/lib/mcp/toolPermissions');
const { TOOL_SCOPES } = await import('@/lib/mcp/scopes');
const { MCP_TOOL_NAMES } = await import('@/lib/mcp/registry');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { makeWorkItemFixture } = await import('../fixtures');
const { truncateAuthTables } = await import('../helpers/db');
const { adminDb } = await import('../helpers/adminDb');

// `attach_file` (Story MOTIR-3000 · Subtask MOTIR-3058) against real Postgres,
// with only the blob STORE mocked.
//
// ⚠️ THE PERMISSION ASSERTION IS THE POINT OF THIS FILE. Everything else here
// is ordinary adapter coverage; the grant test is the one that would have caught
// MOTIR-3051, where a tool shipped asserting a permission the dispatched
// agent's own token does not hold — perfect for an interactive operator, and
// unreachable from the run it was built for.

let fx: Awaited<ReturnType<typeof makeWorkItemFixture>>;

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "attachment", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

async function makeItem(title: string): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return item.identifier;
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('the tool is reachable by the caller it was built for', () => {
  it('asserts its permission is one CLI_TOKEN_GRANT actually carries', () => {
    const permission = TOOL_PERMISSIONS[ATTACH_FILE_TOOL_NAME];
    expect(permission).toBe('work_item:edit');
    expect(
      CLI_TOKEN_GRANT,
      `attach_file requires "${permission}", which a dispatched run's token does not hold — ` +
        'the MOTIR-3051 shape: a tool that works for an operator and not for the agent.',
    ).toContain(permission);
  });

  it('CLI_TOKEN_GRANT is PINNED — widening it is a deliberate, stated change', () => {
    // If a future edit needs to widen the grant, it is a deliberate, stated
    // change with its own justification — not something that arrives inside an
    // unrelated diff. Pinning it here makes that visible at the point of change.
    //
    // ⚠️ THE PIN HAS SINCE FIRED ONCE, AND THAT IS THE MECHANISM WORKING RATHER
    // THAN A REASON TO LOOSEN IT. This test was written as "UNCHANGED by this
    // card" for MOTIR-3058, whose card did not widen the grant. MOTIR-3480 did:
    // `search_lessons` is gated on `lesson:view`, and a sandboxed run holding
    // every other key would have got a refusal it would read as an outage. That
    // card carries the argument (at the constant, and in `token-permissions.md`
    // §3 / MOTIR-3051's AC 4 terms), so the pin was updated WITH it — which is
    // exactly the "deliberate, stated change" the comment above asks for.
    //
    // Renamed because the old title asserted something no longer true. The pin
    // itself is unchanged in kind: it still fails for the NEXT diff that widens
    // this set without saying so.
    //
    // ⚠️ The ORDER is catalog order, not append order — the device flow's wire
    // `scope` string is normalized to it, so the array is declared that way (see
    // the header on `CLI_TOKEN_GRANT`).
    expect([...CLI_TOKEN_GRANT]).toEqual([
      'project:browse',
      'lesson:view',
      // MOTIR-3553 — the FOURTH deliberate widening of this grant, and the
      // second for the lesson corpus. `search_lessons` let a dispatched run READ
      // what went wrong before; this lets it say that one of those lessons
      // described what just went wrong. Without it the corpus decays on a timer
      // no amount of use resets. Additive, idempotent, and unable to change or
      // retire a lesson — which is why it is its own key and not `lesson:manage`.
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
      // MOTIR-11038 — `repository:manage`, for `create_project_repository`: an init
      // card's agent creates the repository its card declares. The argument and the
      // measured blast radius are at the constant.
      'repository:manage',
      'ai:plan',
    ]);
  });

  it('is registered, and carries a WRITE scope', () => {
    expect(MCP_TOOL_NAMES).toContain(ATTACH_FILE_TOOL_NAME);
    expect(TOOL_SCOPES[ATTACH_FILE_TOOL_NAME]).toBe('work_items:write');
  });
});

describe('it attaches through the ONE service path', () => {
  it('writes an `api` row attributed to the token owner and reports it back', async () => {
    const key = await makeItem('Research');

    const result = await runAttachFile(
      {
        key,
        filename: 'findings.md',
        contentType: 'text/markdown',
        contentBase64: b64('# Findings\n'),
      },
      fx.ctx,
    );

    expect(result.isError).toBeFalsy();
    const rows = await adminDb.attachment.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('api');
    expect(rows[0]!.uploaderUserId).toBe(fx.ownerId);
    expect(rows[0]!.originalFilename).toBe('findings.md');
    expect(rows[0]!.sizeBytes).toBe(Buffer.byteLength('# Findings\n'));
  });

  it('accepts a lower-cased key, like every other work-item tool', async () => {
    const key = await makeItem('Research');
    const result = await runAttachFile(
      {
        key: key.toLowerCase(),
        filename: 'a.md',
        contentType: 'text/markdown',
        contentBase64: b64('x'),
      },
      fx.ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(await adminDb.attachment.count()).toBe(1);
  });
});

describe('it re-implements no gate — the service refuses and the tool reports', () => {
  it('a disallowed media type', async () => {
    const key = await makeItem('Research');
    const result = await runAttachFile(
      { key, filename: 'x.exe', contentType: 'application/x-msdownload', contentBase64: b64('MZ') },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('UNSUPPORTED_FILE_TYPE');
    expect(await adminDb.attachment.count()).toBe(0);
  });

  it('`text/html` is refused — a design mock has its own publisher', async () => {
    const key = await makeItem('Research');
    const result = await runAttachFile(
      { key, filename: 'm.mock.html', contentType: 'text/html', contentBase64: b64('<p>x</p>') },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    expect(await adminDb.attachment.count()).toBe(0);
  });

  it('an unknown key is not-found, and writes nothing', async () => {
    const result = await runAttachFile(
      {
        key: 'PROD-99999',
        filename: 'a.md',
        contentType: 'text/markdown',
        contentBase64: b64('x'),
      },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    expect(await adminDb.attachment.count()).toBe(0);
  });
});

describe('the base64 argument is validated, not salvaged', () => {
  // ⚠️ `Buffer.from(s, 'base64')` never throws — it DISCARDS characters outside
  // the alphabet. Without an explicit check, a caller that sent a raw string by
  // mistake gets a successful upload of garbage: the file lands on the card and
  // fails only when a human opens it.
  it('refuses a payload that is not base64 at all', async () => {
    const key = await makeItem('Research');
    const result = await runAttachFile(
      { key, filename: 'a.md', contentType: 'text/markdown', contentBase64: '# not base64 !!' },
      fx.ctx,
    );
    expect(result.isError).toBe(true);
    expect(await adminDb.attachment.count()).toBe(0);
  });

  it('round-trips bytes EXACTLY — the decoded size is the sent size', async () => {
    const key = await makeItem('Research');
    const payload = 'binary\u0000bytes\u00ff';
    const encoded = Buffer.from(payload, 'binary').toString('base64');
    await runAttachFile(
      { key, filename: 'a.bin', contentType: 'application/pdf', contentBase64: encoded },
      fx.ctx,
    );
    const row = await adminDb.attachment.findFirst();
    expect(row!.sizeBytes).toBe(Buffer.from(payload, 'binary').length);
  });
});
