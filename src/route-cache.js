import { distanceMetres } from './routing/spatial.js';

// Bump this when route costs, endpoint policy or the saved result schema changes.
export const CACHE_VERSION = '3-number-only-directional-snaps-ranges';
export const DEFAULT_JOURNEY = Object.freeze({
  from: Object.freeze({ name: 'London', lat: 51.5074, lng: -0.1278 }),
  to: Object.freeze({ name: 'Edinburgh', lat: 55.9533, lng: -3.1883 }),
  mode: 'number-only',
  experimentMode: 'number-only',
});

const MODES = new Set(['normal', 'numbered', 'number-only']);
const EXPERIMENTS = new Set(['numbered', 'number-only']);
const MAX_RESULTS = 8;
const MAX_BYTES = 25 * 1024 * 1024;
const DATABASE = 'speedymap-route-cache';
const PAYLOADS = 'routes';
const METADATA = 'metadata';
let databasePromise;

function point(value) {
  const coordinates = Array.isArray(value) ? value : [value?.lat, value?.lng];
  if (coordinates.length !== 2 || !coordinates.every(Number.isFinite) ||
    Math.abs(coordinates[0]) > 90 || Math.abs(coordinates[1]) > 180) throw new TypeError('Invalid route-cache coordinates.');
  return coordinates;
}

function requestModes(request) {
  const mode = request.mode || 'numbered';
  const experimentMode = request.experimentMode || (mode === 'number-only' ? 'number-only' : 'numbered');
  if (!MODES.has(mode) || !EXPERIMENTS.has(experimentMode)) throw new TypeError('Invalid route-cache mode.');
  return { mode, experimentMode };
}

const fixedCoordinate = (number) => Number(number.toFixed(6)).toFixed(6);

export function makeRouteCacheKey(manifest, request) {
  const from = point(request.from);
  const to = point(request.to);
  const { mode, experimentMode } = requestModes(request);
  return JSON.stringify([CACHE_VERSION, String(manifest.generatedAt || manifest.sourceDate || 'unknown'),
    String(manifest.sourceDate || ''), ...from.map(fixedCoordinate), ...to.map(fixedCoordinate), mode, experimentMode]);
}

function keyRequest(key) {
  if (typeof key !== 'string' || key.length > 4096) return null;
  try {
    const fields = JSON.parse(key);
    if (!Array.isArray(fields) || fields.length !== 9 || fields[0] !== CACHE_VERSION ||
      !fields.slice(1, 7).every((value) => typeof value === 'string')) return null;
    const request = { from: fields.slice(3, 5).map(Number), to: fields.slice(5, 7).map(Number),
      mode: fields[7], experimentMode: fields[8] };
    point(request.from); point(request.to); requestModes(request);
    return request;
  } catch { return null; }
}

const nonnegative = (number) => Number.isFinite(number) && number >= 0;
const validPoint = (coordinates) => Array.isArray(coordinates) && coordinates.length === 2 &&
  coordinates.every(Number.isFinite) && Math.abs(coordinates[0]) <= 90 && Math.abs(coordinates[1]) <= 180;

function validRoute(route) {
  if (!route || !MODES.has(route.mode) || !nonnegative(route.seconds) || !nonnegative(route.metres) ||
    !nonnegative(route.normalSeconds) || !nonnegative(route.numberedSeconds) || !nonnegative(route.numberOnlySeconds) ||
    !Array.isArray(route.coordinates) || !route.coordinates.length || route.coordinates.length > 1_000_000 ||
    !route.coordinates.every(validPoint) || !Array.isArray(route.segments)) return false;
  if (!route.segments.length) return route.coordinates.length === 1 && route.seconds === 0 && route.metres === 0;
  let previousEnd = 0;
  let metres = 0, seconds = 0;
  for (const segment of route.segments) {
    if (!segment || typeof segment.ref !== 'string' || typeof segment.name !== 'string' ||
      !nonnegative(segment.metres) || !nonnegative(segment.seconds) ||
      !Number.isFinite(segment.effectiveMph) || segment.effectiveMph <= 0 ||
      !Number.isFinite(segment.limitMph) || segment.limitMph <= 0 ||
      !Number.isInteger(segment.coordinateStart) || !Number.isInteger(segment.coordinateEnd) ||
      segment.coordinateStart !== previousEnd || segment.coordinateEnd < segment.coordinateStart ||
      segment.coordinateEnd >= route.coordinates.length) return false;
    previousEnd = segment.coordinateEnd;
    metres += segment.metres;
    seconds += segment.seconds;
  }
  const close = (left, right) => Math.abs(left - right) <= Math.max(0.1, Math.abs(right) * 1e-9);
  const modeSeconds = route.mode === 'normal' ? route.normalSeconds :
    route.mode === 'number-only' ? route.numberOnlySeconds : route.numberedSeconds;
  return previousEnd === route.coordinates.length - 1 && close(metres, route.metres) &&
    close(seconds, route.seconds) && close(modeSeconds, route.seconds);
}

