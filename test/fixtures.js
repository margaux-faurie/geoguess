import { createGameService } from '../src/game.js';
import { createMemoryStore } from '../src/store.js';

/** 12 fake locations spread along the equator. Pano ids are fake: tests never call Google. */
export function fixtureMap() {
  return {
    id: 'world',
    name: 'World',
    scale_km: 14917,
    locations: Array.from({ length: 12 }, (_, i) => ({
      id: `loc-${i}`,
      pano_id: `pano-${i}`,
      lat: 0,
      lng: -150 + i * 25,
      heading: i * 30,
    })),
  };
}

export function fixtureService({ start = 1_000_000 } = {}) {
  const clock = { t: start };
  const store = createMemoryStore();
  let n = 0;
  const service = createGameService({
    maps: [fixtureMap()],
    store,
    now: () => clock.t,
    random: () => 0.5,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  });
  return { service, store, clock };
}
