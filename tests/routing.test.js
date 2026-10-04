import test from 'node:test';
import assert from 'node:assert/strict';
import { RoutingEngine } from '../src/routing/engine.js';
import { effectiveSpeed, METRES_PER_MPH_SECOND, roadNumber } from '../src/routing/speed.js';
import { distanceMetres } from '../src/routing/spatial.js';
import { MinHeap } from '../src/routing/heap.js';

function graph(nodes, edges, restrictions = []) {
  const sorted = edges.map((edge, original) => ({ ...edge, original })).sort((a, b) => a.from - b.from);
  const edgeIds = new Map(sorted.map((edge, index) => [edge.original, index]));
  const offsets = new Uint32Array(nodes.length + 1);
  for (const edge of sorted) offsets[edge.from + 1]++;
  for (let node = 1; node < offsets.length; node++) offsets[node] += offsets[node - 1];
  return {
    lat: Int32Array.from(nodes, (node) => Math.round(node[0] * 1e6)),
    lon: Int32Array.from(nodes, (node) => Math.round(node[1] * 1e6)),
    offsets,
    targets: Uint32Array.from(sorted, (edge) => edge.to),
    lengths: Float32Array.from(sorted, (edge) => edge.length ?? 100),
    limits: Uint16Array.from(sorted, (edge) => (edge.limit ?? 60) * 10),
    roads: Uint32Array.from(sorted, (_, index) => index),
    flags: Uint8Array.from(sorted, (edge) => edge.flags ?? 0),
    geometryRefs: new Uint32Array(edges.length),
    roadMetadata: sorted.map((edge) => ({ ref: edge.ref ?? '', name: edge.name ?? '', highway: 'primary' })),
    restrictions: restrictions.map(([incoming, outgoing]) => [edgeIds.get(incoming), edgeIds.get(outgoing)]),
  };
}

const nodes = [[52, 0], [52, 0.001], [52.001, 0], [52.001, 0.001]];

test('recognises motorway suffixes and the smallest recognised shared reference', () => {
  for (const [ref, expected] of [['A47', 47], ['M1', 1], ['A1(M)', 1], ['M6 Toll', 6], ['m6 toll', 6], ['a 47', 47], ['B6047', 6047], ['C12', 12], ['U12', 12], ['C1K', 1], ['C125n', 125], ['C127C', 127], ['U12A', 12], ['A47; M1', 1], ['local;B10;A47', 10]]) {
    assert.equal(roadNumber(ref), expected, ref);
  }
  for (const ref of ['', 'High Street', 'E15', 'A47 slip road', 'C1Main', 'U12AB', 'A0', null]) assert.equal(roadNumber(ref), null, String(ref));
});

test('caps high numbered roads at their limit and keeps unnumbered roads at their limit', () => {
  assert.equal(effectiveSpeed(60, 'A47'), 47);
  assert.equal(effectiveSpeed(70, 'M1'), 1);
  assert.equal(effectiveSpeed(70, 'M6 Toll'), 6);
  assert.equal(effectiveSpeed(60, 'C1K'), 1);
  assert.equal(effectiveSpeed(40, 'B6047'), 40);
  assert.equal(effectiveSpeed(30, ''), 30);
  assert.equal(effectiveSpeed(70, 'M1', 'normal'), 70);
  assert.equal(effectiveSpeed(30, 'A1000', 'number-only'), 1000);
  assert.equal(effectiveSpeed(70, 'M1', 'number-only'), 1);
  assert.equal(effectiveSpeed(30, '', 'number-only'), 30);
  assert.equal(effectiveSpeed(40, 'Unknown Road 1000', 'number-only'), 40);
  assert.throws(() => effectiveSpeed(0, 'A47'), RangeError);
});

test('numbered-road routing takes smaller roads instead of the normally fastest M1', async () => {
  const engine = new RoutingEngine(graph(nodes.slice(0, 3), [
    { from: 0, to: 1, length: 1000, limit: 70, ref: 'M1' },
    { from: 0, to: 2, length: 800, limit: 60, name: 'Mill Lane' },
    { from: 2, to: 1, length: 800, limit: 60, name: 'Church Lane' },
  ]));
  const normal = await engine.search(0, 1, { mode: 'normal' });
  const numbered = await engine.search(0, 1);
  assert.deepEqual(normal.nodes, [0, 1]);
  assert.deepEqual(numbered.nodes, [0, 2, 1]);
  assert.equal(normal.metres, 1000);
  assert.equal(numbered.metres, 1600);
  assert.ok(Math.abs(numbered.seconds - 1600 / (60 * METRES_PER_MPH_SECOND)) < 1e-9);
  const materialized = await engine.materialize(normal);
  assert.equal(materialized.segments[0].effectiveMph, 70);
  assert.equal(materialized.segments[0].numberedMph, 1);
  assert.ok(materialized.numberedSeconds > materialized.normalSeconds * 69.9);
});

