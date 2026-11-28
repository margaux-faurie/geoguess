// Cloudflare Worker entry. Static files in public/ are served by the platform; only /api/* reaches this code
// (see wrangler.toml). Identity comes from Cloudflare Access; missing Access settings means no API (fail closed).

import locations from '../data/locations.json';
import { createEdgeApp } from './edge.js';

let handle;

export default {
  async fetch(request, env) {
    try {
      handle ??= createEdgeApp({ env, db: env.DB, locations });
      return await handle(request);
    } catch (e) {
      // Misconfiguration (missing Access settings, bad locations file): nothing specific goes to the client.
      console.error('worker init failed', e.message);
      return new Response('{"error":"server_error","message":"The service is not configured."}', {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
  },
};
