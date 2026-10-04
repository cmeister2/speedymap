import { RoutingError } from './spatial.js';

const ARRAY_TYPES = {
  i32: Int32Array, u32: Uint32Array, f32: Float32Array, u16: Uint16Array, u8: Uint8Array,
  Int32: Int32Array, Uint32: Uint32Array, Float32: Float32Array, Uint16: Uint16Array, Uint8: Uint8Array,
};

function checkAbort(signal) {
  if (signal?.aborted) throw new RoutingError('CANCELLED', 'Route calculation cancelled.');
}

async function fetchResponse(url, signal, options = {}) {
  checkAbort(signal);
  const response = await fetch(url, { signal, ...options });
  if (!response.ok) throw new RoutingError('DOWNLOAD_FAILED', response.status === 404
    ? 'A road database file is unavailable (404). The data may have been updated; reload the page to load the current version.'
    : `Could not download the road database (${response.status}). Check the data files and try again.`);
  return response;
}

export async function fetchGzip(url, signal, expectedByteLength) {
  const response = await fetchResponse(url, signal);
  const bytes = await response.arrayBuffer();
  checkAbort(signal);
  const prefix = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 2));
  const isGzip = prefix.length === 2 && prefix[0] === 0x1f && prefix[1] === 0x8b;
  const httpDecoded = response.headers.get('content-encoding')?.split(',').some((encoding) => encoding.trim().toLowerCase() === 'gzip');
  // Fetch already decodes Content-Encoding:gzip (including Vite previews).
  // Length also disambiguates raw graph coordinates starting with gzip magic.
  if (!isGzip || (httpDecoded && expectedByteLength !== undefined && bytes.byteLength === expectedByteLength)) return bytes;
  if (typeof DecompressionStream === 'undefined') throw new RoutingError('UNSUPPORTED_BROWSER', 'This browser cannot decompress the road database. Use a current version of Chrome, Firefox, Edge or Safari.');
  const inflated = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  checkAbort(signal);
  return inflated;
}

export async function fetchGzipJson(url, signal) {
  return JSON.parse(new TextDecoder().decode(await fetchGzip(url, signal)));
}

export function versionedAssetUrl(file, manifestUrl, version) {
  const url = new URL(file, manifestUrl);
  if (version !== undefined && version !== null) url.searchParams.set('v', String(version));
  return url;
}

function validateSection(section, buffer) {
  const Type = ARRAY_TYPES[section.type];
  if (!Type || !Number.isInteger(section.count) || section.count < 0 ||
    !Number.isInteger(section.byteOffset) || section.byteOffset < 0 ||
    section.byteLength !== section.count * Type.BYTES_PER_ELEMENT ||
    section.byteOffset % Type.BYTES_PER_ELEMENT !== 0 || section.byteOffset + section.byteLength > buffer.byteLength) {
    throw new RoutingError('INVALID_GRAPH', 'The road database manifest contains an invalid section.');
  }
  return new Type(buffer, section.byteOffset, section.count);
}