test('directed edges enforce one-way roads', async () => {
  const engine = new RoutingEngine(graph(nodes.slice(0, 2), [{ from: 0, to: 1, ref: 'A47' }]));
  assert.deepEqual((await engine.search(0, 1)).nodes, [0, 1]);
  await assert.rejects(engine.search(1, 0), { code: 'NO_ROUTE' });
});

test('turn restrictions retain a slower permitted arrival at the same junction', async () => {
  const engine = new RoutingEngine(graph(nodes, [
    { from: 0, to: 1, length: 100 },
    { from: 0, to: 3, length: 300 },
    { from: 3, to: 1, length: 150 },
    { from: 1, to: 2, length: 150 },
  ], [[0, 3]]));
  const route = await engine.search(0, 2);
  assert.deepEqual(route.nodes, [0, 3, 1, 2]);
  assert.equal(route.metres, 600);
});

test('turn restrictions can make an otherwise connected destination unreachable', async () => {
  const engine = new RoutingEngine(graph(nodes.slice(0, 3), [
    { from: 0, to: 1 }, { from: 1, to: 2, length: 150 },
  ], [[0, 1]]));
  await assert.rejects(engine.search(0, 2), { code: 'NO_ROUTE' });
});

test('destination-only roads cannot form a shortcut but remain available to their endpoints', async () => {
  const engine = new RoutingEngine(graph(nodes, [
    { from: 0, to: 3, length: 1000 },
    { from: 0, to: 1, length: 100 },
    { from: 1, to: 2, length: 150, flags: 2 },
    { from: 2, to: 3, length: 100 },
  ]));
  assert.deepEqual((await engine.search(0, 3)).nodes, [0, 3]);
  assert.deepEqual((await engine.search(1, 3)).nodes, [1, 2, 3]);
  assert.deepEqual((await engine.search(0, 2)).nodes, [0, 1, 2]);
  assert.deepEqual((await engine.search(0, 3, { mode: 'normal' })).nodes, [0, 3]);
});

test('same node produces a zero-length route and disconnected networks give an explicit error', async () => {
  const engine = new RoutingEngine(graph(nodes, [{ from: 0, to: 1 }, { from: 2, to: 3 }]));
  const same = await engine.search(2, 2);
  assert.equal(same.seconds, 0);
  assert.equal(same.metres, 0);
  assert.deepEqual(same.edges, []);
  await assert.rejects(engine.search(0, 3), { code: 'NO_ROUTE' });
});

test('snaps to nearest road node and reports the actual snap distance', async () => {
  const engine = new RoutingEngine(graph(nodes.slice(0, 2), [{ from: 0, to: 1, flags: 1 }]));
  const from = [52.0001, 0];
  const route = await engine.route(from, nodes[1]);
  assert.equal(route.snap.from.node, 0);
  assert.ok(Math.abs(route.snap.from.distanceMetres - distanceMetres(...from, ...nodes[0])) < 1e-6);
  assert.deepEqual(route.snap.from.coordinate, nodes[0]);
  assert.equal(route.segments[0].inferredLimit, true);
  assert.deepEqual([route.segments[0].coordinateStart, route.segments[0].coordinateEnd], [0, 1]);
  assert.deepEqual(route.coordinates, nodes.slice(0, 2));
  assert.throws(() => engine.snap([55, -5]), { code: 'OFF_NETWORK' });
  assert.throws(() => engine.snap([NaN, 0]), { code: 'INVALID_POINT' });
});

test('cancellation stops a route search', async () => {
  const engine = new RoutingEngine(graph(nodes.slice(0, 2), [{ from: 0, to: 1 }]));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(engine.search(0, 1, { signal: controller.signal }), { code: 'CANCELLED' });
});

test('heap preserves ordering through growth and stale candidate entries', () => {
  const heap = new MinHeap(2);
  for (let id = 99; id >= 0; id--) heap.push(id, id / 3, id * 2);
  for (let id = 0; id < 100; id++) assert.deepEqual(heap.pop(), { id, priority: id / 3, cost: id * 2 });
  assert.equal(heap.pop(), null);
});

