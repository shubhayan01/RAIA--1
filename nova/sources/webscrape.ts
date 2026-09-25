import * as cheerio from 'cheerio';
import { requestOnce, followChain, absolutize } from '../lib/http';
import { safeOrigin } from '../lib/html';

/**
 * Prospect website research (Feature 1, Step 1).
 *
 * Fetches the homepage plus /about, /services and /contact (following redirects),
 * and extracts real, on-page signals. Everything here is scraped fact — NOTHING
 * is inferred by the LLM. If a page is missing we simply skip it.
 */

export interface ScrapeResult {
  domain: string;
  homepageUrl: string;
  reachable: boolean;
  companyName: string | null;
  whatTheyDo: string | null;       // meta description + first H2s
  services: string[];              // service headings / list items
  location: string | null;         // footer / contact address hint
  contacts: {
    emails: string[];
    phones: string[];
    linkedin: string | null;
    instagram: string | null;
    facebook: string | null;
    twitter: string | null;
    otherSocial: string[];
  };
  techStack: string[];             // WordPress / Shopify / Webflow / HubSpot etc.
  sizeSignal: {
    teamLinks: number;
    clientMentions: number;
    caseStudies: number;
    note: string;
  };
  pagesFetched: string[];
  error?: string;
}

const SUBPAGES = ['/about', '/about-us', '/services', '/what-we-do', '/contact', '/contact-us'];

export async function scrapeProspect(domainRaw: string): Promise<ScrapeResult> {
  const domain = normalizeDomain(domainRaw);
  const result: ScrapeResult = {
    domain,
    homepageUrl: `https://${domain}`,
    reachable: false,
    companyName: null,
    whatTheyDo: null,
    services: [],
    location: null,
    contacts: { emails: [], phones: [], linkedin: null, instagram: null, facebook: null, twitter: null, otherSocial: [] },
    techStack: [],
    sizeSignal: { teamLinks: 0, clientMentions: 0, caseStudies: 0, note: '' },
    pagesFetched: [],
  };

  // Resolve the homepage (apex -> www, http -> https, etc.)
  let home = `https://${domain}`;
  try {
    const chain = await followChain(home);
    if (chain.final && chain.final.status >= 200 && chain.final.status < 400 && chain.final.finalUrl) {
      home = chain.final.finalUrl;
    }
  } catch { /* keep default */ }
  result.homepageUrl = home;

  const origin = safeOrigin(home) || `https://${domain}`;
  const homeRes = await requestOnce(home);
  if (!homeRes.ok || !homeRes.body) {
    result.error = homeRes.error || `homepage returned ${homeRes.status}`;
    return result;
  }
  result.reachable = true;
  result.pagesFetched.push(home);

  const combined: string[] = [homeRes.body];
  parseHomepage(homeRes.body, home, result);

  // Fetch a few likely info pages (best-effort, deduped by final URL).
  const seen = new Set<string>([normalizeDomain(home)]);
  for (const path of SUBPAGES) {
    if (result.pagesFetched.length >= 4) break;
    const url = origin + path;
    const res = await requestOnce(url).catch(() => null);
    if (res && res.ok && res.body) {
      const key = normalizeDomain(res.finalUrl || url);
      if (seen.has(key)) continue;
      seen.add(key);
      result.pagesFetched.push(res.finalUrl || url);
      combined.push(res.body);
      harvestFromPage(res.body, res.finalUrl || url, result);
    }
  }

  // De-dupe / trim collected arrays.
  result.services = uniq(result.services).slice(0, 12);
  result.contacts.emails = uniq(result.contacts.emails).slice(0, 8);
  result.contacts.phones = uniq(result.contacts.phones).slice(0, 4);
  result.contacts.otherSocial = uniq(result.contacts.otherSocial).slice(0, 6);
  result.techStack = uniq(result.techStack);

  // Size signal note (a heuristic label, clearly derived from counts).
  const s = result.sizeSignal;
  s.note = s.clientMentions >= 6 || s.caseStudies >= 6 || s.teamLinks >= 12
    ? 'Established / mid-size (multiple clients, case studies or a sizeable team page)'
    : s.clientMentions + s.caseStudies + s.teamLinks >= 3
      ? 'Small-to-mid (some clients / case studies present)'
      : 'Small / early-stage (few visible clients or team members)';

  return result;
}

function parseHomepage(html: string, url: string, r: ScrapeResult) {
  const $ = cheerio.load(html);

  // Company name: og:site_name > title > first H1
  r.companyName =
    $('meta[property="og:site_name"]').attr('content')?.trim() ||
    cleanTitle($('title').first().text()) ||
    $('h1').first().text().replace(/\s+/g, ' ').trim() ||
    null;

  // What they do: meta description + first few H2s
  const metaDesc = $('meta[name="description"]').attr('content')?.trim() || $('meta[property="og:description"]').attr('content')?.trim() || '';
  const h2s = $('h2').map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean).slice(0, 3);
  r.whatTheyDo = [metaDesc, h2s.join(' · ')].filter(Boolean).join(' — ') || null;

  harvestFromPage(html, url, r);
}

