// Runtime-agnostic request handler (Web standard Request -> Response).
// Node runs it through src/server.js; a Cloudflare Worker can call it from its fetch handler.

import { HttpError } from './errors.js';

const MAX_BODY_BYTES = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createLimiter({ windowMs, max }) {
  const hits = new Map();
  return (key, t) => {
    const recent = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(t);
    hits.set(key, recent);
    if (hits.size > 5000) for (const k of hits.keys()) if (!hits.get(k).some((x) => t - x < windowMs)) hits.delete(k);
    return true;
  };
}

/**
 * Who is playing. Guests get a random id kept in a cookie.
 * Swap this function for Cloudflare Access (Cf-Access-Authenticated-User-Email) or real accounts later.
 */
function identify(request, url) {
  const cookie = request.headers.get('cookie') ?? '';
  const found = /(?:^|;\s*)gid=([^;]+)/.exec(cookie)?.[1];
  if (found && UUID.test(found)) return { userId: found, setCookie: null };
  const userId = globalThis.crypto.randomUUID();
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return {
    userId,
    setCookie: `gid=${userId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`,
  };
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'too_large', 'Request body is too large.');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_json', 'The request body is not valid JSON.');
  }
}

export function createApp({ service, env = {}, now = Date.now, limits = {} }) {
  const gameCreateLimit = createLimiter({ windowMs: 3_600_000, max: limits.gamesPerHour ?? 30 });
  const guessLimit = createLimiter({ windowMs: 1000, max: limits.guessesPerSecond ?? 1 });

  async function route(request, url, userId) {
    const { pathname } = url;
    const method = request.method;
    let m;

    if (pathname === '/api/config' && method === 'GET') {
      return { body: { maps_key: env.GOOGLE_MAPS_API_KEY || null } };
    }
    if (pathname === '/api/maps' && method === 'GET') {
      return { body: service.listMaps() };
    }
    if (pathname === '/api/games' && method === 'POST') {
      if (!gameCreateLimit(userId, now())) {
        throw new HttpError(429, 'rate_limited', 'Too many new games. Try again later.');
      }
      return { status: 201, body: await service.startGame(userId, await readJson(request)) };
    }
    if ((m = /^\/api\/games\/([^/]+)$/.exec(pathname)) && method === 'GET') {
      return { body: await service.getGame(userId, m[1]) };
    }
    if ((m = /^\/api\/games\/([^/]+)\/rounds\/(\d+)\/guess$/.exec(pathname)) && method === 'POST') {
      if (!guessLimit(`${userId}:${m[1]}`, now())) {
        throw new HttpError(429, 'rate_limited', 'Slow down: one guess per second.');
      }
      const body = await readJson(request);
      const guess = body.guess !== undefined ? body.guess : body.lat !== undefined ? { lat: body.lat, lng: body.lng } : null;
      return { body: await service.submitGuess(userId, m[1], Number(m[2]), guess) };
    }
    throw new HttpError(404, 'not_found', 'Not found.');
  }

  return async function handle(request) {
    const url = new URL(request.url);
    const { userId, setCookie } = identify(request, url);
    let status = 200;
    let body;
    try {
      const out = await route(request, url, userId);
      status = out.status ?? 200;
      body = out.body;
    } catch (e) {
      if (e instanceof HttpError) {
        status = e.status;
        body = { error: e.code, message: e.message, ...e.body };
      } else {
        console.error(e);
        status = 500;
        body = { error: 'server_error', message: 'Something went wrong on the server.' };
      }
    }
    const headers = new Headers({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    if (setCookie) headers.append('set-cookie', setCookie);
    return new Response(JSON.stringify(body), { status, headers });
  };
}
