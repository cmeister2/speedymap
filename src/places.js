const rank = { city: 0, town: 1, village: 2, suburb: 3, hamlet: 4 };
export const normalise = (value) =>
  value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function searchPlaces(places, query, count = 7) {
  const needle = normalise(query);
  if (needle.length < 2) return [];
  return places
    .filter(
      (place) =>
        normalise(place.name).includes(needle) ||
        normalise(place.alternateName || "").includes(needle),
    )
    .sort((a, b) => {
      const an = normalise(a.name),
        bn = normalise(b.name);
      const score = (name) =>
        name === needle ? 0 : name.startsWith(needle) ? 1 : 2;
      return (
        score(an) - score(bn) ||
        (rank[a.type] ?? 5) - (rank[b.type] ?? 5) ||
        a.name.localeCompare(b.name) ||
        a.lat - b.lat
      );
    })
    .slice(0, count);
}

export function parseCoordinates(text) {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*[,;]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(
    text,
  );
  if (!match) return null;
  const lat = Number(match[1]),
    lng = Number(match[2]);
  if (lat < 49 || lat > 61.5 || lng < -9 || lng > 2.5)
    throw new Error(
      "Choose coordinates in the United Kingdom (latitude, longitude).",
    );
  return {
    name: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
    lat,
    lng,
    type: "coordinates",
  };
}

export function isPostcode(text) {
  return /^(GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})$/i.test(text.trim());
}

export function formatTime(seconds) {
  if (seconds < 30) return "< 1 min";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60),
    remainder = minutes % 60;
  return `${hours} h${remainder ? ` ${remainder} min` : ""}`;
}

export function formatDistance(metres) {
  const miles = metres / 1609.344;
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles).toLocaleString("en-GB")} mi`;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
}

export function makeGpx(route, from, to) {
  const xml = (value) => escapeHtml(value);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Speedymap" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>${xml(from.name)} to ${xml(to.name)}</name><desc>Experimental road-number speed routing. Road data © OpenStreetMap contributors, ODbL.</desc></metadata><trk><name>${xml(from.name)} to ${xml(to.name)}</name><trkseg>${route.coordinates.map(([lat, lng]) => `<trkpt lat="${lat}" lon="${lng}"/>`).join("")}</trkseg></trk></gpx>`;
}
