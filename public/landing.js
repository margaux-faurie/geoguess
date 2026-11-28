// The launch screen's demo: behind the form, the map plays rounds by itself. It flies somewhere, a guess
// drops, the true place appears, the miss is drawn and scored. Runs only while the launch screen is shown.

import { greatCircle, STYLE_URL } from './guessmap.js';

// Made-up rounds: a place, and a guess that is plausibly wrong.
const ROUNDS = [
  { place: 'Valparaíso, Chile', truth: { lat: -33.046, lng: -71.62 }, guess: { lat: -34.6, lng: -58.38 } },
  { place: 'Hội An, Vietnam', truth: { lat: 15.88, lng: 108.33 }, guess: { lat: 13.75, lng: 100.5 } },
  { place: 'Tromsø, Norway', truth: { lat: 69.65, lng: 18.96 }, guess: { lat: 64.15, lng: -21.94 } },
  { place: 'Essaouira, Morocco', truth: { lat: 31.51, lng: -9.77 }, guess: { lat: 36.72, lng: -4.42 } },
  { place: 'Hobart, Australia', truth: { lat: -42.88, lng: 147.33 }, guess: { lat: -41.29, lng: 174.78 } },
];

// Same formula as the server (src/scoring.js): only for display here.
function scoreFor(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  const km = 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
  return { km, pts: Math.round(5000 * Math.exp((-10 * km) / 14917)) };
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('stopped', 'AbortError')); }, { once: true });
});

function marker(className) {
  const el = document.createElement('div');
  el.className = `marker ${className}`;
  return el;
}

export function createLanding(container, card) {
  const maplibregl = window.maplibregl;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let map = null;
  let run = null; // AbortController of the running loop
  const $ = (id) => card.querySelector(id);
  const fmt = (n) => Number(n).toLocaleString('en');

  function ensureMap() {
    if (map) return;
    map = new maplibregl.Map({
      container,
      style: STYLE_URL,
      center: [10, 25],
      zoom: 1.4,
      interactive: false,
      attributionControl: { compact: true },
    });
    map.once('load', () => {
      map.addSource('demo', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'demo', type: 'line', source: 'demo',
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#0c0b0a', 'line-width': 3, 'line-dasharray': [1.5, 1.5] },
      });
    });
  }

  async function play(signal) {
    await new Promise((r) => (map.loaded() ? r() : map.once('load', r)));
    const pins = [];
    const clear = () => {
      pins.splice(0).forEach((p) => p.remove());
      map.getSource('demo')?.setData({ type: 'FeatureCollection', features: [] });
      card.hidden = true;
    };
    // The panel covers the left of the screen on wide layouts: keep the action to its right.
    const padding = () => (innerWidth > 760
      ? { left: Math.min(620, innerWidth * 0.45), right: 80, top: 80, bottom: 160 }
      : { left: 40, right: 40, top: 40, bottom: 100 });

    for (let i = 0; ; i = (i + 1) % ROUNDS.length) {
      const r = ROUNDS[i];
      const line = greatCircle(r.guess, r.truth);
      const lngs = line.map((p) => p[0]);
      const lats = line.map((p) => p[1]);
      clear();
      map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
        { padding: padding(), maxZoom: 6, duration: reduced ? 0 : 2600 });
      await sleep(reduced ? 300 : 2800, signal);

      pins.push(new maplibregl.Marker({ element: marker('pin') }).setLngLat([r.guess.lng, r.guess.lat]).addTo(map));
      await sleep(reduced ? 0 : 700, signal);
      pins.push(new maplibregl.Marker({ element: marker('answer') }).setLngLat([r.truth.lng, r.truth.lat]).addTo(map));

      // Draw the miss from the guess to the place.
      const steps = reduced ? 1 : 30;
      for (let s = 1; s <= steps; s++) {
        const n = Math.max(2, Math.round((line.length * s) / steps));
        map.getSource('demo').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: line.slice(0, n) } });
        await sleep(reduced ? 0 : 25, signal);
      }

      const { km, pts } = scoreFor(r.guess, r.truth);
      $('#demo-place').textContent = r.place;
      $('#demo-dist').textContent = `${fmt(Math.round(km))} km away`;
      $('#demo-pts').textContent = `${fmt(pts)} points`;
      card.hidden = false;
      if (reduced) return; // one still example, no loop
      await sleep(3200, signal);
    }
  }

  return {
    start() {
      if (run || !maplibregl) return;
      ensureMap();
      run = new AbortController();
      play(run.signal).catch((e) => { if (e.name !== 'AbortError') console.warn('[guessgeo] demo', e.message); });
      map.resize();
    },
    stop() {
      run?.abort();
      run = null;
      card.hidden = true;
    },
  };
}
