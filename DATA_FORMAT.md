# Routing database

`public/data` contains public roads usable by cars from the Geofabrik United Kingdom OpenStreetMap extract. The extract covers Great Britain and Northern Ireland, excluding the Isle of Man and Channel Islands. Coverage depends on OpenStreetMap, including its speed-limit and access tags.

The files contain a directed graph, road labels, turn restrictions, place names and road geometry. A new route loads the graph and labels; its geometry loads separately. The default journey and previously saved results do not need the graph. Binary values use little endian. Coordinates use WGS84 signed integer microdegrees; divide by 1,000,000 for decimal degrees.

## Build and reproduce

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/download_osm.py
.venv/bin/python scripts/build_graph.py --input .cache/united-kingdom-latest.osm.pbf --output public/data
.venv/bin/python -m unittest discover -s scripts/tests -v
.venv/bin/python scripts/validate_data.py public/data
node scripts/build_default_route.mjs
```

The downloader resolves Geofabrik's dated PBF URL, resumes up to eight byte ranges, validates the published MD5 checksum, and downloads the Wales polygon into the same cache directory. The builder reads the PBF replication timestamp. For an exact replay, pass the dated `--url` to the downloader and `--source-url` to the builder. The source PBF, temporary files, and Python environment are ignored by Git. Building uses Python, pyosmium, and NumPy; running the website needs none of these and has no routing server.

Optional builder arguments include `--wales-polygon PATH`, `--max-segment 250`, `--source-date ISO_TIMESTAMP`, and `--region LABEL`. For a machine with limited RAM, `--location-index sparse_file_array,.cache/node-locations.bin` puts the node cache on disk; this temporary index is freshly created and removed by the builder. The downloader's `.source.json` record supplies the dated URL, source file size and MD5 in the manifest; the builder verifies those values before reading. Tests use small actual OSM XML fixtures and validate access, one-way direction, directional speed, Wales defaults, turn restrictions, shape splitting, and binary integrity. The independent validator checks every directed geometry endpoint and recomputes all geometry arc lengths to verify routing costs, in addition to all asset hashes and indices.

## Manifest

`manifest.json` has `schemaVersion: 1`. Each generated gzip asset has a SHA-256 content hash in its filename, for example `graph-000.abcdef1234567890.bin.gz` or `roads.abcdef1234567890.json.gz`. Graph and lazy geometry loaded from the same manifest therefore cannot be confused with a newly deployed snapshot at the same URL. The builder removes obsolete generated gzip files and atomically replaces the manifest after all assets are ready. Important fields:

| Field | Meaning |
| --- | --- |
| `region`, `source`, `sourceDate`, `generatedAt` | Extract label, attribution/license/source URL, OSM data timestamp, build timestamp |
| `nodes`, `edges`, `geometries`, `roadCount`, `placeCount`, `restrictionCount` | Counts in the derived database |
| `bounds` | `[minimumLongitude, minimumLatitude, maximumLongitude, maximumLatitude]` |
| `graphBytes` | Total inflated graph bytes |
| `initialCompressedBytes`, `totalCompressedBytes` | Compressed graph/JSON bytes, and graph/JSON/all-geometry bytes |
| `sections` | Named typed graph arrays and their absolute offsets |
| `graphChunks` | Ordered gzip files making up the graph buffer |
| `roadsFile`, `placesFile`, `restrictionsFile` | Paths of gzip-compressed UTF-8 JSON arrays relative to the manifest |
| `geometryChunks` | Geometry gzip files with ranges of global geometry IDs |
| `maxSegmentMetres` | Maximum approximate arc length between graph vertices |
| `missingLimitEdgeCount`, `inferredLimitPolicy`, `limitations` | Inferred limits and unsupported OSM features |

Each section is `{name, type, count, byteOffset, byteLength}`. `type` is `Int32`, `Uint32`, `Float32`, `Uint16`, or `Uint8`. All section starts align to four bytes; padding bytes are zero. Each graph chunk is `{file, byteOffset, byteLength, compressedBytes}`, with up to 16 MiB of inflated bytes. Decompress and place each chunk at its `byteOffset` in a buffer of `graphBytes` bytes. Gzip files are ordinary static assets, requiring no content-encoding configuration.

## Graph arrays

The arrays occur in this order. `N = nodes`, `E = edges`.

| Name | Type and count | Meaning |
| --- | --- | --- |
| `lat` | `Int32[N]` | Node latitude, microdegrees |
| `lon` | `Int32[N]` | Node longitude, microdegrees |
| `offsets` | `Uint32[N+1]` | Node `n` outgoing edges occupy `[offsets[n], offsets[n+1])` |
| `targets` | `Uint32[E]` | Destination graph node for each directed edge |
| `lengths` | `Float32[E]` | Road arc length in metres, along all shape points |
| `limits` | `Uint16[E]` | Direction-specific car limit in tenths of mph |
| `roads` | `Uint32[E]` | Road metadata index |
| `geometryRefs` | `Uint32[E]` | Low 31 bits are global geometry ID; bit 31 reverses point order |
| `flags` | `Uint8[E]` | Bit 0: inferred limit; bit 1: destination-only car access |

Graph vertices retain intersections, OSM way endpoints, and turn restriction via nodes. Long geometry legs are split with interpolated vertices; every graph edge has approximately at most 250 metres of road geometry. Shapes preserve the original intermediate OSM points. Snapping to a nearest graph vertex approximates the actual endpoint by part of a segment. Overpasses connect only where OSM shares the node, never because their coordinates intersect.

Bidirectional roads have two edges sharing one geometry ID. The reversed edge sets `geometryRefs & 0x80000000`. CSR sorting determines final edge IDs; turn restrictions reference these final IDs.

## Road metadata and geometry

The `roadsFile` gzip asset is an array of `{ref, name, highway}` objects. `ref` is exactly the OSM way reference. Empty references remain unnumbered. References on junctions or slip roads are used only when the way itself has that reference; the importer does not guess a connecting road number. Semicolon-separated references remain intact for the routing engine's documented numeric interpretation.

Each geometry chunk in the manifest is `{file, start, count, byteLength, compressedBytes}`. It contains:

1. `Uint32 geometryCount`
2. `Uint32 pointCount`
3. `Uint32 offsets[geometryCount+1]`
4. `Int32 lat[pointCount]`
5. `Int32 lon[pointCount]`

The chunk covers global geometry IDs `[start, start+count)`. For global ID `g`, local ID `g-start` selects points `[offsets[local], offsets[local+1])`. Geometry begins and ends at the graph vertices and includes all original shape points between them. Reverse the decoded points if the directed edge's high bit is set.

## Speeds and travel time

Explicit directional `maxspeed:forward`/`maxspeed:backward` takes precedence over `maxspeed`. OSM numeric values without units are km/h; `mph`, UK national-limit values such as `GB:nsl_single` and `GB:nsl_dual`, and tagged source/type defaults are interpreted. If only valid lane limits exist, the highest lane limit gives the fastest permissible car speed. Valid semicolon-separated speed values use the lowest value conservatively.

Missing or unrecognised limits use **inferred** defaults: 70 mph for motorway/motorway links, 60 mph for rural roads, and 20 mph in Wales or 30 mph elsewhere for urban roads. The urban heuristic is `residential`, `living_street`, or `service`, or `lit=yes`. The Wales classification tests the first OSM point of the way against Geofabrik's Wales polygon; ways crossing the boundary are classified as a whole. Unknown dual carriageways conservatively use 60 mph unless tagging supplies their national dual-carriageway limit. Inference is visible in bit 0 and counted in the manifest; it is not a verified legal limit.

The browser supports normal speed limits, `min(roadNumber, limit)` and the road number itself in mph. Unnumbered roads retain the base limit in all three modes. Edge time is `lengthMetres / (speedMph * 0.44704)` seconds. The model has no congestion, traffic-light delay, acceleration, gradient, lane or weather adjustment.

## Access and turn restrictions

Supported road classes: motorway, trunk, primary, secondary, tertiary, their `_link` classes, unclassified, residential, living_street, service, road, and track. Area highways are excluded. Car access uses OSM mode precedence `motorcar`, then `motor_vehicle`, then `vehicle`, then `access`, including directional forms. `no`, `private`, `customers`, `delivery`, `agricultural`, and `forestry` are excluded. `permissive` and untagged access are included. `destination` is retained with flag bit 1; the routing engine permits destination components attached to the chosen endpoints and prevents unrelated through-routing. Untagged tracks may be rough or unsuitable for an ordinary car; surfaces and vehicle dimensions are not modelled.

One-way tags, `oneway=-1`, implied motorway one-way, roundabouts and circular junctions are supported. Reversible/alternating roads are excluded. Nodes with denied car access, and bollards/blocks/bus traps/cycle barriers without explicit car permission, prevent adjacent graph edges from connecting across the obstruction. Untagged gates are traversable. This conservative obstruction handling can omit the short piece of road next to a barrier.

The `restrictionsFile` gzip asset is `[[incomingEdgeId, outgoingEdgeId], ...]` of prohibited turns. Unconditional node-via `no_*` and `only_*` restrictions applying to cars are compiled to forbidden pairs. Vehicle exception lists and motorcar/motor_vehicle restriction tags are supported. U-turn restrictions distinguish reversal from straight travel on the same OSM way.

**Limitations:** via-way turn restrictions and conditional turn/access/speed rules are counted but not evaluated. Conditional road rules retain their unconditional/default behavior. Restriction relations referencing excluded roads or missing graph nodes are counted as unresolved. Ferries, car trains, seasonal availability, toll preferences, vehicle width/height/weight restrictions, and car park entry rules are outside this graph. Great Britain and Northern Ireland therefore have separate road components, so a route between them cannot be calculated without a ferry dataset.

## Places and licensing

The `placesFile` gzip asset is an offline OSM gazetteer of named `place=city|town|village|hamlet|suburb` nodes: `[{name, lat, lng, type, alternateName?}]`. Coordinates here are decimal degrees. It includes only place nodes, so some localities tagged exclusively as areas are absent; the map permits endpoint selection independently of place-name search.

The database is licensed under ODbL 1.0; its notice is in `public/data/LICENSE.txt`. Display attribution "Copyright OpenStreetMap contributors" linked to https://www.openstreetmap.org/copyright. Geofabrik supplies the extract. The source extract and build scripts can reproduce the database. The application's MIT license applies to the code, not the data.

Primary references: [Geofabrik United Kingdom extract](https://download.geofabrik.de/europe/united-kingdom.html), [OSM maxspeed tagging](https://wiki.openstreetmap.org/wiki/Key:maxspeed), [OSM turn restrictions](https://wiki.openstreetmap.org/wiki/Relation:restriction), [UK speed limits](https://www.gov.uk/speed-limits), [Welsh 20 mph guidance](https://www.gov.wales/introducing-20mph-speed-limits-frequently-asked-questions), and [ODbL](https://opendatacommons.org/licenses/odbl/1-0/).