function harvestFromPage(html: string, url: string, r: ScrapeResult) {
  const $ = cheerio.load(html);
  const lower = html.toLowerCase();

  // ---- tech stack (meta generator + script/link srcs) ----
  const generator = $('meta[name="generator"]').attr('content')?.toLowerCase() || '';
  const techHints: [RegExp, string][] = [
    [/wordpress|wp-content|wp-includes/, 'WordPress'],
    [/shopify|cdn\.shopify/, 'Shopify'],
    [/webflow/, 'Webflow'],
    [/wix\.com|wixstatic/, 'Wix'],
    [/squarespace/, 'Squarespace'],
    [/hubspot|hs-scripts|hs-analytics/, 'HubSpot'],
    [/drupal/, 'Drupal'],
    [/joomla/, 'Joomla'],
    [/next\.js|__next|_next\/static/, 'Next.js'],
    [/react/, 'React'],
    [/gtag|googletagmanager|google-analytics/, 'Google Analytics'],
    [/cloudflare/, 'Cloudflare'],
    [/mailchimp|mc\.us\d/, 'Mailchimp'],
    [/woocommerce/, 'WooCommerce'],
  ];
  for (const [re, name] of techHints) {
    if (re.test(generator) || re.test(lower)) r.techStack.push(name);
  }

  // ---- services (service-page headings + prominent list items) ----
  $('h2, h3').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t && t.length < 60 && /service|solution|what we do|offering|capabilit|expertise/i.test(t + ' ' + url)) {
      // headings on a services-type page or that mention services
    }
  });
  if (/service|what-we-do|solution/i.test(url)) {
    $('h2, h3, li').each((_, el) => {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t && t.length >= 3 && t.length <= 60) r.services.push(t);
    });
  }

  // ---- contacts: emails, phones, socials ----
  const emails = lower.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  for (const e of emails) if (!/\.(png|jpg|jpeg|gif|webp)$/i.test(e)) r.contacts.emails.push(e.toLowerCase());

  const phones = html.match(/(?:\+?\d[\d\s().-]{7,}\d)/g) || [];
  for (const p of phones.slice(0, 6)) {
    const digits = p.replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 15) r.contacts.phones.push(p.trim());
  }

  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href) return;
    const abs = absolutize(href, url);
    if (/linkedin\.com\/(company|in)\//i.test(abs) && !r.contacts.linkedin) r.contacts.linkedin = clean(abs);
    else if (/instagram\.com\//i.test(abs) && !r.contacts.instagram) r.contacts.instagram = clean(abs);
    else if (/facebook\.com\//i.test(abs) && !r.contacts.facebook) r.contacts.facebook = clean(abs);
    else if (/(twitter|x)\.com\//i.test(abs) && !r.contacts.twitter) r.contacts.twitter = clean(abs);
    else if (/(youtube|tiktok|pinterest)\.com\//i.test(abs)) r.contacts.otherSocial.push(clean(abs));
  });

  // ---- location hint (footer text / address) ----
  if (!r.location) {
    const footer = $('footer').text().replace(/\s+/g, ' ').trim();
    const addr = $('address').first().text().replace(/\s+/g, ' ').trim();
    const cand = addr || footer;
    const m = cand.match(/[A-Z][a-zA-Z.]+(?:,\s?[A-Z][a-zA-Z.]+){1,2}(?:\s\d{4,6})?/);
    if (m) r.location = m[0].slice(0, 80);
  }

  // ---- size signals ----
  r.sizeSignal.teamLinks += $('a[href*="team" i], a[href*="/people" i], .team, .team-member').length;
  r.sizeSignal.clientMentions += (lower.match(/our clients?|trusted by|clients we|brands we/g) || []).length;
  r.sizeSignal.caseStudies += $('a[href*="case-stud" i], a[href*="portfolio" i], .case-study').length
    + (lower.match(/case study|case studies/g) || []).length;
}

/* ------------------------------- helpers -------------------------------- */

export function normalizeDomain(input: string): string {
  let s = (input || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
  // If the input still carries command words / whitespace ("audit acme.com"),
  // pull out the first domain-looking token rather than stripping the space away
  // (which would fuse "audit" onto the host → "auditacme.com").
  const m = s.match(/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}/);
  if (m) s = m[0];
  return s.replace(/\/.*$/, '').replace(/[^a-z0-9.-]/g, '');
}

/** Parse a batch of domains/emails from free text (newline/comma separated). */
export function parseProspectInput(text: string): { domains: string[]; emailByDomain: Record<string, string> } {
  const tokens = (text || '').split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  const domains: string[] = [];
  const emailByDomain: Record<string, string> = {};
  for (const tok of tokens) {
    const emailMatch = tok.match(/^[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})$/i);
    if (emailMatch) {
      const dom = normalizeDomain(emailMatch[1]);
      if (dom && !domains.includes(dom)) domains.push(dom);
      emailByDomain[dom] = tok.toLowerCase();
      continue;
    }
    const domMatch = tok.match(/((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})/i);
    if (domMatch) {
      const dom = normalizeDomain(domMatch[1]);
      if (dom && !domains.includes(dom) && !/^(e\.g|i\.e|vs|etc)\./.test(dom)) domains.push(dom);
    }
  }
  return { domains, emailByDomain };
}

function cleanTitle(t: string): string | null {
  const s = (t || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  // strip common " | Home", " - Tagline" suffixes to get the brand
  return s.split(/\s[|–—-]\s/)[0].trim() || s;
}
function clean(u: string): string { return u.split('?')[0].replace(/\/$/, ''); }
function uniq<T>(a: T[]): T[] { return [...new Set(a)]; }
