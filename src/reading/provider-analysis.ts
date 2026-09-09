import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { readingAnalysisJsonSchema } from './analysis-schema.js';
import { READING_ANALYSIS_INSTRUCTIONS } from './analysis-prompt.js';
import type { ProviderAnalysisInput } from './passage-evidence.js';
import type { ProviderModel } from './provider-model.js';
import type { ProviderResponseMetadata } from './flue-trace.js';

export async function requestReadingAnalysis(model: ProviderModel, input: ProviderAnalysisInput, options: {
  signal?: AbortSignal;
  fetch?: typeof fetch;
  onResponse: (metadata: ProviderResponseMetadata) => void;
}): Promise<unknown> {
  const config = { apiKey: model.apiKey, baseURL: model.baseUrl, maxRetries: 0, timeout: 55_000,
    logLevel: 'off' as const, ...(options.fetch ? { fetch: options.fetch } : {}) };
  const requestOptions = options.signal ? { signal: options.signal } : {};
  if (model.provider === 'openai') {
    const response = await new OpenAI(config).responses.create({
      model: model.id,
      store: false,
      instructions: READING_ANALYSIS_INSTRUCTIONS,
      input: JSON.stringify(input),
      max_output_tokens: 8192,
      text: { format: { type: 'json_schema', name: 'reading_analysis', strict: true, schema: readingAnalysisJsonSchema } }
    }, requestOptions);
    options.onResponse({ provider: model.provider, output_chars: response.output_text.length,
      input_tokens: response.usage?.input_tokens ?? 0, output_tokens: response.usage?.output_tokens ?? 0 });
    if (response.status !== 'completed' || !response.output_text || response.output.some((entry) =>
      entry.type === 'message' && entry.content.some((part) => part.type === 'refusal'))) {
      throw new Error('The analysis provider did not return a complete structured result.');
    }
    return JSON.parse(response.output_text);
  }
  // A forced output tool returns JSON only; there is no tool execution loop.
  const response = await new Anthropic(config).messages.create({
    model: model.id,
    max_tokens: 8192,
    system: READING_ANALYSIS_INSTRUCTIONS,
    messages: [{ role: 'user', content: JSON.stringify(input) }],
    tools: [{ name: 'reading_analysis', description: 'Return the completed structured reading analysis. This records output only and performs no action.',
      input_schema: { ...readingAnalysisJsonSchema, type: 'object' } }],
    tool_choice: { type: 'tool', name: 'reading_analysis', disable_parallel_tool_use: true }
  }, requestOptions);
  const outputs = response.content.filter((part) => part.type === 'tool_use');
  options.onResponse({ provider: model.provider, output_chars: JSON.stringify(response.content).length,
    input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens });
  if (response.stop_reason !== 'tool_use' || outputs.length !== 1 || outputs[0]!.name !== 'reading_analysis') {
    throw new Error('The analysis provider did not return a complete structured result.');
  }
  return outputs[0]!.input;
}
