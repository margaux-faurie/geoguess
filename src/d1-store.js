// Game store on Cloudflare D1 (SQLite). Same contract as src/store.js:
//   get(id) -> game | null
//   put(game) -> void, optimistic concurrency on game.version (new games start at 0), else 409.
//   listByChallenge(id) -> games, oldest first

import { HttpError } from './errors.js';

const conflict = () => new HttpError(409, 'conflict', 'This game changed while you were playing. Reload and try again.');

export function createD1Store(db, now = Date.now) {
  return {
    async get(id) {
      const row = await db.prepare('SELECT data FROM games WHERE id = ?1').bind(id).first();
      return row ? JSON.parse(row.data) : null;
    },

    async put(game) {
      const t = now();
      const next = { ...game, version: game.version + 1 };
      const data = JSON.stringify(next);
      let changes;
      if (game.version === 0) {
        // INSERT OR IGNORE: if the id already exists, nothing changes and the caller has a stale copy.
        ({ meta: { changes } } = await db
          .prepare(
            'INSERT OR IGNORE INTO games (id, user_id, version, data, created_at, updated_at, challenge_id) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)',
          )
          .bind(next.id, next.user_id, next.version, data, t, next.challenge_id ?? null)
          .run());
      } else {
        ({ meta: { changes } } = await db
          .prepare('UPDATE games SET version = ?1, data = ?2, updated_at = ?3, challenge_id = ?6 WHERE id = ?4 AND version = ?5')
          .bind(next.version, data, t, next.id, game.version, next.challenge_id ?? null)
          .run());
      }
      if (changes !== 1) throw conflict();
    },

    async listByChallenge(challengeId) {
      const { results } = await db
        .prepare('SELECT data FROM games WHERE challenge_id = ?1 ORDER BY created_at, rowid LIMIT 200')
        .bind(challengeId)
        .all();
      return results.map((r) => JSON.parse(r.data));
    },
  };
}
