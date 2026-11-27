import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createLimiter } from '../src/limiter.js';
import { SECURITY_HEADERS } from '../src/security-headers.js';
import { createNodeServer } from '../src/server.js';
import { fixtureService } from './fixtures.js';

const ORIGIN = 'https://guessgeo.test';
const UUID_A = '11111111-1111-4111-8111-111111111111';

function setup(limits) {
  const { service, clock } = fixtureService();
  const handle = createApp({ service, now: () => clock.t, limits });
  const post = (path, body, headers = {}) =>
    handle(new Request(ORIGIN + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `__Host-gid=${UUID_A}`, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }));
  return { handle, post, clock };
}

test('POST bodies must be JSON objects, within the size limit counted in bytes', async () => {
  const { post } = setup();
  for (const bad of ['null', '[]', '"x"', '5']) assert.equal((await post('/api/games', bad)).status, 400, bad);
  // 6,000 two-byte characters: under 10,000 characters but over 10,000 bytes.
  assert.equal((await post('/api/games', JSON.stringify({ pad: 'é'.repeat(6000) }))).status, 413);
});

test('POST must be same-origin JSON', async () => {
  const { post } = setup();
  assert.equal((await post('/api/games', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/games', {}, { origin: ORIGIN })).status, 201);
  assert.equal((await post('/api/games', 'a=b', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await post('/api/games', {}, { 'content-type': 'text/plain' })).status, 415);
});

test('a guess without a "guess" field is an error, only an explicit null skips', async () => {
  const { post, clock } = setup();
  const created = await (await post('/api/games', {})).json();
  const path = `/api/games/${created.game_id}/rounds/1`;
  assert.equal((await post(`${path}/start`, {})).status, 200);
  for (const bad of [{}, { lat: 1, lng: 2 }, { gues: null }]) {
    clock.t += 1100; // stay under the one-guess-per-second limit
    const res = await post(`${path}/guess`, bad);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'bad_guess');
  }
  clock.t += 1100;
  assert.equal((await post(`${path}/guess`, { guess: null })).status, 200);
});

test('game ids in the URL must be UUIDs', async () => {
  const { handle } = setup();
  const res = await handle(new Request(`${ORIGIN}/api/games/${'a'.repeat(500)}`, { headers: { cookie: `__Host-gid=${UUID_A}` } }));
  assert.equal(res.status, 404);
});

test('game creation is limited per client address, not only per cookie', async () => {
  const { handle } = setup({ gamesPerHour: 100, gamesPerHourPerIp: 3 });
  const create = (n) =>
    handle(new Request(`${ORIGIN}/api/games`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client-ip': '203.0.113.9', cookie: `__Host-gid=00000000-0000-4000-8000-${String(n).padStart(12, '0')}` },
      body: '{}',
    }));
  const statuses = [];
  for (let n = 1; n <= 5; n++) statuses.push((await create(n)).status); // a fresh cookie each time
  assert.deepEqual(statuses, [201, 201, 201, 429, 429]);
});

test('over https the cookie is __Host-prefixed and Secure; over http it is plain', async () => {
  const { handle } = setup();
  const https = await handle(new Request(`${ORIGIN}/api/maps`));
  assert.match(https.headers.get('set-cookie'), /^__Host-gid=[0-9a-f-]{36}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
  const http1 = await handle(new Request('http://localhost:3000/api/maps'));
  assert.match(http1.headers.get('set-cookie'), /^gid=/);
  assert.ok(!/Secure/.test(http1.headers.get('set-cookie')));
});

test('limiter: counts per key, resets with time, and drops stale keys', () => {
  const limiter = createLimiter({ windowMs: 1000, max: 2 });
  assert.equal(limiter.allow('a', 0), true);
  assert.equal(limiter.allow('a', 1), true);
  assert.equal(limiter.allow('a', 2), false);
  assert.equal(limiter.allow('b', 3), true, 'other keys are independent');
  assert.equal(limiter.allow('a', 1002), true, 'the window slides');

  for (let i = 0; i < 100; i++) limiter.allow(`k${i}`, 10);
  assert.ok(limiter.size() > 100);
  limiter.allow('later', 5000); // past every window: the sweep runs
  assert.equal(limiter.size(), 1, 'stale keys are gone');
});

test('limiter: a refused key never creates state of its own', () => {
  const limiter = createLimiter({ windowMs: 1000, max: 0 });
  assert.equal(limiter.allow('x', 0), false);
  assert.equal(limiter.size(), 0);
});

async function withNode(fn) {
  const { service, clock } = fixtureService();
  const handle = createApp({ service, now: () => clock.t });
  const publicDir = mkdtempSync(join(tmpdir(), 'guessgeo-public-'));
  writeFileSync(join(publicDir, 'index.html'), '<h1>hello</h1>');
  const server = createNodeServer({ handle, publicDir });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, server.address().port);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}

const raw = (port, requestLine) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: requestLine.method, path: requestLine.path, headers: requestLine.headers });
    req.on('response', (res) => { res.resume(); res.on('end', () => resolve(res)); });
    req.on('error', reject);
    req.end();
  });

test('node server: security headers everywhere, 400 for malformed paths, 405 for odd methods', async () => {
  await withNode(async (base, port) => {
    const page = await fetch(`${base}/`);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(page.headers.get(name), value, name);
    const missing = await fetch(`${base}/missing.js`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('x-content-type-options'), 'nosniff');

    assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
    assert.equal((await raw(port, { method: 'TRACE', path: '/api/maps' })).statusCode, 405);
    assert.equal((await raw(port, { method: 'DELETE', path: '/' })).statusCode, 405);
    assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
  });
});

test('node server: spoofed client-address headers do not escape the per-address limit', async () => {
  const { service, clock } = fixtureService();
  const handle = createApp({ service, now: () => clock.t, limits: { gamesPerHourPerIp: 2 } });
  const publicDir = mkdtempSync(join(tmpdir(), 'guessgeo-public-'));
  const server = createNodeServer({ handle, publicDir });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${base}/api/games`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-client-ip': `9.9.9.${i}`, 'cf-connecting-ip': `8.8.8.${i}` }, // no cookie, new "address" each time
        body: '{}',
      });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [201, 201, 429, 429]);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});

test('node server: a request target that is not origin-form is rejected', async () => {
  await withNode(async (_base, port) => {
    assert.equal((await raw(port, { method: 'GET', path: '//evil.example/api/maps' })).statusCode, 400);
  });
});

test('public/_headers carries exactly the same security headers as the Node server', () => {
  const text = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
  const parsed = Object.fromEntries(
    text.split('\n').slice(1).filter(Boolean).map((l) => {
      const i = l.indexOf(':');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
  assert.deepEqual(parsed, SECURITY_HEADERS);
});
