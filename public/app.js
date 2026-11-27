import { createGuessMap } from './guessmap.js';

// guessgeo client. No build step. Street View comes from the Maps JavaScript API; the guess map is
// MapLibre with OpenStreetMap tiles (see guessmap.js).
// The server owns the locations and the scores: this file only shows a panorama by id,
// sends a pin, and displays what comes back.

const $ = (sel) => document.querySelector(sel);
const fmt = (n) => Number(n).toLocaleString('en');
const MAX_ROUND_SCORE = 5000;
const STORAGE_KEY = 'guessgeo:game';

const state = {
  game: null, // { id, settings, total, roundsTotal }
  round: null, // the public round being played
  results: [],
  clockOffset: 0, // server time minus browser time, so the countdown matches the server
  pin: null, // { lat, lng }
  busy: false,
  joining: null, // challenge id while the invite screen is shown
  timer: null,
};
let panorama;
let guessMap;
let summaryMap;
let resultShownAt = 0;
let startPano = null; // where the round began, for "Back to start"
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
    throw Object.assign(new Error(body.message || 'Something went wrong. Try again.'), { status: res.status, code: body.error });
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
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=quarterly&loading=async&callback=__mapsReady`;
    s.async = true;
    s.onerror = () => reject(new Error('Could not load Google Maps.'));
    document.head.append(s);
  });
}

function initMaps() {
  guessMap = createGuessMap($('#guess-map'), { onPick: placePin, onError: (m) => notice(m, 'map') });

  // Keep the keyboard from moving the player when movement is off.
  $('#pano').addEventListener('keydown', (e) => {
    const mode = document.body.dataset.movement;
    const moves = ['ArrowUp', 'ArrowDown', 'w', 'W', 's', 'S'];
    if (mode === 'nmpz' || (mode === 'nomove' && moves.includes(e.key))) e.stopPropagation();
  }, true);

  $('#back-to-start').addEventListener('click', () => {
    if (!panorama || !startPano) return;
    panorama.setPano(startPano.pano);
    panorama.setPov({ heading: startPano.heading, pitch: 0 });
    panorama.setZoom(1);
  });
}

function placePin(latLng) {
  if (document.body.dataset.view !== 'play' || state.busy) return false;
  state.pin = latLng;
  $('#guess-btn').disabled = false;
  $('#guess-btn').textContent = 'Guess';
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
  clearNotice('pano');

  const mode = state.game.settings.movement;
  document.body.dataset.movement = mode;
  $('#guess-btn').disabled = true;
  $('#guess-btn').textContent = 'Place your pin';

  renderHud();
  // Show the view first so the panorama is laid out before it loads.
  setView('play');
  guessMap.reset();
  startPano = null;
  $('#back-to-start').hidden = mode !== 'move';
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
    if (status && status !== 'OK') notice('Street View is not available at this spot.', 'pano');
    else clearNotice('pano');
  });
  // Keep the angle continuous so the needle never spins the long way round at north.
  let shown = 0;
  panorama.addListener('pov_changed', () => {
    const h = -panorama.getPov().heading;
    shown += ((((h - shown) % 360) + 540) % 360) - 180;
    $('#compass-needle').style.transform = `rotate(${shown}deg)`;
  });
}

// Ask Street View for the panorama first, so a failure says why instead of showing a blank page.
function loadPanorama(round) {
  const roundNo = round.round_no;
  const slow = setTimeout(() => notice('Street View is taking a long time to answer. Check your connection.', 'pano'), 10_000);
  new google.maps.StreetViewService().getPanorama({ pano: round.pano_id }, (data, status) => {
    clearTimeout(slow);
    if (state.round?.round_no !== roundNo) return;
    if (status !== google.maps.StreetViewStatus.OK) console.warn('[guessgeo] street view lookup', status);
    if (status !== google.maps.StreetViewStatus.OK || !data?.location?.pano) {
      // Gone from Street View (ZERO_RESULTS): ask the server for another place, once, at no cost.
      if (status === google.maps.StreetViewStatus.ZERO_RESULTS) return replaceDeadRound(round);
      notice(`Street View could not load this spot (${status}).`, 'pano');
      return;
    }
    const heading = round.heading;
    startPano = { pano: data.location.pano, heading };
    ensurePanorama(data.location.pano, heading);
    panorama.setOptions(panoOptionsFor(state.game.settings.movement));
    panorama.setPano(data.location.pano);
    panorama.setPov({ heading, pitch: 0 });
    panorama.setZoom(1);
    panorama.setVisible(true);
    google.maps.event.trigger(panorama, 'resize');
  });
}

async function replaceDeadRound(round) {
  stopTimer(); // the dead round's clock must not fire a skip while the server finds a new place
  notice('That spot is gone from Street View. Finding another one…', 'pano');
  try {
    const { body } = await api(`/api/games/${state.game.id}/rounds/${round.round_no}/replace`, {
      method: 'POST',
      body: JSON.stringify({ failed_pano_id: round.pano_id }),
    });
    if (state.round !== round || document.body.dataset.view !== 'play') return; // the player moved on
    state.clockOffset = body.server_now - Date.now();
    if (body.pano_id === round.pano_id) throw new Error('No other spot is available. Skip this round.');
    startRound(body);
  } catch (e) {
    notice(e.message, 'pano');
    // In a challenge the place cannot be swapped: the round is skipped (0 points) for this player.
    if (e.code === 'challenge_no_replace') return submit();
    if (e.status === 409) return resync();
    startTimer(round);
  }
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
  guessMap.stopPicking();
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
    guessMap.startPicking();
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
  resultShownAt = performance.now(); // a key pressed just as the timer fired must not skip the result
  $('#result-round').textContent = `Round ${res.round_no} of ${state.game.roundsTotal}`;
  $('#result-title').textContent = res.distance_km === null ? 'No guess' : `${formatKm(res.distance_km)} away`;
  $('#result-score').textContent = `${fmt(res.score)} points`;
  $('#result-total').textContent = `Total ${fmt(res.total_score)}`;
  const meter = $('#result-meter');
  meter.style.width = '0%';
  requestAnimationFrame(() => { meter.style.width = `${(res.score / MAX_ROUND_SCORE) * 100}%`; });

  renderHud();
  // Frame the guess and the place in the part of the screen the result card leaves free.
  const card = $('#result').getBoundingClientRect();
  guessMap.showAnswer(res.guess, res.true, { top: 72, left: 48, right: 48, bottom: Math.round(window.innerHeight - card.top) + 32 });

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
  remember(null);
  setView('summary');
  if (!summaryMap) summaryMap = createGuessMap($('#summary-map'), { cooperative: true });
  summaryMap.showAll(state.results);
  $('#again').focus();
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
  renderChallenge();
}

// ---- Challenges: friends play the same five places, then compare on a scoreboard ----

const NAME_KEY = 'guessgeo:name';
const savedName = () => { try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; } };
const saveName = (n) => { try { localStorage.setItem(NAME_KEY, n); } catch { /* storage can be blocked */ } };
const challengeUrl = (id) => `${location.origin}/?c=${id}`;

const canShare = () => Boolean(navigator.share) && matchMedia('(hover: none)').matches;

function showShare(challengeId) {
  $('#share-btn').textContent = canShare() ? 'Share link' : 'Copy link';
  $('#challenge-form').hidden = true;
  $('#share').hidden = false;
  $('#share-link').value = challengeUrl(challengeId);
}

async function renderChallenge() {
  $('#board-block').hidden = true;
  $('#share').hidden = true;
  $('#challenge-form').hidden = Boolean(state.game.challengeId);
  $('#challenge-form').player.value = savedName();
  const game = state.game;
  if (!game.challengeId) return;
  showShare(game.challengeId);
  try {
    const { body } = await api(`/api/challenges/${game.challengeId}`);
    if (!body.board || state.game !== game || document.body.dataset.view !== 'summary') return;
    $('#board').replaceChildren(
      ...body.board.map((p) => {
        const li = document.createElement('li');
        li.classList.toggle('me', p.me);
        li.dataset.rank = p.rank;
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = p.name;
        const pts = document.createElement('span');
        pts.textContent = `${fmt(p.total_score)} points`;
        li.append(who, pts);
        return li;
      }),
    );
    $('#board-block').hidden = false;
  } catch (e) {
    notice(e.message);
  }
}

$('#challenge-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = e.currentTarget.player.value.trim();
  const game = state.game; // the player may start another game while this request runs
  try {
    const { body } = await api(`/api/games/${game.id}/challenge`, { method: 'POST', body: JSON.stringify({ name }) });
    saveName(name);
    game.challengeId = body.challenge_id;
    if (state.game !== game || document.body.dataset.view !== 'summary') return;
    showShare(body.challenge_id);
    $('#share-btn').focus();
  } catch (err) {
    notice(err.message);
  }
});

$('#share-btn').addEventListener('click', async () => {
  const url = $('#share-link').value;
  try {
    if (canShare()) {
      await navigator.share({ title: 'Where is this?', text: 'Beat my score on these five places', url });
      return;
    }
    await navigator.clipboard.writeText(url);
    $('#share-btn').textContent = 'Copied';
    setTimeout(() => { $('#share-btn').textContent = 'Copy link'; }, 2000);
  } catch {
    $('#share-link').select(); // clipboard blocked: leave it selected for a manual copy
  }
});

// Opened from a challenge link: resume this player's game in it, show their summary, or invite them in.
async function openChallenge(challengeId) {
  const { body } = await api(`/api/challenges/${challengeId}`);
  if (body.my_game_id) {
    const { body: game } = await api(`/api/games/${body.my_game_id}`);
    if (game.status === 'in_progress') return beginGame(game, true);
    state.game = gameFrom(game);
    state.results = game.results;
    return showSummary();
  }
  state.joining = challengeId;
  const s = body.settings;
  const rules = [
    s.movement === 'move' ? 'moving allowed' : s.movement === 'nomove' ? 'no moving' : 'no moving, panning or zooming',
    s.time_limit_s ? `${s.time_limit_s} seconds a round` : 'no time limit',
  ].join(', ');
  $('#invite').textContent = `${body.created_by} challenged you: ${body.rounds_total} places, ${rules}. ${body.players} played so far.`;
  $('#invite').hidden = false;
  $('#name-field').hidden = false;
  $('#movement-field').hidden = true;
  $('#time-field').hidden = true;
  const form = $('#setup-form');
  form.player.required = true;
  form.player.value = savedName();
  form.querySelector('button').textContent = 'Play the challenge';
  setView('setup');
}

function leaveChallengeInvite() {
  state.joining = null;
  $('#invite').hidden = true;
  $('#name-field').hidden = true;
  $('#movement-field').hidden = false;
  $('#time-field').hidden = false;
  const form = $('#setup-form');
  form.player.required = false;
  form.querySelector('button').textContent = 'Start';
  history.replaceState(null, '', '/');
}

function gameFrom(view) {
  return {
    id: view.game_id,
    settings: view.settings,
    total: view.total_score,
    roundsTotal: view.rounds_total,
    challengeId: view.challenge_id ?? null,
  };
}

function beginGame(view, resumed = false) {
  state.game = gameFrom(view);
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
    if (!window.maplibregl) throw new Error('Could not load the map. Check your connection and reload.');
    await loadGoogle(cfg.maps_key);
    await google.maps.importLibrary('streetView');
    initMaps();
    const challengeId = new URLSearchParams(location.search).get('c');
    if (challengeId && /^[0-9a-f-]{36}$/i.test(challengeId)) {
      try {
        return await openChallenge(challengeId.toLowerCase());
      } catch (e) {
        notice(e.status === 404 ? 'That challenge link does not exist.' : e.message);
        if (e.status === 404) history.replaceState(null, '', '/');
      }
    }
    const lastId = remembered();
    if (lastId) {
      try {
        const { body } = await api(`/api/games/${lastId}`);
        if (body.status === 'in_progress') return beginGame(body, true);
        if (body.status === 'finished') {
          state.game = gameFrom(body);
          state.results = body.results;
          return showSummary();
        }
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
    let body;
    if (state.joining) {
      const name = form.player.value.trim();
      try {
        ({ body } = await api(`/api/challenges/${state.joining}/join`, { method: 'POST', body: JSON.stringify({ name }) }));
      } catch (err) {
        if (err.code === 'challenge_full') leaveChallengeInvite(); // still free to play a normal game
        throw err;
      }
      saveName(name);
      state.joining = null;
    } else {
      ({ body } = await api('/api/games', {
        method: 'POST',
        body: JSON.stringify({ settings: { movement: form.movement.value, time_limit_s: Number(form.time.value) } }),
      }));
    }
    beginGame(body);
  } catch (err) {
    setView('setup');
    notice(err.message);
  }
});
$('#guess-btn').addEventListener('click', submit);

// Space or Enter: guess once a pin is down, or go on from a result. Ignored while typing in a field.
document.addEventListener('keydown', (e) => {
  if (e.repeat || e.altKey || e.ctrlKey || e.metaKey || !(e.key === ' ' || e.key === 'Enter')) return;
  if (e.defaultPrevented) return;
  if (e.target.closest?.('select, input, textarea, button, a, summary, details, [role="button"], [role="link"]')) return;
  const view = document.body.dataset.view;
  if (view === 'play' && state.pin && !state.busy) {
    e.preventDefault();
    submit();
  } else if (view === 'result' && performance.now() - resultShownAt > 400) {
    e.preventDefault();
    $('#next').click();
  }
});
$('#again').addEventListener('click', () => {
  leaveChallengeInvite();
  setView('setup');
});

boot();
