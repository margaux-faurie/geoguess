import assert from 'node:assert/strict';
import test from 'node:test';
import { haversineKm, score } from '../src/scoring.js';

const WORLD = 14917;
const FRANCE = 1300;

test('world map scores match the table in the spec', () => {
  const table = [[1, 4997], [100, 4676], [500, 3576], [1000, 2558], [2500, 936], [5000, 175]];
  for (const [km, expected] of table) assert.equal(score(km, WORLD), expected, `${km} km`);
});

test('france map scores match the table in the spec', () => {
  const table = [[1, 4962], [10, 4630], [50, 3404], [200, 1074], [500, 107]];
  for (const [km, expected] of table) assert.equal(score(km, FRANCE), expected, `${km} km`);
});

test('within 25 m is a perfect 5000', () => {
  assert.equal(score(0, WORLD), 5000);
  assert.equal(score(0.025, WORLD), 5000);
  assert.equal(score(0.03, WORLD), 5000); // just outside the radius, still rounds to 5000
  assert.equal(score(1, WORLD), 4997); // 1 km is where the curve starts to bite
});

test('score never rises with distance and stays within 0..5000', () => {
  let prev = Infinity;
  for (let km = 0; km <= 20000; km += 250) {
    const s = score(km, WORLD);
    assert.ok(s <= prev && s >= 0 && s <= 5000);
    prev = s;
  }
});

test('a non-positive map scale is rejected', () => {
  assert.throws(() => score(10, 0), RangeError);
});

test('haversine: known distances', () => {
  assert.ok(Math.abs(haversineKm(0, 0, 0, 0)) < 1e-9);
  // Paris to London is about 344 km
  const parisLondon = haversineKm(48.8566, 2.3522, 51.5074, -0.1278);
  assert.ok(parisLondon > 340 && parisLondon < 348, String(parisLondon));
  // Quarter of the equator is pi/2 * R
  assert.ok(Math.abs(haversineKm(0, 0, 0, 90) - 10007.54) < 0.1);
  // Antipodes are half the circumference
  assert.ok(Math.abs(haversineKm(0, 0, 0, 180) - 20015.09) < 0.1);
  // Symmetric
  assert.equal(haversineKm(10, 20, -30, 40), haversineKm(-30, 40, 10, 20));
});
