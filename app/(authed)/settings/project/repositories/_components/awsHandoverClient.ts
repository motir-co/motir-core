import type { TenantAccountHandoverDto } from '@/lib/dto/tenantAccountHandover';

// THE WIRE OF THE AWS HOSTING HANDOVER (Story MOTIR-9800 · MOTIR-12137) — the
// five shipped routes under `/api/organizations/[orgId]/hosting/aws-handover`,
// read with plain `fetch` as the rest of the room is. Every answer is either the
// handover (`{ handover }`) or the route's typed refusal (`{ code, error }`);
// nothing here throws for a refusal, so a caller renders it in place.

/** What one call answered: the handover, or the refusal's code. */
export type HandoverAnswer =
  | { ok: true; handover: TenantAccountHandoverDto }
  | { ok: false; code: string | null };

const base = (orgId: string) =>
  `/api/organizations/${encodeURIComponent(orgId)}/hosting/aws-handover`;

async function answerOf(res: Response): Promise<HandoverAnswer> {
  const body = (await res.json().catch(() => null)) as {
    handover?: TenantAccountHandoverDto;
    code?: string;
  } | null;
  if (res.ok && body?.handover) return { ok: true, handover: body.handover };
  return { ok: false, code: typeof body?.code === 'string' ? body.code : null };
}

async function call(url: string, init?: RequestInit): Promise<HandoverAnswer> {
  try {
    return await answerOf(await fetch(url, { cache: 'no-store', ...init }));
  } catch {
    // The network failed: no code, which every caller reads as "try again".
    return { ok: false, code: null };
  }
}

const post = (url: string, body: Record<string, string>) =>
  call(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export const awsHandoverClient = {
  start: (orgId: string, input: { ownerEmail: string; githubOwner: string }) =>
    post(base(orgId), input),
  status: (orgId: string, tenantAccountId: string) =>
    call(`${base(orgId)}?tenantAccountId=${encodeURIComponent(tenantAccountId)}`),
  emailCode: (orgId: string, tenantAccountId: string, code: string) =>
    post(`${base(orgId)}/email-code`, { tenantAccountId, code }),
  recheck: (orgId: string, tenantAccountId: string) =>
    post(`${base(orgId)}/recheck`, { tenantAccountId }),
  retry: (orgId: string, tenantAccountId: string) =>
    post(`${base(orgId)}/retry`, { tenantAccountId }),
};

/** An AWS account id as people read it: three groups of four digits. */
export function formatAwsAccountId(id: string): string {
  return /^\d{12}$/.test(id) ? id.replace(/(\d{4})(?=\d)/g, '$1 ') : id;
}
