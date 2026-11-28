import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createD1Store } from '../src/d1-store.js';

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // Node < 22.5: no built-in SQLite, the D1 contract tests are skipped.
}

// D1 is SQLite: wrap node:sqlite in the small slice of the D1 API the store uses.
function fakeD1() {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of ['0001_init.sql', '0002_maps.sql']) sqlite.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
  return {
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      return {
        bind: (...args) => ({
          first: async () => stmt.get(...args) ?? null,
          run: async () => ({ meta: { changes: Number(stmt.run(...args).changes) } }),
        }),
      };
    },
  };
}

const game = (over = {}) => ({ id: 'g1', user_id: 'u1', version: 0, rounds: [1, 2, 3], ...over });

test('d1 store: insert, read back, update', { skip: !DatabaseSync }, async () => {
  const store = createD1Store(fakeD1(), () => 1000);
  assert.equal(await store.get('g1'), null);
  await store.put(game());
  const first = await store.get('g1');
  assert.equal(first.version, 1);
  assert.deepEqual(first.rounds, [1, 2, 3]);
  first.rounds.push(4);
  await store.put(first);
  const second = await store.get('g1');
  assert.equal(second.version, 2);
  assert.deepEqual(second.rounds, [1, 2, 3, 4]);
});

test('d1 store: stale writes get a 409, new games cannot overwrite an existing id', { skip: !DatabaseSync }, async () => {
  const store = createD1Store(fakeD1());
  await store.put(game());
  const a = await store.get('g1');
  const b = await store.get('g1');
  await store.put(a);
  await assert.rejects(store.put(b), { status: 409, code: 'conflict' });
  await assert.rejects(store.put(game({ rounds: ['hijack'] })), { status: 409 });
  assert.deepEqual((await store.get('g1')).rounds, [1, 2, 3]);
});

test('d1 store: values with quotes and unicode are bound, not interpolated', { skip: !DatabaseSync }, async () => {
  const store = createD1Store(fakeD1());
  await store.put(game({ id: "x'); DROP TABLE games;--", user_id: 'é"u' }));
  assert.equal((await store.get("x'); DROP TABLE games;--")).user_id, 'é"u');
  await store.put(game({ id: 'g2' }));
  assert.ok(await store.get('g2'));
});
