// Pure validation (no Node APIs) so the same code runs in Node and in a Worker.

/** Validate parsed locations data (one map, or an array of maps). `source` only labels errors. */
export function parseMaps(raw, source = 'locations') {
  const file = source;
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
