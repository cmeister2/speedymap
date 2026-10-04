import { MinHeap } from './heap.js';
import { METRES_PER_MPH_SECOND, roadNumber } from './speed.js';
import { distanceMetres, RoutingError, SpatialIndex } from './spatial.js';

const EMPTY = 0xffffffff;
const yieldTask = () => new Promise((resolve) => setTimeout(resolve, 0));

export class RoutingEngine {
  constructor(graph) {
    this.graph = graph;
    const { lat, lon, offsets, targets, lengths, limits, roads, roadMetadata } = graph;
    this.nodeCount = lat.length;
    this.edgeCount = targets.length;
    if (!this.nodeCount || offsets.length !== this.nodeCount + 1 || offsets[this.nodeCount] !== this.edgeCount ||
      lon.length !== this.nodeCount || lengths.length !== this.edgeCount || limits.length !== this.edgeCount || roads.length !== this.edgeCount) {
      throw new RoutingError('INVALID_GRAPH', 'The road database has inconsistent graph sections.');
    }
    this.roadCaps = new Float64Array(roadMetadata.length);
    roadMetadata.forEach((road, index) => { this.roadCaps[index] = roadNumber(road.ref) ?? Infinity; });
    this.maximumSpeeds = { normal: 0, numbered: 0, 'number-only': 0 };
    this.hasIncoming = new Uint8Array(this.nodeCount);
    let hasDestinationAccess = false;
    for (let edge = 0; edge < this.edgeCount; edge++) {
      const speed = limits[edge] / 10;
      if (!(speed > 0) || !(lengths[edge] >= 0) || !Number.isFinite(lengths[edge]) ||
        roads[edge] >= roadMetadata.length || targets[edge] >= this.nodeCount) {
        throw new RoutingError('INVALID_GRAPH', 'The road database contains an invalid edge.');
      }
      this.maximumSpeeds.normal = Math.max(this.maximumSpeeds.normal, speed);
      this.hasIncoming[targets[edge]] = 1;
      this.maximumSpeeds.numbered = Math.max(this.maximumSpeeds.numbered, Math.min(speed, this.roadCaps[roads[edge]]));
      const roadCap = this.roadCaps[roads[edge]];
      this.maximumSpeeds['number-only'] = Math.max(this.maximumSpeeds['number-only'], Number.isFinite(roadCap) ? roadCap : speed);
      if (graph.flags?.[edge] & 2) hasDestinationAccess = true;
    }
    this.destinationComponents = hasDestinationAccess ? this.buildDestinationComponents() : null;
    const forbiddenByIncoming = new Map();
    for (const [incoming, outgoing] of graph.restrictions ?? []) {
      if (!Number.isInteger(incoming) || !Number.isInteger(outgoing) || incoming < 0 || outgoing < 0 || incoming >= this.edgeCount || outgoing >= this.edgeCount) {
        throw new RoutingError('INVALID_GRAPH', 'The road database contains an invalid turn restriction.');
      }
      const via = targets[incoming];
      if (outgoing < offsets[via] || outgoing >= offsets[via + 1]) {
        throw new RoutingError('INVALID_GRAPH', 'A turn restriction does not meet at a road junction.');
      }
      if (!forbiddenByIncoming.has(incoming)) forbiddenByIncoming.set(incoming, new Set());
      forbiddenByIncoming.get(incoming).add(outgoing);
    }
    this.restrictedStates = new Map();
    this.extraNodes = new Uint32Array(forbiddenByIncoming.size);
    this.forbidden = [];
    let extra = 0;
    for (const [incoming, forbidden] of forbiddenByIncoming) {
      this.restrictedStates.set(incoming, this.nodeCount + extra);
      this.extraNodes[extra] = targets[incoming];
      this.forbidden[extra++] = forbidden;
    }
    const stateCount = this.nodeCount + extra;
    this.distances = new Float64Array(stateCount);
    this.generations = new Uint32Array(stateCount);
    this.previousStates = new Uint32Array(stateCount);
    this.previousEdges = new Uint32Array(stateCount);
    this.components = this.buildComponents();
    this.generation = 0;
    this.heap = new MinHeap();
    let bounds = graph.bounds;
    if (!bounds) {
      bounds = [Infinity, Infinity, -Infinity, -Infinity];
      for (let node = 0; node < this.nodeCount; node++) {
        bounds[0] = Math.min(bounds[0], lon[node] / 1e6);
        bounds[1] = Math.min(bounds[1], lat[node] / 1e6);
        bounds[2] = Math.max(bounds[2], lon[node] / 1e6);
        bounds[3] = Math.max(bounds[3], lat[node] / 1e6);
      }
    }
    this.spatial = new SpatialIndex(lat, lon, bounds);
  }

