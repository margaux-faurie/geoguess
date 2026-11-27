# guessgeo

A GeoGuessr-style game for friends: Street View drops you somewhere, you pin where it is, closer scores more (up to 5,000 a round, 5 rounds). Built to live at guessgeo.margauxfaurie.com and follow the Portfolio Design System.

Milestone 1 of the spec: one World map, Classic mode, guest play, server-side scoring. No dependencies, no build step (Node 20 or newer).

## Run it

1. Google Cloud: create a project, enable billing (a card is needed even inside the free caps), enable **Maps JavaScript API** and **Street View Static API**.
2. Make two keys:
   - Browser key: Maps JavaScript API only, restricted to `http://localhost:3000/*` and your real domain.
   - Server key: Street View Static API only, never used in the browser.
3. Safeguards: a budget alert, and a daily Street View quota of about 150 loads so Google stops serving instead of billing.
4. `cp .env.example .env` and fill in both keys.
5. `npm run locations` builds `data/locations.json` (200 real panoramas, found with the free metadata API).
6. `npm start`, then open http://localhost:3000.

`npm test` runs the server tests (54). They never call Google. The D1 tests use Node's built-in SQLite and are skipped before Node 22.5.

## How it works

- The server picks the locations when a game starts and keeps the true coordinates. The browser only gets a panorama id and a starting heading. The coordinates come back after the guess.
- Score per round: `5000 * e^(-10 d / D)` with `d` the miss in km and `D` the map's scale (14,917 km for the World map). A guess within 25 m is a perfect 5,000. Distance is haversine. Both live in `src/scoring.js`, the only place scores are computed.
- Timer: the clock of a round starts when the player's browser asks for it (`POST /api/games/:id/rounds/:n/start`), so reading a result never costs time, and the panorama id is not revealed before that. The server accepts a guess up to 2 seconds after the limit. Later than that scores 0 (HTTP 410, the answer is still revealed). One guess per round, in order. Only an explicit `{"guess": null}` skips a round.
- Players are guests: a random id in an httpOnly cookie. A game belongs to its id, so nobody can read another player's game.
- A dead panorama (Street View answers ZERO_RESULTS) is swapped once per round for an unused location. The client must name the panorama it failed on; the old place is never revealed.
- Challenges: after a game, `POST /api/games/:id/challenge {name}` gives a link `/?c=<id>`. Friends who open it join with `POST /api/challenges/:id/join {name}` and play the same rounds with the same settings. `GET /api/challenges/:id` shows how many have played; the scoreboard (names and scores, never account ids) only appears once you have finished. At most 50 players; joining counts as a new game for the limits. Needs migration `0002_challenges.sql` on D1.
- Limits: 30 new games an hour per player and 90 per client address, one guess a second per game. POSTs must be same-origin `application/json` bodies of at most 10,000 bytes.
- Games keep the map's scale from when they started. Pages carry security headers (`src/security-headers.js`, mirrored in `public/_headers`); the CSP is report-only until the browser console shows no violations with the live Maps scripts, then rename it to `Content-Security-Policy`.
- The dev server listens on 127.0.0.1 only (`HOST=0.0.0.0` to share it on your network).

```
src/scoring.js   haversine + score        (no Node imports)
src/game.js      rounds, deadlines, rules (no Node imports)
src/app.js       /api routes, Request -> Response (no Node imports)
src/maps.js      validation of data/locations.json (no Node imports)
src/store.js     memory and JSON-file stores, optimistic concurrency (dev)
src/d1-store.js  the same store contract on Cloudflare D1
src/access.js    Cloudflare Access JWT verification
src/edge.js      wires Access + D1 + game rules for the Worker
src/worker.js    Worker entry
src/server.js    local dev server: static files + the app
scripts/build-locations.mjs   free metadata API -> data/locations.json
public/app.js    the client: views, Street View, rounds, results
public/guessmap.js  the MapLibre guess map and great-circle lines
```

