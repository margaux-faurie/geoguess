import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createNodeServer } from '../src/server.js';
import { fixtureService } from './fixtures.js';

async function withServer(fn, { limits = {} } = {}) {
  const { service, clock } = fixtureService();
  const handle = createApp({ service, env: { GOOGLE_MAPS_API_KEY: 'test-key' }, now: () => clock.t, limits });
  const publicDir = mkdtempSync(join(tmpdir(), 'guessgeo-public-'));
  writeFileSync(join(publicDir, 'index.html'), '<h1>hello</h1>');
  const server = createNodeServer({ handle, publicDir });
  server.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (path, init = {}) => {
    const res = await fetch(base + path, { ...init, headers: { cookie, 'content-type': 'application/json', ...init.headers } });
    const set = res.headers.getSetCookie()[0];
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body, res, text };
  };
  try {
    await fn({ call, clock, base, setCookie: (c) => { cookie = c; } });
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}

test('config exposes the browser key only', async () => {
  await withServer(async ({ call }) => {
    const { status, body } = await call('/api/config');
    assert.equal(status, 200);
    assert.deepEqual(body, { maps_key: 'test-key' });
  });
});

test('a guest cookie is issued once and is httpOnly', async () => {
  await withServer(async ({ call, setCookie }) => {
    const first = await call('/api/maps');
    const set = first.res.headers.getSetCookie()[0];
    assert.match(set, /^gid=[0-9a-f-]{36}; Path=\/; HttpOnly; SameSite=Lax/);
    const second = await call('/api/maps');
    assert.equal(second.res.headers.getSetCookie().length, 0, 'known guest gets no new cookie');
    assert.deepEqual(first.body, [{ id: 'world', name: 'World', location_count: 12 }]);
    setCookie('gid=not-a-uuid');
    const third = await call('/api/maps');
    assert.equal(third.res.headers.getSetCookie().length, 1, 'a malformed cookie is replaced');
  });
});

test('play a full game over HTTP', async () => {
  await withServer(async ({ call, clock }) => {
    const created = await call('/api/games', { method: 'POST', body: JSON.stringify({ settings: { rounds: 3 } }) });
    assert.equal(created.status, 201);
    const id = created.body.game_id;
    assert.ok(!/"lat"|"lng"/.test(created.text), 'no coordinates in the start response');

    assert.deepEqual(created.body.current_round, { round_no: 1, started_at: null }, 'no panorama before the round starts');

    let last;
    for (let n = 1; n <= 3; n++) {
      clock.t += 1500;
      const started = await call(`/api/games/${id}/rounds/${n}/start`, { method: 'POST', body: '{}' });
      assert.equal(started.status, 200);
      assert.equal(typeof started.body.pano_id, 'string');
      last = await call(`/api/games/${id}/rounds/${n}/guess`, { method: 'POST', body: JSON.stringify({ guess: { lat: 5, lng: 5 } }) });
      assert.equal(last.status, 200);
      assert.equal(typeof last.body.score, 'number');
      assert.ok(last.body.true.lat === 0);
    }
    assert.equal(last.body.finished, true);

    const got = await call(`/api/games/${id}`);
    assert.equal(got.body.status, 'finished');
    assert.equal(got.body.results.length, 3);
  });
});

test('errors: bad json, unknown route, foreign game, rate limits', async () => {
  await withServer(async ({ call, clock, setCookie }) => {
    const badJson = await call('/api/games', { method: 'POST', body: '{nope' });
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error, 'bad_json');

    assert.equal((await call('/api/nothing')).status, 404);

    const created = await call('/api/games', { method: 'POST', body: '{}' });
    const id = created.body.game_id;
    setCookie('gid=11111111-1111-4111-8111-111111111111');
    assert.equal((await call(`/api/games/${id}`)).status, 404, "someone else's game");
    setCookie('');

    // fresh player so the original cookie logic does not interfere
    const mine = await call('/api/games', { method: 'POST', body: '{}' });
    const mid = mine.body.game_id;
    await call(`/api/games/${mid}/rounds/1/start`, { method: 'POST', body: '{}' });
    const g1 = await call(`/api/games/${mid}/rounds/1/guess`, { method: 'POST', body: JSON.stringify({ guess: null }) });
    assert.equal(g1.status, 200);
    const g2 = await call(`/api/games/${mid}/rounds/2/guess`, { method: 'POST', body: JSON.stringify({ guess: null }) });
    assert.equal(g2.status, 429, 'second guess within a second');
    clock.t += 1100;
    await call(`/api/games/${mid}/rounds/2/start`, { method: 'POST', body: '{}' });
    const g3 = await call(`/api/games/${mid}/rounds/2/guess`, { method: 'POST', body: JSON.stringify({ guess: null }) });
    assert.equal(g3.status, 200);

    const huge = await call('/api/games', { method: 'POST', body: JSON.stringify({ pad: 'x'.repeat(20_000) }) });
    assert.equal(huge.status, 413);
  });
});

test('game creation is limited per hour', async () => {
  await withServer(async ({ call }) => {
    assert.equal((await call('/api/games', { method: 'POST', body: '{}' })).status, 201);
    assert.equal((await call('/api/games', { method: 'POST', body: '{}' })).status, 201);
    const third = await call('/api/games', { method: 'POST', body: '{}' });
    assert.equal(third.status, 429);
  }, { limits: { gamesPerHour: 2 } });
});

test('static files: served, no directory traversal', async () => {
  await withServer(async ({ base }) => {
    const ok = await fetch(`${base}/`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '<h1>hello</h1>');
    assert.equal((await fetch(`${base}/missing.js`)).status, 404);
    const raw = await fetch(`${base}/..%2f..%2fpackage.json`);
    assert.ok([403, 404].includes(raw.status), `traversal got ${raw.status}`);
    assert.notEqual(raw.headers.get('content-type'), 'application/json; charset=utf-8');
  });
});
