import { promises as dns } from 'node:dns';
import net from 'node:net';

/**
 * SSRF guard for the crawlers.
 *
 * SAGE fetches arbitrary user-supplied URLs (audit / autolink / schema). Without a
 * guard, a customer on a hosted instance could point a crawler at internal
 * infrastructure — cloud metadata (169.254.169.254), localhost, or private-range
 * hosts — and read back the response. `assertPublicUrl` rejects those: it blocks
 * loopback / private / link-local / reserved addresses, both as literal IPs and as
 * hostnames that RESOLVE to such addresses (defeating the DNS-rebinding trick).
 *
 * The crawlers validate the seed URL once per run; because the BFS only enqueues
 * same-origin links and drops cross-origin redirects, validating the seed host
 * covers the whole crawl.
 */

/** True if an IP literal is loopback, private, link-local, or otherwise reserved. */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true; // malformed → treat as unsafe
    const [a, b] = p;
    if (a === 0) return true;                        // "this" network
    if (a === 10) return true;                       // private
    if (a === 127) return true;                      // loopback
    if (a === 169 && b === 254) return true;         // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true;         // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;                       // multicast / reserved / broadcast
    return false;
  }
  const low = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (low === '::1' || low === '::' || low === '') return true; // loopback / unspecified
  if (low.startsWith('fe80')) return true;                      // link-local
  if (low.startsWith('fc') || low.startsWith('fd')) return true; // unique local
  if (low.startsWith('::ffff:')) {                              // IPv4-mapped
    const v4 = low.slice(7);
    return net.isIPv4(v4) ? isPrivateIp(v4) : true;
  }
  return false;
}

/**
 * Throw if `rawUrl` is not a public http(s) URL. Resolves DNS and checks every
 * returned address, so a public hostname that maps to a private IP is still blocked.
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new Error('Invalid URL.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http and https URLs can be crawled.');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    host === 'localhost' || host.endsWith('.localhost') ||
    host.endsWith('.local') || host.endsWith('.internal') ||
    host === 'metadata' || host === 'metadata.google.internal'
  ) {
    throw new Error('Refusing to crawl an internal or loopback host.');
  }
  // Literal IP: check directly.
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Refusing to crawl a private or reserved IP address.');
    return;
  }
  // Hostname: resolve and check every address (blocks DNS-rebinding to internal IPs).
  let addrs: { address: string }[];
  try { addrs = await dns.lookup(host, { all: true }); }
  catch { throw new Error(`Could not resolve host: ${host}`); }
  if (!addrs.length) throw new Error(`Could not resolve host: ${host}`);
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error('That host resolves to a private or reserved IP address — refusing to crawl it.');
  }
}
