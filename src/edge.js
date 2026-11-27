// Wires the pieces for a Worker: Access identity + D1 store + the game service. No Cloudflare globals,
// so it can be tested in Node with a fake D1.

import { accessIdentity, createAccessVerifier } from './access.js';
import { createApp } from './app.js';
import { createD1Store } from './d1-store.js';
import { createGameService } from './game.js';
import { parseMaps } from './maps.js';

/** @param {{ env: object, db: object, locations: unknown, fetchImpl?: typeof fetch, now?: () => number }} deps */
export function createEdgeApp({ env, db, locations, fetchImpl, now }) {
  const verify = createAccessVerifier({
    teamDomain: env.ACCESS_TEAM_DOMAIN,
    audience: env.ACCESS_AUD,
    fetchImpl,
    now,
  });
  const service = createGameService({
    maps: parseMaps(locations, 'data/locations.json'),
    store: createD1Store(db, now),
    now,
  });
  return createApp({ service, env, now, identify: accessIdentity(verify) });
}
