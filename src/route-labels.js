import L from "leaflet";
import { escapeHtml as esc, formatDistance } from "./places.js";

function speedRange(segments, field) {
  const speeds = segments.map((segment) => segment[field]);
  const low = Math.min(...speeds),
    high = Math.max(...speeds);
  return low === high ? `${low}` : `${low}-${high}`;
}

function roadDetails(section, mode) {
  const estimated = section.segments.some((segment) => segment.inferredLimit);
  const heading = section.ref || section.name;
  return `<strong>${esc(heading)}</strong>${section.ref && section.name ? `<span class="route-road-detail-name">${esc(section.name)}</span>` : ""}
    <span>${mode === "normal" ? "Normal max" : "Your max"} <b>${esc(speedRange(section.segments, "effectiveMph"))} mph</b></span>
    <span>Road limit ${esc(speedRange(section.segments, "limitMph"))} mph${estimated ? "*" : ""} · ${esc(formatDistance(section.metres))}</span>
    ${estimated ? "<small>* Includes an estimated speed limit</small>" : ""}`;
}

// Clip each line to the visible map so labels remain on the road when panning.
function clipLine(a, b, width, height) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  let start = 0,
    end = 1;
  const p = [-dx, dx, -dy, dy],
    q = [a.x - 24, width - 24 - a.x, a.y - 24, height - 24 - a.y];
  for (let i = 0; i < 4; i++) {
    if (!p[i]) {
      if (q[i] < 0) return;
    } else {
      const fraction = q[i] / p[i];
      if (p[i] < 0) start = Math.max(start, fraction);
      else end = Math.min(end, fraction);
      if (start > end) return;
    }
  }
  return [
    L.point(a.x + dx * start, a.y + dy * start),
    L.point(a.x + dx * end, a.y + dy * end),
  ];
}

function visibleMiddle(points, section, size) {
  const pieces = [];
  let length = 0;
  for (let i = section.coordinateStart; i < section.coordinateEnd; i++) {
    const clipped = clipLine(points[i], points[i + 1], size.x, size.y);
    if (!clipped) continue;
    const distance = clipped[0].distanceTo(clipped[1]);
    if (distance > 0) {
      pieces.push({ points: clipped, distance });
      length += distance;
    }
  }
  if (length < 12) return;
  let remaining = length / 2;
  for (const piece of pieces) {
    if (remaining <= piece.distance) {
      const [a, b] = piece.points,
        fraction = remaining / piece.distance;
      return {
        point: L.point(
          a.x + (b.x - a.x) * fraction,
          a.y + (b.y - a.y) * fraction,
        ),
        length,
      };
    }
    remaining -= piece.distance;
  }
}

function overlaps(a, b) {
  return (
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  );
}

export function createRouteLabels(map) {
  const hitLayer = L.layerGroup().addTo(map),
    labelLayer = L.layerGroup().addTo(map);
  const pane = map.createPane("routeRoadLabels");
  pane.style.zIndex = "550";
  let route,
    sections = [];

  function clear() {
    route = null;
    sections = [];
    hitLayer.clearLayers();
    labelLayer.clearLayers();
  }

  function updateLabels() {
    labelLayer.clearLayers();
    if (!route || !sections.length) return;
    const size = map.getSize(),
      points = route.coordinates.map((coordinate) =>
        map.latLngToContainerPoint(coordinate),
      );
    // Reserve endpoints and map controls, as well as space between road shields.
    const occupied = [
      { left: 0, top: 0, right: size.x, bottom: 76 },
      { left: 0, top: size.y - 78, right: size.x, bottom: size.y },
      { left: size.x - 65, top: 65, right: size.x, bottom: 165 },
    ];
    for (const point of [points[0], points[points.length - 1]]) {
      occupied.push({
        left: point.x - 27,
        right: point.x + 27,
        top: point.y - 27,
        bottom: point.y + 27,
      });
    }
    const candidates = [];
    for (const section of sections) {
      if (!section.ref && map.getZoom() < 13) continue;
      const visible = visibleMiddle(points, section, size);
      if (visible) candidates.push({ section, ...visible });
    }
    candidates.sort(
      (a, b) =>
        Number(Boolean(b.section.ref)) - Number(Boolean(a.section.ref)) ||
        b.length - a.length,
    );
    for (const { section, point } of candidates) {
      const text = section.ref || section.name,
        width = Math.min(
          section.ref ? 132 : 160,
          Math.max(42, 18 + text.length * 7),
        ),
        height = 25,
        rectangle = {
          left: point.x - width / 2 - 8,
          right: point.x + width / 2 + 8,
          top: point.y - height / 2 - 9,
          bottom: point.y + height / 2 + 9,
        };
      if (
        rectangle.left < 8 ||
        rectangle.right > size.x - 8 ||
        occupied.some((other) => overlaps(rectangle, other))
      )
        continue;
      occupied.push(rectangle);
      const marker = L.marker(map.containerPointToLatLng(point), {
        pane: "routeRoadLabels",
        bubblingMouseEvents: false,
        title: `${text}${section.ref && section.name ? ` · ${section.name}` : ""}`,
        icon: L.divIcon({
          className: `route-road-label${section.ref ? "" : " route-road-name-label"}`,
          html: esc(text),
          iconSize: [width, height],
          iconAnchor: [width / 2, height / 2],
        }),
      });
      marker.on("add", () => {
        const element = marker.getElement();
        element.setAttribute("aria-label", `View road details for ${text}`);
        element.dataset.roadRef = section.ref;
        element.dataset.mode = route.mode;
      });
      const direction =
        point.x < 150 ? "right" : point.x > size.x - 150 ? "left" : "top";
      marker.bindTooltip(roadDetails(section, route.mode), {
        className: "route-road-detail",
        direction,
        offset: [0, direction === "top" ? -12 : 0],
        opacity: 1,
      });
      marker.on("click", () => marker.openTooltip());
      marker.addTo(labelLayer);
    }
  }

  function setRoute(nextRoute) {
    clear();
    route = nextRoute;
    if (!route.coordinates?.length) return;
    for (const segment of route.segments || []) {
      if (
        (!segment.ref && !segment.name) ||
        !Number.isInteger(segment.coordinateStart) ||
        !Number.isInteger(segment.coordinateEnd) ||
        segment.coordinateEnd <= segment.coordinateStart
      )
        continue;
      const previous = sections[sections.length - 1];
      if (
        previous &&
        previous.ref === segment.ref &&
        previous.name === segment.name &&
        previous.coordinateEnd === segment.coordinateStart
      ) {
        previous.coordinateEnd = segment.coordinateEnd;
        previous.metres += segment.metres;
        previous.segments.push(segment);
      } else {
        sections.push({
          ref: segment.ref,
          name: segment.name,
          coordinateStart: segment.coordinateStart,
          coordinateEnd: segment.coordinateEnd,
          metres: segment.metres,
          segments: [segment],
        });
      }
    }
    // Every known section remains inspectable even when shields are hidden to avoid overlap.
    for (const section of sections) {
      L.polyline(
        route.coordinates.slice(
          section.coordinateStart,
          section.coordinateEnd + 1,
        ),
        { weight: 16, opacity: 0, bubblingMouseEvents: false },
      )
        .bindTooltip(roadDetails(section, route.mode), {
          className: "route-road-detail",
          sticky: true,
          opacity: 1,
        })
        .addTo(hitLayer);
    }
    updateLabels();
  }

  map.on("moveend zoomend resize", updateLabels);
  return { setRoute, clear };
}
