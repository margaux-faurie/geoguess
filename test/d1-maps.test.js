import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadMapsFromD1, mapsToSql } from '../src/d1-maps.js';
import worker from '../src/worker.js';
import { fixtureMap } from './fixtures.js';

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // Node < 22.5: skipped.
}

function fakeD1() {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of ['0001_init.sql', '0002_maps.sql']) {
    sqlite.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
  }
  const wrap = (stmt, args) => ({
    first: async () => stmt.get(...args) ?? null,
    run: async () => ({ meta: { changes: Number(stmt.run(...args).changes) } }),
    all: async () => ({ results: stmt.all(...args) }),
  });
  return {
    sqlite,
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      return { bind: (...a) => wrap(stmt, a), ...wrap(stmt, []) };
    },
  };
}

test('maps round-trip through the generated SQL, quotes included', { skip: !DatabaseSync }, async () => {
  const db = fakeD1();
  const map = { ...fixtureMap(), name: "World's \"best\"; DROP TABLE maps;--" };
  db.sqlite.exec(mapsToSql([map], 1000));
  const [loaded] = await loadMapsFromD1(db);
  assert.equal(loaded.name, map.name);
  assert.equal(loaded.locations.length, 12);
  assert.deepEqual(loaded.locations[3], { ...map.locations[3] });
  // Uploading again replaces, it does not duplicate.
  db.sqlite.exec(mapsToSql([{ ...map, name: 'World' }], 2000));
  const again = await loadMapsFromD1(db);
  assert.equal(again.length, 1);
  assert.equal(again[0].name, 'World');
});

test('an empty maps table is an error that says what to run', { skip: !DatabaseSync }, async () => {
  await assert.rejects(loadMapsFromD1(fakeD1()), /locations:upload/);
});

test('worker: 503 until locations are uploaded, then it starts without a redeploy', { skip: !DatabaseSync }, async () => {
  const db = fakeD1();
  const env = { DB: db, ACCESS_TEAM_DOMAIN: 'x.cloudflareaccess.com', ACCESS_AUD: 'aud', GOOGLE_MAPS_API_KEY: 'k' };
  const req = () => new Request('https://guessgeo.test/api/maps');
  const errors = [];
  const original = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const first = await worker.fetch(req(), env);
    assert.equal(first.status, 503);
    assert.deepEqual(await first.json(), { error: 'server_error', message: 'The service is not configured.' });
    db.sqlite.exec(mapsToSql([fixtureMap()]));
    // Now it starts; with no Access token the API refuses, which proves the app is up and failing closed.
    const second = await worker.fetch(req(), env);
    assert.equal(second.status, 401);
  } finally {
    console.error = original;
  }
  assert.ok(errors.some((e) => /locations:upload/.test(e)));
});
