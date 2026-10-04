import L from "leaflet";
import "./style.css";
import { createRouteLabels } from "./route-labels.js";
import {
  CACHE_VERSION,
  DEFAULT_JOURNEY,
  makeRouteCacheKey,
  isValidRouteResult,
  readCachedRoute,
  writeCachedRoute,
} from "./route-cache.js";
import {
  searchPlaces,
  normalise,
  parseCoordinates,
  isPostcode,
  formatTime,
  formatDistance,
  escapeHtml as esc,
  makeGpx,
} from "./places.js";

const $ = (selector) => document.querySelector(selector);
const pickIcon =
  '<svg class="location-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/></svg>';
const dataBase = new URL(`${import.meta.env.BASE_URL}data/`, location.href);
const examples = {
  edinburgh: [DEFAULT_JOURNEY.from, DEFAULT_JOURNEY.to],
  norwich: [
    { name: "Norwich", lat: 52.6286, lng: 1.2923 },
    { name: "Peterborough", lat: 52.5739, lng: -0.2429 },
  ],
  cambridge: [
    { name: "London", lat: 51.5074, lng: -0.1278 },
    { name: "Cambridge", lat: 52.2053, lng: 0.1218 },
  ],
  belfast: [
    { name: "Belfast", lat: 54.5973, lng: -5.9301 },
    { name: "Derry / Londonderry", lat: 54.997, lng: -7.3092 },
  ],
  m1: [
    { name: "Nottingham", lat: 52.9534193, lng: -1.1496461 },
    { name: "Sheffield", lat: 53.3806626, lng: -1.4702278 },
  ],
  a1: [
    { name: "Doncaster", lat: 53.5227681, lng: -1.1335312 },
    { name: "Newcastle upon Tyne", lat: 54.9738474, lng: -1.6131572 },
  ],
};
let places = [],
  manifest,
  worker,
  workerReady = false,
  loadingPromise,
  loadReject,
  pendingJourney,
  bundledDefaultPromise,
  bundledDefaultKey,
  resolveMetadata;
const metadataReady = new Promise((resolve) => {
  resolveMetadata = resolve;
});
let serial = 0,
  routeId = 0,
  busy = false,
  currentResult,
  showAllSegments = false,
  mapPick = "from";
const selections = {
  from: { ...DEFAULT_JOURNEY.from },
  to: { ...DEFAULT_JOURNEY.to },
};
const markers = {};
const postcodeCache = new Map();
const map = L.map("map", {
  zoomControl: false,
  minZoom: 5,
  maxZoom: 19,
}).setView([53.05, -1.75], 7);
L.control.zoom({ position: "topright" }).addTo(map);
const tileUrl =
  import.meta.env.VITE_TILE_URL ||
  "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
L.tileLayer(tileUrl, {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
}).addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const routeLabels = createRouteLabels(map);

function markerFor(key) {
  const place = selections[key];
  if (!place) {
    if (markers[key]) {
      markers[key].remove();
      delete markers[key];
    }
    return;
  }
  const icon = L.divIcon({
    html: `<span class="endpoint-marker ${key === "to" ? "destination" : ""}">${key === "from" ? "A" : "B"}</span>`,
    className: "",
    iconSize: [27, 27],
    iconAnchor: [13, 13],
  });
  if (!markers[key]) {
    markers[key] = L.marker([place.lat, place.lng], {
      icon,
      draggable: true,
      autoPan: true,
    }).addTo(map);
    markers[key].on("dragend", () => {
      const { lat, lng } = markers[key].getLatLng();
      setSelection(key, {
        name: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        lat,
        lng,
      });
      invalidateResult();
    });
  } else markers[key].setLatLng([place.lat, place.lng]);
  markers[key].bindTooltip(
    `${key === "from" ? "From" : "To"}: ${esc(place.name)}`,
    { direction: "top", offset: [0, -13] },
  );
}

function setSelection(key, place) {
  selections[key] = place;
  $(`#${key}-input`).value = place.name;
  hideSuggestions(key);
  markerFor(key);
}

function hideSuggestions(key) {
  $(`#${key}-suggestions`).hidden = true;
  $(`#${key}-input`).setAttribute("aria-expanded", "false");
  $(`#${key}-input`).removeAttribute("aria-activedescendant");
}