test('A* agrees with an independent full incoming-edge Dijkstra across varied restricted networks', async () => {
  let seed = 73421;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  const references = ['', 'M1', 'A47', 'B1234', 'C3'];
  const caps = { '': Infinity, M1: 1, A47: 47, B1234: 1234, C3: 3 };
  const oracle = (input, mode) => {
    const count = input.targets.length;
    const costs = new Float64Array(count + 1).fill(Infinity);
    const settled = new Uint8Array(count + 1);
    const forbidden = new Set(input.restrictions.map((pair) => pair.join(',')));
    costs[count] = 0;
    for (let step = 0; step <= count; step++) {
      let incoming = -1;
      for (let state = 0; state <= count; state++) {
        if (!settled[state] && (incoming < 0 || costs[state] < costs[incoming])) incoming = state;
      }
      if (incoming < 0 || !Number.isFinite(costs[incoming])) return Infinity;
      const node = incoming === count ? 0 : input.targets[incoming];
      if (node === input.lat.length - 1) return costs[incoming];
      settled[incoming] = 1;
      for (let edge = input.offsets[node]; edge < input.offsets[node + 1]; edge++) {
        if (forbidden.has(`${incoming},${edge}`)) continue;
        const limit = input.limits[edge] / 10;
        const cap = caps[input.roadMetadata[input.roads[edge]].ref];
        const speed = mode === 'normal' ? limit : mode === 'number-only'
          ? (Number.isFinite(cap) ? cap : limit) : Math.min(limit, cap);
        costs[edge] = Math.min(costs[edge], costs[incoming] + input.lengths[edge] / (speed * 0.44704));
      }
    }
    return Infinity;
  };
  for (let sample = 0; sample < 30; sample++) {
    const points = Array.from({ length: 12 }, (_, node) => [52 + Math.floor(node / 4) * 0.001, (node % 4) * 0.001]);
    const edges = [];
    for (let from = 0; from < points.length; from++) {
      for (let to = 0; to < points.length; to++) {
        if (from === to || (to !== (from + 1) % points.length && random() > 0.17)) continue;
        edges.push({ from, to, length: distanceMetres(...points[from], ...points[to]) * 1.01 + random() * 200,
          limit: [30, 40, 60, 70][Math.floor(random() * 4)], ref: references[Math.floor(random() * references.length)] });
      }
    }
    const restrictions = [];
    for (let incoming = 0; incoming < edges.length; incoming++) {
      if (random() > 0.4) continue;
      const outgoing = edges.findIndex((edge) => edge.from === edges[incoming].to);
      if (outgoing >= 0) restrictions.push([incoming, outgoing]);
    }
    const input = graph(points, edges, restrictions);
    const engine = new RoutingEngine(input);
    for (const mode of ['normal', 'numbered', 'number-only']) {
      const expected = oracle(input, mode);
      if (!Number.isFinite(expected)) await assert.rejects(engine.search(0, points.length - 1, { mode }), { code: 'NO_ROUTE' });
      else assert.ok(Math.abs((await engine.search(0, points.length - 1, { mode })).seconds - expected) < 1e-7, `sample ${sample}, ${mode}`);
    }
  }
});

test('cancelling during yielded search leaves the engine reusable', async () => {
  const points = Array.from({ length: 100 }, (_, node) => [52, node * 0.001]);
  const engine = new RoutingEngine(graph(points, points.slice(1).map((_, from) => ({ from, to: from + 1 }))));
  const controller = new AbortController();
  await assert.rejects(engine.search(0, 99, { signal: controller.signal, yieldEvery: 10, onProgress: () => controller.abort() }), { code: 'CANCELLED' });
  assert.equal((await engine.search(0, 99)).metres, 9900);
});

test('snaps past a disconnected service-road island to the nearest connected local road', async () => {
  const points = [[52, 0], [52, 0.001], [52, 0.0011], [52.0001, 0.0011]];
  const engine = new RoutingEngine(graph(points, [
    { from: 0, to: 1 }, { from: 1, to: 0 },
    { from: 2, to: 3 }, { from: 3, to: 2 },
  ]));
  assert.equal(engine.snap(points[2]).node, 2, 'geometrically nearest node stays available');
  const route = await engine.route(points[0], points[2]);
  assert.equal(route.snap.from.node, 0);
  assert.equal(route.snap.to.node, 1, 'route resolves the nearest reachable local component');
  assert.ok(route.snap.to.distanceMetres > 6 && route.snap.to.distanceMetres < 8);
  const inverse = await engine.route(points[2], points[0]);
  assert.equal(inverse.snap.from.node, 1);
  assert.equal(inverse.snap.to.node, 0);
  const local = await engine.route(points[2], points[3]);
  assert.equal(local.snap.from.node, 2, 'routing wholly inside a small network is retained');
  assert.equal(local.snap.to.node, 3);
});

