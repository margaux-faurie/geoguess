// Runtime-agnostic: no Node imports, so this file also runs in a Cloudflare Worker.
// Owns the rules: which locations a game has, round order, deadlines, scoring.
// True coordinates leave this module only through `reveal`, after a round is resolved.

import { HttpError } from './errors.js';
import { FORMULA_VERSION, haversineKm, score } from './scoring.js';

/** Extra time after the limit for a guess already in flight. */
export const GRACE_MS = 2000;
export const MOVEMENTS = ['move', 'nomove', 'nmpz'];

export function parseSettings(input, maxRounds) {
  const s = input && typeof input === 'object' ? input : {};
  const rounds = s.rounds ?? 5;
  const timeLimit = s.time_limit_s ?? 0;
  const movement = s.movement ?? 'move';
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > Math.min(10, maxRounds)) {
    throw new HttpError(400, 'bad_settings', 'Rounds must be a whole number from 1 to 10.');
  }
  if (!Number.isInteger(timeLimit) || (timeLimit !== 0 && (timeLimit < 10 || timeLimit > 600))) {
    throw new HttpError(400, 'bad_settings', 'The time limit must be off (0) or 10 to 600 seconds.');
  }
  if (!MOVEMENTS.includes(movement)) {
    throw new HttpError(400, 'bad_settings', 'Movement must be move, nomove or nmpz.');
  }
  return { rounds, time_limit_s: timeLimit, movement };
}

/** Most players shown on one challenge. */
export const MAX_CHALLENGE_PLAYERS = 50;