function setStatus(message) {
  $("#status").textContent = message;
}
function showError(message) {
  $("#error").textContent = message;
  $("#error").hidden = false;
}
function clearError() {
  $("#error").hidden = true;
}
function mode() {
  return $('input[name="mode"]:checked').value === "normal"
    ? "normal"
    : experimentMode();
}
function experimentMode() {
  return $("#number-only-toggle").checked ? "number-only" : "numbered";
}
function updateComparisonKey() {
  $(".rule-card p").textContent =
    experimentMode() === "number-only"
      ? "Maximum speed = the road number in mph. Unnumbered roads keep their speed limit."
      : "Maximum speed = the smaller of the road number and its speed limit.";
  $("#comparison-key").textContent =
    mode() !== "normal"
      ? "Normal route"
      : experimentMode() === "number-only"
        ? "Road number speed route"
        : "Number limit route";
}
function setBusy(value) {
  busy = value;
  $("#route-button").disabled = value;
  $("#route-button-text").textContent = value
    ? "Finding your way…"
    : "Find my route";
  $("#cancel-button").hidden = !value;
  if (!value) $("#load-progress").hidden = true;
}

function invalidateResult() {
  // Changes to endpoints cancel the in-flight calculation before accepting a new one.
  if (busy) cancelCalculation();
  else routeId = ++serial;
  currentResult = null;
  routeLayer.clearLayers();
  routeLabels.clear();
  $("#results").hidden = true;
  $("#idle-content").hidden = false;
  $("#map-state").textContent = "A new way from A to B";
  clearError();
}

function setupPlaceInput(key) {
  const input = $(`#${key}-input`),
    dropdown = $(`#${key}-suggestions`);
  let matches = [],
    active = -1;
  function activate(index) {
    active = index;
    [...dropdown.querySelectorAll(".suggestion")].forEach((button, i) => {
      button.classList.toggle("active", i === index);
      button.setAttribute("aria-selected", String(i === index));
    });
    if (index >= 0)
      input.setAttribute("aria-activedescendant", `${key}-option-${index}`);
    else input.removeAttribute("aria-activedescendant");
  }
  function update() {
    matches = searchPlaces(places, input.value);
    active = -1;
    dropdown.replaceChildren();
    for (const [index, place] of matches.entries()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "suggestion";
      button.id = `${key}-option-${index}`;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", "false");
      const description =
        place.region ||
        place.district ||
        `${place.type || "place"} · ${place.lat.toFixed(2)}, ${place.lng.toFixed(2)}`;
      button.innerHTML = `<span>${esc(place.name)}</span><small>${esc(description)}</small>`;
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => {
        setSelection(key, place);
        invalidateResult();
        input.focus();
        hideSuggestions(key);
      });
      dropdown.append(button);
    }
    dropdown.hidden = !matches.length;
    input.setAttribute("aria-expanded", String(matches.length > 0));
  }
  input.addEventListener("input", () => {
    selections[key] = null;
    markerFor(key);
    invalidateResult();
    update();
  });
  input.addEventListener("focus", () => {
    mapPick = key;
    $("#map-instruction").innerHTML =
      `${pickIcon} Click to set your ${key === "from" ? "starting point" : "destination"}`;
    if (!selections[key]) update();
  });
  input.addEventListener("blur", () => hideSuggestions(key));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideSuggestions(key);
    if (dropdown.hidden) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      activate(
        active < 0
          ? event.key === "ArrowDown"
            ? 0
            : matches.length - 1
          : (active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) %
              matches.length,
      );
    }
    if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      setSelection(key, matches[active]);
      invalidateResult();
    }
  });
}

