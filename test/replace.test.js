import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureService } from './fixtures.js';

const ME = 'user-me';

async function rejects(promise, status, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.status, status);
    assert.equal(e.code, code);
    return true;
  });
}

test('a dead panorama is replaced once, with a fresh clock, without revealing the old place', async () => {
  const { service, clock } = fixtureService();
  const g = await service.startGame(ME, { settings: { time_limit_s: 30 } });
  const r1 = await service.startRound(ME, g.game_id, 1);
  clock.t += 20_000;

  const r2 = await service.replaceRound(ME, g.game_id, 1, r1.pano_id);
  assert.notEqual(r2.pano_id, r1.pano_id);
  assert.equal(r2.round_no, 1);
  assert.equal(r2.started_at, clock.t, 'the new panorama gets a fresh clock');
  assert.equal(r2.ends_at, clock.t + 30_000);
  assert.ok(!/"lat"|"lng"|true_|dead_panos|replaced/.test(JSON.stringify([r2, await service.getGame(ME, g.game_id)])));

  // The new panorama is not one of the game's other rounds.
  const game = await service.getGame(ME, g.game_id);
  assert.equal(game.current_round.pano_id, r2.pano_id);

  // A retry naming the old panorama changes nothing; a second real replacement is refused.
  assert.equal((await service.replaceRound(ME, g.game_id, 1, r1.pano_id)).pano_id, r2.pano_id);
  await rejects(service.replaceRound(ME, g.game_id, 1, r2.pano_id), 409, 'already_replaced');
});

test('replacement rules: own game, current started round, real panorama id', async () => {
  const { service } = fixtureService();
  const g = await service.startGame(ME);
  await rejects(service.replaceRound(ME, g.game_id, 1, 'x'), 409, 'round_not_started');
  const r1 = await service.startRound(ME, g.game_id, 1);
  await rejects(service.replaceRound('someone-else', g.game_id, 1, r1.pano_id), 404, 'not_found');
  await rejects(service.replaceRound(ME, g.game_id, 2, r1.pano_id), 409, 'round_not_started');
  // A made-up id answers with the round unchanged.
  assert.equal((await service.replaceRound(ME, g.game_id, 1, 'made-up')).pano_id, r1.pano_id);
  assert.equal((await service.replaceRound(ME, g.game_id, 1, 42)).pano_id, r1.pano_id);
});

test('a replaced round is scored against the new place', async () => {
  const { service } = fixtureService();
  const g = await service.startGame(ME);
  const r1 = await service.startRound(ME, g.game_id, 1);
  await service.replaceRound(ME, g.game_id, 1, r1.pano_id);
  const pano = (await service.getGame(ME, g.game_id)).current_round.pano_id;
  const i = Number(pano.split('-')[1]);
  const res = await service.submitGuess(ME, g.game_id, 1, { lat: 0, lng: -150 + i * 25 });
  assert.equal(res.score, 5000, 'guessing the new place exactly scores full points');
});

test('no spare location left: the replacement is refused', async () => {
  const { service } = fixtureService();
  const g = await service.startGame(ME, { settings: { rounds: 10 } }); // 10 of the 12 fixture locations
  const ids = [];
  for (let n = 1; n <= 2; n++) {
    const r = await service.startRound(ME, g.game_id, n);
    ids.push((await service.replaceRound(ME, g.game_id, n, r.pano_id)).pano_id);
    await service.submitGuess(ME, g.game_id, n, null);
  }
  assert.notEqual(ids[0], ids[1], 'a dead panorama is never handed out again in the same game');
  const r3 = await service.startRound(ME, g.game_id, 3);
  await rejects(service.replaceRound(ME, g.game_id, 3, r3.pano_id), 409, 'no_spare_location');
});

test('no replacement once the round is out of time', async () => {
  const { service, clock } = fixtureService();
  const g = await service.startGame(ME, { settings: { time_limit_s: 30 } });
  const r1 = await service.startRound(ME, g.game_id, 1);
  clock.t += 33_000;
  await rejects(service.replaceRound(ME, g.game_id, 1, r1.pano_id), 409, 'deadline_passed');
});
