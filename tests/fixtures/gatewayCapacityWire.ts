// Wire-shaped gateway capacity answers (the capacity contract §3–§7), for suites
// that stub `fetch` under the real capacity client (Story MOTIR-9539).

export const CAPACITY_GATEWAY = 'https://gateway.example.test';

const NA = { status: 'not_applicable' };

/** A stored-row answer to `PUT /api/motir/capacity/limits/:provider/:model`. */
export function storedRowBody(limits: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      provider: 'qwen',
      model: 'qwen-example-1',
      tier_note: 'Tier 3',
      unknown_note: '',
      planning_share_percent: 40,
      limits: {
        max_concurrency: NA,
        rpm: { value: 600, status: 'set' },
        input_tpm: NA,
        output_tpm: NA,
        tpm: { value: 800000, status: 'set' },
        tpd: NA,
        ...limits,
      },
      updated_at: '2026-10-25T12:00:00.123Z',
    },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function refusalResponse(status: number, code: string, field?: string): Response {
  return jsonResponse({ success: false, error: field ? { code, field } : { code } }, status);
}
