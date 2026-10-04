#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { RoutingEngine } from '../src/routing/engine.js';
import { loadGraph } from '../src/routing/loader.js';
import { CACHE_VERSION, DEFAULT_JOURNEY, isValidRouteResult, makeRouteCacheKey } from '../src/route-cache.js';

// The browser loader and geometry store use fetch. Supply local files through
// Response so this generator runs the same validation/decompression code without
// a web server or any network requests.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.protocol !== 'file:') return originalFetch(input, options);
  options.signal?.throwIfAborted();
  const bytes = await readFile(fileURLToPath(url));
  options.signal?.throwIfAborted();
  return new Response(bytes, { headers: {
    'content-type': url.pathname.endsWith('.json') ? 'application/json' : 'application/octet-stream',
  } });
};

const output = new URL('../public/default-route.json.gz', import.meta.url);
const temporary = new URL(`../public/.default-route.${process.pid}.json.gz.tmp`, import.meta.url);
const started = performance.now();

function validateRoute(route, mode) {
  assert.equal(route.mode, mode);
  assert.ok(Number.isFinite(route.seconds) && route.seconds > 0);
  assert.ok(Number.isFinite(route.metres) && route.metres > 0);
  assert.ok(route.coordinates.length > 1);
  assert.ok(route.coordinates.every((point) => point.length === 2 && point.every(Number.isFinite)));
  assert.ok(route.segments.length > 0);
  assert.equal(route.segments[0].coordinateStart, 0);
  assert.equal(route.segments.at(-1).coordinateEnd, route.coordinates.length - 1);
  let previousEnd = 0;
  let metres = 0;
  let seconds = 0;
  for (const segment of route.segments) {
    assert.equal(segment.coordinateStart, previousEnd);
    assert.ok(Number.isInteger(segment.coordinateEnd) && segment.coordinateEnd > segment.coordinateStart);
    assert.ok(segment.coordinateEnd < route.coordinates.length);
    assert.ok(Number.isFinite(segment.effectiveMph) && segment.effectiveMph > 0);
    metres += segment.metres;
    seconds += segment.seconds;
    previousEnd = segment.coordinateEnd;
  }
  assert.ok(Math.abs(metres - route.metres) < 0.1);
  assert.ok(Math.abs(seconds - route.seconds) < 0.1);
  assert.deepEqual(route.coordinates[0], route.snap.from.coordinate);
  assert.deepEqual(route.coordinates.at(-1), route.snap.to.coordinate);
}

function report(route, milliseconds) {
  return {
    mode: route.mode, seconds: route.seconds, minutes: route.seconds / 60,
    miles: route.metres / 1609.344, metres: route.metres,
    coordinates: route.coordinates.length, segments: route.segments.length,
    maxEffectiveMph: Math.max(...route.segments.map((segment) => segment.effectiveMph)),
    visited: route.visited, snap: route.snap, milliseconds,
  };
}

try {
  let lastStage;
  const graph = await loadGraph(new URL('../public/data/manifest.json', import.meta.url), {
    onProgress: ({ stage, message }) => {
      if (stage !== lastStage) console.log(JSON.stringify({ stage, message }));
      lastStage = stage;
    },
  });
  assert.ok(graph.geometryStore, 'Full road geometry is required for the default cache.');
  const engine = new RoutingEngine(graph);
  console.log(JSON.stringify({ stage: 'loaded', nodes: graph.manifest.nodes,
    edges: graph.manifest.edges, milliseconds: performance.now() - started }));
  const routes = {};
  for (const mode of [DEFAULT_JOURNEY.mode, 'normal']) {
    const routeStarted = performance.now();
    const route = await engine.route(
      [DEFAULT_JOURNEY.from.lat, DEFAULT_JOURNEY.from.lng],
      [DEFAULT_JOURNEY.to.lat, DEFAULT_JOURNEY.to.lng], {
      mode, yieldEvery: 0,
      onProgress: ({ stage, message }) => {
        if (stage !== lastStage) console.log(JSON.stringify({ stage, mode, message }));
        lastStage = stage;
      },
    });
    validateRoute(route, mode);
    routes[mode] = route;
    console.log(JSON.stringify({ stage: 'route', ...report(route, performance.now() - routeStarted) }));
  }
  const payload = {
    cacheVersion: CACHE_VERSION,
    key: makeRouteCacheKey(graph.manifest, DEFAULT_JOURNEY),
    journey: DEFAULT_JOURNEY,
    result: { route: routes[DEFAULT_JOURNEY.mode], comparison: routes.normal },
    sourceDate: graph.manifest.sourceDate,
  };
  assert.ok(isValidRouteResult(payload.result, DEFAULT_JOURNEY), 'Default route failed shared cache validation.');
  const json = JSON.stringify(payload);
  const compressed = gzipSync(json, { level: 9 });
  assert.ok(compressed.byteLength < 100 * 1024 * 1024, 'Default route exceeds GitHub file size limit.');
  await mkdir(new URL('../public/', import.meta.url), { recursive: true });
  await writeFile(temporary, compressed, { flag: 'wx' });
  await rename(temporary, output);
  console.log(JSON.stringify({ stage: 'published', file: fileURLToPath(output),
    sourceDate: payload.sourceDate, cacheVersion: CACHE_VERSION,
    jsonBytes: Buffer.byteLength(json), compressedBytes: compressed.byteLength,
    milliseconds: performance.now() - started }));
} finally {
  globalThis.fetch = originalFetch;
  await rm(temporary, { force: true });
}