  snap(point, maxDistance) { return this.spatial.nearest(point, maxDistance); }

  buildComponents() {
    const { offsets, targets } = this.graph;
    // Search predecessors are unused until the first route. Reuse their storage
    // as union-find workspace instead of allocating another nationwide array.
    const parents = new Int32Array(this.previousStates.buffer, 0, this.nodeCount);
    parents.fill(-1);
    const root = (node) => {
      let result = node;
      while (parents[result] >= 0) result = parents[result];
      while (node !== result) {
        const next = parents[node];
        parents[node] = result;
        node = next;
      }
      return result;
    };
    for (let node = 0; node < this.nodeCount; node++) {
      for (let edge = offsets[node]; edge < offsets[node + 1]; edge++) {
        let fromRoot = root(node);
        let toRoot = root(targets[edge]);
        if (fromRoot === toRoot) continue;
        if (parents[fromRoot] > parents[toRoot]) {
          const temporary = fromRoot;
          fromRoot = toRoot;
          toRoot = temporary;
        }
        parents[fromRoot] += parents[toRoot];
        parents[toRoot] = fromRoot;
      }
    }
    const components = new Uint32Array(this.nodeCount);
    for (let node = 0; node < this.nodeCount; node++) components[node] = root(node) + 1;
    return components;
  }

  resolveSnaps(from, to, maxDistance = 5000) {
    const start = this.snap(from, maxDistance);
    const destination = this.snap(to, maxDistance);
    const { offsets } = this.graph;
    const startEligible = (node) => offsets[node + 1] > offsets[node];
    const destinationEligible = (node) => Boolean(this.hasIncoming[node]);
    if (start.node === destination.node || (this.components[start.node] === this.components[destination.node] &&
      startEligible(start.node) && destinationEligible(destination.node))) return { start, destination };
    const radius = (snap) => Math.min(maxDistance, Math.max(250, snap.distanceMetres + 250));
    let starts, destinations;
    try {
      starts = this.spatial.candidates(from, radius(start), { limit: 256, components: this.components, eligible: startEligible });
      destinations = this.spatial.candidates(to, radius(destination), { limit: 256, components: this.components, eligible: destinationEligible });
    } catch (error) {
      if (error.code !== 'OFF_NETWORK') throw error;
      throw new RoutingError('NO_ROUTE', 'No usable road entry or exit was found near one of these places. Choose a nearby road pin.');
    }
    const byComponent = new Map(destinations.map((snap) => [this.components[snap.node], snap]));
    let best = null;
    let bestDistance = Infinity;
    for (const candidate of starts) {
      const target = byComponent.get(this.components[candidate.node]);
      if (!target) continue;
      const distance = candidate.distanceMetres + target.distanceMetres;
      if (distance < bestDistance) { best = { start: candidate, destination: target }; bestDistance = distance; }
    }
    if (best) return best;
    throw new RoutingError('NO_ROUTE', 'These places are not connected by the drivable road database. Islands and excluded ferry crossings may have separate networks.');
  }

  buildDestinationComponents() {
    const { offsets, targets, flags } = this.graph;
    const components = new Uint32Array(this.nodeCount);
    const root = (node) => {
      let result = node;
      while (components[result] !== result + 1) result = components[result] - 1;
      while (node !== result) {
        const next = components[node] - 1;
        components[node] = result + 1;
        node = next;
      }
      return result;
    };
    for (let node = 0; node < this.nodeCount; node++) {
      for (let edge = offsets[node]; edge < offsets[node + 1]; edge++) {
        if (!(flags[edge] & 2)) continue;
        const target = targets[edge];
        if (!components[node]) components[node] = node + 1;
        if (!components[target]) components[target] = target + 1;
        const fromRoot = root(node);
        const toRoot = root(target);
        if (fromRoot !== toRoot) components[Math.max(fromRoot, toRoot)] = Math.min(fromRoot, toRoot) + 1;
      }
    }
    for (let node = 0; node < this.nodeCount; node++) if (components[node]) components[node] = root(node) + 1;
    return components;
  }

