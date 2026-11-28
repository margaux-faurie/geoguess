// The guess map: MapLibre GL with OpenFreeMap vector tiles (OpenStreetMap data, no key, no account).
// It only knows about points and lines; the game logic stays in app.js.
// MapLibre is loaded by a <script> tag with a pinned version and an integrity hash (see index.html).

export const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const WORLD = { center: [10, 20], zoom: 0.6 };

const ORANGE = '#ffb38a';
const INK = '#0c0b0a';
const NAVY = '#14284b';
const PAPER = '#fbf9f5';

// Points along the great circle between two places, so a long line follows the real shortest path.
export function greatCircle(a, b, steps = 64) {
  const rad = Math.PI / 180;
  const [lat1, lng1, lat2, lng2] = [a.lat * rad, a.lng * rad, b.lat * rad, b.lng * rad];
  const d = 2 * Math.asin(Math.min(1, Math.sqrt(
    Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lng2 - lng1) / 2) ** 2,
  )));
  // Same point, or (almost) opposite sides of the Earth where every great circle fits: a straight line.
  if (d < 1e-9 || Math.sin(d) < 1e-6) return [[a.lng, a.lat], [b.lng, b.lat]];
  const out = [];
  let prevLng = null;
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lng1) + B * Math.cos(lat2) * Math.cos(lng2);
    const y = A * Math.cos(lat1) * Math.sin(lng1) + B * Math.cos(lat2) * Math.sin(lng2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    let lng = Math.atan2(y, x) / rad;
    const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) / rad;
    // Keep longitudes continuous across the antimeridian so the line does not jump across the map.
    if (prevLng !== null) while (lng - prevLng > 180) lng -= 360;
    if (prevLng !== null) while (lng - prevLng < -180) lng += 360;
    prevLng = lng;
    out.push([lng, lat]);
  }
  return out;
}

function dot(className, label) {
  const el = document.createElement('div');
  el.className = `marker ${className}`;
  el.setAttribute('role', 'img');
  if (label) el.setAttribute('aria-label', label);
  return el;
}

function lineFeatures(pairs) {
  return {
    type: 'FeatureCollection',
    features: pairs.map(([a, b]) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: greatCircle(a, b) } })),
  };
}

// Creates a map in `container`. `onPick(latLng)` is called when the player clicks, if picking is on.
export function createGuessMap(container, { onPick, onError, interactive = true, cooperative = false } = {}) {
  const maplibregl = window.maplibregl;
  const map = new maplibregl.Map({
    container,
    style: STYLE_URL,
    center: WORLD.center,
    zoom: WORLD.zoom,
    minZoom: 0,
    renderWorldCopies: true,
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    interactive,
    cooperativeGestures: cooperative,
  });
  map.touchZoomRotate?.disableRotation();
  if (interactive) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.getCanvas().style.cursor = 'crosshair';
  // The guess map grows on hover and fills the screen on a result: follow the container, not the window.
  new ResizeObserver(() => map.resize()).observe(container);
  // Start with the attribution folded to its (i) button; it opens on click.
  map.once('load', () => container.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));

  let picking = false;
  let markers = [];
  let pinMarker = null;
  const ready = new Promise((resolve) => map.once('load', resolve));
  // Style unreachable (OpenFreeMap down or blocked): say so once instead of showing a blank map.
  // A single missing tile later on is normal and not reported.
  let loaded = false;
  ready.then(() => { loaded = true; });
  let failed = false;
  const fail = () => {
    if (failed || loaded) return;
    failed = true;
    onError?.('The map could not load. Check your connection and reload.');
  };
  map.on('error', (e) => { if (!map.isStyleLoaded()) { console.warn('[guessgeo] map', e?.error?.message); fail(); } });
  setTimeout(fail, 20_000);

  ready.then(() => {
    map.addSource('route', { type: 'geojson', data: lineFeatures([]) });
    map.addLayer({
      id: 'route', type: 'line', source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': INK, 'line-width': 2.5, 'line-dasharray': [1.5, 1.5], 'line-opacity': 0.85 },
    });
  });

  function pick(lngLat) {
    if (!picking) return;
    const w = lngLat.wrap();
    const latLng = { lat: w.lat, lng: w.lng };
    if (onPick?.(latLng) === false) return; // the game said no (round over, guess in flight)
    setPin(latLng);
  }
  map.on('click', (e) => pick(e.lngLat));
  // Keyboard players: arrows pan the map, Enter drops the pin at its centre.
  map.getCanvas().setAttribute('aria-label', 'Guess map. Arrow keys move, Enter drops your pin at the centre.');
  map.getCanvas().addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !picking) return;
    e.preventDefault();
    e.stopPropagation();
    pick(map.getCenter());
  });

  function setPin(latLng) {
    if (!pinMarker) pinMarker = new maplibregl.Marker({ element: dot('pin', 'Your guess'), anchor: 'center' });
    pinMarker.setLngLat([latLng.lng, latLng.lat]).addTo(map);
  }

  function clear() {
    for (const m of markers) m.remove();
    markers = [];
    pinMarker?.remove();
    pinMarker = null;
    ready.then(() => map.getSource('route').setData(lineFeatures([])));
  }

  function add(className, latLng, label) {
    const m = new maplibregl.Marker({ element: dot(className, label), anchor: 'center' }).setLngLat([latLng.lng, latLng.lat]).addTo(map);
    markers.push(m);
  }

  // Frames every [lng, lat] in `coords`. Longitudes may run past ±180 on a line that crosses the antimeridian.
  function fit(coords, maxZoom, padding) {
    if (!coords.length) return;
    const lngs = coords.map((p) => p[0]);
    const lats = coords.map((p) => p[1]);
    const auto = Math.min(80, Math.round(Math.min(container.clientWidth, container.clientHeight) / 5));
    // A padding bigger than the map (a short phone screen) makes fitBounds give up: fall back.
    const fits = padding && padding.top + padding.bottom < container.clientHeight * 0.8 && padding.left + padding.right < container.clientWidth * 0.8;
    const pad = fits ? padding : auto;
    map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: pad, maxZoom, duration: 600 });
  }

  return {
    ready,
    resize: () => map.resize(),
    // New round: world view, no pin, clicks place the pin.
    reset() {
      clear();
      picking = true;
      map.resize();
      map.jumpTo(WORLD);
    },
    setPin,
    stopPicking() { picking = false; },
    startPicking() { picking = true; },
    // One round's answer: the true place, the guess if any, and the line between them.
    showAnswer(guess, truth, padding) {
      picking = false;
      clear();
      add('answer', truth, 'The place');
      if (guess) add('pin', guess, 'Your guess');
      map.resize();
      ready.then(() => {
        map.getSource('route').setData(lineFeatures(guess ? [[guess, truth]] : []));
        fit(guess ? greatCircle(guess, truth) : [[truth.lng, truth.lat]], guess ? 14 : 5, padding);
      });
    },
    // The whole game: every answer, every guess, every line.
    showAll(results) {
      picking = false;
      clear();
      const pairs = [];
      const coords = [];
      for (const r of results) {
        add('answer', r.true, `Round ${r.round_no}: the place`);
        if (r.guess) {
          add('pin', r.guess, `Round ${r.round_no}: your guess`);
          pairs.push([r.guess, r.true]);
          coords.push(...greatCircle(r.guess, r.true));
        } else coords.push([r.true.lng, r.true.lat]);
      }
      map.resize();
      ready.then(() => {
        map.getSource('route').setData(lineFeatures(pairs));
        fit(coords, 5);
      });
    },
  };
}

export const COLOURS = { ORANGE, INK, NAVY, PAPER };
