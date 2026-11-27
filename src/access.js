// Cloudflare Access identity. Access puts a signed JWT in the Cf-Access-Jwt-Assertion header;
// we verify signature, issuer, audience and expiry ourselves, so a request that reaches the Worker
// some other way (for example its workers.dev address) cannot pretend to be a logged-in friend.
// Web APIs only: runs in a Worker and in Node.

import { HttpError } from './errors.js';

const JWKS_TTL_MS = 3_600_000;
const CLOCK_SKEW_S = 30;
const MAX_TOKEN_CHARS = 8_192;

const decoder = new TextDecoder();

function b64urlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function parseJsonPart(value) {
  return JSON.parse(decoder.decode(b64urlToBytes(value)));
}

function unauthorized() {
  return new HttpError(401, 'unauthorized', 'Sign in required.');
}

/**
 * @param {{ teamDomain: string, audience: string, fetchImpl?: typeof fetch, now?: () => number }} options
 *   teamDomain: "<team>.cloudflareaccess.com"; audience: the Access application's AUD tag.
 * @returns {(token: string | null) => Promise<{ sub: string, email: string | null }>}
 */
export function createAccessVerifier({ teamDomain, audience, fetchImpl = fetch, now = Date.now }) {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.cloudflareaccess\.com$/i.test(teamDomain ?? '')) {
    throw new Error('ACCESS_TEAM_DOMAIN must look like "<team>.cloudflareaccess.com".');
  }
  if (!audience) throw new Error('ACCESS_AUD is required.');
  const issuer = `https://${teamDomain}`;
  let cache = { keys: new Map(), fetchedAt: 0 };

  async function refreshKeys() {
    const res = await fetchImpl(`${issuer}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`Could not fetch Access keys (${res.status}).`);
    const { keys } = await res.json();
    const next = new Map();
    for (const jwk of keys ?? []) {
      if (jwk.kty !== 'RSA' || !jwk.kid) continue;
      next.set(
        jwk.kid,
        await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']),
      );
    }
    cache = { keys: next, fetchedAt: now() };
  }

  async function keyFor(kid) {
    if (now() - cache.fetchedAt > JWKS_TTL_MS || !cache.keys.has(kid)) {
      // Unknown kid: refetch at most once per call (keys rotate), never trust the token's own key.
      await refreshKeys();
    }
    return cache.keys.get(kid) ?? null;
  }

  return async function verify(token) {
    if (!token || token.length > MAX_TOKEN_CHARS) throw unauthorized();
    const parts = token.split('.');
    if (parts.length !== 3) throw unauthorized();

    let header;
    let claims;
    try {
      header = parseJsonPart(parts[0]);
      claims = parseJsonPart(parts[1]);
    } catch {
      throw unauthorized();
    }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw unauthorized();

    let key;
    try {
      key = await keyFor(header.kid);
    } catch (e) {
      console.error('access keys unavailable', e.message);
      throw new HttpError(503, 'auth_unavailable', 'Sign-in is temporarily unavailable.');
    }
    if (!key) throw unauthorized();

    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) throw unauthorized();

    const t = Math.floor(now() / 1000);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== issuer || !audiences.includes(audience)) throw unauthorized();
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < t) throw unauthorized();
    if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_S > t) throw unauthorized();
    if (typeof claims.sub !== 'string' || !claims.sub) throw unauthorized();

    return { sub: claims.sub, email: typeof claims.email === 'string' ? claims.email : null };
  };
}

/** An `identify` for createApp: the player is the Access user, identified by the stable `sub` claim. */
export function accessIdentity(verify) {
  return async (request) => {
    const who = await verify(request.headers.get('cf-access-jwt-assertion'));
    return { userId: `access:${who.sub}`, setCookie: null };
  };
}