  /** Directed A*, with distinct arrival states only where a turn is restricted. */
  async search(start, destination, { mode = 'numbered', signal, onProgress, yieldEvery = 8192 } = {}) {
    if (mode !== 'numbered' && mode !== 'number-only' && mode !== 'normal') throw new RoutingError('INVALID_MODE', 'Choose capped road numbers, exact road numbers or normal speed limits.');
    if (!Number.isInteger(start) || !Number.isInteger(destination) || start < 0 || destination < 0 || start >= this.nodeCount || destination >= this.nodeCount) {
      throw new RoutingError('INVALID_POINT', 'A snapped place is outside the road database.');
    }
    if (signal?.aborted) throw new RoutingError('CANCELLED', 'Route calculation cancelled.');
    if (start === destination) return { edges: [], nodes: [start], seconds: 0, metres: 0, visited: 0, mode };
    this.generation = (this.generation + 1) >>> 0;
    if (!this.generation) { this.generations.fill(0); this.generation = 1; }
    const generation = this.generation;
    const { lat, lon, offsets, targets, lengths, limits, roads, flags } = this.graph;
    const destinationAllowed = new Set(this.destinationComponents
      ? [this.destinationComponents[start], this.destinationComponents[destination]] : []);
    const maxMetresPerSecond = this.maximumSpeeds[mode] * METRES_PER_MPH_SECOND;
    const goalLat = lat[destination] / 1e6;
    const goalLng = lon[destination] / 1e6;
    // Leave a small margin for float32 length rounding in the stored graph.
    const heuristic = (node) => distanceMetres(lat[node] / 1e6, lon[node] / 1e6, goalLat, goalLng) * 0.99999 / maxMetresPerSecond;
    this.heap.clear();
    this.generations[start] = generation;
    this.distances[start] = 0;
    this.previousStates[start] = EMPTY;
    this.previousEdges[start] = EMPTY;
    this.heap.push(start, heuristic(start), 0);
    let visited = 0;
    let finalState = -1;
    while (this.heap.size) {
      const { id: state, cost } = this.heap.pop();
      if (this.generations[state] !== generation || this.distances[state] !== cost) continue;
      const extra = state - this.nodeCount;
      const node = extra >= 0 ? this.extraNodes[extra] : state;
      if (node === destination) { finalState = state; break; }
      const forbidden = extra >= 0 ? this.forbidden[extra] : null;
      for (let edge = offsets[node]; edge < offsets[node + 1]; edge++) {
        if (forbidden?.has(edge)) continue;
        const target = targets[edge];
        if ((flags?.[edge] & 2) && !destinationAllowed.has(this.destinationComponents[target])) continue;
        const nextState = this.restrictedStates.get(edge) ?? target;
        const limit = limits[edge] / 10;
        const roadCap = this.roadCaps[roads[edge]];
        const speed = mode === 'normal' ? limit : mode === 'number-only'
          ? (Number.isFinite(roadCap) ? roadCap : limit) : Math.min(limit, roadCap);
        const candidate = cost + lengths[edge] / (speed * METRES_PER_MPH_SECOND);
        if (this.generations[nextState] === generation && candidate >= this.distances[nextState]) continue;
        this.generations[nextState] = generation;
        this.distances[nextState] = candidate;
        this.previousStates[nextState] = state;
        this.previousEdges[nextState] = edge;
        this.heap.push(nextState, candidate + heuristic(target), candidate);
      }
      visited++;
      if (yieldEvery > 0 && visited % yieldEvery === 0) {
        onProgress?.({ stage: 'routing', visited, message: `Searching roads (${visited.toLocaleString()} junctions)…` });
        await yieldTask();
        if (signal?.aborted) throw new RoutingError('CANCELLED', 'Route calculation cancelled.');
      }
    }
    if (finalState < 0) throw new RoutingError('NO_ROUTE', 'These places are not connected by the drivable road database. Islands and excluded ferry crossings may have separate networks.');
    const edges = [];
    const nodes = [destination];
    let state = finalState;
    let metres = 0;
    while (this.previousStates[state] !== EMPTY) {
      const edge = this.previousEdges[state];
      edges.push(edge);
      metres += lengths[edge];
      state = this.previousStates[state];
      nodes.push(state >= this.nodeCount ? this.extraNodes[state - this.nodeCount] : state);
    }
    edges.reverse(); nodes.reverse();
    return { edges, nodes, seconds: this.distances[finalState], metres, visited, mode };
  }

