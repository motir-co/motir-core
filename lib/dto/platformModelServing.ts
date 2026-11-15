// The platform MODEL SERVING screen's view model (MOTIR-11280; design
// `platform-admin/design-notes.md` § Model serving). Plain data a Client
// Component can receive: dates are ISO strings, names are already resolved.

export interface ModelServingPriceDTO {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens; `null` when the row sets none. */
  output: number | null;
}

export interface ModelServingSourceDTO {
  url: string;
  /** The host shown as the link text, e.g. `docs.z.ai`. */
  host: string;
  /** `YYYY-MM-DD`. */
  readDate: string;
}

export interface ModelServingOfferingDTO {
  provider: string;
  providerName: string;
  channelName: string;
  enabled: boolean;
  isOrigin: boolean;
  /** What this provider charges Motir; `null` when the gateway holds no price row for it. */
  cost: ModelServingPriceDTO | null;
  costSource: ModelServingSourceDTO | null;
}

export interface ModelServingEntryDTO {
  model: string;
  modelName: string;
  originProvider: string;
  originName: string;
  charged: ModelServingPriceDTO;
  priceSource: ModelServingSourceDTO;
  /** The admin's choice, or `null` when the default (the original provider) applies. */
  selected: string | null;
  selectedBy: string | null;
  selectedAt: string | null;
  /** Who serves the next request; `null` when every channel is off. */
  effective: string | null;
  offerings: ModelServingOfferingDTO[];
}

export type PlatformModelServingViewDTO =
  | { state: 'ok'; canChange: boolean; entries: ModelServingEntryDTO[] }
  | { state: 'unavailable' };
