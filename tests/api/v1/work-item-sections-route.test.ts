import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { POST } from '@/app/api/v1/projects/[projectKey]/work-items/route';
import { PATCH } from '@/app/api/v1/work-items/[key]/route';
import { resetRateLimitStore } from '@/lib/api/v1/rateLimit';
import { db } from '@/lib/db';
import { renderSections } from '@/lib/workItems/sections/render';
import type { WorkItemSections } from '@/lib/workItems/sections/registry';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// The v1 write pair takes `sections` (Story MOTIR-9023 · MOTIR-9031), end to end
// through `withV1Route` against real Postgres: POST and PATCH check and render
// it, a missing section answers 422 `INVALID_SECTIONS` naming it in `sections`,
// and `sections` beside `descriptionMd` answers 422
// `SECTIONS_AND_DESCRIPTION_CONFLICT`.

const BASE = 'http://localhost:3000/api/v1';
const EDITOR = ['project:browse', 'work_item:edit'] as const;

const LEAF: WorkItemSections = {
  framing: 'Add the export button.',
  scopeBoundary: 'Only the toolbar.',
  acceptanceCriteria: ['The button downloads a CSV.'],
  contextRefs: [{ ref: 'components/Toolbar.tsx', why: 'where the button lives' }],
};

beforeEach(async () => {
  await truncateAuthTables();
  resetRateLimitStore();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function create(c: V1ProjectCaller, body: unknown): Promise<Response> {
  return POST(
    new Request(`${BASE}/projects/${c.projectKey}/work-items`, {
      method: 'POST',
      headers: { ...c.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ projectKey: c.projectKey }) },
  );
}

function patch(c: V1ProjectCaller, key: string, body: unknown): Promise<Response> {
  return PATCH(
    new Request(`${BASE}/work-items/${key}`, {
      method: 'PATCH',
      headers: { ...c.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key }) },
  );
}

describe('POST /projects/{key}/work-items with sections', () => {
  it('renders the sections into descriptionMd', async () => {
    const c = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const res = await create(c, { kind: 'task', title: 'Export', type: 'code', sections: LEAF });
    const body = (await res.json()) as { descriptionMd: string };
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(body.descriptionMd).toBe(renderSections('task', 'code', LEAF));
  });

  it('answers 422 INVALID_SECTIONS naming the missing section', async () => {
    const c = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const { acceptanceCriteria: _omitted, ...without } = LEAF;
    const res = await create(c, { kind: 'task', title: 'x', type: 'code', sections: without });
    const body = (await res.json()) as {
      code: string;
      sections: { missing: string[]; unknown: string[]; invalid: unknown[] };
    };
    expect(res.status).toBe(422);
    expect(body.code).toBe('INVALID_SECTIONS');
    expect(body.sections.missing).toContain('acceptanceCriteria');
    expect(await adminDb.workItem.count()).toBe(0);
  });

  it('answers 422 SECTIONS_AND_DESCRIPTION_CONFLICT for both fields, writing nothing', async () => {
    const c = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const res = await create(c, {
      kind: 'task',
      title: 'x',
      type: 'code',
      sections: LEAF,
      descriptionMd: 'free text',
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('SECTIONS_AND_DESCRIPTION_CONFLICT');
    expect(await adminDb.workItem.count()).toBe(0);
  });

  it('a sections value that is not an object is INVALID_SECTIONS', async () => {
    const c = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const res = await create(c, { kind: 'task', title: 'x', type: 'code', sections: 'nope' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_SECTIONS');
  });
});

describe('PATCH /work-items/{key} with sections', () => {
  async function seed(c: V1ProjectCaller): Promise<string> {
    const res = await create(c, { kind: 'task', title: 'Export', type: 'code', sections: LEAF });
    return ((await res.json()) as { key: string }).key;
  }

  it('merges a sparse patch over the stored body', async () => {
    const c = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const key = await seed(c);
    const res = await patch(c, key, { sections: { scopeBoundary: 'Also the menu.' } });
    const body = (await res.json()) as { descriptionMd: string };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.descriptionMd).toBe(
      renderSections('task', 'code', { ...LEAF, scopeBoundary: 'Also the menu.' }),
    );
  });

  it('checks against the NEW cell when it changes the type in the same patch', async () => {
    const c = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const key = await seed(c);
    const res = await patch(c, key, { type: 'decision', sections: { framing: 'Now a decision.' } });
    const body = (await res.json()) as { code: string; sections: { missing: string[] } };
    expect(res.status).toBe(422);
    expect(body.code).toBe('INVALID_SECTIONS');
    expect(body.sections.missing).toContain('alternatives');
  });

  it('answers 422 SECTIONS_AND_DESCRIPTION_CONFLICT for both fields', async () => {
    const c = await createV1ProjectCaller({ permissions: [...EDITOR] });
    const key = await seed(c);
    const res = await patch(c, key, { sections: { framing: 'f' }, descriptionMd: 'free' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('SECTIONS_AND_DESCRIPTION_CONFLICT');
  });
});
