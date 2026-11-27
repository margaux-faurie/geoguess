// Local dev server: serves public/ and hands /api/* to the runtime-agnostic app.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from './app.js';
import { loadEnv } from './env.js';
import { createGameService } from './game.js';
import { SECURITY_HEADERS } from './security-headers.js';
import { parseMaps } from './maps.js';
import { createFileStore } from './store.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function readBody(req, limit = 11_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createNodeServer({ handle, publicDir = join(ROOT, 'public') }) {
  return http.createServer(async (req, res) => {
    try {
      let url;
      try {
        url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS }).end('Bad request');
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        if (!['GET', 'POST'].includes(req.method)) {
          res.writeHead(405, { allow: 'GET, POST', ...SECURITY_HEADERS }).end();
          return;
        }
        const hasBody = req.method !== 'GET';
        const body = hasBody ? await readBody(req) : undefined;
        if (hasBody && body === null) {
          res.writeHead(413, { 'content-type': 'application/json', ...SECURITY_HEADERS }).end('{"error":"too_large"}');
          return;
        }
        // The client address comes from the socket, never from a header the caller could set.
        const headers = { ...req.headers, 'x-client-ip': req.socket.remoteAddress ?? 'unknown' };
        const response = await handle(new Request(url, { method: req.method, headers, body }));
        const out = {};
        for (const [k, v] of response.headers) if (k !== 'set-cookie') out[k] = v;
        const cookies = response.headers.getSetCookie();
        if (cookies.length) out['set-cookie'] = cookies;
        res.writeHead(response.status, out).end(Buffer.from(await response.arrayBuffer()));
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD', ...SECURITY_HEADERS }).end();
        return;
      }
      let rel;
      try {
        rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS }).end('Bad request');
        return;
      }
      const file = resolve(publicDir, `.${rel}`);
      if (file !== publicDir && !file.startsWith(publicDir + sep)) {
        res.writeHead(403, SECURITY_HEADERS).end('Forbidden');
        return;
      }
      const data = await readFile(file).catch(() => null);
      if (!data) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS }).end('Not found');
        return;
      }
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
        ...SECURITY_HEADERS,
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain', ...SECURITY_HEADERS });
      res.end('Server error');
    }
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  loadEnv(join(ROOT, '.env'));
  let maps;
  try {
    const file = join(ROOT, 'data', 'locations.json');
    maps = parseMaps(JSON.parse(readFileSync(file, 'utf8')), file);
  } catch (e) {
    console.error(`Could not load data/locations.json (${e.code ?? e.message}).`);
    console.error('Run `npm run locations` first (needs GOOGLE_METADATA_API_KEY in .env).');
    process.exit(1);
  }
  let store;
  try {
    store = createFileStore(join(ROOT, 'data', 'games.json'));
  } catch (e) {
    console.error(`Could not read data/games.json (${e.message}). Fix or delete the file to start fresh.`);
    process.exit(1);
  }
  const service = createGameService({ maps, store });
  // Only the browser key goes to the app: the metadata key must never sit next to code that serves requests.
  const handle = createApp({ service, env: { GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY } });
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '127.0.0.1'; // local only; set HOST=0.0.0.0 to share on your network
  createNodeServer({ handle }).listen(port, host, () => {
    console.log(`guessgeo on http://localhost:${port}`);
    if (!process.env.GOOGLE_MAPS_API_KEY) console.log('GOOGLE_MAPS_API_KEY is not set: the game cannot show Street View.');
  });
}
