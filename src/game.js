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

  /** What the player may see before guessing: never coordinates. */
  function publicRound(r) {
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
      settings: game.settings,
      status: game.status,
      total_score: game.total_score,
      rounds_total: game.rounds.length,
      server_now: now(),
      current_round: cur ? publicRound(cur) : null,
      results: game.rounds.filter(isResolved).map(reveal),
    };
  }

  async function ownedGame(userId, id) {
    const game = await store.get(id);
    // Same answer for "missing" and "someone else's": no way to probe other games.
    if (!game || game.user_id !== userId) throw new HttpError(404, 'not_found', 'Game not found.');
    return game;
  }

  return {
    listMaps() {
      return maps.map((m) => ({ id: m.id, name: m.name, location_count: m.locations.length }));
    },

    async startGame(userId, input = {}) {
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
        total_score: 0,
        total_time_ms: 0,
        started_at: t,
        finished_at: null,
        version: 0,
        rounds: sample(map.locations, settings.rounds).map((loc, i) => ({
          round_no: i + 1,
          location_id: loc.id,
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
          guessed_at: null,
          distance_km: null,
          score: null,
          formula_version: FORMULA_VERSION,
        })),
      };
      beginRound(game.rounds[0]);
      await store.put(game);
      return view(game);
    },

    async getGame(userId, id) {
      return view(await ownedGame(userId, id));
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
      if (roundNo !== cur.round_no) {
        throw roundNo < cur.round_no
          ? new HttpError(409, 'already_guessed', 'That round already has a guess.')
          : new HttpError(409, 'round_not_started', 'That round has not started yet.');
      }
      const guess = parseGuess(rawGuess);
      const t = now();
      const late = cur.deadline_at !== null && t > cur.deadline_at;

      if (late || guess === null) {
        cur.score = 0;
      } else {
        const map = mapsById.get(game.map_id);
        cur.guess_lat = guess.lat;
        cur.guess_lng = guess.lng;
        cur.guessed_at = t;
        cur.distance_km =
          Math.round(haversineKm(guess.lat, guess.lng, cur.true_lat, cur.true_lng) * 1000) / 1000;
        cur.score = score(cur.distance_km, map.scale_km);
      }
      game.total_score += cur.score;
      game.total_time_ms += (cur.ends_at === null ? t : Math.min(t, cur.ends_at)) - cur.started_at;

      const next = currentRound(game);
      if (next) {
        beginRound(next);
      } else {
        game.status = 'finished';
        game.finished_at = t;
      }
      await store.put(game);

      const result = {
        ...reveal(cur),
        total_score: game.total_score,
        finished: game.status === 'finished',
        next: next ? publicRound(next) : null,
        server_now: t,
      };
      if (late) {
        throw new HttpError(410, 'deadline_passed', 'Time ran out for that round. It scores 0.', result);
      }
      return result;
    },
  };
}
