export const DEFAULT_READING_MODEL = 'gpt-5.6-luna';
export type ProviderModel = { provider: 'openai' | 'anthropic'; id: string; baseUrl: string; apiKey: string };

/** Bare IDs select OpenAI. Provider prefixes are routing syntax, never sent to the SDK. */
export function resolveProviderModel(model: string, env: NodeJS.ProcessEnv = process.env): ProviderModel {
  const match = /^(?:(openai|anthropic)\/)?([a-zA-Z0-9][a-zA-Z0-9._:-]*)$/.exec(model);
  if (!match) throw new Error('Expected an OpenAI model ID or openai/<id> or anthropic/<id>.');
  const provider = (match[1] ?? 'openai') as ProviderModel['provider'];
  const key = provider.toUpperCase();
  const apiKey = env[`${key}_API_KEY`]?.trim();
  if (!apiKey) throw new Error('The selected analysis provider has no API key configured.');
  const baseUrl = env[`${key}_BASE_URL`] ?? (provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com');
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('The selected provider base URL is invalid.');
  }
  return { provider, id: match[2]!, baseUrl, apiKey };
}
