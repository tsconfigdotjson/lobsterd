export const PROVIDER_DEFAULTS = {
  baseUrl: "https://api.fireworks.ai/inference/v1",
  model: "accounts/fireworks/models/kimi-k2p5",
  modelName: "Kimi K2.5",
  contextWindow: 131072,
  maxTokens: 32768,
};

export interface ProviderInput {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export function buildProviderConfig(
  input: ProviderInput,
): { models: Record<string, unknown>; agents: Record<string, unknown> } {
  // Derive a provider key from the base URL hostname
  const providerKey = new URL(input.baseUrl).hostname.split(".")[0] ?? "custom";

  return {
    models: {
      providers: {
        [providerKey]: {
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
          api: "openai-completions",
          models: [
            {
              id: input.model,
              name: PROVIDER_DEFAULTS.modelName,
              contextWindow: PROVIDER_DEFAULTS.contextWindow,
              maxTokens: PROVIDER_DEFAULTS.maxTokens,
            },
          ],
        },
      },
    },
    agents: {
      defaults: {
        model: {
          primary: `${providerKey}/${input.model}`,
        },
      },
    },
  };
}
