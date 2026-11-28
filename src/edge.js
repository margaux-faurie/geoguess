// Wires the pieces for a Worker: Access identity + D1 store + the game service. No Cloudflare globals,
// so it can be tested in Node with a fake D1.

import { accessIdentity, createAccessVerifier } from './access.js';
import { createApp } from './app.js';
import { createD1Store } from './d1-store.js';
import { createGameService } from './game.js';
import { parseMaps } from './maps.js';

/**
 * @param {{ env: object, db: object, maps?: Array, locations?: unknown, fetchImpl?: typeof fetch, now?: () => number }} deps
 *   maps: already validated maps (from D1); locations: raw locations data to validate instead.
 */
export function createEdgeApp({ env, db, maps, locations, fetchImpl, now }) {
  const verify = createAccessVerifier({
    teamDomain: env.ACCESS_TEAM_DOMAIN,
    audience: env.ACCESS_AUD,
    fetchImpl,
    now,
  });
  const service = createGameService({
    maps: maps ?? parseMaps(locations, 'locations'),
    store: createD1Store(db, now),
    now,
  });
  // On Cloudflare the edge sets cf-connecting-ip; nothing else is trusted for the client address.
  const clientIp = (request) => request.headers.get('cf-connecting-ip') ?? 'unknown';
  return createApp({ service, env, now, identify: accessIdentity(verify), clientIp });
}