  breakdown(path) {
    const { lengths, limits, roads, flags, roadMetadata } = this.graph;
    const segments = [];
    let normalSeconds = 0;
    let numberedSeconds = 0;
    let numberOnlySeconds = 0;
    for (const edge of path.edges) {
      const roadIndex = roads[edge];
      const road = roadMetadata[roadIndex];
      const limitMph = limits[edge] / 10;
      const numberedMph = Math.min(limitMph, this.roadCaps[roadIndex]);
      const roadCap = this.roadCaps[roadIndex];
      const numberOnlyMph = Number.isFinite(roadCap) ? roadCap : limitMph;
      const effectiveMph = path.mode === 'normal' ? limitMph : path.mode === 'number-only' ? numberOnlyMph : numberedMph;
      const seconds = lengths[edge] / (effectiveMph * METRES_PER_MPH_SECOND);
      normalSeconds += lengths[edge] / (limitMph * METRES_PER_MPH_SECOND);
      numberedSeconds += lengths[edge] / (numberedMph * METRES_PER_MPH_SECOND);
      numberOnlySeconds += lengths[edge] / (numberOnlyMph * METRES_PER_MPH_SECOND);
      const inferredLimit = Boolean(flags?.[edge] & 1);
      const previous = segments[segments.length - 1];
      if (previous && previous.roadIndex === roadIndex && previous.limitMph === limitMph && previous.inferredLimit === inferredLimit) {
        previous.metres += lengths[edge];
        previous.seconds += seconds;
        previous.edgeCount++;
      } else {
        segments.push({ roadIndex, ref: road.ref || '', name: road.name || '', highway: road.highway || '',
          metres: lengths[edge], seconds, limitMph, effectiveMph, numberedMph, numberOnlyMph, roadNumber: roadNumber(road.ref), inferredLimit, edgeCount: 1 });
      }
    }
    return { segments, normalSeconds, numberedSeconds, numberOnlySeconds };
  }

  async materialize(path, { signal, onProgress } = {}) {
    const { lat, lon, geometryRefs, geometryStore } = this.graph;
    let coordinates;
    const edgeRanges = [];
    if (geometryStore && path.edges.length) {
      coordinates = await geometryStore.coordinates(path.edges.map((edge) => geometryRefs[edge]), { signal, onProgress, edgeRanges });
    } else {
      coordinates = path.nodes.map((node) => [lat[node] / 1e6, lon[node] / 1e6]);
      for (let edge = 0; edge < path.edges.length; edge++) edgeRanges.push([edge, edge + 1]);
    }
    const breakdown = this.breakdown(path);
    let edgeOffset = 0;
    for (const segment of breakdown.segments) {
      segment.coordinateStart = edgeRanges[edgeOffset][0];
      segment.coordinateEnd = edgeRanges[edgeOffset + segment.edgeCount - 1][1];
      edgeOffset += segment.edgeCount;
    }
    return { coordinates, seconds: path.seconds, metres: path.metres, visited: path.visited, mode: path.mode, ...breakdown };
  }

  async route(from, to, options = {}) {
    const { start, destination } = this.resolveSnaps(from, to, options.maxSnapDistance);
    const path = await this.search(start.node, destination.node, options);
    const route = await this.materialize(path, options);
    route.snap = { from: start, to: destination };
    return route;
  }
}
