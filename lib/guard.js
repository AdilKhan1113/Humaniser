// Protection for a public deployment.
//
// Two problems appear the moment this app has a URL instead of a localhost
// port. The API key sits on the server, so anyone who finds the link can spend
// the owner's money; and a single script can exhaust a month's credit in
// minutes. So model rewrites sit behind a shared access code, and every route
// is rate limited per client.
//
// The offline engine is left open: it costs nothing to run and sends nothing
// anywhere, so there is no reason to put a password in front of it.

import crypto from 'node:crypto';

export const ACCESS_CODE = process.env.HUMANISER_ACCESS_CODE || '';
export const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';

// Per-client hourly ceilings. Model rewrites are what cost money; the
// `claude` bucket name is kept for its env var, RATE_LIMIT_CLAUDE.
const LIMITS = {
  claude: Number(process.env.RATE_LIMIT_CLAUDE || 20),
  offline: Number(process.env.RATE_LIMIT_OFFLINE || 240),
  // Rejected access codes are counted separately. Charging them to the model
  // allowance would let anyone probing the endpoint lock the owner out of
  // their own key without ever authenticating.
  auth: Number(process.env.RATE_LIMIT_AUTH || 30),
};
const WINDOW_MS = 60 * 60 * 1000;

const buckets = new Map();

// A ceiling on distinct clients tracked at once. Reached only under abuse, and
// far above any real number of users, so dropping the oldest entries is the
// right trade against unbounded growth.
const MAX_BUCKETS = 50_000;

/**
 * Identifies the client. Behind a host's load balancer the socket address is
 * the balancer, so the forwarded header is used — but only when TRUST_PROXY
 * says a balancer is actually in front, since the header is trivial to forge
 * and would otherwise hand every caller an unlimited supply of identities.
 */
export function clientKey(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Counts a request against a client's hourly allowance.
 * @returns {{ok: boolean, remaining: number, retryAfter: number}}
 */
export function takeToken(key, kind) {
  const limit = LIMITS[kind] ?? LIMITS.offline;
  const now = Date.now();
  const id = `${kind}:${key}`;
  let bucket = buckets.get(id);

  if (!bucket || now - bucket.start >= WINDOW_MS) {
    if (buckets.size >= MAX_BUCKETS) {
      sweepBuckets(now);
      // Still full after sweeping means active abuse. Drop the oldest entries,
      // which Map iterates in insertion order.
      let toDrop = Math.ceil(MAX_BUCKETS / 10);
      for (const key of buckets.keys()) {
        if (toDrop-- <= 0) break;
        buckets.delete(key);
      }
    }
    bucket = { start: now, used: 0 };
    buckets.set(id, bucket);
  }
  if (bucket.used >= limit) {
    return { ok: false, remaining: 0, retryAfter: Math.ceil((bucket.start + WINDOW_MS - now) / 1000) };
  }
  bucket.used += 1;
  return { ok: true, remaining: limit - bucket.used, retryAfter: 0 };
}

/** Drops buckets whose window has passed, so the map cannot grow without end. */
export function sweepBuckets(now = Date.now()) {
  let dropped = 0;
  for (const [id, bucket] of buckets) {
    if (now - bucket.start >= WINDOW_MS) {
      buckets.delete(id);
      dropped += 1;
    }
  }
  return dropped;
}

/**
 * Checks the access code in constant time, so a caller cannot learn the code
 * one character at a time from how long the comparison takes.
 */
export function accessCodeAccepted(supplied) {
  if (!ACCESS_CODE) return true; // no code configured: nothing to check
  // Both sides are hashed to a fixed 32 bytes before comparison. Comparing the
  // raw strings meant a length mismatch returned early, which tells a caller
  // how long the code is.
  const given = crypto.createHash('sha256').update(String(supplied || ''), 'utf8').digest();
  const wanted = crypto.createHash('sha256').update(ACCESS_CODE, 'utf8').digest();
  return crypto.timingSafeEqual(given, wanted);
}

export const limitsForStatus = () => ({ ...LIMITS, windowMinutes: WINDOW_MS / 60000 });
