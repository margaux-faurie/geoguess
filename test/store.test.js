import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFileStore, createMemoryStore } from '../src/store.js';

const game = (over = {}) => ({ id: 'g1', user_id: 'u', version: 0, n: 1, ...over });

for (const [name, make] of [
  ['memory', () => createMemoryStore()],
  ['file', () => createFileStore(join(mkdtempSync(join(tmpdir(), 'store-')), 'games.json'))],
]) {
  test(`${name} store: versions advance and stale writes conflict`, async () => {
    const store = make();
    assert.equal(await store.get('g1'), null);
    await store.put(game());
    const a = await store.get('g1');
    const b = await store.get('g1');
    assert.equal(a.version, 1);
    a.n = 2;
    await store.put(a);
    assert.equal((await store.get('g1')).n, 2);
    await assert.rejects(store.put(b), { status: 409, code: 'conflict' });
    await assert.rejects(store.put(game({ n: 99 })), { status: 409 }, 'a new game cannot overwrite an existing id');
  });

  test(`${name} store: reads are copies`, async () => {
    const store = make();
    await store.put(game());
    const copy = await store.get('g1');
    copy.n = 'tampered';
    assert.equal((await store.get('g1')).n, 1);
  });
}

test('file store: survives a restart, refuses a corrupt file, and a failed write changes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  const file = join(dir, 'games.json');
  const first = createFileStore(file);
  await first.put(game());
  const reloaded = createFileStore(file);
  assert.equal((await reloaded.get('g1')).version, 1);

  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{"truncated');
  assert.throws(() => createFileStore(bad));

  // The temp file path is a directory, so writing fails: memory must not move on.
  const blocked = join(dir, 'blocked.json');
  mkdirSync(`${blocked}.tmp`);
  const store = createFileStore(blocked);
  await assert.rejects(store.put(game()));
  assert.equal(await store.get('g1'), null);
});
