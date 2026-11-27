import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { HttpError } from './errors.js';

// Store interface (async, so a D1-backed store can replace these without touching game.js):
//   get(id)   -> game | null   (a copy: mutating it changes nothing until put)
//   put(game) -> void          optimistic concurrency: game.version must match the stored one,
//                              otherwise 409 'conflict'. New games start at version 0.
//   listByChallenge(id) -> games  every game played in one challenge (copies), oldest first

/** The stored copy of `game` bumped by one version, or a 409 if `game` is stale. Nothing is committed here. */
function nextVersion(games, game) {
  const current = games.get(game.id);
  const expected = current ? current.version : 0;
  if (game.version !== expected) {
    throw new HttpError(409, 'conflict', 'This game changed while you were playing. Reload and try again.');
  }
  if (!current && game.challenge_id) {
    // Same rule as the unique index on D1: one game per player per challenge.
    for (const g of games.values()) {
      if (g.challenge_id === game.challenge_id && g.user_id === game.user_id) {
        throw new HttpError(409, 'conflict', 'You already have a game in this challenge. Reload to continue it.');
      }
    }
  }
  const next = structuredClone(game);
  next.version = expected + 1;
  return next;
}

export function createMemoryStore() {
  const games = new Map();
  return {
    async get(id) {
      const g = games.get(id);
      return g ? structuredClone(g) : null;
    },
    async put(game) {
      const next = nextVersion(games, game);
      games.set(next.id, next);
    },
    async listByChallenge(challengeId) {
      return byChallenge(games, challengeId);
    },
  };
}

function byChallenge(games, challengeId) {
  return [...games.values()]
    .filter((g) => g.challenge_id === challengeId)
    .sort((a, b) => a.started_at - b.started_at)
    .map((g) => structuredClone(g));
}

/** In-memory store persisted to one JSON file (fine for a few friends). A failed write changes nothing. */
export function createFileStore(file) {
  const games = new Map();
  if (existsSync(file)) {
    for (const g of JSON.parse(readFileSync(file, 'utf8'))) games.set(g.id, g);
  }
  function persist(all) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...all.values()]));
    renameSync(tmp, file);
  }
  return {
    async get(id) {
      const g = games.get(id);
      return g ? structuredClone(g) : null;
    },
    async put(game) {
      const next = nextVersion(games, game);
      persist(new Map(games).set(next.id, next)); // disk first: if it throws, memory is untouched
      games.set(next.id, next);
    },
    async listByChallenge(challengeId) {
      return byChallenge(games, challengeId);
    },
  };
}
