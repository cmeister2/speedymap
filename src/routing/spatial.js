const EARTH_RADIUS = 6371008.8;
const RADIANS = Math.PI / 180;

export function distanceMetres(aLat, aLng, bLat, bLng) {
  const latDelta = (bLat - aLat) * RADIANS;
  const lngDelta = (bLng - aLng) * RADIANS;
  const sineLat = Math.sin(latDelta / 2);
  const sineLng = Math.sin(lngDelta / 2);
  const haversine = sineLat * sineLat + Math.cos(aLat * RADIANS) * Math.cos(bLat * RADIANS) * sineLng * sineLng;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

export class RoutingError extends Error {
  constructor(code, message) { super(message); this.name = 'RoutingError'; this.code = code; }
}

export function validatePoint(point) {
  if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) ||
    point[0] < -90 || point[0] > 90 || point[1] < -180 || point[1] > 180) {
    throw new RoutingError('INVALID_POINT', 'Choose a valid latitude and longitude for both places.');
  }
}

/** Compact grid index. Each graph node needs one uint32 link. */
export class SpatialIndex {
  constructor(lat, lon, bounds, cellSize = 0.025) {
    this.lat = lat;
    this.lon = lon;
    this.cellSize = cellSize;
    this.minLng = bounds[0];
    this.minLat = bounds[1];
    this.width = Math.max(1, Math.floor((bounds[2] - bounds[0]) / cellSize) + 1);
    this.height = Math.max(1, Math.floor((bounds[3] - bounds[1]) / cellSize) + 1);
    this.heads = new Uint32Array(this.width * this.height);
    this.next = new Uint32Array(lat.length);
    for (let node = 0; node < lat.length; node++) {
      const x = this.column(lon[node] / 1e6);
      const y = this.row(lat[node] / 1e6);
      const cell = y * this.width + x;
      this.next[node] = this.heads[cell];
      this.heads[cell] = node + 1;
    }
  }

  column(lng) { return Math.max(0, Math.min(this.width - 1, Math.floor((lng - this.minLng) / this.cellSize))); }
  row(lat) { return Math.max(0, Math.min(this.height - 1, Math.floor((lat - this.minLat) / this.cellSize))); }

  nearest(point, maxDistance = 5000) {
    return this.candidates(point, maxDistance, { limit: 1 })[0];
  }

  candidates(point, maxDistance = 5000, { limit = 16, components, eligible } = {}) {
    validatePoint(point);
    if (!Number.isFinite(maxDistance) || maxDistance <= 0) throw new RoutingError('INVALID_DISTANCE', 'The road search distance must be positive.');
    if (!Number.isInteger(limit) || limit < 1) throw new RoutingError('INVALID_DISTANCE', 'The road search needs a positive number of candidates.');
    const [lat, lng] = point;
    const latDelta = maxDistance / 110000;
    const lngDelta = maxDistance / (110000 * Math.max(0.01, Math.cos(lat * RADIANS)));
    const minX = this.column(lng - lngDelta);
    const maxX = this.column(lng + lngDelta);
    const minY = this.row(lat - latDelta);
    const maxY = this.row(lat + latDelta);
    const candidates = [];
    const groups = components ? new Map() : null;
    let cutoff = maxDistance;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        for (let link = this.heads[y * this.width + x]; link !== 0; link = this.next[link - 1]) {
          const node = link - 1;
          if (eligible && !eligible(node)) continue;
          const distance = distanceMetres(lat, lng, this.lat[node] / 1e6, this.lon[node] / 1e6);
          if (distance > cutoff) continue;
          if (groups) {
            const key = components[node];
            const previous = groups.get(key);
            if (!previous || distance < previous.distance || (distance === previous.distance && node < previous.node)) groups.set(key, { node, distance });
          } else {
            const previous = candidates[candidates.length - 1];
            if (candidates.length === limit && distance === cutoff && node >= previous.node) continue;
            const candidate = { node, distance };
            let index = candidates.length;
            while (index > 0 && (candidates[index - 1].distance > distance ||
              (candidates[index - 1].distance === distance && candidates[index - 1].node > node))) index--;
            candidates.splice(index, 0, candidate);
            if (candidates.length > limit) candidates.pop();
            if (candidates.length === limit) cutoff = candidates[candidates.length - 1].distance;
          }
        }
      }
    }
    const found = groups ? [...groups.values()].sort((a, b) => a.distance - b.distance || a.node - b.node).slice(0, limit) : candidates;
    if (!found.length) throw new RoutingError('OFF_NETWORK', `No drivable road was found within ${(maxDistance / 1000).toLocaleString()} km of this place. Choose a point closer to a road.`);
    return found.map(({ node, distance }) => {
      const coordinate = [this.lat[node] / 1e6, this.lon[node] / 1e6];
      return { node, coordinate, distanceMetres: distance, coordinates: coordinate, distance };
    });
  }
}