async function resolvePlace(key, requestId) {
  const text = $(`#${key}-input`).value.trim();
  if (selections[key] && selections[key].name === text) return selections[key];
  const coordinate = parseCoordinates(text);
  if (coordinate) {
    setSelection(key, coordinate);
    return coordinate;
  }
  if (isPostcode(text)) {
    const postcode = text.toUpperCase().replace(/\s+/g, "");
    setStatus(`Looking up ${text.toUpperCase()}…`);
    let place = postcodeCache.get(postcode);
    if (!place) {
      const response = await fetch(
        `https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`,
        { signal: AbortSignal.timeout(15000) },
      );
      if (!response.ok)
        throw new Error(
          `Could not find postcode ${text.toUpperCase()}. Try a town or a point on the map.`,
        );
      const { result } = await response.json();
      if (
        !Number.isFinite(result?.latitude) ||
        !Number.isFinite(result?.longitude)
      )
        throw new Error(
          "That postcode has no location. Choose a point on the map.",
        );
      place = {
        name: result.postcode,
        lat: result.latitude,
        lng: result.longitude,
      };
      postcodeCache.set(postcode, place);
    }
    if (requestId !== routeId) throw new Error("Calculation cancelled.");
    setSelection(key, place);
    return place;
  }
  const matches = places.filter(
    (place) =>
      normalise(place.name) === normalise(text) ||
      (place.alternateName &&
        normalise(place.alternateName) === normalise(text)),
  );
  const cityOrTown = matches.filter((place) =>
    ["city", "town"].includes(place.type),
  );
  const place =
    matches.length === 1
      ? matches[0]
      : cityOrTown.length === 1
        ? cityOrTown[0]
        : null;
  if (place) {
    setSelection(key, place);
    return place;
  }
  $(`#${key}-input`).focus();
  throw new Error(
    matches.length
      ? `There is more than one ${text}. Choose a suggestion, or click the map.`
      : `Choose a town from the suggestions, enter a full UK postcode, or click the map for your ${key === "from" ? "start" : "destination"}.`,
  );
}

function createWorker() {
  worker = new Worker(new URL("./routing/worker.js", import.meta.url), {
    type: "module",
  });
  worker.addEventListener("message", async (event) => {
    const message = event.data;
    if (message.type === "progress") {
      if ((!workerReady && busy) || (busy && message.id === routeId)) {
        setStatus(message.message || message.stage || "Working…");
        $("#load-progress").hidden = false;
        if (Number.isFinite(message.progress)) {
          $("#load-progress").value = message.progress;
        } else $("#load-progress").removeAttribute("value");
      }
    }
    if (message.type === "result" && message.id === routeId) {
      const result = { route: message.route, comparison: message.comparison };
      currentResult = result;
      showAllSegments = false;
      renderResult();
      setBusy(false);
      const request =
        pendingJourney?.id === message.id ? pendingJourney.request : null;
      if (request)
        await writeCachedRoute(makeRouteCacheKey(manifest, request), result);
      if (message.id === routeId && currentResult === result)
        setStatus("Calculated here in your browser. No routing server.");
    }
    if (message.type === "error" && message.id === routeId) {
      setBusy(false);
      showError(message.message);
      setStatus("Try different endpoints or another route.");
    }
  });
  worker.addEventListener("error", (event) => {
    if (loadReject)
      loadReject(
        new Error(event.message || "The road database could not be loaded."),
      );
    workerReady = false;
    loadingPromise = null;
    setBusy(false);
    showError(
      "The routing engine stopped. Please try again, or use a desktop browser with more memory.",
    );
    worker?.terminate();
    worker = null;
  });
}

async function ensureGraph() {
  if (workerReady) return;
  if (loadingPromise) return loadingPromise;
  if (!manifest)
    throw new Error(
      "The UK database is not available. Build the road data before deploying this site.",
    );
  if (!("DecompressionStream" in window))
    throw new Error(
      "Please use a current browser with gzip decompression support.",
    );
  if (!worker) createWorker();
  const id = ++serial;
  loadingPromise = new Promise((resolve, reject) => {
    loadReject = reject;
    const receive = ({ data: message }) => {
      if (message.id !== id) return;
      if (message.type === "loaded") {
        worker.removeEventListener("message", receive);
        workerReady = true;
        manifest = message.stats;
        $("#download-note").hidden = true;
        loadReject = null;
        setStatus("UK road database ready. Finding the quickest route…");
        resolve();
      }
      if (message.type === "error") {
        worker.removeEventListener("message", receive);
        loadingPromise = null;
        loadReject = null;
        reject(new Error(message.message));
      }
    };
    worker.addEventListener("message", receive);
    worker.postMessage({
      type: "load",
      id,
      manifestUrl: new URL("manifest.json", dataBase).href,
    });
  });
  return loadingPromise;
}

