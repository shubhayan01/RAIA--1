import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config';

/**
 * Minimal, dependency-free session auth — identical pattern to SAGE.
 * A signed (HMAC-SHA256) cookie carries the username + expiry — no server-side
 * store needed. Credentials come from .env (AUTH_USERNAME / AUTH_PASSWORD).
 */

const COOKIE = 'scribe_session';

function sign(payload: string): string {
  return crypto.createHmac('sha256', config.auth.secret).update(payload).digest('base64url');
}

function makeToken(username: string): string {
  const exp = Date.now() + config.auth.ttlHours * 3600_000;
  const payload = Buffer.from(JSON.stringify({ u: username, exp })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token: string | undefined): { user: string } | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data?.u || !data?.exp || Date.now() > data.exp) return null;
    return { user: String(data.u) };
  } catch {
    return null;
  }
}

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

/** Current logged-in user, or null. When auth is disabled, returns a synthetic user. */
export function currentUser(req: Request): string | null {
  if (!config.auth.enabled) return 'guest';
  return verifyToken(readCookie(req, COOKIE))?.user ?? null;
}

export function authInfo(req: Request) {
  return { enabled: config.auth.enabled, user: currentUser(req) };
}

/** Gate a request. API paths get 401 JSON; page requests redirect to /login. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!config.auth.enabled || currentUser(req)) return next();
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'auth required' });
  return res.redirect('/login');
}

/* -------- route handlers -------- */
export function handleLogin(req: Request, res: Response) {
  const { username, password } = (req.body || {}) as { username?: string; password?: string };
  const ok = !!username && username === config.auth.username && password === config.auth.password;
  if (!ok) return res.redirect('/login?error=1');

  const token = makeToken(username!);
  res.setHeader('Set-Cookie', cookieString(token, config.auth.ttlHours * 3600));
  return res.redirect('/');
}

export function handleLogout(_req: Request, res: Response) {
  res.setHeader('Set-Cookie', cookieString('', 0));
  return res.redirect('/login');
}

function cookieString(value: string, maxAgeSec: number): string {
  const parts = [
    `${COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  return parts.join('; ');
}
