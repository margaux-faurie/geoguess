import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createEdgeApp } from '../src/edge.js';
import { fixtureMap } from './fixtures.js';

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // Node < 22.5: skipped.
}

const TEAM = 'margaux.cloudflareaccess.com';
const AUD = 'aud-1';
const NOW = 1_800_000_000_000;
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const json = (v) => b64url(new TextEncoder().encode(JSON.stringify(v)));

function fakeD1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  return {
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      return {
        bind: (...a) => ({
          first: async () => stmt.get(...a) ?? null,
          run: async () => ({ meta: { changes: Number(stmt.run(...a).changes) } }),
        }),
      };
    },
  };
}

test('worker app: Access login required, games are per user, a full guess works', { skip: !DatabaseSync }, async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' };
  const token = async (sub) => {
    const head = json({ alg: 'RS256', kid: 'k1' });
    const body = json({ iss: `https://${TEAM}`, aud: [AUD], sub, exp: NOW / 1000 + 600 });
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
  };

  const handle = createEdgeApp({
    env: { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, GOOGLE_MAPS_API_KEY: 'browser-key' },
    db: fakeD1(),
    locations: fixtureMap(),
    fetchImpl: async () => new Response(JSON.stringify({ keys: [jwk] })),
    now: () => NOW,
  });
  const call = async (path, who, init = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (who) headers['cf-access-jwt-assertion'] = await token(who);
    const res = await handle(new Request(`https://guessgeo.test${path}`, { ...init, headers }));
    return { status: res.status, body: await res.json(), cookie: res.headers.get('set-cookie') };
  };

  assert.equal((await call('/api/maps', null)).status, 401);

  const created = await call('/api/games', 'alice', { method: 'POST', body: '{}' });
  assert.equal(created.status, 201);
  assert.equal(created.cookie, null);
  const game = created.body;

  assert.equal((await call(`/api/games/${game.game_id}`, 'alice')).status, 200);
  assert.equal((await call(`/api/games/${game.game_id}`, 'bob')).status, 404);

  assert.equal((await call(`/api/games/${game.game_id}/rounds/1/start`, 'alice', { method: 'POST', body: '{}' })).status, 200);
  const guess = await call(`/api/games/${game.game_id}/rounds/1/guess`, 'alice', {
    method: 'POST',
    body: JSON.stringify({ guess: { lat: 0, lng: 0 } }),
  });
  assert.equal(guess.status, 200);
  assert.ok(guess.body.score >= 0 || guess.body.result?.score >= 0);
});
