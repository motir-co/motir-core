// THE PEOPLE-FACING NAMES of the providers and models the gateway serves
// (MOTIR-11280; design `platform-admin/design-notes.md` § Model serving). The
// gateway and motir-ai speak in provider ids (`z-ai`, `qwen`) and model ids
// (`glm-5.3`); a screen that names them to a person reads them through here.
//
// Pure and client-safe. An id with no entry is shown as itself, so a provider or
// model the gateway adds later still renders, only less prettily.

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  moonshotai: 'Moonshot AI',
  openai: 'OpenAI',
  qwen: 'Alibaba Cloud',
  'z-ai': 'Z.ai',
};

/** The models more than one provider sells — the ones the Model serving page lists. */
const MODEL_NAMES: Readonly<Record<string, string>> = {
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'glm-5.1': 'GLM-5.1',
  'glm-5.2': 'GLM-5.2',
  'glm-5.3': 'GLM-5.3',
  'kimi-k2.7-code': 'Kimi K2.7 Code',
  'kimi-k3': 'Kimi K3',
  'kimi-k3.1-pro': 'Kimi K3.1 Pro',
};

export function providerDisplayName(id: string): string {
  return Object.hasOwn(PROVIDER_NAMES, id) ? PROVIDER_NAMES[id]! : id;
}

export function modelDisplayName(id: string): string {
  return Object.hasOwn(MODEL_NAMES, id) ? MODEL_NAMES[id]! : id;
}
