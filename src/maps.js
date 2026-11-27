import { readFileSync } from 'node:fs';

/** Load and validate data/locations.json (one map, or an array of maps). */
export function loadMaps(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((map) => {
    if (!map.id || !map.name || !(map.scale_km > 0) || !Array.isArray(map.locations) || map.locations.length === 0) {
      throw new Error(`${file}: a map needs id, name, scale_km > 0 and at least one location`);
    }
    const locations = map.locations.map((loc, i) => {
      if (typeof loc.pano_id !== 'string' || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) {
        throw new Error(`${file}: location ${i} needs pano_id, lat and lng`);
      }
      return { ...loc, id: loc.id ?? `${map.id}-${i}` };
    });
    return { ...map, locations };
  });
}
