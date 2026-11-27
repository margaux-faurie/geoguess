import assert from 'node:assert/strict';
import test from 'node:test';
import { GRACE_MS } from '../src/game.js';
import { fixtureService } from './fixtures.js';

const ME = 'user-me';
const YOU = 'user-you';

async function rejects(promise, status, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.status, status);
    assert.equal(e.code, code);
    return true;
  });
}

test('a new game has 5 rounds and shows no coordinates', async () => {
  const { service } = fixtureService();
  const g = await service.startGame(ME);
  assert.equal(g.rounds_total, 5);
  assert.equal(g.status, 'in_progress');
  assert.deepEqual(Object.keys(g.current_round).sort(), ['deadline_at', 'ends_at', 'heading', 'pano_id', 'round_no', 'started_at']);
  assert.deepEqual(g.results, []);
  const text = JSON.stringify(g);
  assert.ok(!/"lat"|"lng"|true_lat|true_lng/.test(text), 'no coordinates before a guess');
});

test('guessing exactly the true spot gives 5000 and distance 0', async () => {
  const { service, store } = fixtureService();
  const g = await service.startGame(ME);
  const stored = await store.get(g.game_id);
  const r = stored.rounds[0];
  const res = await service.submitGuess(ME, g.game_id, 1, { lat: r.true_lat, lng: r.true_lng });
  assert.equal(res.score, 5000);
  assert.equal(res.distance_km, 0);
  assert.equal(res.total_score, 5000);
});

test('a skip scores 0 with no distance', async () => {
  const { service } = fixtureService();
  const g = await service.startGame(ME);
  const res = await service.submitGuess(ME, g.game_id, 1, null);
  assert.equal(res.score, 0);
  assert.equal(res.distance_km, null);
  assert.equal(res.guess, null);
  assert.equal(res.next.round_no, 2);
});

test('a full game finishes, totals the rounds, and then rejects more guesses', async () => {
  const { service } = fixtureService();
  const g = await service.startGame(ME);
  let last;
  for (let n = 1; n <= 5; n++) last = await service.submitGuess(ME, g.game_id, n, { lat: 10, lng: 10 });
  assert.equal(last.finished, true);
  assert.equal(last.next, null);
  const done = await service.getGame(ME, g.game_id);
  assert.equal(done.status, 'finished');
  assert.equal(done.current_round, null);
  assert.equal(done.results.length, 5);
  assert.equal(done.total_score, done.results.reduce((s, r) => s + r.score, 0));
  await rejects(service.submitGuess(ME, g.game_id, 5, { lat: 0, lng: 0 }), 409, 'game_finished');
});

test('one guess per round, in order', async () => {
  const { service } = fixtureService();
  const g = await service.startGame(ME);
  await rejects(service.submitGuess(ME, g.game_id, 2, { lat: 0, lng: 0 }), 409, 'round_not_started');
  await service.submitGuess(ME, g.game_id, 1, { lat: 0, lng: 0 });
  await rejects(service.submitGuess(ME, g.game_id, 1, { lat: 0, lng: 0 }), 409, 'already_guessed');
});

test('invalid guesses are rejected and do not consume the round', async () => {
  const { service } = fixtureService();
  const g = await service.startGame(ME);
  for (const bad of [{ lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { lat: 'x', lng: 0 }, { lat: NaN, lng: 0 }, 'hello', 42]) {
    await rejects(service.submitGuess(ME, g.game_id, 1, bad), 400, 'bad_guess');
  }
  const res = await service.submitGuess(ME, g.game_id, 1, { lat: 0, lng: 0 });
  assert.equal(res.round_no, 1);
});

test('games belong to their player', async () => {
  const { service } = fixtureService();
  const g = await service.startGame(ME);
  await rejects(service.getGame(YOU, g.game_id), 404, 'not_found');
  await rejects(service.submitGuess(YOU, g.game_id, 1, { lat: 0, lng: 0 }), 404, 'not_found');
  await rejects(service.getGame(ME, 'nope'), 404, 'not_found');
});

test('settings are validated', async () => {
  const { service } = fixtureService();
  await rejects(service.startGame(ME, { settings: { rounds: 0 } }), 400, 'bad_settings');
  await rejects(service.startGame(ME, { settings: { rounds: 11 } }), 400, 'bad_settings');
  await rejects(service.startGame(ME, { settings: { time_limit_s: 5 } }), 400, 'bad_settings');
  await rejects(service.startGame(ME, { settings: { movement: 'fly' } }), 400, 'bad_settings');
  await rejects(service.startGame(ME, { map_id: 'mars' }), 404, 'map_not_found');
  const ok = await service.startGame(ME, { settings: { rounds: 3, time_limit_s: 60, movement: 'nmpz' } });
  assert.deepEqual(ok.settings, { rounds: 3, time_limit_s: 60, movement: 'nmpz' });
  assert.equal(ok.rounds_total, 3);
});

test('a round never repeats a location within one game', async () => {
  const { service, store } = fixtureService();
  const g = await service.startGame(ME, { settings: { rounds: 10 } });
  const stored = await store.get(g.game_id);
  assert.equal(new Set(stored.rounds.map((r) => r.pano_id)).size, 10);
});

test('timer: a guess inside the grace window counts, after the deadline it scores 0 with a 410', async () => {
  const { service, store, clock } = fixtureService();
  const g = await service.startGame(ME, { settings: { time_limit_s: 30 } });
  const stored = await store.get(g.game_id);
  const r1 = stored.rounds[0];
  assert.equal(g.current_round.ends_at - g.current_round.started_at, 30_000);
  assert.equal(g.current_round.deadline_at - g.current_round.ends_at, GRACE_MS);

  clock.t += 30_000 + GRACE_MS; // exactly at the deadline: still accepted
  const ok = await service.submitGuess(ME, g.game_id, 1, { lat: r1.true_lat, lng: r1.true_lng });
  assert.equal(ok.score, 5000);

  clock.t += 30_000 + GRACE_MS + 1; // round 2 started at the previous time, so this is late
  await assert.rejects(service.submitGuess(ME, g.game_id, 2, { lat: 0, lng: 0 }), (e) => {
    assert.equal(e.status, 410);
    assert.equal(e.code, 'deadline_passed');
    assert.equal(e.body.score, 0);
    assert.equal(e.body.round_no, 2);
    assert.equal(e.body.next.round_no, 3);
    assert.ok(e.body.true, 'the answer is still revealed');
    return true;
  });
  const after = await service.getGame(ME, g.game_id);
  assert.equal(after.current_round.round_no, 3);
  assert.equal(after.results[1].score, 0);
});

test('concurrent writes: a stale copy of the game is rejected with a conflict', async () => {
  const { service, store } = fixtureService();
  const g = await service.startGame(ME);
  const a = await store.get(g.game_id);
  const b = await store.get(g.game_id);
  a.total_score = 1;
  await store.put(a);
  b.total_score = 2;
  await rejects(store.put(b), 409, 'conflict');
});
