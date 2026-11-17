import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The record page's key actions (Story MOTIR-11455 · MOTIR-11463, design
 * MOTIR-11591). The two platform routes are stubbed at their modules, so what is
 * pinned is the action's own half: the in-process POST it makes (path, params,
 * `{ key }` body, no bearer header), the result code per route answer, and that
 * only a success revalidates. The routes' own gate and refusal map are pinned by
 * their suites and by the integration gate.
 */

const link = vi.hoisted(() => vi.fn());
const remove = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock('@/app/api/platform/planner-findings/[findingId]/bug-key/route', () => ({ POST: link }));
vi.mock('@/app/api/platform/planner-findings/[findingId]/bug-key/remove/route', () => ({
  POST: remove,
}));
vi.mock('next/cache', () => ({ revalidatePath }));

const { linkKey, removeKey } =
  await import('@/app/(admin)/admin/planner-findings/_components/findingKeyActions');

function answer(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('linkKey', () => {
  it('posts { key } in-process to the link route and returns the stored key', async () => {
    link.mockResolvedValue(answer(200, { finding: { id: 'pf 1', bugKey: 'MOTIR-7' } }));
    await expect(linkKey('pf 1', 'MOTIR-7')).resolves.toEqual({
      ok: true,
      finding: { id: 'pf 1', bugKey: 'MOTIR-7' },
    });
    const [request, context] = link.mock.calls[0]! as [Request, { params: Promise<unknown> }];
    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe('/api/platform/planner-findings/pf%201/bug-key');
    expect(request.headers.get('authorization')).toBeNull();
    expect(await request.json()).toEqual({ key: 'MOTIR-7' });
    await expect(context.params).resolves.toEqual({ findingId: 'pf 1' });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/planner-findings', 'layout');
  });

  it.each(['not_a_work_item', 'record_open'] as const)(
    'maps the %s refusal and revalidates nothing',
    async (reason) => {
      link.mockResolvedValue(answer(409, { code: 'FINDING_KEY_REFUSED', reason }));
      await expect(linkKey('pf_1', 'ACME-1')).resolves.toEqual({
        ok: false,
        code: 'REFUSED',
        reason,
      });
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );

  it('maps a 400 to INVALID and a 404 to GONE', async () => {
    link.mockResolvedValueOnce(answer(400, { code: 'INVALID_REQUEST' }));
    await expect(linkKey('pf_1', 'x')).resolves.toEqual({ ok: false, code: 'INVALID' });
    link.mockResolvedValueOnce(answer(404, { code: 'NOT_FOUND' }));
    await expect(linkKey('pf_1', 'MOTIR-1')).resolves.toEqual({ ok: false, code: 'GONE' });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('is FAILED for an unknown answer, an unreadable body, a bodiless success and a throw', async () => {
    link.mockResolvedValueOnce(answer(500, { code: 'INTERNAL' }));
    link.mockResolvedValueOnce(answer(502, 'not json'));
    link.mockResolvedValueOnce(answer(200, {}));
    link.mockResolvedValueOnce(answer(409, { code: 'FINDING_KEY_REFUSED', reason: 'other' }));
    link.mockRejectedValueOnce(new Error('defect'));
    for (let i = 0; i < 5; i += 1) {
      await expect(linkKey('pf_1', 'MOTIR-1')).resolves.toEqual({ ok: false, code: 'FAILED' });
    }
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledTimes(5);
  });
});

describe('removeKey', () => {
  it('posts the shown key to the remove route; a missing key on the answer reads as none', async () => {
    remove.mockResolvedValue(answer(200, { finding: { id: 'pf_1' } }));
    await expect(removeKey('pf_1', 'MOTIR-7')).resolves.toEqual({
      ok: true,
      finding: { id: 'pf_1', bugKey: null },
    });
    const [request] = remove.mock.calls[0]! as [Request];
    expect(new URL(request.url).pathname).toBe(
      '/api/platform/planner-findings/pf_1/bug-key/remove',
    );
    expect(await request.json()).toEqual({ key: 'MOTIR-7' });
    expect(link).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledTimes(1);
  });
});
