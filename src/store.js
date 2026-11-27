import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { HttpError } from './errors.js';

// Store interface (async, so a D1-backed store can replace these without touching game.js):
//   get(id)   -> game | null   (a copy: mutating it changes nothing until put)
//   put(game) -> void          optimistic concurrency: game.version must match the stored one,
//                              otherwise 409 'conflict'. New games start at version 0.

function checkAndBump(games, game) {
  const current = games.get(game.id);
  const expected = current ? current.version : 0;
  if (game.version !== expected) {
    throw new HttpError(409, 'conflict', 'This game changed while you were playing. Reload and try again.');
  }
  const next = structuredClone(game);
  next.version = expected + 1;
  games.set(game.id, next);
}

export function createMemoryStore() {
  const games = new Map();
  return {
    async get(id) {
      const g = games.get(id);
      return g ? structuredClone(g) : null;
    },
    async put(game) {
      checkAndBump(games, game);
    },
  };
}

/** In-memory store persisted to one JSON file (fine for a few friends). */
export function createFileStore(file) {
  const games = new Map();
  if (existsSync(file)) {
    for (const g of JSON.parse(readFileSync(file, 'utf8'))) games.set(g.id, g);
  }
  function persist() {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...games.values()]));
    renameSync(tmp, file);
  }
  return {
    async get(id) {
      const g = games.get(id);
      return g ? structuredClone(g) : null;
    },
    async put(game) {
      checkAndBump(games, game);
      persist();
    },
  };
}
