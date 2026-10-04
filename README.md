# Speedymap

A static UK route planner where road numbers set travel speeds. With road speed limits enabled, a road's maximum speed in miles per hour is:

```text
effective speed = min(road number, speed limit in mph)
```

The A47 runs at up to 47 mph, the M1 at 1 mph, and an A47 segment with a 30 mph limit stays at 30 mph. Routing finds the fastest path at those speeds and calculates a normal-speed route for comparison.

With **Ignore road speed limits** checked, an A1000 runs at 1,000 mph regardless of its tagged limit. Uncheck it to apply the capped rule above. Unnumbered roads keep their normal limits. Road details and shared URLs use the selected mode.

The app opens with a precomputed London to Edinburgh route at exact road-number speeds, plus its normal-speed comparison. This does not download the full graph. Completed journeys are saved in IndexedDB and reused when the endpoints, speed mode and road snapshot match. The cache holds up to eight results within 25 MiB. Unavailable browser storage disables saved results.

The rule covers mapped A, B, C, M and U road references, including `A1(M)` and `M6 Toll` (1 and 6 mph respectively). A single-letter suffix keeps the integer part: `C1K` counts as 1. Numbers come from recognised road-reference tags; digits in ordinary road names do not set a cap. For a segment carrying several road references, the smallest positive road number is used. Unnumbered roads and unrecognised references keep their normal speed limit.