function selectedJourney() {
  return {
    from: { ...selections.from },
    to: { ...selections.to },
    mode: mode(),
    experimentMode: experimentMode(),
  };
}

async function cachedJourney(request) {
  const key = makeRouteCacheKey(manifest, request);
  const stored = await readCachedRoute(key);
  if (isValidRouteResult(stored, request)) return { key, result: stored };
  const counterpart = {
    ...request,
    mode: request.mode === "normal" ? request.experimentMode : "normal",
  };
  const counterpartKey = makeRouteCacheKey(manifest, counterpart);
  const paired = await readCachedRoute(counterpartKey);
  const swap = (result) =>
    result && { route: result.comparison, comparison: result.route };
  const swapped = swap(paired);
  if (isValidRouteResult(swapped, request)) return { key, result: swapped };
  const defaultKey = makeRouteCacheKey(manifest, DEFAULT_JOURNEY);
  if (key !== defaultKey && counterpartKey !== defaultKey) return null;
  if (bundledDefaultKey !== defaultKey) {
    bundledDefaultKey = defaultKey;
    bundledDefaultPromise = null;
  }
  bundledDefaultPromise ??= (async () => {
    try {
      const url = new URL("../default-route.json.gz", dataBase);
      url.searchParams.set(
        "v",
        `${manifest.generatedAt || manifest.sourceDate}-${CACHE_VERSION}`,
      );
      const payload = await readGzipJson(url, { cache: "no-cache" });
      return payload.cacheVersion === CACHE_VERSION &&
        payload.key === defaultKey &&
        isValidRouteResult(payload.result, DEFAULT_JOURNEY)
        ? payload.result
        : null;
    } catch {
      return null;
    }
  })();
  const bundled = await bundledDefaultPromise;
  const result = key === defaultKey ? bundled : swap(bundled);
  return isValidRouteResult(result, request) ? { key, result } : null;
}

async function showCachedJourney(cached, requestId) {
  if (requestId !== routeId) return;
  currentResult = cached.result;
  showAllSegments = false;
  renderResult();
  setBusy(false);
  $("#download-note").hidden = true;
  await writeCachedRoute(cached.key, cached.result);
  if (requestId === routeId && currentResult === cached.result)
    setStatus(
      "Cached journey ready. New journeys are calculated in your browser.",
    );
}

async function calculate(event) {
  event?.preventDefault();
  if (busy) return;
  clearError();
  setBusy(true);
  routeId = ++serial;
  const requestId = routeId;
  try {
    const from = await resolvePlace("from", requestId);
    if (requestId !== routeId) return;
    const to = await resolvePlace("to", requestId);
    if (requestId !== routeId) return;
    await metadataReady;
    if (requestId !== routeId) return;
    if (!manifest)
      throw new Error(
        "The UK road database is not available. Please reload and try again.",
      );
    const request = selectedJourney();
    setStatus("Checking saved journeys…");
    const cached = await cachedJourney(request);
    if (requestId !== routeId) return;
    if (cached) {
      await showCachedJourney(cached, requestId);
      return;
    }
    pendingJourney = { id: requestId, request };
    $("#download-note").hidden = workerReady;
    setStatus(
      workerReady
        ? "Finding the quickest route…"
        : "Loading UK roads for a new journey. This takes a little longer…",
    );
    await ensureGraph();
    if (requestId !== routeId) return;
    worker.postMessage({
      type: "route",
      id: requestId,
      from: [from.lat, from.lng],
      to: [to.lat, to.lng],
      mode: mode(),
      experimentMode: experimentMode(),
      compare: true,
    });
  } catch (error) {
    if (requestId !== routeId) return;
    setBusy(false);
    showError(
      error.name === "TimeoutError"
        ? "Postcode lookup timed out. Try a town or a point on the map."
        : error.message,
    );
    setStatus("Your next detour is waiting.");
  }
}

function cancelCalculation() {
  routeId = ++serial;
  if (workerReady) {
    worker.postMessage({ type: "cancel" });
  } else {
    if (loadReject) loadReject(new Error("Calculation cancelled."));
    loadReject = null;
    if (worker) worker.terminate();
    worker = null;
    loadingPromise = null;
  }
  setBusy(false);
  setStatus(
    "Calculation cancelled. Downloaded files remain in your browser cache.",
  );
}

