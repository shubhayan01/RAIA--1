import { timedFetch } from '../../lib/http';
import { ChatMessage, ChatOptions, LLMError, LLMProvider } from '../types';

/** Anthropic Messages API (different shape: system is a top-level field). */
export function anthropicProvider(opts: { apiKey: string; model: string; defaultTemperature: number }): LLMProvider {
  return {
    name: 'anthropic',
    model: opts.model,
    async chat(messages: ChatMessage[], o: ChatOptions = {}): Promise<string> {
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const turns = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }));

      const res = await timedFetch(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': opts.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: opts.model,
            system: system || undefined,
            messages: turns,
            max_tokens: o.maxTokens ?? 4096,
            temperature: o.temperature ?? opts.defaultTemperature,
          }),
        },
        60000,
      );

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new LLMError(`anthropic ${res.status}: ${detail.slice(0, 300)}`, res.status);
      }
      const json: any = await res.json();
      const content = json?.content?.[0]?.text;
      if (typeof content !== 'string') throw new LLMError('anthropic: empty completion');
      return content;
    },
  };
}
