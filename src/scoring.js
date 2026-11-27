// Runtime-agnostic: no Node imports, so this file also runs in a Cloudflare Worker.
// The only place scores are computed. Runs on the server only.

export const EARTH_RADIUS_KM = 6371.0088;
export const MAX_SCORE = 5000;
/** A guess within 25 m counts as perfect, to absorb panorama position noise. */
export const PERFECT_RADIUS_KM = 0.025;
/** Stored on every round so the curve can change later without rewriting history. */
export const FORMULA_VERSION = 1;

const rad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in km between two lat/lng points (haversine). */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Round score, 0 to 5000: 5000 * e^(-10 d / D)
 * d = distance in km, D = the map's scale in km (diagonal of its bounding box).
 * World map: D = 14917, which matches the community-derived GeoGuessr curve.
 */
export function score(distanceKm, mapScaleKm) {
  if (!(mapScaleKm > 0)) throw new RangeError('mapScaleKm must be positive');
  if (distanceKm <= PERFECT_RADIUS_KM) return MAX_SCORE;
  return Math.round(MAX_SCORE * Math.exp((-10 * distanceKm) / mapScaleKm));
}
