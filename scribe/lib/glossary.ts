/**
 * Canonical term glossary — defined ONCE and locked.
 *
 * "Definitional drift" is a real fabrication vector: a model expands GEO as
 * "Generative Engine Optimization" in one paragraph and "Geographic ..." in the
 * next, or two drafts on the same topic disagree on what AEO stands for. Because
 * this map is fixed, the consistency check below is DETERMINISTIC: the same draft
 * always produces the same verdict, and two drafts checked against this table
 * define each term the same way or both fail. No model judgement involved.
 *
 * Add a term here only with its single correct expansion. Do not branch it.
 */
export const GLOSSARY: Record<string, string> = {
  GEO: 'Generative Engine Optimization',
  AEO: 'Answer Engine Optimization',
  AIO: 'AI Overviews',
  SEO: 'Search Engine Optimization',
  SERP: 'Search Engine Results Page',
  SGE: 'Search Generative Experience',
  'E-E-A-T': 'Experience, Expertise, Authoritativeness and Trust',
  LLM: 'Large Language Model',
  CTR: 'Click-Through Rate',
  CTA: 'Call To Action',
  PAA: 'People Also Ask',
};

export interface TermDrift {
  term: string;
  found: string;       // the expansion actually written in the draft
  canonical: string;   // what it must be
}

const normalize = (s: string) =>
  s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Check every acronym expansion in the text against the locked glossary AND
 * against itself (the same acronym must not be expanded two different ways).
 * Only fires when the draft actually spells an expansion out next to the term;
 * a bare acronym with no expansion is fine.
 */
export function checkTermConsistency(text: string): { drifts: TermDrift[]; expansionsSeen: Record<string, string[]> } {
  const drifts: TermDrift[] = [];
  const expansionsSeen: Record<string, string[]> = {};

  for (const [term, canonical] of Object.entries(GLOSSARY)) {
    const canon = normalize(canonical);
    const seen = new Set<string>();
    // Match "TERM (expansion)" and "expansion (TERM)". Expansion window kept short.
    const t = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`\\b${t}\\b\\s*\\(([^)]{3,70})\\)`, 'gi'),
      new RegExp(`([A-Za-z][A-Za-z ,&-]{3,70}?)\\s*\\(\\s*${t}\\s*\\)`, 'gi'),
    ];
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const raw = m[1].trim();
        const norm = normalize(raw);
        // Ignore parentheticals that are clearly not an expansion attempt.
        if (!/[a-z]/i.test(raw) || norm.split(' ').length < 2) continue;
        seen.add(raw);
        if (!fuzzyMatch(norm, canon)) drifts.push({ term, found: raw, canonical });
      }
    }
    if (seen.size) {
      expansionsSeen[term] = [...seen];
      // Internal inconsistency: same acronym, two different expansions in one draft.
      if (seen.size > 1) {
        const distinct = new Set([...seen].map(normalize));
        if (distinct.size > 1) drifts.push({ term, found: [...seen].join(' / '), canonical });
      }
    }
  }

  // De-dup identical drift rows.
  const uniq = new Map(drifts.map((d) => [`${d.term}::${d.found}`, d]));
  return { drifts: [...uniq.values()], expansionsSeen };
}

// Accept minor wording differences ("and" vs "&", trailing words) but reject a
// genuinely different expansion. Match if one normalized string contains the
// other's significant word run, or they share >=80% of tokens.
function fuzzyMatch(a: string, b: string): boolean {
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const at = a.split(' ').filter((w) => w.length > 2);
  const bt = new Set(b.split(' ').filter((w) => w.length > 2));
  if (!at.length || !bt.size) return false;
  const overlap = at.filter((w) => bt.has(w)).length / Math.max(at.length, bt.size);
  return overlap >= 0.8;
}
