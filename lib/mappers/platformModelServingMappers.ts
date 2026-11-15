import type {
  ModelServingEntryDTO,
  ModelServingPriceDTO,
  ModelServingSourceDTO,
} from '@/lib/dto/platformModelServing';
import type { ModelServingEntry, PriceSource, UsdPerMTok } from '@/lib/gateway/modelServingClient';
import { modelDisplayName, providerDisplayName } from '@/lib/models/displayNames';

// THE MODEL SERVING SCREEN'S VIEW MODEL (MOTIR-11280). Fixed field lists only —
// no spread of a gateway object, so a field the gateway grows never reaches the
// screen. The channel id and type stay behind: the screen names a channel.

function price(p: UsdPerMTok): ModelServingPriceDTO {
  return { input: p.prompt, output: p.completion };
}

/** The link text: the URL's host without `www.`, or the URL itself when it is not one. */
export function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function source(s: PriceSource): ModelServingSourceDTO {
  return { url: s.url, host: sourceHost(s.url), readDate: s.readDate };
}

export function toModelServingEntryDTO(e: ModelServingEntry): ModelServingEntryDTO {
  return {
    model: e.model,
    modelName: modelDisplayName(e.model),
    originProvider: e.originProvider,
    originName: providerDisplayName(e.originProvider),
    charged: price(e.charged),
    priceSource: source(e.priceSource),
    selected: e.selected,
    selectedBy: e.selectedBy,
    selectedAt: e.selectedAt ? e.selectedAt.toISOString() : null,
    effective: e.effective === '' ? null : e.effective,
    offerings: e.offerings.map((o) => ({
      provider: o.provider,
      providerName: providerDisplayName(o.provider),
      channelName: o.channelName,
      enabled: o.enabled,
      isOrigin: o.provider === e.originProvider,
      cost: o.cost ? price(o.cost) : null,
      costSource: o.costSource ? source(o.costSource) : null,
    })),
  };
}
