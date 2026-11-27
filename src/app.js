// Runtime-agnostic request handler (Web standard Request -> Response).
// Node runs it through src/server.js; a Cloudflare Worker calls it from its fetch handler.

import { HttpError } from './errors.js';
import { createLimiter } from './limiter.js';

const MAX_BODY_BYTES = 10_000;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`, 'i');
const GAME_PATH = new RegExp(`^/api/games/(${UUID})$`, 'i');
const START_PATH = new RegExp(`^/api/games/(${UUID})/rounds/(\\d{1,2})/start$`, 'i');
const GUESS_PATH = new RegExp(`^/api/games/(${UUID})/rounds/(\\d{1,2})/guess$`, 'i');

/**
 * Default identity: guests get a random id kept in a cookie (local development).
 * Production passes an `identify` that verifies Cloudflare Access (see src/access.js).
 * Contract: (request, url) -> { userId, setCookie } | Promise of it; throws HttpError(401/403) to refuse.
 */
export function guestIdentity(request, url) {
  const secure = url.protocol === 'https:';
  const name = secure ? '__Host-gid' : 'gid'; // __Host- needs Secure + Path=/ and no Domain: a sibling site cannot set it
  const cookie = request.headers.get('cookie') ?? '';
  const found = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookie)?.[1];
  if (found && UUID_RE.test(found)) return { userId: found, setCookie: null };
  const userId = globalThis.crypto.randomUUID();
  return {
    userId,
    setCookie: `${name}=${userId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}`,
  };
}

/** Same-origin JSON only: closes the door on form posts and cross-site requests. */
function assertSameOriginJson(request, url) {
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== url.origin) {
    throw new HttpError(403, 'forbidden_origin', 'Cross-site requests are not allowed.');
  }
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Send application/json.');
  }
}

/** Read at most MAX_BODY_BYTES (counted in bytes while streaming), and require a JSON object. */
async function readJsonObject(request) {
  const declared = Number(request.headers.get('content-length'));
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'too_large', 'Request body is too large.');

  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, 'too_large', 'Request body is too large.');
      }
      chunks.push(value);
    }
  }
  const text = new TextDecoder().decode(concatChunks(chunks, size));
  if (!text.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_json', 'The request body is not valid JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'bad_json', 'Send a JSON object.');
  }
  return parsed;
}

function concatChunks(chunks, size) {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Dev default: the Node adapter stamps x-client-ip from the socket. A Worker passes its own (see edge.js). */
const socketClientIp = (request) => request.headers.get('x-client-ip') ?? 'unknown';

export function createApp({
  service,
  env = {},
  now = Date.now,
  limits = {},
  identify = guestIdentity,
  clientIp = socketClientIp,
}) {
  const gamesPerUser = createLimiter({ windowMs: 3_600_000, max: limits.gamesPerHour ?? 30 });
  const gamesPerIp = createLimiter({ windowMs: 3_600_000, max: limits.gamesPerHourPerIp ?? 90 });
  const guessLimit = createLimiter({ windowMs: 1000, max: limits.guessesPerSecond ?? 1 });

  async function route(request, url, userId) {
    const { pathname } = url;
    const method = request.method;
    let m;

    if (method === 'POST') assertSameOriginJson(request, url);

    if (pathname === '/api/config' && method === 'GET') {
      return { body: { maps_key: env.GOOGLE_MAPS_API_KEY || null } };
    }
    if (pathname === '/api/maps' && method === 'GET') {
      return { body: service.listMaps() };
    }
    if (pathname === '/api/games' && method === 'POST') {
      const t = now();
      // Address first: a refused request must not leave a new per-user key behind.
      if (!gamesPerIp.allow(clientIp(request), t) || !gamesPerUser.allow(userId, t)) {
        throw new HttpError(429, 'rate_limited', 'Too many new games. Try again later.');
      }
      return { status: 201, body: await service.startGame(userId, await readJsonObject(request)) };
    }
    if ((m = GAME_PATH.exec(pathname)) && method === 'GET') {
      return { body: await service.getGame(userId, m[1].toLowerCase()) };
    }
    if ((m = START_PATH.exec(pathname)) && method === 'POST') {
      await readJsonObject(request);
      return { body: await service.startRound(userId, m[1].toLowerCase(), Number(m[2])) };
    }
    if ((m = GUESS_PATH.exec(pathname)) && method === 'POST') {
      if (!guessLimit.allow(`${userId}:${m[1].toLowerCase()}`, now())) {
        throw new HttpError(429, 'rate_limited', 'Slow down: one guess per second.');
      }
      const body = await readJsonObject(request);
      // A missing "guess" is an error, not a skip: only an explicit null skips the round.
      if (!('guess' in body)) throw new HttpError(400, 'bad_guess', 'Send {"guess": {"lat", "lng"}} or {"guess": null} to skip.');
      return { body: await service.submitGuess(userId, m[1].toLowerCase(), Number(m[2]), body.guess) };
    }
    throw new HttpError(404, 'not_found', 'Not found.');
  }

  return async function handle(request) {
    const url = new URL(request.url);
    let status = 200;
    let body;
    let setCookie = null;
    try {
      const identity = await identify(request, url);
      setCookie = identity.setCookie;
      const out = await route(request, url, identity.userId);
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
