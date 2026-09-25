import { timedFetch } from '../../lib/http';
import { ChatMessage, ChatOptions, LLMError, LLMProvider } from '../types';

/**
 * One implementation covers every OpenAI-compatible Chat Completions API:
 * Groq, OpenAI, Ollama, Together, OpenRouter, LM Studio, vLLM, etc.
 * Only baseUrl + apiKey + model differ.
 */
export function openAICompatible(opts: {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  defaultTemperature: number;
}): LLMProvider {
  return {
    name: opts.name,
    model: opts.model,
    async chat(messages: ChatMessage[], o: ChatOptions = {}): Promise<string> {
      const body: Record<string, unknown> = {
        model: opts.model,
        messages,
        temperature: o.temperature ?? opts.defaultTemperature,
      };
      // Default floor so a structured call can never be silently truncated.
      // Explicit maxTokens (brief 8000, audit 5000, etc.) is always honored via ??.
      body.max_tokens = o.maxTokens ?? 4000;
      if (o.json) body.response_format = { type: 'json_object' };

      const res = await timedFetch(
        `${opts.baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
        },
        60000,
      );

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new LLMError(`${opts.name} ${res.status}: ${detail.slice(0, 300)}`, res.status);
      }
      const json: any = await res.json();
      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new LLMError(`${opts.name}: empty completion`);
      return content;
    },
  };
}
