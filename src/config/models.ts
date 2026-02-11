export interface ModelCatalogEntry {
  id: string;
  label: string;
  providerKey: string;
  baseUrl: string;
  api: string;
  models: Array<{
    id: string;
    name: string;
    contextWindow: number;
    maxTokens: number;
  }>;
  defaultModelRef: string;
}

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    id: "fireworks-kimi-k2p5",
    label: "Kimi K2.5 (Fireworks AI)",
    providerKey: "fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    api: "openai-completions",
    models: [
      {
        id: "accounts/fireworks/models/kimi-k2p5",
        name: "Kimi K2.5",
        contextWindow: 131072,
        maxTokens: 32768,
      },
    ],
    defaultModelRef: "fireworks/accounts/fireworks/models/kimi-k2p5",
  },
];

export function buildProviderConfig(
  entry: ModelCatalogEntry,
  apiKey: string,
): { models: Record<string, unknown>; agents: Record<string, unknown> } {
  return {
    models: {
      providers: {
        [entry.providerKey]: {
          baseUrl: entry.baseUrl,
          apiKey,
          api: entry.api,
          models: entry.models,
        },
      },
    },
    agents: {
      defaults: {
        model: {
          primary: entry.defaultModelRef,
        },
      },
    },
  };
}