/** Validate saved geometry before handing it to map rendering or route labels. */
export function isValidRouteResult(result, expectedRequest) {
  if (!result || !validRoute(result.route) || !validRoute(result.comparison)) return false;
  const primary = result.route.mode;
  const comparison = result.comparison.mode;
  if (primary === 'normal' ? !EXPERIMENTS.has(comparison) : comparison !== 'normal') return false;
  if (!expectedRequest) return true;
  try {
    const { mode, experimentMode } = requestModes(expectedRequest);
    if (primary !== mode || comparison !== (mode === 'normal' ? experimentMode : 'normal')) return false;
    const from = point(expectedRequest.from), to = point(expectedRequest.to);
    for (const route of [result.route, result.comparison]) {
      const first = route.coordinates[0], last = route.coordinates[route.coordinates.length - 1];
      if (distanceMetres(...from, ...first) > 5001 || distanceMetres(...to, ...last) > 5001) return false;
    }
    return true;
  } catch { return false; }
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve) => {
    let request;
    let settled = false;
    const finish = (database) => {
      if (settled) { database?.close(); return; }
      settled = true;
      clearTimeout(timeout);
      resolve(database);
    };
    const timeout = setTimeout(() => finish(null), 1500);
    try { request = globalThis.indexedDB?.open(DATABASE, 1); }
    catch { finish(null); return; }
    if (!request) { finish(null); return; }
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const name of [PAYLOADS, METADATA]) {
        if (!database.objectStoreNames.contains(name)) database.createObjectStore(name, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => { database.close(); databasePromise = undefined; };
      database.onclose = () => { databasePromise = undefined; };
      finish(database);
    };
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
  }).then((database) => { if (!database) databasePromise = undefined; return database; });
  return databasePromise;
}

function transaction(database, stores, mode, work) {
  return new Promise((resolve, reject) => {
    let tx;
    let result;
    let timeout;
    try { tx = database.transaction(stores, mode); }
    catch (error) { reject(error); return; }
    const finish = (error) => { clearTimeout(timeout); error ? reject(error) : resolve(result); };
    tx.oncomplete = () => finish();
    tx.onabort = () => finish(tx.error || new Error('Route-cache transaction aborted.'));
    tx.onerror = () => {};
    timeout = setTimeout(() => { try { tx.abort(); } catch {} finish(new Error('Route-cache transaction timed out.')); }, 2000);
    try { work(tx, (value) => { result = value; }); }
    catch (error) { try { tx.abort(); } catch {} finish(error); }
  });
}

async function removeEntry(database, key) {
  await transaction(database, [PAYLOADS, METADATA], 'readwrite', (tx) => {
    tx.objectStore(PAYLOADS).delete(key);
    tx.objectStore(METADATA).delete(key);
  });
}

export async function readCachedRoute(key) {
  const expected = keyRequest(key);
  if (!expected) return null;
  try {
    const database = await openDatabase();
    if (!database) return null;
    const entry = await transaction(database, [PAYLOADS, METADATA], 'readonly', (tx, setResult) => {
      let payload, metadata;
      const set = () => setResult({ payload, metadata });
      const value = tx.objectStore(PAYLOADS).get(key);
      value.onsuccess = () => { payload = value.result; set(); };
      const info = tx.objectStore(METADATA).get(key);
      info.onsuccess = () => { metadata = info.result; set(); };
    });
    if (!entry?.payload || !entry.metadata || entry.payload.cacheVersion !== CACHE_VERSION ||
      entry.metadata.cacheVersion !== CACHE_VERSION || !Number.isInteger(entry.metadata.bytes) ||
      entry.metadata.bytes <= 0 || entry.metadata.bytes > MAX_BYTES || !isValidRouteResult(entry.payload.result, expected)) {
      if (entry?.payload || entry?.metadata) await removeEntry(database, key).catch(() => {});
      return null;
    }
    await transaction(database, [METADATA], 'readwrite', (tx) => {
      const store = tx.objectStore(METADATA), request = store.get(key);
      request.onsuccess = () => { if (request.result) store.put({ ...request.result, lastUsed: Date.now() }); };
    }).catch(() => {});
    return entry.payload.result;
  } catch { return null; }
}

export async function writeCachedRoute(key, result) {
  const expected = keyRequest(key);
  if (!expected || !isValidRouteResult(result, expected)) return false;
  try {
    const database = await openDatabase();
    if (!database) return false;
    const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength + new TextEncoder().encode(key).byteLength + 128;
    if (bytes > MAX_BYTES) return false;
    await transaction(database, [PAYLOADS, METADATA], 'readwrite', (tx) => {
      const payloads = tx.objectStore(PAYLOADS), metadata = tx.objectStore(METADATA);
      payloads.put({ key, result, cacheVersion: CACHE_VERSION });
      metadata.put({ key, bytes, lastUsed: Date.now(), cacheVersion: CACHE_VERSION });
      const records = metadata.getAll();
      records.onsuccess = () => {
        const entries = records.result.sort((a, b) => (a.key === key ? -1 : b.key === key ? 1 : b.lastUsed - a.lastUsed));
        let count = 0, total = 0;
        for (const entry of entries) {
          const valid = entry.cacheVersion === CACHE_VERSION && Number.isInteger(entry.bytes) && entry.bytes > 0;
          if (!valid || count >= MAX_RESULTS || total + entry.bytes > MAX_BYTES) {
            metadata.delete(entry.key); payloads.delete(entry.key);
          } else { count++; total += entry.bytes; }
        }
      };
    });
    return true;
  } catch { return false; }
}
