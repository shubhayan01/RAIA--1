import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Tiny JSON file store. Copied wholesale from SAGE. Everything lives under
 * <projectRoot>/data/ which is git-ignored. Deliberately simple: read → mutate →
 * write the whole document. NOVA uses this for prospects, pipeline, sequences,
 * meetings and clients.
 */

const DATA_ROOT = resolve(process.cwd(), 'data');

/** Absolute path for a store file, e.g. dataPath('prospects', 'acme.com.json'). */
export function dataPath(...parts: string[]): string {
  return join(DATA_ROOT, ...parts);
}

/** Filesystem-safe token for a domain (used as a filename). */
export function safeDomainKey(domain: string): string {
  let s = (domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
  // Pull the domain token out of any leftover command text ("outreach for acme.com")
  // so keys stay stable and never fuse a verb onto the host.
  const m = s.match(/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}/);
  if (m) s = m[0];
  return s.replace(/\/.*$/, '').replace(/[^a-z0-9.-]/g, '_');
}

/** Read a JSON file, returning `fallback` if it does not exist or is unreadable. */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Write a JSON file, creating parent directories as needed. */
export async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

/** List the *.json basenames (without extension) inside a data subdirectory. */
export async function listJsonKeys(subdir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dataPath(subdir));
    return entries.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}
