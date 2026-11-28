// Cloudflare Worker entry. Static files in public/ are served by the platform; only /api/* reaches this code
// (see wrangler.toml). Identity comes from Cloudflare Access; missing Access settings means no API (fail closed).
// The locations (true coordinates) live in D1, uploaded with `npm run locations:upload`, never in the bundle.

import { loadMapsFromD1 } from './d1-maps.js';
import { createEdgeApp } from './edge.js';

let ready; // one start per isolate; a failed start is retried on the next request

async function start(env) {
  const maps = await loadMapsFromD1(env.DB);
  return createEdgeApp({ env, db: env.DB, maps });
}

export default {
  async fetch(request, env) {
    try {
      ready ??= start(env).catch((e) => {
        ready = undefined;
        throw e;
      });
      const handle = await ready;
      return await handle(request);
    } catch (e) {
      // Misconfiguration (missing Access settings, no locations uploaded): nothing specific goes to the client.
      console.error('worker start failed', e.message);
      return new Response('{"error":"server_error","message":"The service is not configured."}', {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
  },
};
