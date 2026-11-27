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

`npm test` runs the server tests. They never call Google.

## How it works

- The server picks the locations when a game starts and keeps the true coordinates. The browser only gets a panorama id and a starting heading. The coordinates come back after the guess.
- Score per round: `5000 * e^(-10 d / D)` with `d` the miss in km and `D` the map's scale (14,917 km for the World map). A guess within 25 m is a perfect 5,000. Distance is haversine. Both live in `src/scoring.js`, the only place scores are computed.
- Timer: the server stamps each round and accepts a guess up to 2 seconds after the limit. Later than that scores 0 (HTTP 410, the answer is still revealed). One guess per round, in order.
- Players are guests: a random id in an httpOnly cookie. A game belongs to its id, so nobody can read another player's game.
- Limits: 30 new games an hour per player, one guess a second per game.

```
src/scoring.js   haversine + score        (no Node imports)
src/game.js      rounds, deadlines, rules (no Node imports)
src/app.js       /api routes, Request -> Response (no Node imports)
src/store.js     memory and JSON-file stores, optimistic concurrency
src/server.js    local dev server: static files + the app
scripts/build-locations.mjs   free metadata API -> data/locations.json
public/          the client (Street View, guess map, results)
```

`scoring.js`, `game.js` and `app.js` use only web-standard APIs, so they run unchanged in a Cloudflare Worker.

## Not verified yet

Built and tested without a Google key or a browser, so these are untested:

- The client against the real Street View and Maps APIs: panorama display, the guess map, the paper map style, marker and line drawing, the result view.
- The movement modes: hiding links and click-to-go, the overlay for no moving/panning/zooming, and the keyboard blocking.
- Billing: whether reusing one panorama object across rounds counts as one load or one per round. Watch the first day's usage in Google Cloud.
- A panorama that was removed since `npm run locations` shows "Street View is not available at this spot." There is no skip without penalty yet. Re-run the builder now and then.

## Known limits

- Anyone with the page open can read a panorama's position from the Maps objects in dev tools. The server keeps the answer and the score honest, not the panorama. Fine for friends.
- Games live in `data/games.json`, written whole on each change. Fine for a few players.
- `data/locations.json` holds true coordinates and is gitignored. Never put it in `public/`.

## Next

- Deploy as a Worker `guessgeo` on guessgeo.margauxfaurie.com: static files from `public/`, `/api/*` through `src/app.js`, games in D1 (a store with the same `get`/`put` as `src/store.js`), locations bundled from `data/locations.json`.
- Accounts: the wildcard Access app already covers `*.margauxfaurie.com`, so friends in the Portfolio Visitors policy can be identified from the Access header (change `identify` in `src/app.js`). Public sign-up would need its own auth.
- Daily challenge, leaderboards, challenge links (spec milestones 4 and 5).
- Design system: see `docs/design-notes.md`.

## Deploying to Cloudflare (guessgeo.margauxfaurie.com)

The API runs as a Worker (`src/worker.js`), games live in D1, players are identified by Cloudflare Access.
`data/locations.json` is generated on your machine and bundled at deploy time. It holds the true coordinates,
so it stays out of git: deploy from the machine that generated it.

1. `npx wrangler d1 create guessgeo`, then put the returned id in `wrangler.toml`.
2. `npx wrangler d1 migrations apply guessgeo --remote`
3. In Zero Trust > Access > Applications, note the team domain and the application's AUD tag, and fill
   `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `wrangler.toml`. Without them the API refuses every request.
4. `npx wrangler secret put GOOGLE_MAPS_API_KEY` (the browser key; add `https://guessgeo.margauxfaurie.com/*` to its allowed sites).
5. `npx wrangler deploy`, then attach the `guessgeo.margauxfaurie.com` custom domain to the Worker.

Not verified yet: none of this has been deployed. Rate limits are per Worker instance, so they are approximate.