test('separate distant components fail before attempting a nationwide route search', async () => {
  const points = [[52, 0], [52, 0.001], [54, 1], [54, 1.001]];
  const engine = new RoutingEngine(graph(points, [{ from: 0, to: 1 }, { from: 2, to: 3 }]));
  await assert.rejects(engine.route(points[0], points[2]), { code: 'NO_ROUTE' });
  assert.equal(engine.generation, 0, 'no search is needed when nearby components cannot join');
});

test('fallback graph-node geometry provides inclusive ranges for each road section', async () => {
  const engine = new RoutingEngine(graph(nodes, [{ from: 0, to: 1 }, { from: 1, to: 2, length: 150 }, { from: 2, to: 3 }]));
  const route = await engine.materialize(await engine.search(0, 3));
  assert.deepEqual(route.coordinates, nodes);
  assert.deepEqual(route.segments.map(({ coordinateStart, coordinateEnd }) => [coordinateStart, coordinateEnd]), [[0, 1], [1, 2], [2, 3]]);
  const same = await engine.materialize(await engine.search(0, 0));
  assert.deepEqual(same.coordinates, [nodes[0]]);
  assert.deepEqual(same.segments, []);
});

test('directional snapping retains valid one-way endpoints and same-node trips', async () => {
  const points = [[52, 0], [52, 0.01], [52, 0.02]];
  const engine = new RoutingEngine(graph(points, [{ from: 0, to: 1, length: 800 }, { from: 1, to: 2, length: 800 }]));
  const valid = await engine.route(points[0], points[2]);
  assert.equal(valid.snap.from.node, 0, 'a node without incoming edges is a valid start');
  assert.equal(valid.snap.to.node, 2, 'a node without outgoing edges is a valid destination');
  await assert.rejects(engine.route(points[1], points[0]), { code: 'NO_ROUTE' }, 'source-only node cannot be a destination');
  await assert.rejects(engine.route(points[2], points[1]), { code: 'NO_ROUTE' }, 'sink-only node cannot be a start');
  assert.equal((await engine.route(points[0], points[0])).seconds, 0);
  assert.equal((await engine.route(points[2], points[2])).seconds, 0);
});

test('direction eligibility is checked before selecting the nearest candidate in each component', async () => {
  const points = [[52, 0], [52, 0.001], [52, 0.0011]];
  const engine = new RoutingEngine(graph(points, [{ from: 0, to: 2 }, { from: 1, to: 2 }]));
  const route = await engine.route(points[0], points[1]);
  assert.equal(engine.snap(points[1]).node, 1);
  assert.equal(route.snap.to.node, 2, 'slightly farther node in the same component has an incoming road');
  assert.ok(route.snap.to.distanceMetres > 6 && route.snap.to.distanceMetres < 8);
});

test('exact road-number speeds can exceed limits and choose a different fastest route', async () => {
  const engine = new RoutingEngine(graph(nodes.slice(0, 3), [
    { from: 0, to: 1, length: 1000, limit: 30, ref: 'A1000' },
    { from: 0, to: 2, length: 150, limit: 60, ref: 'A60' },
    { from: 2, to: 1, length: 150, limit: 60, ref: 'A60' },
  ]));
  assert.deepEqual((await engine.search(0, 1, { mode: 'normal' })).nodes, [0, 2, 1]);
  assert.deepEqual((await engine.search(0, 1, { mode: 'numbered' })).nodes, [0, 2, 1]);
  const path = await engine.search(0, 1, { mode: 'number-only' });
  assert.deepEqual(path.nodes, [0, 1]);
  assert.ok(Math.abs(path.seconds - 1000 / (1000 * METRES_PER_MPH_SECOND)) < 1e-10);
  const route = await engine.materialize(path);
  assert.equal(route.mode, 'number-only');
  assert.equal(route.segments[0].effectiveMph, 1000);
  assert.equal(route.segments[0].limitMph, 30);
  assert.equal(route.segments[0].numberedMph, 30);
  assert.equal(route.segments[0].numberOnlyMph, 1000);
  assert.equal(route.seconds, route.numberOnlySeconds);
  assert.equal(route.normalSeconds, route.numberedSeconds);
  assert.ok(route.numberedSeconds > route.numberOnlySeconds * 33);
  assert.equal(engine.maximumSpeeds['number-only'], 1000);
});

test('exact-number mode preserves the road integer rather than rounding through float32', async () => {
  const number = 16777217;
  const engine = new RoutingEngine(graph(nodes.slice(0, 2), [{ from: 0, to: 1, length: 100, ref: `A${number}`, limit: 30 }]));
  const route = await engine.materialize(await engine.search(0, 1, { mode: 'number-only' }));
  assert.equal(route.segments[0].effectiveMph, number);
  assert.equal(engine.maximumSpeeds['number-only'], number);
  assert.equal(route.seconds, 100 / (number * METRES_PER_MPH_SECOND));
});