export async function loadGraph(manifestUrl, { signal, onProgress } = {}) {
  const url = new URL(manifestUrl, globalThis.location?.href ?? 'http://localhost/');
  onProgress?.({ stage: 'manifest', progress: 0, message: 'Reading the road database manifest…' });
  const manifest = await (await fetchResponse(url, signal, { cache: 'no-cache' })).json();
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.sections) || !Array.isArray(manifest.graphChunks) || !manifest.graphChunks.length) {
    throw new RoutingError('INVALID_GRAPH', 'This road database format is not supported. Rebuild the data with the current importer.');
  }
  // These arrays are written little-endian by the importer.
  if (new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] !== 4) {
    throw new RoutingError('UNSUPPORTED_BROWSER', 'This platform has an unsupported binary byte order.');
  }
  let byteLength = 0;
  let expectedOffset = 0;
  for (const chunk of manifest.graphChunks) {
    if (chunk.byteOffset !== expectedOffset || !Number.isInteger(chunk.byteLength) || chunk.byteLength <= 0 || typeof chunk.file !== 'string') {
      throw new RoutingError('INVALID_GRAPH', 'The road database manifest has missing or overlapping chunks.');
    }
    expectedOffset += chunk.byteLength;
    byteLength = expectedOffset;
  }
  const version = manifest.generatedAt || `${manifest.sourceDate || 'unknown'}-${manifest.dataBytes ?? byteLength}`;
  let buffer;
  try { buffer = new ArrayBuffer(byteLength); }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new RoutingError('MEMORY_LIMIT', 'The nationwide road database does not fit in this device’s memory. Try a desktop browser with more available memory.');
  }
  const destination = new Uint8Array(buffer);
  for (let index = 0; index < manifest.graphChunks.length; index++) {
    const chunk = manifest.graphChunks[index];
    const bytes = await fetchGzip(versionedAssetUrl(chunk.file, url, version), signal, chunk.byteLength);
    if (bytes.byteLength !== chunk.byteLength) throw new RoutingError('INVALID_GRAPH', 'A downloaded road database chunk has the wrong size.');
    destination.set(new Uint8Array(bytes), chunk.byteOffset);
    onProgress?.({ stage: 'graph', progress: (index + 1) / manifest.graphChunks.length * 0.9,
      loadedBytes: chunk.byteOffset + chunk.byteLength, totalBytes: byteLength,
      message: `Loading road graph (${index + 1}/${manifest.graphChunks.length})…` });
  }
  const graph = {};
  for (const section of manifest.sections) graph[section.name] = validateSection(section, buffer);
  for (const name of ['lat', 'lon', 'offsets', 'targets', 'lengths', 'limits', 'roads', 'geometryRefs']) {
    if (!graph[name]) throw new RoutingError('INVALID_GRAPH', `The road database is missing its ${name} section.`);
  }
  onProgress?.({ stage: 'metadata', progress: 0.93, message: 'Loading road names and turn restrictions…' });
  const metadata = await Promise.allSettled([
    fetchGzipJson(versionedAssetUrl(manifest.roadsFile, url, version), signal),
    manifest.restrictionsFile ? fetchGzipJson(versionedAssetUrl(manifest.restrictionsFile, url, version), signal) : Promise.resolve([]),
  ]);
  for (const result of metadata) if (result.status === 'rejected') throw result.reason;
  graph.roadMetadata = metadata[0].value;
  graph.restrictions = metadata[1].value;
  graph.bounds = manifest.bounds;
  graph.manifest = manifest;
  graph.geometryStore = new GeometryStore(manifest.geometryChunks ?? [], url, 64 * 1024 * 1024, version);
  onProgress?.({ stage: 'index', progress: 0.97, message: 'Indexing places near roads…' });
  return graph;
}

export class GeometryStore {
  constructor(chunks, manifestUrl, maxCacheBytes = 64 * 1024 * 1024, version) {
    this.chunks = chunks;
    this.manifestUrl = manifestUrl;
    this.cache = new Map();
    this.cacheBytes = 0;
    this.maxCacheBytes = maxCacheBytes;
    this.version = version;
  }

  chunkIndex(id) {
    let lower = 0;
    let upper = this.chunks.length - 1;
    while (lower <= upper) {
      const index = (lower + upper) >>> 1;
      const chunk = this.chunks[index];
      if (id < chunk.start) upper = index - 1;
      else if (id >= chunk.start + chunk.count) lower = index + 1;
      else return index;
    }
    throw new RoutingError('INVALID_GRAPH', 'A route refers to missing road geometry.');
  }

