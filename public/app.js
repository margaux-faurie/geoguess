// guessgeo client. No build step, no dependencies.
// The server owns the locations and the scores: this file only shows a panorama by id,
// sends a pin, and displays what comes back.

const $ = (sel) => document.querySelector(sel);
const fmt = (n) => Number(n).toLocaleString('en');
const MAX_ROUND_SCORE = 5000;
const STORAGE_KEY = 'guessgeo:game';

// Design system colours (tokens.json), as the Maps API needs them in JS.
const INK = '#0c0b0a';
const ORANGE = '#ffb38a';
const NAVY = '#14284b';
const PAPER = '#fbf9f5';

// Guess map in the paper palette: quiet land and water, roads as hairlines, no points of interest.
const MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#fbf9f5' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#544e44' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#fbf9f5' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#e3ddd1' }] },
  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#f2eee6' }] },
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#8f8777' }, { weight: 0.6 }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#e3ddd1' }] },
  { featureType: 'road', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
];

const state = {
  game: null, // { id, settings, total, roundsTotal }
  round: null, // the public round being played
  results: [],
  clockOffset: 0, // server time minus browser time, so the countdown matches the server
  pin: null, // { lat, lng }
  busy: false,
  timer: null,
};
let panorama;
let guessMap;
let pinMarker;
let answerMarker;
let routeLine;
let noticeKey = '';

function setView(view) {
  document.body.dataset.view = view;
}

function notice(text, key = 'general') {
  const el = $('#notice');
  el.textContent = text;
  el.hidden = !text;
  noticeKey = text ? key : '';
}
function clearNotice(key) {
  if (noticeKey === key) notice('');
}

function formatKm(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${fmt(Math.round(km))} km`;
}

function clock(ms) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function api(path, init = {}) {
  let res;
  try {
    res = await fetch(path, { ...init, headers: { 'content-type': 'application/json' } });
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  const body = await res.json().catch(() => ({}));
  // 410 means time ran out: the body still carries the round's result, so it is not an error here.
  if (!res.ok && res.status !== 410) {
    throw Object.assign(new Error(body.message || 'Something went wrong. Try again.'), { status: res.status });
  }
  return { status: res.status, body };
}

function remember(id) {
  try { id ? localStorage.setItem(STORAGE_KEY, id) : localStorage.removeItem(STORAGE_KEY); } catch { /* storage can be blocked */ }
}
function remembered() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

function loadGoogle(key) {
  return new Promise((resolve, reject) => {
    window.__mapsReady = resolve;
    window.gm_authFailure = () => {
      notice('Google rejected the Maps key. Check that it allows this address and the Maps JavaScript API.', 'key');
      $('#setup-form button').disabled = true; // a game on a blank panorama would only waste quota
    };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=quarterly&callback=__mapsReady`;
    s.async = true;
    s.onerror = () => reject(new Error('Could not load Google Maps.'));
    document.head.append(s);
  });
}

function initMaps() {
  guessMap = new google.maps.Map($('#guess-map'), {
    center: { lat: 20, lng: 0 },
    zoom: 1,
    minZoom: 1,
    disableDefaultUI: true,
    zoomControl: true,
    clickableIcons: false,
    gestureHandling: 'greedy',
    draggableCursor: 'crosshair',
    styles: MAP_STYLE,
  });
  guessMap.addListener('click', (e) => {
    if (document.body.dataset.view === 'play' && !state.busy) placePin(e.latLng);
  });
  $('#guess').addEventListener('transitionend', () => google.maps.event.trigger(guessMap, 'resize'));

  // Keep the keyboard from moving the player when movement is off.
  $('#pano').addEventListener('keydown', (e) => {
    const mode = document.body.dataset.movement;
    const moves = ['ArrowUp', 'ArrowDown', 'w', 'W', 's', 'S'];
    if (mode === 'nmpz' || (mode === 'nomove' && moves.includes(e.key))) e.stopPropagation();
  }, true);
}

const pinIcon = () => ({ path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: ORANGE, fillOpacity: 1, strokeColor: INK, strokeWeight: 2 });
const answerIcon = () => ({ path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: NAVY, fillOpacity: 1, strokeColor: PAPER, strokeWeight: 2 });

function placePin(latLng) {
  state.pin = { lat: latLng.lat(), lng: latLng.lng() };
  if (!pinMarker) pinMarker = new google.maps.Marker({ map: guessMap, icon: pinIcon() });
  pinMarker.setPosition(latLng);
  $('#guess-btn').disabled = false;
  $('#guess-btn').textContent = 'Guess';
}

function clearOverlays() {
  for (const o of [pinMarker, answerMarker, routeLine]) o?.setMap(null);
  pinMarker = answerMarker = routeLine = null;
}

function renderHud() {
  $('#hud-round').textContent = `Round ${state.round.round_no} of ${state.game.roundsTotal}`;
  $('#hud-score').textContent = `${fmt(state.game.total)} points`;
}