Search for a town or village, enter coordinates or a full UK postcode, or pick endpoints on the map. Routes have a road breakdown, shareable URL and GPX export. Hover, focus or click a road label for its name, speed limit and calculated maximum speed. [Postcodes.io](https://postcodes.io/) provides postcode lookup, and OpenStreetMap provides online map tiles. Routing uses the local road database in your browser.

## Run locally

Use Node.js 24 or later. The generated UK road database is included in `public/data`; Python is only needed when rebuilding it.

```sh
npm ci
npm run dev
```

```sh
npm test
npm run build
npm run preview
```

Vite builds the static site in `dist/`. Relative asset paths support GitHub Pages repository paths and domain roots.

Optional browser checks use the compiled app, the checked-in full UK snapshot and a GitHub Pages-style subpath:

```sh
npx playwright install chromium
npm run test:browser
```

## GitHub Pages

If this directory is not a Git checkout, initialise it and commit the files:

```sh
git init -b main
git add .
git commit -m 'Build Speedymap'
```

With the GitHub CLI authenticated, create a public repository and push:

```sh
gh repo create speedymap --public --source=. --remote=origin --push
```

Alternatively, create an empty repository on GitHub, add its URL as the `origin` remote and push the default branch. Select **Settings > Pages > Build and deployment > Source: GitHub Actions**. See GitHub's [publishing setup](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site). If the first workflow ran before Pages was enabled, rerun it from the Actions tab.

The included workflow installs dependencies, runs the routing tests, builds the app, checks the database, precomputed default journey and site size, and deploys `dist/`. Only the default branch deploys; pull requests and other branches run the checks. Normal deployments reuse the checked-in road database and default journey.

To refresh the roads, open **Actions > Build and deploy Speedymap > Run workflow** on the default branch and enable **Refresh the UK road database before publishing**. The workflow downloads the latest OpenStreetMap extract, rebuilds the graph and recalculates the default journey. It does not commit generated files. Later normal deployments use the committed snapshot. To keep a refresh, rebuild locally and commit `public/data` and `public/default-route.json.gz`.

The workflow checks the site against GitHub Pages' [1 GB published-site limit](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) and keeps individual files below 100 MiB.

## Example detours

These results use the capped rule and the 3 October snapshot. The third column applies the rule to the same path chosen by normal routing. The fourth gives the fastest route under the rule. Times assume continuous travel at the calculated maximum speeds.

| Journey | Fastest normal route | Normal path with number caps | Fastest capped detour | Main detour roads |
| --- | --- | --- | --- | --- |
| Nottingham to Sheffield | 44 min / 38.1 mi | 15 h 59 min | 54 min / 41.1 mi | A611, A617, A61 |
| Leicester to Sheffield | 1 h 7 min / 64.3 mi | 37 h 26 min | 1 h 26 min / 70.1 mi | A46, A6097, A617, A61 |
| Doncaster to Newcastle upon Tyne | 1 h 45 min / 115.4 mi | 108 h 22 min | 2 h 16 min / 122.3 mi | A6055, A168, A167, B6275 |

The first two normal routes use the M1; the third uses the A1 and A1(M). The M1 and A1 example buttons use the Nottingham and Doncaster endpoints. For Grantham to Newark, the normal A1 route takes 18 minutes, the same path with number caps takes 8 h 54 min, and the capped route via the A52 and local roads takes 22 minutes.

With **Ignore road speed limits** enabled, Nottingham to Sheffield takes 3 min 22 sec over 79.6 miles, using A6005, B6020 and B6417 among other roads. Doncaster to Newcastle takes 5 min 59 sec over 199.2 miles, using B6160, B6278, B6274 and A6108. London to Leeds takes 11 min 14 sec over 345.6 miles. These routes use literal road-number speeds and normal limits on unnumbered roads.

## Road data and speed limits

The database comes from the [Geofabrik United Kingdom OpenStreetMap extract](https://download.geofabrik.de/europe/united-kingdom.html), covering England, Scotland, Wales and Northern Ireland. The Isle of Man and Channel Islands are outside this extract. It includes mapped public roads usable by an ordinary motor car, including eligible tracks. Footpaths, private roads, roads explicitly closed to cars, and roads restricted to customer, delivery, agricultural or forestry access are excluded. Destination-only roads are included, with access approximated using connected restricted-road components: only components containing an endpoint are available to that route. OpenStreetMap coverage and tags can be incomplete.

The included snapshot is dated **3 October 2026, 20:20:50 UTC**. It contains 8,681,452 routing points, 18,247,994 directed edges, 516,177 road-label records, 43,203 named places and 30,088 prohibited turn pairs. The complete compressed database is **385.4 MiB**; source URL, checksum and exact counts are recorded in `public/data/manifest.json`.

Direction-specific OpenStreetMap speed limits are used where available. Numeric limits expressed in km/h are converted to mph, and UK national-speed-limit and urban speed-type tags are interpreted. When a limit is missing, the graph records an inferred limit: 70 mph for motorways and their links, 60 mph for rural roads, and 20 mph in Wales or 30 mph elsewhere for roads classified as urban. Urban inference uses residential, living-street and service-road classes, or `lit=yes`. These are assumptions, and the route breakdown identifies inferred limits.

Ferries are excluded, so routes requiring a sea crossing, including between Great Britain and Northern Ireland, have no continuous road path. Routing honours one-way roads, mapped car-access rules and node-based `no_*` and `only_*` turn restrictions. Reversible and alternating one-way roads are excluded. Conditional access, conditional speed limits and via-way turn restrictions are not fully handled; the manifest's `limitations` field records their counts. Travel times do not include congestion, traffic lights or stops.

## Browser routing

Routes are calculated locally in a JavaScript worker using directed A* over the complete UK graph. An admissible distance/speed heuristic preserves the minimum-time result, and incoming-edge states enforce supported turn restrictions. The road-number rule changes each edge's cost before the search, so the experiment can choose a different route from the normal-speed comparison.

The default result is **374 kB (365 KiB)** compressed, including both routes and their geometry. The first uncached journey downloads **203.5 MiB** of graph and metadata. The default and saved results skip this download. Graph arrays occupy **430 MiB** after decompression. Allow about **1.5 GB of available browser memory** for the worker and temporary buffers; a desktop browser is recommended. Geometry loads as needed, bringing the complete database to **385.4 MiB**. Use a current Chrome, Edge, Firefox or Safari with workers, typed arrays and `DecompressionStream` support.

Endpoints initially snap to the nearest graph node within 5 km. Starts need an outgoing edge and destinations need an incoming edge, except for a zero-length journey at the same node. If those nodes lie in disconnected road components or fail this direction check, the engine considers nearby eligible nodes in a shared component and chooses the pair with the smallest combined offset. Each alternative can be at most 250 m farther from its endpoint than the nearest node, within the same 5 km overall limit. This avoids some isolated service roads; one-way chains and destination-access gateways can still leave a centre point unreachable. Selecting a nearby point on a public road can resolve those cases.

The builder adds nodes along road shapes at roughly 250 m intervals; endpoints do not snap to arbitrary points along edges. The app shows the snapping offsets when either exceeds 250 m, and offsets are excluded from route distance and time. Geometry chunks are fetched as needed after a route is found and cached separately from the routing graph. Cancelling a route keeps an already loaded graph in memory; cancelling the initial database load requires a reload on the next route.

## Refresh the database locally

Use Python 3.11 or later, several GB of free disk space and approximately 10 GiB of available memory for a full UK build. The source extract is about 2.3 GB, and processing time depends on the machine.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python scripts/download_osm.py
.venv/bin/python scripts/build_graph.py \
  --input .cache/united-kingdom-latest.osm.pbf \
  --output public/data \
  --region 'United Kingdom' \
  --source-url https://download.geofabrik.de/europe/united-kingdom-latest.osm.pbf \
  --location-index sparse_file_array,.cache/node-locations.bin
.venv/bin/python scripts/validate_data.py public/data
node scripts/build_default_route.mjs
npm test
npm run build
```

The downloader verifies Geofabrik's MD5 checksum and fetches the Wales boundary used for speed-limit inference. Downloaded source files and temporary build files remain in the ignored `.cache/` directory. The disk-backed node-location index reduces peak memory and is removed after import. The builder writes compressed graph and geometry chunks, road metadata, place names, turn restrictions and a versioned manifest with the dated source URL and checksum into `public/data`.

The default-journey generator writes `public/default-route.json.gz`, including both routes and their geometry. Regenerate it after changing the road snapshot or routing cache version; the deployment checks that it matches the current database and default request.

Run the generator's fixture tests with `.venv/bin/python -m unittest discover -s scripts/tests -v`. Database-refresh deployments run these before downloading and rebuilding the full extract, then validate every compressed file and its graph/geometry references. See [the database format](DATA_FORMAT.md) for the binary layout, source provenance and detailed import policies.

## Licensing

Application source code is [MIT licensed](LICENSE). Road data: Copyright OpenStreetMap contributors, licensed under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Keep attribution and the ODbL terms when distributing or modifying the database. See [OpenStreetMap copyright and attribution](https://www.openstreetmap.org/copyright). The source extract and rebuild commands are above.
