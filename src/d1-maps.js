// Maps on Cloudflare D1: one row per map, the whole map document as JSON. Runtime-agnostic.

import { parseMaps } from './maps.js';

/** Every map stored in D1, validated. An empty table means nothing was uploaded yet. */
export async function loadMapsFromD1(db) {
  const { results } = await db.prepare('SELECT id, data FROM maps ORDER BY id').all();
  if (!results.length) throw new Error('no maps in D1: run `npm run locations:upload`');
  return parseMaps(results.map((r) => JSON.parse(r.data)), 'd1:maps');
}

/** SQL that replaces the stored maps with `maps` (already validated). Values are quoted, never interpolated raw. */
export function mapsToSql(maps, now = Date.now()) {
  const quote = (s) => `'${String(s).replaceAll("'", "''")}'`;
  const lines = maps.map(
    (m) => `INSERT OR REPLACE INTO maps (id, data, updated_at) VALUES (${quote(m.id)}, ${quote(JSON.stringify(m))}, ${Math.trunc(now)});`,
  );
  return `${lines.join('\n')}\n`;
}