function startTimer(round) {
  stopTimer();
  const el = $('#hud-timer');
  if (!round.ends_at) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const tick = () => {
    const left = round.ends_at - (Date.now() + state.clockOffset);
    el.textContent = clock(Math.max(0, left));
    if (left <= 0) {
      stopTimer();
      submit(); // sends the pin if there is one, otherwise a skip
    }
  };
  state.timer = setInterval(tick, 250);
  tick();
}
function stopTimer() {
  clearInterval(state.timer);
  state.timer = null;
}

function startRound(round) {
  state.round = round;
  state.pin = null;
  state.busy = false;
  clearOverlays();
  clearNotice('pano');

  const mode = state.game.settings.movement;
  document.body.dataset.movement = mode;
  guessMap.setCenter({ lat: 20, lng: 0 });
  guessMap.setZoom(1);
  $('#guess-btn').disabled = true;
  $('#guess-btn').textContent = 'Place your pin';

  renderHud();
  // Show the view first so the panorama is laid out before it loads.
  setView('play');
  google.maps.event.trigger(guessMap, 'resize');
  loadPanorama(round);
  startTimer(round);
}

// The panorama object is created on the first round, once its container is on screen: a Street View
// created inside a hidden container can stay blank. The same object is then reused for every round.
function ensurePanorama(panoId, heading) {
  if (panorama) return;
  panorama = new google.maps.StreetViewPanorama($('#pano'), {
    pano: panoId,
    pov: { heading, pitch: 0 },
    zoom: 1,
    addressControl: false,
    showRoadLabels: false,
    fullscreenControl: false,
    enableCloseButton: false,
    imageDateControl: false,
    motionTracking: false,
    motionTrackingControl: false,
    visible: true,
  });
  panorama.addListener('status_changed', () => {
    const status = panorama.getStatus();
    console.info('[guessgeo] panorama status', status);
    if (status && status !== 'OK') notice('Street View is not available at this spot.', 'pano');
    else clearNotice('pano');
  });
}

// Ask Street View for the panorama first, so a failure says why instead of showing a blank page.
function loadPanorama(round) {
  const roundNo = round.round_no;
  const slow = setTimeout(() => notice('Street View is taking a long time to answer. Check your connection.', 'pano'), 10_000);
  new google.maps.StreetViewService().getPanorama({ pano: round.pano_id }, (data, status) => {
    clearTimeout(slow);
    if (state.round?.round_no !== roundNo) return;
    console.info('[guessgeo] street view lookup', status, round.pano_id);
    if (status !== google.maps.StreetViewStatus.OK || !data?.location?.pano) {
      notice(`Street View could not load this spot (${status}).`, 'pano');
      return;
    }
    const heading = round.heading;
    ensurePanorama(data.location.pano, heading);
    panorama.setOptions(panoOptionsFor(state.game.settings.movement));
    panorama.setPano(data.location.pano);
    panorama.setPov({ heading, pitch: 0 });
    panorama.setZoom(1);
    panorama.setVisible(true);
    google.maps.event.trigger(panorama, 'resize');
  });
}

function panoOptionsFor(mode) {
  return {
    linksControl: mode === 'move',
    clickToGo: mode === 'move',
    panControl: mode !== 'nmpz',
    zoomControl: mode !== 'nmpz',
    scrollwheel: mode !== 'nmpz',
    disableDoubleClickZoom: mode === 'nmpz',
  };
}

async function submit() {
  if (state.busy || document.body.dataset.view !== 'play') return;
  state.busy = true;
  stopTimer();
  try {
    const { body } = await api(`/api/games/${state.game.id}/rounds/${state.round.round_no}/guess`, {
      method: 'POST',
      body: JSON.stringify({ guess: state.pin }),
    });
    state.clockOffset = body.server_now - Date.now();
    state.game.total = body.total_score;
    state.results.push(body);
    if (body.error === 'deadline_passed') notice('Time ran out. That round scores 0.', 'timeout');
    showResult(body);
  } catch (e) {
    state.busy = false;
    notice(e.message);
    if (e.status === 409) return resync(); // another tab already moved this game on
    // Network or server hiccup: give the clock back (and retry soon if time is already up).
    setTimeout(() => {
      if (document.body.dataset.view === 'play' && !state.busy) startTimer(state.round);
    }, 2000);
  }
}

async function resync() {
  try {
    const { body } = await api(`/api/games/${state.game.id}`);
    if (body.results.length > state.results.length) {
      // A guess went through but its answer never reached us: show that result before moving on.
      state.results = body.results;
      state.game.total = body.total_score;
      showResult({
        ...body.results.at(-1),
        total_score: body.total_score,
        finished: body.status === 'finished',
        next_round_no: body.current_round?.round_no ?? null,
      });
    } else if (body.status === 'in_progress') beginGame(body, true);
    else {
      state.results = body.results;
      state.game.total = body.total_score;
      showSummary();
    }
  } catch (e) {
    notice(e.message);
  }
}