  async chunk(index, signal) {
    if (this.cache.has(index)) {
      const cached = this.cache.get(index);
      this.cache.delete(index); this.cache.set(index, cached);
      return cached;
    }
    const chunk = this.chunks[index];
    const buffer = await fetchGzip(versionedAssetUrl(chunk.file, this.manifestUrl, this.version), signal, chunk.byteLength);
    const header = new DataView(buffer);
    if (buffer.byteLength < 8) throw new RoutingError('INVALID_GRAPH', 'A road geometry chunk is incomplete.');
    const count = header.getUint32(0, true);
    const pointCount = header.getUint32(4, true);
    const expectedBytes = 8 + (count + 1) * 4 + pointCount * 8;
    if (count !== chunk.count || expectedBytes !== buffer.byteLength || (chunk.byteLength && chunk.byteLength !== buffer.byteLength)) {
      throw new RoutingError('INVALID_GRAPH', 'A road geometry chunk has the wrong size.');
    }
    const offsets = new Uint32Array(buffer, 8, count + 1);
    const lat = new Int32Array(buffer, 8 + (count + 1) * 4, pointCount);
    const lon = new Int32Array(buffer, 8 + (count + 1) * 4 + pointCount * 4, pointCount);
    if (offsets[count] !== pointCount) throw new RoutingError('INVALID_GRAPH', 'A road geometry index is incomplete.');
    const parsed = { offsets, lat, lon, bytes: buffer.byteLength };
    this.cache.set(index, parsed);
    this.cacheBytes += buffer.byteLength;
    while (this.cacheBytes > this.maxCacheBytes && this.cache.size > 1) {
      const oldest = this.cache.keys().next().value;
      this.cacheBytes -= this.cache.get(oldest).bytes;
      this.cache.delete(oldest);
    }
    return parsed;
  }

  async coordinates(refs, { signal, onProgress, edgeRanges } = {}) {
    const needed = new Map();
    for (const ref of refs) {
      const id = ref & 0x7fffffff;
      const index = this.chunkIndex(id);
      if (!needed.has(index)) needed.set(index, new Set());
      needed.get(index).add(id);
    }
    const geometries = new Map();
    const entries = [...needed];
    let complete = 0;
    let next = 0;
    let firstError;
    checkAbort(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const fetchNext = async () => {
      try {
        while (next < entries.length) {
          checkAbort(controller.signal);
          const [index, ids] = entries[next++];
          const chunk = await this.chunk(index, controller.signal);
          for (const id of ids) {
            const localId = id - this.chunks[index].start;
            const coordinates = [];
            for (let point = chunk.offsets[localId]; point < chunk.offsets[localId + 1]; point++) {
              coordinates.push([chunk.lat[point] / 1e6, chunk.lon[point] / 1e6]);
            }
            geometries.set(id, coordinates);
          }
          complete++;
          onProgress?.({ stage: 'geometry', progress: complete / needed.size,
            message: `Drawing route (${complete}/${needed.size} geometry files)…` });
        }
      } catch (error) {
        firstError ??= error;
        controller.abort();
        throw error;
      }
    };
    try {
      const results = await Promise.allSettled(Array.from({ length: Math.min(4, entries.length) }, fetchNext));
      if (firstError) throw firstError;
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    } finally { signal?.removeEventListener('abort', abort); }
    if (signal?.aborted) throw new RoutingError('CANCELLED', 'Route calculation cancelled.');
    if (controller.signal.aborted) {
      throw new RoutingError('CANCELLED', 'Route calculation cancelled.');
    }
    const coordinates = [];
    for (const ref of refs) {
      const geometry = geometries.get(ref & 0x7fffffff);
      if (!geometry.length) throw new RoutingError('INVALID_GRAPH', 'A route contains an empty road geometry.');
      const reverse = Boolean(ref >>> 31);
      const first = geometry[reverse ? geometry.length - 1 : 0];
      const previous = coordinates[coordinates.length - 1];
      const coordinateStart = previous && previous[0] === first[0] && previous[1] === first[1]
        ? coordinates.length - 1 : coordinates.length;
      for (let index = 0; index < geometry.length; index++) {
        const point = geometry[reverse ? geometry.length - 1 - index : index];
        const previous = coordinates[coordinates.length - 1];
        if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) coordinates.push(point);
      }
      edgeRanges?.push([coordinateStart, coordinates.length - 1]);
    }
    return coordinates;
  }
}
