#!/usr/bin/env node
// Builds data/locations.json: real Street View panoramas, found with the free metadata API.
//
//   npm run locations                     200 locations
//   npm run locations -- --count=300      another size
//
// For each seed city it picks random points nearby, asks Google for the closest official
// outdoor panorama, and keeps its pano_id. Metadata requests are free and use no quota.
// The output holds true coordinates: it is gitignored and must never be served publicly.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/env.js';
import { EARTH_RADIUS_KM, haversineKm } from '../src/scoring.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
loadEnv(resolve(ROOT, '.env'));

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')),
);
const target = Number(args.count ?? 200);
const outFile = resolve(ROOT, args.out ?? 'data/locations.json');
const MIN_GAP_KM = 0.5;
const SNAP_RADIUS_M = 10_000;
const MAX_ATTEMPTS = target * 8;
const WORLD_SCALE_KM = 14917; // diagonal used by the scoring formula for the World map

const key = process.env.GOOGLE_METADATA_API_KEY;
if (!key) {
  console.error('Set GOOGLE_METADATA_API_KEY in .env (a server-side key with the Street View Static API enabled).');
  process.exit(1);
}
if (!Number.isInteger(target) || target < 1) {
  console.error('--count must be a positive whole number.');
  process.exit(1);
}

const seeds = JSON.parse(readFileSync(resolve(ROOT, 'data/seeds.json'), 'utf8'));
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A random point within radius_km of the seed (uniform over the disc). */
function jitter(seed) {
  const bearing = Math.random() * 2 * Math.PI;
  const d = (Math.sqrt(Math.random()) * seed.radius_km) / EARTH_RADIUS_KM;
  const lat1 = rad(seed.lat);
  const lng1 = rad(seed.lng);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearing));
  const lng2 =
    lng1 +
    Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: deg(lat2), lng: deg(lng2) };
}

async function lookup({ lat, lng }, retry = true) {
  const url = new URL('https://maps.googleapis.com/maps/api/streetview/metadata');
  url.search = new URLSearchParams({
    location: `${lat.toFixed(6)},${lng.toFixed(6)}`,
    radius: String(SNAP_RADIUS_M),
    source: 'outdoor',
    key,
  }).toString();
  const res = await fetch(url);
  const data = await res.json();
  if (data.status === 'UNKNOWN_ERROR' && retry) {
    await sleep(500);
    return lookup({ lat, lng }, false);
  }
  return data;
}

const kept = [];
const seen = new Set();
let attempts = 0;
let noCoverage = 0;
let rejected = 0;

console.log(`Looking for ${target} locations in ${seeds.length} regions...`);

while (kept.length < target && attempts < MAX_ATTEMPTS) {
  const batch = [];
  for (let i = 0; i < 4 && attempts + batch.length < MAX_ATTEMPTS; i++) {
    const seed = seeds[(attempts + batch.length) % seeds.length];
    batch.push({ seed, point: jitter(seed) });
  }
  attempts += batch.length;
  const results = await Promise.all(batch.map((b) => lookup(b.point)));

  for (let i = 0; i < results.length; i++) {
    const data = results[i];
    const { seed } = batch[i];
    if (data.status === 'REQUEST_DENIED' || data.status === 'OVER_QUERY_LIMIT' || data.status === 'INVALID_REQUEST') {
      console.error(`Google answered ${data.status}${data.error_message ? `: ${data.error_message}` : ''}. Stopping.`);
      process.exit(1);
    }
    if (data.status !== 'OK') {
      noCoverage++;
      continue;
    }
    // Official Google coverage only: no user photospheres, no third-party imagery.
    if (!/google/i.test(data.copyright ?? '') || seen.has(data.pano_id)) {
      rejected++;
      continue;
    }
    const { lat, lng } = data.location;
    if (kept.some((k) => haversineKm(k.lat, k.lng, lat, lng) < MIN_GAP_KM)) {
      rejected++;
      continue;
    }
    seen.add(data.pano_id);
    kept.push({
      id: `world-${kept.length}`,
      pano_id: data.pano_id,
      lat,
      lng,
      heading: Math.floor(Math.random() * 360),
      country: seed.country, // the seed's country: approximate near borders
      seed: seed.name,
      capture_date: data.date ?? null,
    });
    if (kept.length >= target) break;
  }
  await sleep(100);
}

if (kept.length === 0) {
  console.error('No locations found. Check the key and that the Street View Static API is enabled.');
  process.exit(1);
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(
  outFile,
  JSON.stringify({
    id: 'world',
    name: 'World',
    scale_km: WORLD_SCALE_KM,
    generated_at: new Date().toISOString(),
    locations: kept,
  }, null, 1),
);

const perCountry = {};
for (const k of kept) perCountry[k.country] = (perCountry[k.country] ?? 0) + 1;
console.log(`Wrote ${kept.length} locations to ${outFile}`);
console.log(`${attempts} lookups: ${noCoverage} without coverage, ${rejected} rejected (not Google, duplicate or too close).`);
console.log(`Countries: ${Object.keys(perCountry).length}`);
if (kept.length < target) console.log(`Only ${kept.length} of ${target} found. Add regions or raise radius_km in data/seeds.json, then run it again.`);
