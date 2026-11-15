import { describe, expect, it } from 'vitest';
import {
  channelOf,
  priceDiff,
  servingOf,
  shortDate,
  usd,
} from '@/app/(admin)/admin/model-serving/_components/servingFormat';
import { sourceHost } from '@/lib/mappers/platformModelServingMappers';
import { modelDisplayName, providerDisplayName } from '@/lib/models/displayNames';
import type { ModelServingEntryDTO } from '@/lib/dto/platformModelServing';

// The Model serving page's arithmetic and names (MOTIR-11280; design
// `platform-admin/design-notes.md` § Model serving, "The example prices").

const charged = { input: 1.4, output: 4.4 };

describe('priceDiff', () => {
  it.each([
    [{ input: 1.4, output: 4.4 }, { kind: 'same' }],
    [
      { input: 1.131, output: 3.957 },
      { kind: 'below', input: 19, output: 10 },
    ],
    [
      { input: 1.1, output: 3.851 },
      { kind: 'below', input: 21, output: 12 },
    ],
    [
      { input: 3.5, output: 7.348 },
      { kind: 'above', input: 150, output: 67 },
    ],
    [
      { input: 1, output: 5 },
      { kind: 'inputBelowOutputAbove', input: 29, output: 14 },
    ],
    [
      { input: 2, output: 4 },
      { kind: 'inputAboveOutputBelow', input: 43, output: 9 },
    ],
  ])('%o against $1.40 / $4.40 is %o', (cost, want) => {
    expect(priceDiff(cost, charged)).toEqual(want);
  });

  it('is unknown with no cost, no output price, or a zero charged price', () => {
    expect(priceDiff(null, charged)).toEqual({ kind: 'unknown' });
    expect(priceDiff({ input: 1, output: null }, charged)).toEqual({ kind: 'unknown' });
    expect(priceDiff({ input: 1, output: 1 }, { input: 0, output: 1 })).toEqual({
      kind: 'unknown',
    });
  });
});

describe('formatting', () => {
  it('prices at two to three decimals, and a missing one as a dash', () => {
    expect(usd(1.4, 'en')).toBe('$1.40');
    expect(usd(3.851, 'en')).toBe('$3.851');
    expect(usd(null, 'en')).toBe('—');
  });

  it('dates a read date and an ISO time in UTC, and keeps an unreadable one', () => {
    expect(shortDate('2026-11-15', 'en-GB')).toBe('15 Nov 2026');
    expect(shortDate('2026-11-14T23:30:00.000Z', 'en-GB')).toBe('14 Nov 2026');
    expect(shortDate('someday', 'en')).toBe('someday');
  });

  it('names the source host without www, or keeps a non-URL', () => {
    expect(sourceHost('https://www.alibabacloud.com/help')).toBe('alibabacloud.com');
    expect(sourceHost('docs')).toBe('docs');
  });
});

describe('display names', () => {
  it('names every provider and multi-seller model, and falls back to the id', () => {
    expect(providerDisplayName('z-ai')).toBe('Z.ai');
    expect(providerDisplayName('qwen')).toBe('Alibaba Cloud');
    expect(providerDisplayName('moonshotai')).toBe('Moonshot AI');
    expect(providerDisplayName('mistral')).toBe('mistral');
    expect(providerDisplayName('toString')).toBe('toString');
    expect(modelDisplayName('deepseek-v4-pro')).toBe('DeepSeek V4 Pro');
    expect(modelDisplayName('kimi-k3.1-pro')).toBe('Kimi K3.1 Pro');
    expect(modelDisplayName('qwen-plus')).toBe('qwen-plus');
  });
});

describe('servingOf', () => {
  const off = (enabled: boolean) => ({
    provider: 'qwen',
    providerName: 'Alibaba Cloud',
    channelName: 'Qwen',
    enabled,
    isOrigin: false,
    cost: null,
    costSource: null,
  });
  const base = {
    originProvider: 'z-ai',
    selected: 'qwen',
    effective: null,
    offerings: [off(false)],
  } as unknown as ModelServingEntryDTO;

  it('falls back only when someone else serves; every channel off is not a fallback', () => {
    expect(servingOf(base)).toMatchObject({ wanted: 'qwen', serving: null, fallingBack: false });
    expect(channelOf(base, 'openai')).toBeNull();
    expect(channelOf({ ...base, offerings: [off(false), off(true)] }, 'qwen')!.enabled).toBe(true);
  });
});

describe('toModelServingEntryDTO', () => {
  it('carries a saved choice, an all-off model and an unpriced seller', async () => {
    const { toModelServingEntryDTO } = await import('@/lib/mappers/platformModelServingMappers');
    const dto = toModelServingEntryDTO({
      model: 'glm-5.3',
      originProvider: 'z-ai',
      charged: { prompt: 1.4, completion: 4.4, cacheRead: 0.26 },
      priceSource: { url: 'https://docs.z.ai/p', readDate: '2026-11-15' },
      selected: 'qwen',
      selectedBy: 'yue@motir.co',
      selectedAt: new Date('2026-11-14T09:00:00Z'),
      effective: '',
      offerings: [
        {
          provider: 'qwen',
          channelId: 7,
          channelName: 'Qwen',
          channelType: 49,
          enabled: false,
          cost: null,
          costSource: null,
        },
      ],
    });
    expect(dto).toMatchObject({
      selectedAt: '2026-11-14T09:00:00.000Z',
      effective: null,
      offerings: [{ providerName: 'Alibaba Cloud', isOrigin: false, cost: null, costSource: null }],
    });
  });
});
