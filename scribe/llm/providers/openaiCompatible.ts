import { timedFetch } from '../../lib/http';
import { ChatMessage, ChatOptions, LLMError, LLMProvider } from '../types';

/**
 * One implementation covers every OpenAI-compatible Chat Completions API:
 * Groq, OpenAI, Ollama, Together, OpenRouter, LM Studio, vLLM, etc.
 * Only baseUrl + apiKey + model differ.
 *
 * Copied wholesale from SAGE — NOVA uses the exact same LLM abstraction.
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
      body.max_tokens = o.maxTokens ?? 4000;
      if (o.json) body.response_format = { type: 'json_object' };
      // Reasoning models (gpt-oss-* on Groq, etc.) burn completion budget on hidden
      // reasoning tokens. For JSON/extraction we ask for LOW effort so the budget
      // is spent on the answer, not the thinking — the single biggest cause of a
      // truncated-JSON parse failure. Harmless on non-reasoning models (ignored).
      if (o.reasoningEffort) body.reasoning_effort = o.reasoningEffort;

      // Retry on rate-limit (429) / transient (503) with a short backoff — free
      // tiers (e.g. Groq's 8k TPM) briefly throttle under normal use, and the
      // response tells us how long to wait. Up to 3 attempts.
      let lastDetail = '';
      for (let attempt = 0; attempt < 3; attempt++) {
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

        if (res.ok) {
          const json: any = await res.json();
          const choice = json?.choices?.[0];
          const content = choice?.message?.content;
          if (typeof content !== 'string') throw new LLMError(`${opts.name}: empty completion`);
          // On a JSON call, hitting the token ceiling means the object is cut off
          // mid-structure and will not parse. Signal it so the caller can retry with
          // more headroom instead of trying to parse a guaranteed-broken payload.
          // (Markdown drafts that hit the ceiling are still usable, so only JSON.)
          if (o.json && choice?.finish_reason === 'length') {
            throw new LLMError(`${opts.name}: JSON truncated at max_tokens (${body.max_tokens})`, 422);
          }
          return content;
        }

        lastDetail = await res.text().catch(() => '');
        if ((res.status === 429 || res.status === 503) && attempt < 2) {
          await new Promise((r) => setTimeout(r, retryDelayMs(res, lastDetail)));
          continue;
        }
        throw new LLMError(`${opts.name} ${res.status}: ${lastDetail.slice(0, 300)}`, res.status);
      }
      throw new LLMError(`${opts.name} 429: ${lastDetail.slice(0, 300)}`, 429);
    },
  };
}

/**
 * Honour Retry-After / "try again in Xs" hints; cap at 30s, floor at 1.2s.
 * The cap must exceed the provider's own hint or the retry fires too early and
 * fails again — e.g. Groq's free 8k-TPM tier routinely asks to wait ~20-25s after
 * a burst of extraction calls, which the old 12s cap could not honour.
 */
function retryDelayMs(res: Response, detail: string): number {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 30000);
  const m = detail.match(/try again in ([\d.]+)\s*s/i);
  if (m) return Math.min(Math.ceil(parseFloat(m[1]) * 1000) + 400, 30000);
  return 1500;
}