Everything except `store.js`, `server.js` and the scripts uses only web-standard APIs, so it runs unchanged in a Cloudflare Worker.

## The guess map

MapLibre GL 5.24.1 on [OpenFreeMap](https://openfreemap.org) tiles (OpenStreetMap data): free, no key, no account. The library is loaded from jsDelivr with a pinned version and a Subresource Integrity hash, so a changed file is refused by the browser. To upgrade, change the version in `public/index.html` and recompute both hashes. Each player's browser asks OpenFreeMap for tiles directly (their address and the page origin, not the game).

Terms: the billing account is in France, so the Google Maps Platform EEA terms apply. They let you use Google content next to a third-party map at your own discretion, unlike the global terms, which forbid Street View and a non-Google map on one screen. One clause still needs a decision: the EEA terms say Street View Static API content may not be used with any map, and `npm run locations` takes the true coordinates from the Street View Static metadata endpoint. The panorama shown in the game comes from the Maps JavaScript API. Not legal advice; see the open question in the work log.

## Tested in a browser (27 Nov 2026)

A full five-round game on the local server: panorama display, compass, Back to start, pin and Guess (click and Space), result view with the great-circle line, Next (click and Enter), resume after reload, game-over map.

Not tested yet: the No moving and No moving/panning/zooming modes, the timer running out, phone screens, and the Worker on Cloudflare. Billing: watch the first day's usage in Google Cloud. A panorama removed from Street View since `npm run locations` is replaced for free, once per round, with a fresh clock (`POST /api/games/:id/rounds/:n/replace`, tested on the server only: the browser path needs a real dead panorama).

## Known limits

- Anyone with the page open can read a panorama's position from the Maps objects in dev tools. The server keeps the answer and the score honest, not the panorama. Fine for friends.
- Games live in `data/games.json`, written whole on each change. Fine for a few players.
- `data/locations.json` holds true coordinates and is gitignored. Never put it in `public/`.

## Next

- Deploy the Worker (below). Public sign-up would need its own auth instead of Access.
- Abandoned games are never deleted yet; add a retention rule in D1 before opening the game beyond friends.
- The pool of 200 locations can be harvested by skipping rounds (the answer is revealed). Fine for friends; before leaderboards, use a much larger pool and exclude spots a player has already seen.
- Daily challenge, leaderboards, challenge links (spec milestones 4 and 5).
- Design system: see `docs/design-notes.md`.

## Deploying to Cloudflare (guessgeo.margauxfaurie.com)

The API runs as a Worker (`src/worker.js`), games live in D1, players are identified by Cloudflare Access.
`data/locations.json` is generated on your machine and bundled at deploy time. It holds the true coordinates,
so it stays out of git: deploy from the machine that generated it.

1. `npx wrangler@4 d1 create guessgeo`, then put the returned id in `wrangler.toml`.
2. `npx wrangler@4 d1 migrations apply guessgeo --remote`
3. In Zero Trust > Access > Applications, create an application for `guessgeo.margauxfaurie.com` only (not the wildcard:
   its AUD tag would accept a token issued for any other subdomain), allow your friends, then fill `ACCESS_TEAM_DOMAIN`
   and `ACCESS_AUD` in `wrangler.toml`. Without them the API refuses every request.
4. `npx wrangler@4 secret put GOOGLE_MAPS_API_KEY` (the browser key; add `https://guessgeo.margauxfaurie.com/*` to its allowed sites).
5. `npx wrangler@4 deploy`. `wrangler.toml` declares the custom domain and turns off the public workers.dev and preview addresses.
6. Before the first real game, try one create / start / guess with `npx wrangler@4 dev --remote`: the D1 store has only been tested against Node's SQLite, not Cloudflare's own result format.

Not verified yet: none of this has been deployed. Rate limits are per Worker instance, so they are approximate; Access plus the per-address limit is what protects the quota.
