// Wire-shaped answers of motir-gateway's Model serving API
// (`docs/motir-model-serving-api.md` §3–§4 there), for suites that stub `fetch`
// under the real client (MOTIR-11280). GLM-5.3 is made by Z.ai and also sold by
// Alibaba; the prices are the gateway's own rows.

export const SERVING_GATEWAY = 'https://gateway.example.test';

export function glm53Entry(over: Record<string, unknown> = {}) {
  return {
    model: 'glm-5.3',
    originProvider: 'z-ai',
    chargedUSDPerMTok: { prompt: 1.4, completion: 4.4, cacheRead: 0.26 },
    priceSource: { url: 'https://docs.z.ai/guides/overview/pricing', readDate: '2026-11-15' },
    selected: null,
    selectedBy: null,
    selectedAt: null,
    effective: 'z-ai',
    offerings: [
      {
        provider: 'z-ai',
        channelId: 3,
        channelName: 'GLM',
        channelType: 16,
        enabled: true,
        costUSDPerMTok: { prompt: 1.4, completion: 4.4, cacheRead: 0.26 },
        costSource: { url: 'https://docs.z.ai/guides/overview/pricing', readDate: '2026-11-15' },
      },
      {
        provider: 'qwen',
        channelId: 7,
        channelName: 'Qwen',
        channelType: 49,
        enabled: true,
        costUSDPerMTok: { prompt: 1.131, completion: 3.957 },
        costSource: {
          url: 'https://www.alibabacloud.com/help/en/model-studio/model-pricing',
          readDate: '2026-11-12',
        },
      },
    ],
    ...over,
  };
}

export function servingReadBody(data: unknown[] = [glm53Entry()]) {
  return { success: true, readAt: '2026-11-15T10:00:00Z', data };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