function drawRoutes() {
  routeLayer.clearLayers();
  const { route, comparison } = currentResult;
  if (comparison?.coordinates?.length > 1)
    L.polyline(comparison.coordinates, {
      color: "#9b9488",
      weight: 4,
      opacity: 0.75,
      dashArray: "7 8",
      lineCap: "round",
    }).addTo(routeLayer);
  if (route.coordinates?.length > 1) {
    L.polyline(route.coordinates, {
      color: "#fffdf5",
      weight: 8,
      opacity: 0.9,
      lineCap: "round",
    }).addTo(routeLayer);
    L.polyline(route.coordinates, {
      color: "#1c7864",
      weight: 5,
      opacity: 0.95,
      lineCap: "round",
    }).addTo(routeLayer);
  }
  routeLabels.setRoute(route);
}

function fitRoute() {
  const coordinates = currentResult?.route.coordinates;
  const points = coordinates?.length
    ? [...coordinates, ...(currentResult.comparison?.coordinates || [])]
    : Object.values(selections)
        .filter(Boolean)
        .map((p) => [p.lat, p.lng]);
  if (points.length)
    map.fitBounds(L.latLngBounds(points), {
      padding: [65, 65],
      maxZoom: 14,
      animate: false,
    });
}

function renderResult() {
  const { route, comparison } = currentResult;
  const numbered = route.mode !== "normal";
  const numberOnly = route.mode === "number-only";
  const segments = route.segments || [];
  const shown = showAllSegments ? segments : segments.slice(0, 10);
  const inferred = segments.some((segment) => segment.inferredLimit);
  const savedSeconds =
    numbered && comparison
      ? (numberOnly
          ? comparison.numberOnlySeconds
          : comparison.numberedSeconds) - route.seconds
      : 0;
  const savingNotice =
    savedSeconds > 60
      ? `<p class="route-saving">This detour saves <strong>${esc(formatTime(savedSeconds))}</strong> compared with following the normal route ${numberOnly ? "at road number speeds" : "under number limits"}.</p>`
      : "";
  const snaps = ["from", "to"].map(
    (key) =>
      route.snap?.[key]?.distanceMetres ?? route.snap?.[key]?.distance ?? 0,
  );
  const snapNotice =
    Math.max(...snaps) > 250
      ? `<p class="snap-note">Endpoints joined to the road network: ${Math.round(snaps[0]).toLocaleString("en-GB")} m at the start, ${Math.round(snaps[1]).toLocaleString("en-GB")} m at the finish. These offsets are excluded from distance and time.</p>`
      : "";
  $("#results").innerHTML =
    `<div class="result-heading">YOUR LITTLE DETOUR <span class="route-badge">${numberOnly ? "ROAD NUMBER SPEEDS" : numbered ? "NUMBER LIMITS" : "NORMAL LIMITS"}</span></div>
    <div class="result-stats"><div class="main-stat"><strong>${esc(formatTime(route.seconds))}</strong><span>MODELLED TRAVEL TIME</span></div><div class="distance-stat"><strong>${esc(formatDistance(route.metres))}</strong><span>ON THE ROAD</span></div></div>
    ${comparison ? `<div class="comparison"><span>${numbered ? "With normal speed limits" : comparison.mode === "number-only" ? "With road number speeds" : "With road number limits"}</span><strong>${esc(formatTime(comparison.seconds))} · ${esc(formatDistance(comparison.metres))}</strong></div>` : ""}
    ${savingNotice}
    <p class="time-note">Constant maximum speed; no traffic or stops. ${inferred ? '<span class="inferred-label">* Estimated speed limit where not mapped.</span>' : ""}</p>
    <div class="road-table-title">THE ROADS ALONG THE WAY</div><table class="road-table"><thead><tr><th scope="col">Road / distance</th><th scope="col">Limit</th><th scope="col">Your max</th></tr></thead><tbody>${shown.map((segment) => `<tr><td><span class="ref-chip">${esc(segment.ref || "Unnumbered")}</span><span class="road-name" title="${esc(segment.name || "")}">${esc(segment.name || "Local road")} · ${esc(formatDistance(segment.metres))}</span></td><td>${esc(segment.limitMph)}${segment.inferredLimit ? '<span class="inferred-label" title="Estimated limit">*</span>' : ""}</td><td class="speed-value">${esc(segment.effectiveMph)} <span style="font-weight:400;font-size:8px">mph</span></td></tr>`).join("")}</tbody></table>
    ${segments.length > 10 ? `<button id="more-segments" class="more-segments" type="button">${showAllSegments ? "Show fewer roads" : `Show all ${segments.length} road sections`}</button>` : ""}
    ${snapNotice}<div class="results-actions"><button id="download-gpx" type="button" class="secondary-button">↓ Download GPX</button><button id="result-share" type="button" class="secondary-button">↗ Copy journey link</button></div>`;
  $("#results").hidden = false;
  $("#idle-content").hidden = true;
  updateComparisonKey();
  $("#map-state").textContent =
    `${selections.from.name} → ${selections.to.name}`;
  $("#map-instruction").innerHTML =
    `${pickIcon} Click the map to try another detour`;
  $("#more-segments")?.addEventListener("click", () => {
    showAllSegments = !showAllSegments;
    renderResult();
  });
  $("#download-gpx").addEventListener("click", downloadGpx);
  $("#result-share").addEventListener("click", copyJourney);
  drawRoutes();
  fitRoute();
  updateUrl();
}

