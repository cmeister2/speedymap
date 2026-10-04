import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CACHE_VERSION, DEFAULT_JOURNEY, isValidRouteResult, makeRouteCacheKey,
  readCachedRoute, writeCachedRoute,
} from '../src/route-cache.js';

const manifest = { generatedAt: '2026-10-04T12:00:00Z', sourceDate: '2026-10-03' };

function route(mode, coordinates = [[51.5074, -0.1278], [55.9533, -3.1883]]) {
  const seconds = mode === 'number-only' ? 100 : mode === 'normal' ? 200 : 300;
  return {
    mode, coordinates, metres: 600_000, seconds,
    normalSeconds: 200, numberedSeconds: 300, numberOnlySeconds: 100,
    segments: [{ ref: 'A1000', name: 'Example Road', metres: 600_000, seconds,
      effectiveMph: mode === 'number-only' ? 1000 : 60, limitMph: 60,
      coordinateStart: 0, coordinateEnd: coordinates.length - 1 }],
  };
}

function result(primary = 'number-only', comparison = 'normal') {
  return { route: route(primary), comparison: route(comparison) };
}

test('cache keys are tied to graph generation, routing policy and comparison mode', () => {
  const key = makeRouteCacheKey(manifest, DEFAULT_JOURNEY);
  assert.equal(JSON.parse(key)[0], CACHE_VERSION);
  assert.notEqual(key, makeRouteCacheKey({ ...manifest, generatedAt: '2026-10-05' }, DEFAULT_JOURNEY));
  assert.notEqual(key, makeRouteCacheKey({ ...manifest, sourceDate: '2026-10-04' }, DEFAULT_JOURNEY));
  assert.notEqual(key, makeRouteCacheKey(manifest, { ...DEFAULT_JOURNEY, mode: 'numbered' }));
  const normal = { ...DEFAULT_JOURNEY, mode: 'normal' };
  assert.notEqual(makeRouteCacheKey(manifest, normal),
    makeRouteCacheKey(manifest, { ...normal, experimentMode: 'numbered' }));
  assert.notEqual(key, makeRouteCacheKey(manifest, { ...DEFAULT_JOURNEY, from: DEFAULT_JOURNEY.to, to: DEFAULT_JOURNEY.from }));
});

test('cache keys ignore display names and normalize object, array and shared-link coordinate precision', () => {
  const key = makeRouteCacheKey(manifest, DEFAULT_JOURNEY);
  assert.equal(key, makeRouteCacheKey(manifest, {
    ...DEFAULT_JOURNEY,
    from: { name: 'A renamed London pin', lat: 51.50740001, lng: -0.12780001 },
    to: [55.9533, -3.1883],
  }));
  assert.equal(makeRouteCacheKey({}, { from: [0, -0], to: [1, 1] }),
    makeRouteCacheKey({}, { from: [-0, 0], to: [1, 1], mode: 'numbered', experimentMode: 'numbered' }));
  assert.ok(Object.isFrozen(DEFAULT_JOURNEY.from));
  assert.equal(DEFAULT_JOURNEY.mode, 'number-only');
});

test('cache keys reject coordinates and modes that cannot identify a journey', () => {
  for (const from of [[91, 0], [0, 181], [NaN, 1], [51], null]) {
    assert.throws(() => makeRouteCacheKey(manifest, { ...DEFAULT_JOURNEY, from }), TypeError);
  }
  assert.throws(() => makeRouteCacheKey(manifest, { ...DEFAULT_JOURNEY, mode: 'invalid' }), TypeError);
  assert.throws(() => makeRouteCacheKey(manifest, { ...DEFAULT_JOURNEY, experimentMode: 'normal' }), TypeError);
});

