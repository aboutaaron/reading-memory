import type { FlueContext } from '@flue/sdk/client';
import * as v from 'valibot';

export const triggers = { webhook: true };

export default async function ({ init, payload }: FlueContext) {
  const agent = await init({ model: payload.model ?? 'openai/gpt-5.5', sandbox: 'local' });
  const session = await agent.session(payload.session_id ?? 'analysis');

  return session.skill('analyze-item', {
    args: {
      item_id: payload.item_id,
      title: payload.title ?? null,
      text: payload.text
    },
    result: v.object({
      summary: v.string(),
      claims: v.array(v.string()),
      relevance: v.object({
        score: v.number(),
        themes: v.array(v.string())
      }),
      recommended_action: v.picklist(['brief', 'save', 'skip']),
      confidence: v.number(),
      reason: v.string(),
      tags: v.array(v.object({
        tag: v.string(),
        reason: v.string(),
        confidence: v.number()
      })),
      relationships: v.array(v.object({
        from_item_id: v.string(),
        to_item_id: v.string(),
        relation_type: v.string(),
        explanation: v.string(),
        confidence: v.number()
      }))
    })
  });
}
