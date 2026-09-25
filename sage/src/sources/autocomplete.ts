import { getJSON } from '../lib/http';
import { pool } from '../lib/concurrency';

/**
 * FREE keyword expansion using Google Autocomplete (Suggest).
 * No API key, no cost. Returns real queries people type.
 */
async function suggest(query: string): Promise<string[]> {
  try {
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(query)}`;
    const data = await getJSON<[string, string[]]>(url, {}, 8000);
    return Array.isArray(data?.[1]) ? data[1] : [];
  } catch {
    return [];
  }
}

const MODIFIERS = [
  '', 'how to', 'what is', 'best', 'top', 'vs', 'for', 'near me', 'cost', 'price',
  'services', 'agency', 'software', 'tools', 'examples', 'guide', 'tips',
];
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');

/**
 * Expand a seed into a broad long-tail set:
 *  - "<modifier> seed" and "seed <modifier>"
 *  - "seed <letter>" alphabet soup
 * Deduped, lowercased.
 */
export async function expandKeywords(seed: string, breadth: 'quick' | 'wide' = 'wide'): Promise<string[]> {
  const s = seed.trim().toLowerCase();
  const seeds = new Set<string>([s]);

  const mods = breadth === 'wide' ? MODIFIERS : MODIFIERS.slice(0, 6);
  for (const m of mods) {
    if (m) {
      seeds.add(`${m} ${s}`);
      seeds.add(`${s} ${m}`);
    }
  }
  if (breadth === 'wide') for (const a of ALPHABET) seeds.add(`${s} ${a}`);

  const batches = [...seeds];
  const lists = await pool(batches, 6, (q) => suggest(q));

  const out = new Set<string>();
  out.add(s);
  for (const list of lists) for (const kw of list) {
    const k = kw.trim().toLowerCase();
    if (k && k.length <= 90) out.add(k);
  }
  return [...out];
}

/** Pull "People also ask"-style questions from autocomplete question stems. */
export async function questionKeywords(seed: string): Promise<string[]> {
  const stems = ['how', 'what', 'why', 'when', 'which', 'who', 'can', 'does', 'is', 'are'];
  const lists = await pool(stems, 6, (stem) => suggest(`${stem} ${seed}`));
  const out = new Set<string>();
  for (const list of lists) for (const q of list) {
    const k = q.trim().toLowerCase();
    if (/[?]|^(how|what|why|when|which|who|can|does|is|are)\b/.test(k)) out.add(k);
  }
  return [...out].slice(0, 25);
}
