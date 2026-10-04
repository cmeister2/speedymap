import test from "node:test";
import assert from "node:assert/strict";
import {
  searchPlaces,
  parseCoordinates,
  isPostcode,
  formatTime,
  escapeHtml,
  makeGpx,
} from "../src/places.js";

test("local place search ranks exact names and larger settlements, retaining ambiguous results", () => {
  const places = [
    { name: "Cambridge", type: "village", lat: 53 },
    { name: "Cambridge Heath", type: "suburb", lat: 51 },
    { name: "Cambridge", type: "city", lat: 52 },
  ];
  assert.deepEqual(
    searchPlaces(places, "cambridge").map((p) => p.type),
    ["city", "village", "suburb"],
  );
  assert.deepEqual(searchPlaces(places, "c"), []);
  assert.equal(
    searchPlaces(
      [{ name: "Llanfihangel-y-Creuddyn", type: "village" }],
      "llanfihangel y",
    )[0].name,
    "Llanfihangel-y-Creuddyn",
  );
  assert.equal(
    searchPlaces(
      [{ name: "Cardiff", alternateName: "Caerdydd", type: "city" }],
      "Caerdydd",
    )[0].name,
    "Cardiff",
  );
});
test("coordinates accept UK points and reject outside points", () => {
  assert.equal(parseCoordinates("52.62, -1.12").lat, 52.62);
  assert.equal(parseCoordinates("Norwich"), null);
  assert.throws(() => parseCoordinates("10, 10"), /United Kingdom/);
});
test("postcodes are checked before sending explicit postcode lookups", () => {
  for (const code of ["SW1A 1AA", "BT1 5GS", "NR11AA", "GIR 0AA"])
    assert.equal(isPostcode(code), true);
  for (const code of ["London", "52.1, 0.2", "SW1A"])
    assert.equal(isPostcode(code), false);
});
test("long travel times remain meaningful for M1 journeys", () => {
  assert.equal(formatTime(3600 * 49), "49 h");
  assert.equal(formatTime(3599), "1 h");
  assert.equal(formatTime(0), "< 1 min");
});
test("map names cannot inject markup into route tables or GPX", () => {
  assert.equal(
    escapeHtml('<img onerror="x">'),
    "&lt;img onerror=&quot;x&quot;&gt;",
  );
  assert.match(
    makeGpx({ coordinates: [[52, 1]] }, { name: "A & B" }, { name: "<town>" }),
    /A &amp; B to &lt;town&gt;/,
  );
});