function showResult(res) {
  setView('result');
  answerMarker = new google.maps.Marker({ map: guessMap, position: res.true, icon: answerIcon() });
  const bounds = new google.maps.LatLngBounds();
  bounds.extend(res.true);
  if (res.guess) {
    routeLine = new google.maps.Polyline({
      map: guessMap, path: [res.guess, res.true], geodesic: true, strokeColor: INK, strokeOpacity: 0.7, strokeWeight: 2,
    });
    bounds.extend(res.guess);
  }
  requestAnimationFrame(() => {
    google.maps.event.trigger(guessMap, 'resize');
    if (res.guess) {
      guessMap.fitBounds(bounds, 140);
    } else {
      guessMap.setCenter(res.true);
      guessMap.setZoom(6);
    }
  });

  $('#result-round').textContent = `Round ${res.round_no} of ${state.game.roundsTotal}`;
  $('#result-title').textContent = res.distance_km === null ? 'No guess' : `${formatKm(res.distance_km)} away`;
  $('#result-score').textContent = `${fmt(res.score)} points`;
  $('#result-total').textContent = `Total ${fmt(res.total_score)}`;
  const meter = $('#result-meter');
  meter.style.width = '0%';
  requestAnimationFrame(() => { meter.style.width = `${(res.score / MAX_ROUND_SCORE) * 100}%`; });

  $('#next').textContent = res.finished ? 'See results' : 'Next round';
  $('#next').onclick = () => {
    clearNotice('timeout');
    if (res.finished) showSummary();
    else enterRound(res.next_round_no, true);
  };
  $('#next').focus();
}

function showSummary() {
  stopTimer();
  clearOverlays();
  remember(null);
  setView('summary');
  $('#summary-total').textContent = `${fmt(state.game.total)} points`;
  $('#summary-max').textContent = `Out of ${fmt(state.game.roundsTotal * MAX_ROUND_SCORE)}.`;
  $('#summary-rounds').replaceChildren(
    ...state.results.map((r) => {
      const li = document.createElement('li');
      const dist = document.createElement('strong');
      dist.textContent = r.distance_km === null ? 'No guess' : formatKm(r.distance_km);
      const pts = document.createElement('span');
      pts.className = 'pts';
      pts.textContent = ` · ${fmt(r.score)} points`;
      li.append(dist, pts);
      return li;
    }),
  );
}

function beginGame(view, resumed = false) {
  state.game = {
    id: view.game_id,
    settings: view.settings,
    total: view.total_score,
    roundsTotal: view.rounds_total,
  };
  state.results = resumed ? view.results : [];
  state.clockOffset = view.server_now - Date.now();
  remember(view.game_id);
  const round = view.current_round;
  // A round that has not started has no panorama yet: ask the server to start its clock now.
  if (round.pano_id) startRound(round);
  else enterRound(round.round_no);
}

async function enterRound(roundNo, fromResult = false) {
  setView('loading');
  try {
    const { body } = await api(`/api/games/${state.game.id}/rounds/${roundNo}/start`, { method: 'POST', body: '{}' });
    state.clockOffset = body.server_now - Date.now();
    startRound(body);
  } catch (e) {
    notice(e.message);
    if (e.status === 409) return resync();
    // The game is still there: go back to where the player was so they can try again.
    setView(fromResult ? 'result' : 'setup');
  }
}

async function boot() {
  setView('loading');
  try {
    const cfg = (await api('/api/config')).body;
    if (!cfg.maps_key) {
      setView('setup');
      notice('Add GOOGLE_MAPS_API_KEY to .env and reload.', 'key');
      $('#setup-form button').disabled = true;
      return;
    }
    await loadGoogle(cfg.maps_key);
    initMaps();
    const lastId = remembered();
    if (lastId) {
      try {
        const { body } = await api(`/api/games/${lastId}`);
        if (body.status === 'in_progress') return beginGame(body, true);
        remember(null);
      } catch (e) {
        if (e.status === 404) remember(null); // gone for good; any other error may be temporary, so keep it
      }
    }
    setView('setup');
  } catch (e) {
    setView('setup');
    $('#setup-form button').disabled = true; // no map, no game
    notice(e.message);
  }
}

$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  notice('');
  setView('loading');
  try {
    const { body } = await api('/api/games', {
      method: 'POST',
      body: JSON.stringify({ settings: { movement: form.movement.value, time_limit_s: Number(form.time.value) } }),
    });
    beginGame(body);
  } catch (err) {
    setView('setup');
    notice(err.message);
  }
});
$('#guess-btn').addEventListener('click', submit);
$('#again').addEventListener('click', () => setView('setup'));

boot();
