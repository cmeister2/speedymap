import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { fetchGzip, GeometryStore, loadGraph } from '../src/routing/loader.js';
import { RoutingEngine } from '../src/routing/engine.js';

test('loads split compressed graph sections and materializes forward/reversed geometry', async () => {
  const arrays = {
    lat: new Int32Array([52000000, 52000000]),
    lon: new Int32Array([0, 1000]),
    offsets: new Uint32Array([0, 1, 2]),
    targets: new Uint32Array([1, 0]),
    lengths: new Float32Array([100, 100]),
    limits: new Uint16Array([600, 600]),
    roads: new Uint32Array([0, 0]),
    geometryRefs: new Uint32Array([0, 0x80000000]),
    flags: new Uint8Array([0, 0]),
  };
  const sections = [];
  let length = 0;
  for (const [name, array] of Object.entries(arrays)) {
    length = Math.ceil(length / array.BYTES_PER_ELEMENT) * array.BYTES_PER_ELEMENT;
    sections.push({ name, type: array.constructor.name.replace('Array', ''), count: array.length, byteOffset: length, byteLength: array.byteLength });
    length += array.byteLength;
  }
  const bytes = Buffer.alloc(length);
  for (const section of sections) bytes.set(new Uint8Array(arrays[section.name].buffer), section.byteOffset);
  const geometry = Buffer.alloc(8 + 3 * 4 + 3 * 8);
  geometry.writeUInt32LE(2, 0);
  geometry.writeUInt32LE(3, 4);
  [0, 2, 3].forEach((value, index) => geometry.writeUInt32LE(value, 8 + index * 4));
  [52000000, 52000000, 52001000].forEach((value, index) => geometry.writeInt32LE(value, 20 + index * 4));
  [0, 1000, 1000].forEach((value, index) => geometry.writeInt32LE(value, 32 + index * 4));
  const manifest = {
    schemaVersion: 1, nodes: 2, edges: 2, geometries: 2, bounds: [0, 52, 0.001, 52], sections,
    generatedAt: '2026-10-04T16:00:00Z',
    graphChunks: [
      { file: 'graph-0.gz', byteOffset: 0, byteLength: 13 },
      { file: 'graph-1.gz', byteOffset: 13, byteLength: length - 13 },
    ],
    roadsFile: 'roads.json.gz', restrictionsFile: 'restrictions.json.gz',
    geometryChunks: [{ file: 'geometry.gz', start: 0, count: 2, byteLength: geometry.byteLength }],
  };
  const files = new Map([
    ['/manifest.json', Buffer.from(JSON.stringify(manifest))],
    ['/graph-0.gz', gzipSync(bytes.subarray(0, 13))],
    ['/graph-1.gz', gzipSync(bytes.subarray(13))],
    ['/roads.json.gz', gzipSync(JSON.stringify([{ ref: 'A47', name: 'Test Road', highway: 'primary' }]))],
    ['/restrictions.json.gz', gzipSync('[]')],
    ['/geometry.gz', gzipSync(geometry)],
    ['/magic.gz', gzipSync(Buffer.from([0x1f, 0x8b, 0, 0]))],
  ]);
  const requests = [];
  let encoded = false;
  const server = createServer((request, response) => {
    requests.push(request.url);
    const pathname = new URL(request.url, 'http://fixture.test').pathname;
    const file = files.get(pathname);
    if (encoded && pathname.endsWith('.gz')) response.setHeader('Content-Encoding', 'gzip');
    response.writeHead(file ? 200 : 404);
    response.end(file || 'Missing fixture');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/manifest.json`;
    const progress = [];
    const loaded = await loadGraph(url, { onProgress: (event) => progress.push(event) });
    assert.deepEqual([...loaded.targets], [1, 0]);
    assert.equal(requests.some((url) => url.startsWith('/geometry.gz')), false, 'geometries must load lazily');
    const engine = new RoutingEngine(loaded);
    const forward = await engine.route([52, 0], [52, 0.001]);
    assert.deepEqual(forward.coordinates, [[52, 0], [52, 0.001]]);
    assert.equal(forward.segments[0].effectiveMph, 47);
    assert.deepEqual([forward.segments[0].coordinateStart, forward.segments[0].coordinateEnd], [0, 1]);
    const reverse = await engine.route([52, 0.001], [52, 0]);
    assert.deepEqual(reverse.coordinates, [[52, 0.001], [52, 0]]);
    assert.deepEqual([reverse.segments[0].coordinateStart, reverse.segments[0].coordinateEnd], [0, 1]);
    assert.equal(requests.filter((path) => path.startsWith('/geometry.gz')).length, 1, 'geometry cache serves repeat routes');
    assert.equal(requests[0], '/manifest.json', 'manifest uses its normal HTTP URL');
    for (const path of requests.slice(1)) {
      assert.equal(new URL(path, 'http://fixture.test').searchParams.get('v'), manifest.generatedAt, path);
    }
    assert.equal(progress.filter((event) => event.stage === 'graph').length, 2);
    encoded = true;
    const httpDecoded = new RoutingEngine(await loadGraph(url));
    const encodedRoute = await httpDecoded.route([52, 0], [52, 0.001]);
    assert.deepEqual(encodedRoute.coordinates, forward.coordinates, 'HTTP gzip decoding is not decompressed twice');
    assert.equal(encodedRoute.seconds, forward.seconds);
    const rawMagic = await fetchGzip(new URL('magic.gz', url), undefined, 4);
    assert.deepEqual([...new Uint8Array(rawMagic)], [0x1f, 0x8b, 0, 0], 'expected binary length prevents a false gzip-magic match after HTTP decoding');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('parallel geometry fetches stay bounded and preserve route order', async () => {
  const store = new GeometryStore(Array.from({ length: 6 }, (_, start) => ({ start, count: 1 })), 'http://fixture.test/manifest.json');
  let active = 0;
  let maximumActive = 0;
  store.chunk = async (index) => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 12 - index));
    active--;
    return { offsets: new Uint32Array([0, 2]), lat: new Int32Array([52000000, 52000000]), lon: new Int32Array([index * 1000, (index + 1) * 1000]) };
  };
  const coordinates = await store.coordinates([0, 1, 2, 3, 4, 5]);
  assert.equal(maximumActive, 4);
  assert.deepEqual(coordinates, Array.from({ length: 7 }, (_, point) => [52, point / 1000]));
});

test('a geometry download failure aborts the rest of the batch', async () => {
  const store = new GeometryStore(Array.from({ length: 8 }, (_, start) => ({ start, count: 1 })), 'http://fixture.test/manifest.json');
  const started = [];
  let active = 0;
  store.chunk = async (index, signal) => {
    started.push(index);
    active++;
    try {
      if (index === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        throw Object.assign(new Error('Missing hashed geometry'), { code: 'DOWNLOAD_FAILED' });
      }
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, 100);
        signal.addEventListener('abort', () => { clearTimeout(timeout); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
      });
    } finally { active--; }
  };
  await assert.rejects(store.coordinates([0, 1, 2, 3, 4, 5, 6, 7]), { code: 'DOWNLOAD_FAILED' });
  assert.equal(active, 0);
  assert.deepEqual(started, [0, 1, 2, 3]);
});

test('inclusive segment ranges follow reversed geometry and deduplicated shared points', async () => {
  const store = new GeometryStore([{ start: 0, count: 3 }], 'http://fixture.test/manifest.json');
  store.chunk = async () => ({
    offsets: new Uint32Array([0, 4, 8, 11]),
    lat: new Int32Array(11).fill(52000000),
    lon: new Int32Array([0, 1000, 1000, 2000, 5000, 4000, 3000, 2000, 5000, 6000, 7000]),
  });
  const refs = [0, 0x80000001, 2];
  const edgeRanges = [];
  const expected = Array.from({ length: 8 }, (_, point) => [52, point / 1000]);
  assert.deepEqual(await store.coordinates(refs, { edgeRanges }), expected);
  assert.deepEqual(edgeRanges, [[0, 2], [2, 5], [5, 7]]);
  assert.deepEqual(await store.coordinates(refs), expected, 'default coordinates API still returns only the array');
  const engine = new RoutingEngine({
    lat: new Int32Array(4).fill(52000000), lon: new Int32Array([0, 2000, 5000, 7000]),
    offsets: new Uint32Array([0, 1, 2, 3, 3]), targets: new Uint32Array([1, 2, 3]),
    lengths: new Float32Array([200, 300, 200]), limits: new Uint16Array([500, 500, 700]),
    roads: new Uint32Array([0, 0, 1]), geometryRefs: new Uint32Array(refs),
    roadMetadata: [{ ref: 'A47', name: 'First Road' }, { ref: 'M1', name: 'Second Road' }],
    geometryStore: store,
  });
  const route = await engine.materialize(await engine.search(0, 3));
  assert.deepEqual(route.coordinates, expected);
  assert.deepEqual(route.segments.map(({ coordinateStart, coordinateEnd, edgeCount }) => ({ coordinateStart, coordinateEnd, edgeCount })), [
    { coordinateStart: 0, coordinateEnd: 5, edgeCount: 2 },
    { coordinateStart: 5, coordinateEnd: 7, edgeCount: 1 },
  ]);
  assert.deepEqual(route.coordinates[route.segments[0].coordinateEnd], route.coordinates[route.segments[1].coordinateStart], 'neighboring roads share one exact junction index');
});
