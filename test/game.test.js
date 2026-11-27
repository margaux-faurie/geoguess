import assert from 'node:assert/strict';
import test from 'node:test';
import { GRACE_MS, createGameService } from '../src/game.js';
import { score } from '../src/scoring.js';
import { fixtureMap, fixtureService } from './fixtures.js';

const ME = 'user-me';
const YOU = 'user-you';

async function rejects(promise, status, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.status, status);
    assert.equal(e.code, code);
    return true;
  });
}

/** Start the round (the player sees it), then guess. */
async function play(service, id, n, guess) {
  await service.startRound(ME, id, n);
  return service.submitGuess(ME, id, n, guess);
}

test('a new game has 5 rounds, shows no coordinates, and reveals no panorama until a round starts', async () => {
  const { service } = fixtureService();
  const g = await service.startGame(ME);
  assert.equal(g.rounds_total, 5);
  assert.equal(g.status, 'in_progress');
  assert.deepEqual(g.current_round, { round_no: 1, started_at: null });
  assert.deepEqual(g.results, []);

  const r = await service.startRound(ME, g.game_id, 1);
  assert.deepEqual(Object.keys(r).sort(), ['deadline_at', 'ends_at', 'heading', 'pano_id', 'round_no', 'server_now', 'started_at']);
  const text = JSON.stringify([g, r, await service.getGame(ME, g.game_id)]);
  assert.ok(!/"lat"|"lng"|true_lat|true_lng/.test(text), 'no coordinates before a guess');
});

test('starting a round is idempotent and cannot be done out of order', async () => {
  const { service, clock } = fixtureService();
  const g = await service.startGame(ME, { settings: { time_limit_s: 30 } });
  const first = await service.startRound(ME, g.game_id, 1);
  clock.t += 5000;
  const again = await service.startRound(ME, g.game_id, 1);
  assert.equal(again.started_at, first.started_at, 'the clock does not restart');
  await rejects(service.startRound(ME, g.game_id, 2), 409, 'round_not_started');
  await rejects(service.startRound(YOU, g.game_id, 1), 404, 'not_found');
  await rejects(service.submitGuess(ME, (await service.startGame(ME)).game_id, 1, null), 409, 'round_not_started');
});

test('a bad body is a 400, not a crash', async () => {
  const { service } = fixtureService();
  for (const bad of [null, [], 'x', 5]) await rejects(service.startGame(ME, bad), 400, 'bad_json');
});

test('guessing exactly the true spot gives 5000 and distance 0', async () => {
  const { service, store } = fixtureService();
  const g = await service.startGame(ME);
  const stored = await store.get(g.game_id);
  const r = stored.rounds[0];
  const res = await play(service, g.game_id, 1, { lat: r.true_lat, lng: r.true_lng });
  assert.equal(res.score, 5000);
  assert.equal(res.distance_km, 0);
  assert.equal(res.total_score, 5000);
});

test('a skip scores 0 with no distance', async () => {
  const { service } = fixtureService();
  const g = await service.startGame(ME);
  const res = await play(service, g.game_id, 1, null);
  assert.equal(res.score, 0);
  assert.equal(res.distance_km, null);
  assert.equal(res.guess, null);
  assert.equal(res.next_round_no, 2);
});

test('a full game finishes, totals the rounds, and then rejects more guesses', async () => {
  const { service } = fixtureService();
  const g = await service.startGame(ME);
  let last;
  for (let n = 1; n <= 5; n++) last = await play(service, g.game_id, n, { lat: 10, lng: 10 });
  assert.equal(last.finished, true);
  assert.equal(last.next_round_no, null);
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
  await service.startRound(ME, g.game_id, 1);
  await rejects(service.submitGuess(ME, g.game_id, 2, { lat: 0, lng: 0 }), 409, 'round_not_started');
  await service.submitGuess(ME, g.game_id, 1, { lat: 0, lng: 0 });
  await rejects(service.submitGuess(ME, g.game_id, 1, { lat: 0, lng: 0 }), 409, 'already_guessed');
});

test('invalid guesses are rejected and do not consume the round', async () => {
  const { service } = fixtureService();
  const g = await service.startGame(ME);
  await service.startRound(ME, g.game_id, 1);
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
  await rejects(service.startRound(YOU, g.game_id, 1), 404, 'not_found');
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
  const round1 = await service.startRound(ME, g.game_id, 1);
  assert.equal(round1.ends_at - round1.started_at, 30_000);
  assert.equal(round1.deadline_at - round1.ends_at, GRACE_MS);

  clock.t += 30_000 + GRACE_MS; // exactly at the deadline: still accepted
  const ok = await service.submitGuess(ME, g.game_id, 1, { lat: r1.true_lat, lng: r1.true_lng });
  assert.equal(ok.score, 5000);

  await service.startRound(ME, g.game_id, 2);
  clock.t += 30_000 + GRACE_MS + 1; // one millisecond past round 2's deadline
  await assert.rejects(service.submitGuess(ME, g.game_id, 2, { lat: 0, lng: 0 }), (e) => {
    assert.equal(e.status, 410);
    assert.equal(e.code, 'deadline_passed');
    assert.equal(e.body.score, 0);
    assert.equal(e.body.round_no, 2);
    assert.equal(e.body.next_round_no, 3);
    assert.ok(e.body.true, 'the answer is still revealed');
    return true;
  });
  const after = await service.getGame(ME, g.game_id);
  assert.equal(after.current_round.round_no, 3);
  assert.equal(after.results[1].score, 0);
});

test('timer: time spent on the result screen never counts against the next round', async () => {
  const { service, store, clock } = fixtureService();
  const g = await service.startGame(ME, { settings: { time_limit_s: 30 } });
  await play(service, g.game_id, 1, { lat: 0, lng: 0 });

  clock.t += 10 * 60_000; // ten minutes reading the result
  const r2 = await service.startRound(ME, g.game_id, 2);
  assert.equal(r2.ends_at - r2.started_at, 30_000);
  const spot = (await store.get(g.game_id)).rounds[1];
  const res = await service.submitGuess(ME, g.game_id, 2, { lat: spot.true_lat, lng: spot.true_lng });
  assert.equal(res.score, 5000, 'a fresh round is not late');
});

test('a game keeps the scale it started with, even if the map changes later', async () => {
  const { service, store, clock } = fixtureService();
  const g = await service.startGame(ME);
  await service.startRound(ME, g.game_id, 1);
  const spot = (await store.get(g.game_id)).rounds[0];
  const nearby = { lat: spot.true_lat + 1, lng: spot.true_lng }; // about 111 km off

  // The same games, now served by a service whose map file changed its scale.
  const changed = fixtureMap();
  changed.scale_km = 1000;
  const later = createGameService({ maps: [changed], store, now: () => clock.t });
  const res = await later.submitGuess(ME, g.game_id, 1, nearby);
  assert.equal(res.score, score(res.distance_km, 14917), 'scored on the scale the game started with');
  assert.notEqual(res.score, score(res.distance_km, 1000));
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