test('validates fully materialized route pairs and the selected normal comparison experiment', () => {
  assert.equal(isValidRouteResult(result(), DEFAULT_JOURNEY), true);
  assert.equal(isValidRouteResult(result('normal', 'number-only'), { ...DEFAULT_JOURNEY, mode: 'normal' }), true);
  assert.equal(isValidRouteResult(result('normal', 'numbered'), { ...DEFAULT_JOURNEY, mode: 'normal' }), false);
  assert.equal(isValidRouteResult(result('numbered', 'normal'), { ...DEFAULT_JOURNEY, mode: 'numbered' }), true);
  assert.equal(isValidRouteResult(result('number-only', 'numbered')), false);
  assert.equal(isValidRouteResult(result('normal', 'normal')), false);
});

test('rejects corrupt geometry, incomplete ranges and inconsistent route totals', () => {
  const mutations = [
    (value) => { value.route.coordinates = []; },
    (value) => { value.route.coordinates[0] = [NaN, 0]; },
    (value) => { value.route.coordinates[0] = [91, 0]; },
    (value) => { value.route.coordinates = new Float64Array([51, 0]); },
    (value) => { value.route.segments[0].coordinateEnd = 2; },
    (value) => { value.route.segments[0].coordinateStart = 1; },
    (value) => { value.route.segments[0].coordinateEnd = 0; },
    (value) => { value.route.segments[0].effectiveMph = 0; },
    (value) => { value.route.segments[0].metres = -1; },
    (value) => { value.route.segments[0].seconds += 10; },
    (value) => { value.route.numberOnlySeconds += 10; },
    (value) => { value.route.metres += 10; },
    (value) => { value.comparison = null; },
  ];
  for (const mutate of mutations) {
    const value = result();
    mutate(value);
    assert.equal(isValidRouteResult(value, DEFAULT_JOURNEY), false, mutate.toString());
  }
});

test('allows shared segment endpoints and honest road snaps, but rejects results for other places', () => {
  const value = result();
  value.route.coordinates = [[51.5074, -0.1278], [53, -1], [55.9533, -3.1883]];
  value.route.segments = [
    { ...value.route.segments[0], metres: 300_000, seconds: 50, coordinateEnd: 1 },
    { ...value.route.segments[0], metres: 300_000, seconds: 50, coordinateStart: 1, coordinateEnd: 2 },
  ];
  assert.equal(isValidRouteResult(value, DEFAULT_JOURNEY), true);
  value.route.coordinates[0] = [51.5084, -0.1278];
  assert.equal(isValidRouteResult(value, DEFAULT_JOURNEY), true, 'Snapped roads need not exactly equal place coordinates');
  value.route.coordinates[0] = [52.2053, 0.1218];
  assert.equal(isValidRouteResult(value, DEFAULT_JOURNEY), false);
  assert.equal(isValidRouteResult(result(), { ...DEFAULT_JOURNEY, from: DEFAULT_JOURNEY.to }), false);
});

test('preserves zero-length journeys at one snapped point', () => {
  const zero = (mode) => ({ mode, coordinates: [[51.5074, -0.1278]], segments: [],
    metres: 0, seconds: 0, normalSeconds: 0, numberedSeconds: 0, numberOnlySeconds: 0 });
  const value = { route: zero('number-only'), comparison: zero('normal') };
  assert.equal(isValidRouteResult(value, { ...DEFAULT_JOURNEY, to: DEFAULT_JOURNEY.from }), true);
  value.route.coordinates.push([51.5074, -0.1278]);
  assert.equal(isValidRouteResult(value), false);
});

test('missing or unavailable IndexedDB leaves journeys usable without a cache', async () => {
  const key = makeRouteCacheKey(manifest, DEFAULT_JOURNEY);
  assert.equal(await readCachedRoute(key), null);
  assert.equal(await writeCachedRoute(key, result()), false);
  const original = globalThis.indexedDB;
  globalThis.indexedDB = { open() { throw new DOMException('Storage disabled', 'SecurityError'); } };
  try {
    assert.equal(await readCachedRoute(key), null);
    assert.equal(await writeCachedRoute(key, result()), false);
  } finally {
    if (original === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = original;
  }
  assert.equal(await readCachedRoute('invalid key'), null);
  assert.equal(await readCachedRoute(JSON.stringify(['obsolete-cache-version'])), null);
  assert.equal(await writeCachedRoute(key, { route: null }), false);
});