/** A display name for a challenge: 1 to 20 printable characters, trimmed. */
export function parseName(raw) {
  const name = typeof raw === 'string' ? raw.normalize('NFC').trim().replace(/\s+/g, ' ') : '';
  // No control, surrogate or invisible formatting characters (joiners allowed, for emoji and Persian),
  // at least one letter or digit, and not a pile of combining marks. Length in code points.
  const invisible = /[\p{Cc}\p{Cs}\u3164\u2800\u115F\u1160\uFFA0]|(?![\u200C\u200D])\p{Cf}/u;
  const marks = (name.match(/\p{M}/gu) ?? []).length;
  if (!name || invisible.test(name) || !/[\p{L}\p{N}]/u.test(name) || marks > 6 || [...name].length > 20) {
    throw new HttpError(400, 'bad_name', 'Pick a name of 1 to 20 characters.');
  }
  return name;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseGuess(g) {
  if (g === null || g === undefined) return null;
  const { lat, lng } = Object(g);
  const ok =
    typeof lat === 'number' && typeof lng === 'number' &&
    Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  if (!ok) {
    throw new HttpError(400, 'bad_guess', 'lat must be between -90 and 90, lng between -180 and 180.');
  }
  return { lat, lng };
}

/**
 * @param {object} deps
 * @param {Array<{id:string,name:string,scale_km:number,locations:Array}>} deps.maps
 * @param {{get:Function,put:Function}} deps.store
 */
export function createGameService({
  maps,
  store,
  now = Date.now,
  random = Math.random,
  newId = () => globalThis.crypto.randomUUID(),
}) {
  const mapsById = new Map(maps.map((m) => [m.id, m]));

  function sample(items, n) {
    const a = items.slice();
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(random() * (a.length - i));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, n);
  }

  const isResolved = (r) => r.score !== null;
  const currentRound = (game) => game.rounds.find((r) => !isResolved(r)) ?? null;

  function beginRound(round) {
    const t = now();
    round.started_at = t;
    round.ends_at = round.time_limit_ms ? t + round.time_limit_ms : null;
    round.deadline_at = round.ends_at ? round.ends_at + GRACE_MS : null;
  }

  /**
   * What the player may see before guessing: never coordinates. A round that has not been started
   * (its clock has not begun) does not even reveal its panorama id.
   */
  function publicRound(r) {
    if (r.started_at === null) return { round_no: r.round_no, started_at: null };
    return {
      round_no: r.round_no,
      pano_id: r.pano_id,
      heading: r.heading,
      started_at: r.started_at,
      ends_at: r.ends_at,
      deadline_at: r.deadline_at,
    };
  }

  /** What the player sees once the round is resolved. */
  function reveal(r) {
    return {
      round_no: r.round_no,
      distance_km: r.distance_km,
      score: r.score,
      guess: r.guess_lat === null ? null : { lat: r.guess_lat, lng: r.guess_lng },
      true: { lat: r.true_lat, lng: r.true_lng },
    };
  }

  function view(game) {
    const cur = game.status === 'in_progress' ? currentRound(game) : null;
    return {
      game_id: game.id,
      map_id: game.map_id,
      mode: game.mode,
      challenge_id: game.challenge_id ?? null,
      settings: game.settings,
      status: game.status,
      total_score: game.total_score,
      rounds_total: game.rounds.length,
      server_now: now(),
      current_round: cur ? publicRound(cur) : null,
      results: game.rounds.filter(isResolved).map(reveal),
    };
  }

  function assertCurrent(cur, roundNo) {
    if (roundNo === cur.round_no) return;
    throw roundNo < cur.round_no
      ? new HttpError(409, 'already_guessed', 'That round already has a guess.')
      : new HttpError(409, 'round_not_started', 'That round is not the current one.');
  }

  async function ownedGame(userId, id) {
    const game = await store.get(id);
    // Same answer for "missing" and "someone else's": no way to probe other games.
    if (!game || game.user_id !== userId) throw new HttpError(404, 'not_found', 'Game not found.');
    return game;
  }

  // A new game with exactly the rounds of `source` (same places, same settings), clocks not started.
  function copyGame(source, userId, extra) {
    return {
      id: newId(),
      user_id: userId,
      map_id: source.map_id,
      mode: 'challenge',
      settings: source.settings,
      status: 'in_progress',
      scale_km: source.scale_km,
      total_score: 0,
      started_at: now(),
      version: 0,
      ...extra,
      rounds: source.rounds.map((r) => ({
        round_no: r.round_no,
        pano_id: r.pano_id,
        heading: r.heading,
        true_lat: r.true_lat,
        true_lng: r.true_lng,
        time_limit_ms: r.time_limit_ms,
        started_at: null,
        ends_at: null,
        deadline_at: null,
        guess_lat: null,
        guess_lng: null,
        distance_km: null,
        score: null,
        formula_version: FORMULA_VERSION,
      })),
    };
  }

  // The scoreboard: finished games only, best first. Never coordinates of rounds a viewer has not played.
  function board(games, userId) {
    const rows = games
      .filter((g) => g.status === 'finished')
      .map((g) => ({
        name: g.player_name,
        me: g.user_id === userId,
        total_score: g.total_score,
        rounds: g.rounds.map((r) => ({ score: r.score, distance_km: r.distance_km })),
      }))
      .sort((a, b) => b.total_score - a.total_score);
    // Equal totals share a place (1, 2, 2, 4).
    rows.forEach((r, i) => { r.rank = i > 0 && rows[i - 1].total_score === r.total_score ? rows[i - 1].rank : i + 1; });
    return rows;
  }

  async function challengeGames(challengeId) {
    const games = await store.listByChallenge(challengeId);
    if (!games.length) throw new HttpError(404, 'not_found', 'Challenge not found.');
    return games;
  }

  return {
    listMaps() {
      return maps.map((m) => ({ id: m.id, name: m.name, location_count: m.locations.length }));
    },

    async startGame(userId, input = {}) {
      if (!isPlainObject(input)) throw new HttpError(400, 'bad_json', 'Send a JSON object.');
      const map = mapsById.get(input.map_id ?? maps[0]?.id);
      if (!map) throw new HttpError(404, 'map_not_found', 'Map not found.');
      const settings = parseSettings(input.settings, map.locations.length);
      const t = now();
      const game = {
        id: newId(),
        user_id: userId,
        map_id: map.id,
        mode: 'classic',
        settings,
        status: 'in_progress',
        // Snapshot: a later change to the map file must not change how this game is scored.
        scale_km: map.scale_km,
        total_score: 0,
        started_at: t,
        version: 0,
        rounds: sample(map.locations, settings.rounds).map((loc, i) => ({
          round_no: i + 1,
          pano_id: loc.pano_id,
          heading: loc.heading ?? 0,
          true_lat: loc.lat,
          true_lng: loc.lng,
          time_limit_ms: settings.time_limit_s * 1000,
          started_at: null,
          ends_at: null,
          deadline_at: null,
          guess_lat: null,
          guess_lng: null,
          distance_km: null,
          score: null,
          formula_version: FORMULA_VERSION,
        })),
      };
      await store.put(game);
      return view(game);
    },

    async getGame(userId, id) {
      return view(await ownedGame(userId, id));
    },

    /**
     * Turn a finished game into a challenge: friends who open the link play the same rounds.
     * Asking again returns the same challenge. The owner's name is shown on the scoreboard.
     */
    async createChallenge(userId, gameId, rawName) {
      const game = await ownedGame(userId, gameId);
      if (game.status !== 'finished') {
        throw new HttpError(409, 'game_not_finished', 'Finish the game before challenging friends.');
      }
      if (game.challenge_id) return { challenge_id: game.challenge_id };
      game.player_name = parseName(rawName);
      game.challenge_id = newId();
      await store.put(game);
      return { challenge_id: game.challenge_id };
    },

    /**
     * Join a challenge: a new game with the same rounds, or the game this player already has in it.
     * Before finishing, a player sees how many have played, never their scores or places.
     */
    async joinChallenge(userId, challengeId, rawName) {
      const games = await challengeGames(challengeId);
      const mine = games.find((g) => g.user_id === userId);
      if (mine) return view(mine);
      if (games.filter((g) => g.status === 'finished').length >= MAX_CHALLENGE_PLAYERS) {
        throw new HttpError(409, 'challenge_full', 'This challenge is full.');
      }
      const source = games.find((g) => g.mode !== 'challenge') ?? games[0];
      const game = copyGame(source, userId, { challenge_id: challengeId, player_name: parseName(rawName) });
      await store.put(game);
      return view(game);
    },

    /** What a challenge looks like to this player: the scoreboard once they have finished, a summary before. */
    async getChallenge(userId, challengeId) {
      const games = await challengeGames(challengeId);
      const source = games.find((g) => g.mode !== 'challenge') ?? games[0];
      const mine = games.find((g) => g.user_id === userId);
      const done = mine?.status === 'finished';
      return {
        challenge_id: challengeId,
        created_by: source.player_name,
        settings: source.settings,
        rounds_total: source.rounds.length,
        players: games.filter((g) => g.status === 'finished').length,
        my_game_id: mine?.id ?? null,
        my_status: mine?.status ?? null,
        board: done ? board(games, userId) : null,
      };
    },

    /**
     * Start the current round's clock. Called when the player actually sees the round, so time spent
     * reading the previous result never counts. Idempotent: asking again returns the same round.
     */
    async startRound(userId, id, roundNo) {
      const game = await ownedGame(userId, id);
      if (game.status !== 'in_progress') {
        throw new HttpError(409, 'game_finished', 'This game is finished.');
      }
      const cur = currentRound(game);
      assertCurrent(cur, roundNo);
      if (cur.started_at === null) {
        beginRound(cur);
        await store.put(game);
      }
      return { ...publicRound(cur), server_now: now() };
    },

    /**
     * Swap the current round's panorama for another, once, when the player's browser could not load it
     * (Google removed it since the location list was built). The caller names the panorama it failed on,
     * so a stale or repeated request changes nothing. The new panorama gets a fresh clock. The old
     * location is never revealed, and each round can be replaced only once, so this cannot be used to
     * shop for an easier round more than one time per round.
     */
    async replaceRound(userId, id, roundNo, failedPanoId) {
      const game = await ownedGame(userId, id);
      if (game.status !== 'in_progress') {
        throw new HttpError(409, 'game_finished', 'This game is finished.');
      }
      const cur = currentRound(game);
      assertCurrent(cur, roundNo);
      if (cur.started_at === null) {
        throw new HttpError(409, 'round_not_started', 'Start the round before replacing it.');
      }
      if (cur.deadline_at !== null && now() > cur.deadline_at) {
        throw new HttpError(409, 'deadline_passed', 'Time already ran out for that round.');
      }
      if (game.mode === 'challenge') {
        // Everyone in a challenge must play the same places: no swaps, the round is skipped instead.
        throw new HttpError(409, 'challenge_no_replace', 'This spot is gone from Street View. Skip this round.');
      }
      if (typeof failedPanoId !== 'string' || failedPanoId !== cur.pano_id) {
        // Already replaced (a retry) or a made-up id: answer with the round as it is.
        return { ...publicRound(cur), server_now: now() };
      }
      if (cur.replaced) {
        throw new HttpError(409, 'already_replaced', 'This round was already replaced once.');
      }
      const map = mapsById.get(game.map_id);
      const used = new Set(game.rounds.map((r) => r.pano_id).concat(game.dead_panos ?? []));
      const spare = (map?.locations ?? []).filter((l) => !used.has(l.pano_id));
      if (spare.length === 0) {
        throw new HttpError(409, 'no_spare_location', 'No other location is available for this round.');
      }
      const [loc] = sample(spare, 1);
      game.dead_panos = [...(game.dead_panos ?? []), cur.pano_id];
      Object.assign(cur, { pano_id: loc.pano_id, heading: loc.heading ?? 0, true_lat: loc.lat, true_lng: loc.lng, replaced: true });
      beginRound(cur);
      await store.put(game);
      return { ...publicRound(cur), server_now: now() };
    },

    /**
     * Resolve the current round. `guess` null = skip (0 points).
     * A guess after the deadline is stored as 0 and answered with 410 carrying the result.
     */
    async submitGuess(userId, id, roundNo, rawGuess) {
      const game = await ownedGame(userId, id);
      if (game.status !== 'in_progress') {
        throw new HttpError(409, 'game_finished', 'This game is finished.');
      }
      const cur = currentRound(game);
      assertCurrent(cur, roundNo);
      if (cur.started_at === null) {
        throw new HttpError(409, 'round_not_started', 'Start the round before guessing.');
      }
      const guess = parseGuess(rawGuess);
      const t = now();
      const late = cur.deadline_at !== null && t > cur.deadline_at;

      if (late || guess === null) {
        cur.score = 0;
      } else {
        cur.guess_lat = guess.lat;
        cur.guess_lng = guess.lng;
        cur.distance_km =
          Math.round(haversineKm(guess.lat, guess.lng, cur.true_lat, cur.true_lng) * 1000) / 1000;
        cur.score = score(cur.distance_km, game.scale_km ?? mapsById.get(game.map_id)?.scale_km);
      }
      game.total_score += cur.score;

      const next = currentRound(game);
      if (!next) game.status = 'finished';
      await store.put(game);

      const result = {
        ...reveal(cur),
        total_score: game.total_score,
        finished: game.status === 'finished',
        next_round_no: next ? next.round_no : null,
        server_now: t,
      };
      if (late) {
        throw new HttpError(410, 'deadline_passed', 'Time ran out for that round. It scores 0.', result);
      }
      return result;
    },
  };
}
