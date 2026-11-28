import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_CHALLENGE_PLAYERS, parseName } from '../src/game.js';
import { fixtureService } from './fixtures.js';

async function rejects(promise, status, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.status, status);
    assert.equal(e.code, code);
    return true;
  });
}

async function playAll(service, user, game, guess = { lat: 0, lng: 0 }) {
  for (let n = 1; n <= game.rounds_total; n++) {
    await service.startRound(user, game.game_id, n);
    await service.submitGuess(user, game.game_id, n, guess);
  }
  return service.getGame(user, game.game_id);
}

async function finishedGame(service, user = 'ana') {
  const g = await service.startGame(user, { settings: { time_limit_s: 60, movement: 'nmpz' } });
  return playAll(service, user, g);
}

test('names: trimmed, 1 to 20 characters, no control or invisible characters', () => {
  assert.equal(parseName('  Ana   Lou '), 'Ana Lou');
  assert.equal(parseName('Zoë 🌍'), 'Zoë 🌍');
  for (const bad of ['', '   ', 'x'.repeat(21), 'a\u0000b', 'a‮b', 42, null]) {
    assert.throws(() => parseName(bad), { status: 400, code: 'bad_name' });
  }
});

test('a friend plays the same rounds with the same settings, and sees no score before finishing', async () => {
  const { service } = fixtureService();
  const mine = await finishedGame(service);
  const { challenge_id } = await service.createChallenge('ana', mine.game_id, 'Ana');
  assert.deepEqual(await service.createChallenge('ana', mine.game_id, 'Other'), { challenge_id }, 'asking again returns the same');

  const before = await service.getChallenge('ben', challenge_id);
  assert.equal(before.created_by, 'Ana');
  assert.equal(before.players, 1);
  assert.equal(before.board, null);
  assert.equal(before.my_game_id, null);
  assert.ok(!/"lat"|"lng"|true_|pano/.test(JSON.stringify(before)), 'no places before playing');

  const g = await service.joinChallenge('ben', challenge_id, 'Ben');
  assert.deepEqual(g.settings, mine.settings);
  assert.equal(g.challenge_id, challenge_id);
  assert.deepEqual(await service.joinChallenge('ben', challenge_id, 'Ben'), { ...g, server_now: g.server_now }, 'joining twice resumes');

  // Same panoramas, round by round.
  const anaRounds = [];
  for (const r of mine.results) anaRounds.push(r.true);
  const ben = await playAll(service, 'ben', g, { lat: 0, lng: 50 });
  assert.deepEqual(ben.results.map((r) => r.true), anaRounds);

  const after = await service.getChallenge('ben', challenge_id);
  assert.equal(after.players, 2);
  assert.deepEqual(after.board.map((p) => p.name).sort(), ['Ana', 'Ben']);
  assert.ok(after.board[0].total_score >= after.board[1].total_score, 'best first');
  assert.equal(after.board[0].rounds.length, 5);
  assert.ok(!/user_id|"ana"|"ben"/.test(JSON.stringify(after)), 'no account ids on the board');
});

test('challenge rules: finished games only, owner only, unknown challenge, full challenge', async () => {
  const { service } = fixtureService();
  const g = await service.startGame('ana');
  await rejects(service.createChallenge('ana', g.game_id, 'Ana'), 409, 'game_not_finished');
  const done = await finishedGame(service, 'cleo');
  await rejects(service.createChallenge('ana', done.game_id, 'Ana'), 404, 'not_found');
  await rejects(service.createChallenge('cleo', done.game_id, ''), 400, 'bad_name');
  await rejects(service.getChallenge('ana', '00000000-0000-4000-8000-999999999999'), 404, 'not_found');
  await rejects(service.joinChallenge('ana', '00000000-0000-4000-8000-999999999999', 'Ana'), 404, 'not_found');

  const { challenge_id } = await service.createChallenge('cleo', done.game_id, 'Cleo');
  // Unfinished games do not fill a challenge; finished ones do.
  for (let i = 1; i < MAX_CHALLENGE_PLAYERS; i++) {
    const g = await service.joinChallenge(`p${i}`, challenge_id, `P${i}`);
    if (i > 1) await playAll(service, `p${i}`, g);
  }
  await service.joinChallenge('p-unfinished-ok', challenge_id, 'Late');
  await playAll(service, 'p1', await service.joinChallenge('p1', challenge_id, 'P1'));
  await rejects(service.joinChallenge('late', challenge_id, 'Late'), 409, 'challenge_full');
  // Someone already in it can still come back.
  assert.equal((await service.joinChallenge('p1', challenge_id, 'P1')).challenge_id, challenge_id);
});

test('no panorama replacement inside a challenge: everyone plays the same places', async () => {
  const { service } = fixtureService();
  const mine = await finishedGame(service);
  const { challenge_id } = await service.createChallenge('ana', mine.game_id, 'Ana');
  const g = await service.joinChallenge('ben', challenge_id, 'Ben');
  const r = await service.startRound('ben', g.game_id, 1);
  await rejects(service.replaceRound('ben', g.game_id, 1, r.pano_id), 409, 'challenge_no_replace');
});

test('scoreboard: equal totals share a place, and the viewer is marked', async () => {
  const { service } = fixtureService();
  const mine = await finishedGame(service);
  const { challenge_id } = await service.createChallenge('ana', mine.game_id, 'Ana');
  await playAll(service, 'ben', await service.joinChallenge('ben', challenge_id, 'Ben')); // same guesses as Ana
  const { board } = await service.getChallenge('ben', challenge_id);
  assert.deepEqual(board.map((p) => p.rank), [1, 1]);
  assert.deepEqual(board.filter((p) => p.me).map((p) => p.name), ['Ben']);
});

test('two joins at once give one game, not a free replay', async () => {
  const { service } = fixtureService();
  const mine = await finishedGame(service);
  const { challenge_id } = await service.createChallenge('ana', mine.game_id, 'Ana');
  const results = await Promise.allSettled([1, 2, 3].map(() => service.joinChallenge('ben', challenge_id, 'Ben')));
  const ids = new Set(results.filter((r) => r.status === 'fulfilled').map((r) => r.value.game_id));
  assert.equal(ids.size, 1);
});
