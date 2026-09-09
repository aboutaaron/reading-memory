import OpenAI from 'openai';
import { resolveProviderModel } from './provider-model.js';
import { EMBEDDING_DIMENSIONS, validateVector, type Embedder } from './embeddings.js';

/** Embedding traffic is opt-in and uses the same provider credentials/base URL as analysis. */
export function createEmbeddingProvider(model: string | undefined, env: NodeJS.ProcessEnv = process.env): Embedder | null {
  if (!model || model === 'off') return null;
  try {
    const provider = resolveProviderModel(model, env);
    if (provider.provider !== 'openai') return null;
    const client = new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseUrl, timeout: 5000, maxRetries: 0, logLevel: 'off' });
    return {
      model: `openai/${provider.id}`,
      async embed(text, signal) {
        const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
        const response = await client.embeddings.create({ model: provider.id, input: text.slice(0, 16_000),
          dimensions: EMBEDDING_DIMENSIONS, encoding_format: 'float' }, { signal: boundedSignal });
        const vector = response.data[0]?.embedding ?? [];
        validateVector(vector);
        return vector;
      }
    };
  } catch { return null; }
}
