import { config } from '../config';
import { openAICompatible } from './providers/openaiCompatible';
import { anthropicProvider } from './providers/anthropic';
import { ChatMessage, ChatOptions, LLMProvider } from './types';

/**
 * Provider registry. Add a new backend by adding one case here — nothing
 * else in the codebase needs to change. Swap at runtime with LLM_PROVIDER.
 *
 * Copied wholesale from SAGE. In NOVA the LLM is ONLY allowed to: chat, route
 * a request to the right tool, and WRITE outreach/reply/care copy. It must never
 * invent prospect data, rankings, audit numbers or social signals — those come
 * from the real sources (web scrape, PageSpeed, IMAP, the JSON stores).
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
  const jsonSystem = system + '\n\nRespond with valid minified JSON only. No markdown, no commentary.';
  // Reasoning models (Groq gpt-oss-*) spend completion budget on hidden reasoning
  // tokens, so we ask for LOW effort (measured ~10x fewer) to leave the budget for
  // the JSON. Crucially we DO NOT inflate maxTokens: providers count the REQUEST
  // as prompt + max_tokens against the per-minute limit, so a big max_tokens on a
  // large prompt exceeds an 8k-TPM free tier and 429s on every attempt. We keep the
  // caller's budget (with a small floor) and, on retry, keep it bounded too.
  const budget = Math.min(Math.max(opts?.maxTokens ?? 1500, 800), 4096);
  const base: ChatOptions = { ...opts, reasoningEffort: opts?.reasoningEffort ?? 'low', maxTokens: budget };
  try {
    const raw = await complete(jsonSystem, user, { ...base, json: true });
    return parseLooseJSON<T>(raw);
  } catch (e) {
    // Retry once in plain-text mode (some providers' strict JSON mode 400s, and a
    // truncated object surfaces as a 422). Keep the SAME bounded budget so the
    // request never exceeds the token-per-minute limit; parseLooseJSON repairs a
    // truncated tail if needed.
    const raw = await complete(jsonSystem, user, { ...base, json: false });
    return parseLooseJSON<T>(raw);
  }
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
    // Last resort: the object was truncated mid-structure (reasoning model hit the
    // token ceiling). Try to close it up and parse the salvageable prefix.
    if (first >= 0) {
      const repaired = repairTruncatedJson(s.slice(first));
      if (repaired) {
        try { return JSON.parse(repaired) as T; } catch { /* give up below */ }
      }
    }
    throw new Error('LLM did not return parseable JSON');
  }
}

/**
 * Best-effort repair of JSON cut off mid-stream (a reasoning model that ran out
 * of completion budget). Walks the text tracking string/escape state and the
 * bracket stack, discards any trailing partial token, and closes every still-open
 * string, object and array so the salvageable prefix parses. Returns null if the
 * input is too broken to rescue.
 */
export function repairTruncatedJson(input: string): string | null {
  const s = input.trimEnd();
  if (!s) return null;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastValueEnd = -1; // index (exclusive) of the last position that is a valid place to cut
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') { inString = false; lastValueEnd = i + 1; }
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{' || c === '[') { stack.push(c === '{' ? '}' : ']'); continue; }
    if (c === '}' || c === ']') { stack.pop(); lastValueEnd = i + 1; continue; }
    if (c === ',' ) { lastValueEnd = i; continue; }
    if (/[\d}\]"eEnul]/.test(c)) lastValueEnd = i + 1; // numbers, true/false/null tails
  }
  // Cut back to the last complete value, then strip any dangling partial token
  // (a half-written string, a bare key, a key with a colon but no value, a
  // trailing comma) until nothing incomplete remains at the end.
  let cut = lastValueEnd > 0 ? s.slice(0, lastValueEnd) : s;
  let prev = '';
  while (cut !== prev) {
    prev = cut;
    cut = cut.replace(/[\s,]+$/, '');               // trailing whitespace / commas
    cut = cut.replace(/[,[{]\s*"[^"]*$/, '');        // unterminated string (value or key)
    cut = cut.replace(/[,{]\s*"[^"]*"\s*:?\s*$/, ''); // a key (with or without a colon) and no value
    cut = cut.replace(/:\s*$/, '');                  // a dangling colon
  }
  // Recompute the open-bracket stack for the trimmed string and close it.
  const stack2: string[] = [];
  let inStr2 = false, esc2 = false;
  for (let i = 0; i < cut.length; i++) {
    const c = cut[i];
    if (inStr2) { if (esc2) esc2 = false; else if (c === '\\') esc2 = true; else if (c === '"') inStr2 = false; continue; }
    if (c === '"') inStr2 = true;
    else if (c === '{' || c === '[') stack2.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') stack2.pop();
  }
  if (inStr2) cut += '"';
  while (stack2.length) cut += stack2.pop();
  return cut.trim() ? cut : null;
}
