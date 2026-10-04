import { RoutingEngine } from './engine.js';
import { loadGraph } from './loader.js';

let engine = null;
let loadedManifestUrl = null;
let loadPromise = null;
let loadController = null;
let routeController = null;
let pendingRoute = null;
let processingRoutes = false;

function sendError(id, error) {
  if (error.code === 'CANCELLED' || error.name === 'AbortError') return;
  if (error instanceof RangeError) {
    self.postMessage({ type: 'error', id, code: 'MEMORY_LIMIT',
      message: 'The nationwide road database does not fit in this device’s memory. Try a desktop browser with more available memory.' });
    return;
  }
  self.postMessage({ type: 'error', id, code: error.code || 'ROUTING_FAILED',
    message: error.message || 'The route could not be calculated. Please try again.' });
}

function progress(id) {
  return (value) => self.postMessage({ type: 'progress', id, ...value });
}

async function load(request) {
  const { id, manifestUrl } = request;
  if (engine && loadedManifestUrl === manifestUrl) {
    self.postMessage({ type: 'loaded', id, stats: engine.graph.manifest });
    return;
  }
  if (loadPromise && loadedManifestUrl === manifestUrl) {
    try { await loadPromise; self.postMessage({ type: 'loaded', id, stats: engine.graph.manifest }); }
    catch (error) { sendError(id, error); }
    return;
  }
  loadController?.abort();
  routeController?.abort();
  const controller = new AbortController();
  loadController = controller;
  loadedManifestUrl = manifestUrl;
  engine = null;
  const promise = (async () => {
    const graph = await loadGraph(manifestUrl, { signal: controller.signal, onProgress: progress(id) });
    if (controller.signal.aborted) return;
    engine = new RoutingEngine(graph);
    self.postMessage({ type: 'progress', id, stage: 'ready', progress: 1, message: 'Road database ready.' });
    self.postMessage({ type: 'loaded', id, stats: graph.manifest });
  })();
  loadPromise = promise;
  try { await promise; }
  catch (error) { sendError(id, error); }
  finally { if (loadPromise === promise) loadPromise = null; }
}

async function processRoutes() {
  if (processingRoutes) return;
  processingRoutes = true;
  try {
    while (pendingRoute) {
      const request = pendingRoute;
      pendingRoute = null;
      const controller = new AbortController();
      routeController = controller;
      const { id } = request;
      try {
        if (loadPromise) await loadPromise;
        if (controller.signal.aborted) continue;
        if (!engine) throw Object.assign(new Error('Load the road database before calculating a route.'), { code: 'NOT_READY' });
        const options = { mode: request.mode || 'numbered', signal: controller.signal,
          maxSnapDistance: request.maxSnapDistance, onProgress: progress(id) };
        const route = await engine.route(request.from, request.to, options);
        let comparison;
        if (request.compare && !controller.signal.aborted) {
          options.mode = options.mode === 'normal' ? request.experimentMode || 'numbered' : 'normal';
          progress(id)({ stage: 'comparison', message: 'Calculating the comparison route…' });
          comparison = await engine.route(request.from, request.to, options);
        }
        if (!controller.signal.aborted) self.postMessage({ type: 'result', id, route, comparison });
      } catch (error) { if (!controller.signal.aborted) sendError(id, error); }
    }
  } finally { processingRoutes = false; routeController = null; }
}

self.onmessage = ({ data }) => {
  if (data.type === 'load') void load(data);
  else if (data.type === 'route') {
    routeController?.abort();
    pendingRoute = data;
    void processRoutes();
  } else if (data.type === 'cancel') {
    routeController?.abort();
    pendingRoute = null;
  }
};
