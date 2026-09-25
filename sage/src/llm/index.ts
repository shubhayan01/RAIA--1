import { config } from '../config';
import { openAICompatible } from './providers/openaiCompatible';
import { anthropicProvider } from './providers/anthropic';
import { ChatMessage, ChatOptions, LLMProvider } from './types';

/**
 * Provider registry. Add a new backend by adding one case here — nothing
 * else in the codebase needs to change. Swap at runtime with LLM_PROVIDER.
 */
function build(): LLMProvider {
  const { provider, model, apiKey, baseUrl, temperature } = config.llm;
  switch (provider) {
    case 'groq':
      return openAICompatible({
        name: 'groq',
        baseUrl: baseUrl || 'https://api.groq.com/openai/v1',
        apiKey,
        model,
        defaultTemperature: temperature,
      });
    case 'openai':
      return openAICompatible({
        name: 'openai',
        baseUrl: baseUrl || 'https://api.openai.com/v1',
        apiKey,
        model,
        defaultTemperature: temperature,
      });
    case 'ollama':
      return openAICompatible({
        name: 'ollama',
        baseUrl: baseUrl || 'http://localhost:11434/v1',
        apiKey: apiKey || 'ollama',
        model,
        defaultTemperature: temperature,
      });
    case 'anthropic':
      return anthropicProvider({ apiKey, model, defaultTemperature: temperature });
    default:
      // Any other value is treated as a custom OpenAI-compatible endpoint.
      return openAICompatible({
        name: provider,
        baseUrl: baseUrl || 'https://api.openai.com/v1',
        apiKey,
        model,
        defaultTemperature: temperature,
      });
  }
}

let _provider: LLMProvider | null = null;
export function llm(): LLMProvider {
  if (!_provider) _provider = build();
  return _provider;
}

export function llmConfigured(): boolean {
  // Ollama runs locally without a key.
  return config.llm.provider === 'ollama' || !!config.llm.apiKey;
}

export function llmInfo() {
  return { provider: config.llm.provider, model: config.llm.model, configured: llmConfigured() };
}

export async function complete(system: string, user: string, opts?: ChatOptions): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  return llm().chat(messages, opts);
}

/** Ask for JSON, tolerate fenced/markdown-wrapped output, and parse safely. */
export async function completeJSON<T = any>(system: string, user: string, opts?: ChatOptions): Promise<T> {
  const raw = await complete(system + '\n\nRespond with valid minified JSON only. No markdown, no commentary.', user, {
    ...opts,
    json: true,
  });
  return parseLooseJSON<T>(raw);
}

export function parseLooseJSON<T = any>(raw: string): T {
  let s = raw.trim();
  // strip code fences
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(s) as T;
  } catch {
    // grab the outermost {...} or [...]
    const first = s.search(/[{[]/);
    const lastObj = s.lastIndexOf('}');
    const lastArr = s.lastIndexOf(']');
    const last = Math.max(lastObj, lastArr);
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(s.slice(first, last + 1)) as T;
      } catch { /* fall through */ }
    }
    throw new Error('LLM did not return parseable JSON');
  }
}