function updateUrl() {
  const url = new URL(location.href);
  url.search = "";
  for (const key of ["from", "to"])
    if (selections[key]) {
      url.searchParams.set(
        key,
        `${selections[key].lat.toFixed(6)},${selections[key].lng.toFixed(6)}`,
      );
      url.searchParams.set(`${key}Name`, selections[key].name);
    }
  url.searchParams.set("mode", mode());
  if (experimentMode() === "number-only")
    url.searchParams.set("numberOnly", "1");
  history.replaceState(null, "", url);
  return url.href;
}

async function copyJourney() {
  clearError();
  if (!selections.from || !selections.to) {
    showError("Choose both endpoints first to share a journey.");
    return;
  }
  const url = updateUrl();
  try {
    await navigator.clipboard.writeText(url);
    setStatus("Journey link copied.");
  } catch {
    showError(`Copy the address in your browser to share this journey.`);
  }
}

function downloadGpx() {
  const blob = new Blob(
    [makeGpx(currentResult.route, selections.from, selections.to)],
    { type: "application/gpx+xml" },
  );
  const url = URL.createObjectURL(blob),
    anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "speedymap-journey.gpx";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function readGzipJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok)
    throw new Error(`Data file unavailable (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function initialise() {
  const params = new URLSearchParams(location.search);
  const hasRoutePreferences = ["from", "to", "mode", "numberOnly"].some((key) =>
    params.has(key),
  );
  for (const key of ["from", "to"]) {
    try {
      const coordinate = parseCoordinates(params.get(key) || "");
      if (coordinate)
        setSelection(key, {
          ...coordinate,
          name: params.get(`${key}Name`)?.slice(0, 120) || coordinate.name,
        });
    } catch {
      /* Ignore malformed shared URLs. */
    }
  }
  if (params.get("mode") === "normal")
    $('input[name="mode"][value="normal"]').checked = true;
  $("#number-only-toggle").checked =
    !hasRoutePreferences ||
    params.get("numberOnly") === "1" ||
    params.get("mode") === "number-only";
  updateComparisonKey();
  markerFor("from");
  markerFor("to");
  fitRoute();
  const initialRequestId = (routeId = ++serial);
  const initialJourney = selectedJourney();
  try {
    const response = await fetch(new URL("manifest.json", dataBase), {
      cache: "no-cache",
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("json"))
      throw new Error(
        "UK road data has not been built yet. Run the data builder before deploying.",
      );
    manifest = await response.json();
    resolveMetadata();
    const placesUrl = new URL(
      manifest.placesFile || "places.json.gz",
      dataBase,
    );
    placesUrl.searchParams.set(
      "v",
      manifest.generatedAt || manifest.sourceDate || "1",
    );
    const rawPlaces = await readGzipJson(placesUrl);
    places = (Array.isArray(rawPlaces) ? rawPlaces : rawPlaces.places)
      .map((place) => ({
        ...place,
        lng: place.lng ?? place.lon,
        type: place.type ?? place.place,
      }))
      .filter(
        (place) =>
          place.name &&
          Number.isFinite(place.lat) &&
          Number.isFinite(place.lng),
      );
    const nodes = manifest.nodes;
    const roadCount = manifest.roadCount ?? manifest.counts?.roads;
    const bytes = manifest.initialCompressedBytes;
    $("#download-note").textContent =
      `A new, uncached journey loads about ${Math.round(bytes / 1_000_000)} MB of road data, plus route shapes. Desktop browser recommended.`;
    $("#download-note").hidden = workerReady;
    $("#database-label").textContent =
      `UK roads${roadCount ? ` · ${roadCount.toLocaleString("en-GB")} records` : ""}`;
    const date = manifest.sourceDate;
    $("#dataset-details").textContent =
      `Great Britain and Northern Ireland${date ? `, snapshot ${String(date).slice(0, 10)}` : ""}. ${nodes ? `${nodes.toLocaleString("en-GB")} graph junctions and routing points. ` : ""}The opening London to Edinburgh journey is precomputed. Saved routes are reused from your browser. A new, uncached journey loads the road graph${bytes ? ` (${Math.round(bytes / 1048576)} MB download)` : ""}, which stays in memory for further routes. Only the geometry needed for a new journey is loaded. No route server is used. Ferries are excluded; Great Britain and Northern Ireland cannot be connected by this graph.`;
    if (!busy)
      setStatus(
        `Search ${places.length.toLocaleString("en-GB")} places, or choose points on the map.`,
      );
    if (initialRequestId !== routeId) return;
    const cached = await cachedJourney(initialJourney);
    if (initialRequestId !== routeId) return;
    if (cached) {
      await showCachedJourney(cached, initialRequestId);
    } else if (
      makeRouteCacheKey(manifest, initialJourney) ===
      makeRouteCacheKey(manifest, DEFAULT_JOURNEY)
    ) {
      // If the bundle was unavailable or belongs to older data, calculate it normally.
      await calculate();
    }
  } catch (error) {
    resolveMetadata();
    if (initialRequestId !== routeId) return;
    setStatus("Road database unavailable.");
    showError(error.message);
  }
}

for (const key of ["from", "to"]) setupPlaceInput(key);
$("#route-form").addEventListener("submit", calculate);
$("#cancel-button").addEventListener("click", cancelCalculation);
$("#swap-button").addEventListener("click", () => {
  const from = selections.from,
    to = selections.to,
    fromText = $("#from-input").value,
    toText = $("#to-input").value;
  selections.from = to;
  selections.to = from;
  $("#from-input").value = toText;
  $("#to-input").value = fromText;
  markerFor("from");
  markerFor("to");
  invalidateResult();
});
document
  .querySelectorAll('input[name="mode"], #number-only-toggle')
  .forEach((input) =>
    input.addEventListener("change", () => {
      const hadRoute = Boolean(currentResult);
      invalidateResult();
      updateComparisonKey();
      if (hadRoute) calculate();
    }),
  );
document.querySelectorAll("[data-example]").forEach((button) =>
  button.addEventListener("click", () => {
    invalidateResult();
    const [from, to] = examples[button.dataset.example];
    setSelection("from", from);
    setSelection("to", to);
    fitRoute();
    setStatus("An excellent candidate for a detour. Press “Find my route”.");
  }),
);
map.on("click", ({ latlng: { lat, lng } }) => {
  clearError();
  try {
    parseCoordinates(`${lat},${lng}`);
  } catch (error) {
    showError(error.message);
    return;
  }
  invalidateResult();
  setSelection(mapPick, {
    name: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
    lat,
    lng,
  });
  mapPick = mapPick === "from" ? "to" : "from";
  $("#map-instruction").innerHTML =
    `${pickIcon} Click to set your ${mapPick === "from" ? "starting point" : "destination"}`;
  setStatus("Point selected. Press “Find my route” when you’re ready.");
});
$("#fit-button").addEventListener("click", fitRoute);
$("#share-button").addEventListener("click", copyJourney);
const dialog = $("#about-dialog");
for (const selector of ["#about-button", "#details-button"])
  $(selector).addEventListener("click", () => dialog.showModal());
$("#close-about").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) {
    const box = dialog.getBoundingClientRect();
    if (
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    )
      dialog.close();
  }
});
new ResizeObserver(() => map.invalidateSize()).observe($("#map"));
initialise();
