#!/usr/bin/env python3
"""Build a static, browser-readable public-car routing graph from OSM PBF/XML."""
from __future__ import annotations

import argparse
from array import array
from collections import Counter, defaultdict
from datetime import datetime, timezone
import gc
import gzip
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import time

import numpy as np
import osmium

HIGHWAYS = {
    "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
    "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
    "residential", "living_street", "service", "road", "track",
}
DENIED = {"no", "private", "agricultural", "forestry", "delivery", "customers"}
URBAN_HIGHWAYS = {"residential", "living_street", "service"}
PLACE_TYPES = {"city", "town", "village", "hamlet", "suburb"}
EARTH_RADIUS = 6371008.8
SCALE = 1_000_000


def log(message):
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def distance(a, b):
    lat1, lat2 = math.radians(a[0] / SCALE), math.radians(b[0] / SCALE)
    dlat, dlon = lat2 - lat1, math.radians((b[1] - a[1]) / SCALE)
    value = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return EARTH_RADIUS * 2 * math.atan2(math.sqrt(value), math.sqrt(max(0, 1 - value)))


class Polygon:
    """Geofabrik .poly point containment (outer rings and holes)."""
    def __init__(self, path=None):
        self.rings = []
        if not path or not Path(path).exists():
            return
        current, hole = None, False
        for line in Path(path).read_text().splitlines()[1:]:
            tokens = line.split()
            if not tokens:
                continue
            if tokens[0] == "END":
                if current:
                    xs, ys = zip(*current)
                    self.rings.append((current, hole, (min(xs), min(ys), max(xs), max(ys))))
                current = None
            elif len(tokens) == 1:
                current, hole = [], tokens[0].startswith("!")
            elif current is not None:
                current.append((float(tokens[0]), float(tokens[1])))

    def contains(self, lat, lon):
        result = False
        for points, hole, (minx, miny, maxx, maxy) in self.rings:
            if not (minx <= lon <= maxx and miny <= lat <= maxy):
                continue
            inside = False
            a = points[-1]
            for b in points:
                if (a[1] > lat) != (b[1] > lat) and lon < (b[0] - a[0]) * (lat - a[1]) / (b[1] - a[1]) + a[0]:
                    inside = not inside
                a = b
            if inside:
                if hole:
                    return False
                result = True
        return result


def access_value(tags, direction=None):
    for key in ("motorcar", "motor_vehicle", "vehicle", "access"):
        if direction and f"{key}:{direction}" in tags:
            return tags[f"{key}:{direction}"].strip().lower()
        if key in tags:
            return tags[key].strip().lower()
    return "yes"


def access_allowed(tags, direction=None):
    return access_value(tags, direction) not in DENIED


def parse_speed(raw):
    """Return mph, or None. OSM bare numeric values are km/h."""
    if not raw:
        return None
    raw = raw.strip().lower()
    symbolic = {
        "gb:nsl_single": 60, "uk:nsl_single": 60, "gb:nsl_dual": 70, "uk:nsl_dual": 70,
        "gb:motorway": 70, "uk:motorway": 70, "gb:urban": 30, "uk:urban": 30,
        "gb:restricted": 30, "gb:urban:20": 20, "gb:zone20": 20,
    }
    if raw in symbolic:
        return symbolic[raw]
    match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(mph|km/h|kmh|kph|knots)?", raw)
    if not match:
        return None
    value = float(match.group(1))
    unit = match.group(2)
    if unit == "mph":
        mph = value
    elif unit == "knots":
        mph = value * 1.15077945
    else:
        mph = value / 1.609344
    return mph if 0 < mph <= 150 else None


def speed_limit(tags, direction, in_wales):
    raw = tags.get(f"maxspeed:{direction}", tags.get("maxspeed"))
    speed = parse_speed(raw)
    if speed is None and raw and ";" in raw:
        values = [parse_speed(value) for value in raw.split(";")]
        if all(value is not None for value in values):
            speed = min(values)
    if speed is not None:
        return round(speed * 10), 0
    lanes = tags.get(f"maxspeed:lanes:{direction}", tags.get("maxspeed:lanes", ""))
    lane_values = [parse_speed(value) for value in lanes.split("|")]
    if lanes and all(value is not None for value in lane_values):
        return round(max(lane_values) * 10), 0
    # An explicit UK national-limit/type annotation conveys the applicable limit.
    for key in ("maxspeed:type", "source:maxspeed"):
        source = tags.get(key, "").lower()
        parsed = parse_speed(source)
        if parsed is not None:
            if source in {"gb:urban", "uk:urban", "gb:restricted"} and in_wales:
                parsed = 20
            return round(parsed * 10), 0
    highway = tags.get("highway", "")
    if highway in {"motorway", "motorway_link"}:
        fallback = 70
    elif highway in URBAN_HIGHWAYS or tags.get("lit") == "yes":
        fallback = 20 if in_wales else 30
    else:
        fallback = 60
    return fallback * 10, 1


def directions(tags):
    value = tags.get("oneway:motorcar", tags.get("oneway:motor_vehicle", tags.get("oneway", ""))).lower()
    if value in {"reversible", "alternating"}:
        return False, False
    implicit = tags.get("highway") == "motorway" or tags.get("junction") in {"roundabout", "circular"}
    forward = value != "-1"
    backward = value == "-1" or value in {"no", "0", "false"} or (value not in {"yes", "1", "true"} and not implicit)
    return forward and access_allowed(tags, "forward"), backward and access_allowed(tags, "backward")


class Collector(osmium.SimpleHandler):
    def __init__(self, wales):
        super().__init__()
        self.wales = wales
        self.ways = []
        self.uses = {}
        self.ends = set()
        self.barriers = set()
        self.roads = []
        self.road_index = {}
        self.restrictions = []
        self.places = []
        self.stats = Counter()

    def node(self, node):
        if not len(node.tags):
            return
        tags = dict(node.tags)
        if tags.get("place") in PLACE_TYPES and tags.get("name") and node.location.valid():
            place = {"name": tags["name"], "lat": node.location.lat, "lng": node.location.lon, "type": tags["place"]}
            if tags.get("name:cy"):
                place["alternateName"] = tags["name:cy"]
            self.places.append(place)
        blocked_barrier = tags.get("barrier") in {"bollard", "block", "bus_trap", "cycle_barrier", "jersey_barrier", "sump_buster"}
        explicit_car = tags.get("motorcar", tags.get("motor_vehicle")) in {"yes", "designated", "permissive"}
        if not access_allowed(tags) or (blocked_barrier and not explicit_car):
            self.barriers.add(node.id)

    def way(self, way):
        if way.tags.get("highway") not in HIGHWAYS:
            return
        tags = dict(way.tags)
        if tags.get("highway") not in HIGHWAYS or tags.get("area") == "yes":
            return
        forward, backward = directions(tags)
        if not (forward or backward):
            self.stats["excludedAccessWays"] += 1
            return
        if len(way.nodes) < 2 or not all(node.location.valid() for node in way.nodes):
            self.stats["missingLocationWays"] += 1
            return
        ids = array("q", (node.ref for node in way.nodes))
        coords = array("i")
        for node in way.nodes:
            coords.extend((round(node.location.lat * SCALE), round(node.location.lon * SCALE)))
            self.uses[node.ref] = min(2, self.uses.get(node.ref, 0) + 1)
        self.ends.update((ids[0], ids[-1]))
        in_wales = self.wales.contains(coords[0] / SCALE, coords[1] / SCALE)
        road_key = (tags.get("ref", ""), tags.get("name", ""), tags["highway"])
        road = self.road_index.get(road_key)
        if road is None:
            road = len(self.roads)
            self.road_index[road_key] = road
            self.roads.append(dict(zip(("ref", "name", "highway"), road_key)))
        flimit, fflag = speed_limit(tags, "forward", in_wales)
        blimit, bflag = speed_limit(tags, "backward", in_wales)
        if access_value(tags, "forward") == "destination":
            fflag |= 2
        if access_value(tags, "backward") == "destination":
            bflag |= 2
        self.ways.append((way.id, ids, coords, road, forward, backward, flimit, blimit, fflag, bflag))
        self.stats["acceptedWays"] += 1
        if any("conditional" in key for key in tags):
            self.stats["conditionalWays"] += 1
        if tags.get("oneway") in {"reversible", "alternating"}:
            self.stats["variableOnewayWays"] += 1
        if len(self.ways) % 100000 == 0:
            log(f"Read {len(self.ways):,} car ways, {len(self.uses):,} road shape nodes")

    def relation(self, relation):
        if relation.tags.get("type") != "restriction":
            return
        tags = dict(relation.tags)
        if tags.get("type") != "restriction":
            return
        restriction = tags.get("restriction:motorcar", tags.get("restriction:motor_vehicle", tags.get("restriction", "")))
        exceptions = {value.strip() for value in re.split(r"[;,]", tags.get("except", ""))}
        if exceptions & {"motorcar", "motor_vehicle", "vehicle"}:
            return
        if any("conditional" in key for key in tags):
            self.stats["conditionalTurnRestrictions"] += 1
            return
        members = [(member.type, member.ref, member.role) for member in relation.members]
        via = [ref for type_, ref, role in members if role == "via" and type_ == "n"]
        if len(via) != 1 or any(type_ == "w" and role == "via" for type_, _, role in members):
            self.stats["viaWayTurnRestrictions"] += 1
            return
        from_ = [ref for type_, ref, role in members if type_ == "w" and role == "from"]
        to = [ref for type_, ref, role in members if type_ == "w" and role == "to"]
        if from_ and to and restriction.startswith(("no_", "only_")):
            self.restrictions.append((restriction, from_, to, via[0]))
            self.ends.add(via[0])


def gzip_json(path, value):
    with gzip.GzipFile(filename=str(path), mode="wb", mtime=0, compresslevel=6) as target:
        target.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())


def content_address_files(output, manifest):
    """Name immutable assets by content, then remove obsolete generated gzip files."""
    output = Path(output)
    retained = set()

    def rename(name, prefix, suffix):
        old_path = output / name
        with old_path.open("rb") as source_file:
            digest = hashlib.file_digest(source_file, "sha256").hexdigest()
        new_name = f"{prefix}.{digest[:16]}.{suffix}.gz"
        if new_name != name:
            old_path.replace(output / new_name)
        retained.add(new_name)
        return new_name

    for group, prefix in (("graphChunks", "graph"), ("geometryChunks", "geometry")):
        for index, chunk in enumerate(manifest[group]):
            chunk["file"] = rename(chunk["file"], f"{prefix}-{index:03}", "bin")
    for key, prefix in (("roadsFile", "roads"), ("placesFile", "places"), ("restrictionsFile", "restrictions")):
        manifest[key] = rename(manifest[key], prefix, "json")
    for path in output.glob("*.gz"):
        if path.name not in retained and path.name.startswith(("graph-", "geometry-", "roads.", "places.", "restrictions.")):
            path.unlink()
    manifest["assetNaming"] = "SHA-256 content hash prefix (16 hex characters)"
    return manifest


def build(input_path, output, wales_polygon=None, region="United Kingdom", source_url=None, source_date=None, max_segment=250, location_index="flex_mem"):
    if max_segment <= 0:
        raise ValueError("Maximum segment length must be positive")
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    source_record_path = Path(input_path).with_suffix(Path(input_path).suffix + ".source.json")
    source_record = {}
    if source_record_path.exists():
        source_record = json.loads(source_record_path.read_text())
        if Path(input_path).stat().st_size != source_record.get("bytes"):
            raise ValueError("Downloaded source size does not match its provenance record")
        with Path(input_path).open("rb") as source_file:
            if hashlib.file_digest(source_file, "md5").hexdigest() != source_record.get("md5"):
                raise ValueError("Downloaded source checksum does not match its provenance record")
        if not source_url or source_url.endswith("united-kingdom-latest.osm.pbf"):
            source_url = source_record["url"]
    with osmium.io.Reader(str(input_path), osmium.osm.osm_entity_bits.NOTHING) as reader:
        header = reader.header()
        replication_date = header.get("osmosis_replication_timestamp")
    source_date = source_date or replication_date or "unknown (source file has no replication timestamp)"
    collector = Collector(Polygon(wales_polygon))
    log(f"Reading {input_path}; source {source_date}")
    index_file = None
    if location_index.startswith("sparse_file_array,"):
        index_file = Path(location_index.split(",", 1)[1])
        index_file.parent.mkdir(parents=True, exist_ok=True)
        index_file.unlink(missing_ok=True)
    try:
        # The native location handler sees every node first; skip Python callbacks
        # for untagged shape nodes (the majority of a country-sized extract).
        collector.apply_file(str(input_path), locations=True, idx=location_index, filters=[osmium.filter.EmptyTagFilter()])
    finally:
        if index_file:
            index_file.unlink(missing_ok=True)
    log(f"Read {len(collector.ways):,} accepted ways and {len(collector.restrictions):,} node-via restrictions")
    junctions = {ref for ref, count in collector.uses.items() if count > 1}
    junctions.update(collector.ends)
    collector.uses.clear()
    collector.ends.clear()
    gc.collect()
    node_index = {}
    node_lat, node_lon = array("i"), array("i")
    edge_from, edge_to = array("I"), array("I")
    edge_lengths, edge_limits = array("f"), array("H")
    edge_roads, edge_geoms, edge_flags = array("I"), array("I"), array("B")
    geometry_offsets, geometry_lat, geometry_lon = array("I", [0]), array("i"), array("i")
    relevant_ways = {way for _, from_, to, _ in collector.restrictions for way in from_ + to}
    restriction_edges = defaultdict(list)
    synthetic_id = -1

    def graph_node(ref, point):
        index = node_index.get(ref)
        if index is None:
            index = len(node_lat)
            node_index[ref] = index
            node_lat.append(point[0])
            node_lon.append(point[1])
        return index

    def emit(way_id, start_ref, end_ref, points, length, road, forward, backward, flimit, blimit, fflag, bflag):
        if length < 0.01 or start_ref in collector.barriers or end_ref in collector.barriers:
            return
        a, b = graph_node(start_ref, points[0]), graph_node(end_ref, points[-1])
        geometry = len(geometry_offsets) - 1
        for lat, lon in points:
            geometry_lat.append(lat)
            geometry_lon.append(lon)
        geometry_offsets.append(len(geometry_lat))
        for allow, source, target, limit, flag, reverse in (
            (forward, a, b, flimit, fflag, False), (backward, b, a, blimit, bflag, True)
        ):
            if not allow:
                continue
            edge = len(edge_from)
            edge_from.append(source)
            edge_to.append(target)
            edge_lengths.append(length)
            edge_limits.append(limit)
            edge_roads.append(road)
            edge_geoms.append(geometry | (0x80000000 if reverse else 0))
            edge_flags.append(flag)
            if way_id in relevant_ways:
                restriction_edges[way_id].append(edge)

    for way_number, way in enumerate(collector.ways):
        way_id, ids, coords, road, forward, backward, flimit, blimit, fflag, bflag = way
        start_ref = ids[0]
        points = [(coords[0], coords[1])]
        accumulated = 0.0
        for index in range(1, len(ids)):
            end_point = (coords[2 * index], coords[2 * index + 1])
            previous = points[-1]
            remaining = distance(previous, end_point)
            # A rounded split can coincide with an original shape vertex and
            # leave the previous span a few centimetres above its target. Flush
            # that span before calculating another fraction, which must stay
            # positive; a negative fraction would extrapolate off the road.
            if accumulated >= max_segment - 0.25 and remaining > 0.01:
                emit(way_id, start_ref, ids[index - 1], points, accumulated, road, forward, backward, flimit, blimit, fflag, bflag)
                start_ref, points, accumulated = ids[index - 1], [previous], 0.0
            while accumulated + remaining > max_segment + 0.001:
                fraction = (max_segment - accumulated) / remaining
                intermediate = (round(previous[0] + (end_point[0] - previous[0]) * fraction), round(previous[1] + (end_point[1] - previous[1]) * fraction))
                if intermediate == previous or intermediate == end_point:
                    break
                points.append(intermediate)
                emit(way_id, start_ref, synthetic_id, points, accumulated + distance(previous, intermediate), road, forward, backward, flimit, blimit, fflag, bflag)
                start_ref = synthetic_id
                synthetic_id -= 1
                points = [intermediate]
                accumulated = 0.0
                previous = intermediate
                remaining = distance(previous, end_point)
            points.append(end_point)
            accumulated += remaining
            if ids[index] in junctions or index == len(ids) - 1 or ids[index] in collector.barriers:
                emit(way_id, start_ref, ids[index], points, accumulated, road, forward, backward, flimit, blimit, fflag, bflag)
                start_ref, points, accumulated = ids[index], [end_point], 0.0
        collector.ways[way_number] = None
        if (way_number + 1) % 100000 == 0:
            log(f"Segmented {way_number + 1:,} ways: {len(node_lat):,} graph nodes, {len(edge_to):,} edges")
    collector.ways.clear()
    junctions.clear()
    gc.collect()
    if not edge_to:
        raise ValueError("Source contains no usable public-car edges")
    log(f"Sorting {len(edge_to):,} edges into compressed sparse rows")
    source_array = np.asarray(edge_from, dtype="<u4")
    order = np.argsort(source_array, kind="stable")
    old_to_new = np.empty(len(order), dtype="<u4")
    old_to_new[order] = np.arange(len(order), dtype="<u4")
    counts = np.bincount(source_array, minlength=len(node_lat))
    offsets = np.empty(len(node_lat) + 1, dtype="<u4")
    offsets[0] = 0
    np.cumsum(counts, out=offsets[1:])
    # Resolve no/only node-via restrictions against directed edges, then CSR IDs.
    outgoing_at_via = defaultdict(list)
    vias = {node_index[via] for _, _, _, via in collector.restrictions if via in node_index}
    for via in vias:
        outgoing_at_via[via] = [int(order[edge]) for edge in range(int(offsets[via]), int(offsets[via + 1]))]
    forbidden = set()
    for kind, from_ways, to_ways, via_ref in collector.restrictions:
        via = node_index.get(via_ref)
        if via is None:
            collector.stats["unresolvedTurnRestrictions"] += 1
            continue
        incoming = [edge for way in from_ways for edge in restriction_edges[way] if edge_to[edge] == via]
        permitted = {edge for way in to_ways for edge in restriction_edges[way] if edge_from[edge] == via}
        if not incoming or not permitted:
            collector.stats["unresolvedTurnRestrictions"] += 1
            continue
        for a in incoming:
            for b in outgoing_at_via[via]:
                reversal = edge_from[a] == edge_to[b]
                matched = b in permitted
                if kind.endswith("u_turn"):
                    matched = matched and reversal
                elif from_ways == to_ways:
                    matched = matched and not reversal
                prohibited = (matched if kind.startswith("no_") else not matched)
                if prohibited:
                    forbidden.add((int(old_to_new[a]), int(old_to_new[b])))
    del old_to_new, outgoing_at_via, restriction_edges, relevant_ways, node_index
    arrays = [
        ("lat", np.asarray(node_lat, dtype="<i4")), ("lon", np.asarray(node_lon, dtype="<i4")),
        ("offsets", offsets), ("targets", np.asarray(edge_to, dtype="<u4")[order]),
        ("lengths", np.asarray(edge_lengths, dtype="<f4")[order]), ("limits", np.asarray(edge_limits, dtype="<u2")[order]),
        ("roads", np.asarray(edge_roads, dtype="<u4")[order]), ("geometryRefs", np.asarray(edge_geoms, dtype="<u4")[order]),
        ("flags", np.asarray(edge_flags, dtype="u1")[order]),
    ]
    types = {"i": "Int", "u": "Uint", "f": "Float"}
    sections, chunks = [], []
    graph_buffer = bytearray()
    byte_offset = 0
    chunk_size = 16 * 1024 * 1024

    def flush_graph_chunk(final=False):
        nonlocal graph_buffer, byte_offset
        while len(graph_buffer) >= chunk_size or (final and graph_buffer):
            length = min(chunk_size, len(graph_buffer))
            path = output / f"graph-{len(chunks):03}.bin.gz"
            with gzip.GzipFile(filename=str(path), mode="wb", mtime=0, compresslevel=6) as target:
                target.write(memoryview(graph_buffer)[:length])
            chunks.append({"file": path.name, "byteOffset": byte_offset, "byteLength": length, "compressedBytes": path.stat().st_size})
            byte_offset += length
            del graph_buffer[:length]

    total_offset = 0
    for name, values in arrays:
        padding = (-total_offset) % 4
        if padding:
            graph_buffer.extend(b"\0" * padding)
            total_offset += padding
        type_ = f"{types[values.dtype.kind]}{values.dtype.itemsize * 8}"
        sections.append({"name": name, "type": type_, "count": len(values), "byteOffset": total_offset, "byteLength": values.nbytes})
        graph_buffer.extend(values.tobytes())
        total_offset += values.nbytes
        flush_graph_chunk()
    flush_graph_chunk(final=True)
    log(f"Wrote {len(chunks)} graph chunks ({total_offset / 1048576:.1f} MiB inflated)")
    geometry_chunks = []
    for start in range(0, len(geometry_offsets) - 1, 50000):
        count = min(50000, len(geometry_offsets) - 1 - start)
        first, last = geometry_offsets[start], geometry_offsets[start + count]
        path = output / f"geometry-{len(geometry_chunks):03}.bin.gz"
        local_offsets = np.asarray(geometry_offsets[start:start + count + 1], dtype="<u4") - first
        with gzip.GzipFile(filename=str(path), mode="wb", mtime=0, compresslevel=6) as target:
            target.write(struct.pack("<II", count, last - first))
            target.write(local_offsets.tobytes())
            target.write(np.asarray(geometry_lat[first:last], dtype="<i4").tobytes())
            target.write(np.asarray(geometry_lon[first:last], dtype="<i4").tobytes())
        geometry_chunks.append({"file": path.name, "start": start, "count": count, "byteLength": 8 + (count + 1) * 4 + (last - first) * 8, "compressedBytes": path.stat().st_size})
    collector.places.sort(key=lambda place: (place["name"].casefold(), place["type"], place["lat"]))
    gzip_json(output / "roads.json.gz", collector.roads)
    gzip_json(output / "places.json.gz", collector.places)
    gzip_json(output / "restrictions.json.gz", sorted(forbidden))
    missing_limits = int(np.count_nonzero(np.asarray(edge_flags, dtype="u1") & 1))
    manifest = {
        "schemaVersion": 1, "region": region, "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceDate": source_date,
        "source": {"name": "OpenStreetMap via Geofabrik", "url": source_url or str(input_path), "license": "ODbL-1.0", "attribution": "© OpenStreetMap contributors"},
        "nodes": len(node_lat), "edges": len(edge_to), "geometries": len(geometry_offsets) - 1,
        "roadCount": len(collector.roads), "placeCount": len(collector.places), "restrictionCount": len(forbidden),
        "bounds": [min(node_lon) / SCALE, min(node_lat) / SCALE, max(node_lon) / SCALE, max(node_lat) / SCALE],
        "graphBytes": total_offset, "sections": sections, "graphChunks": chunks,
        "roadsFile": "roads.json.gz", "placesFile": "places.json.gz", "restrictionsFile": "restrictions.json.gz",
        "geometryChunks": geometry_chunks, "maxSegmentMetres": max_segment,
        "missingLimitEdgeCount": missing_limits,
        "limitations": dict(collector.stats),
        "coverage": "UK public-car highway network including Northern Ireland; excludes ferries, Isle of Man and Channel Islands",
        "inferredLimitPolicy": "Wales urban20; other UK urban30; motorway/link70; rural60 mph. Urban heuristic residential/living_street/service or lit=yes. Flag bit0 marks every inferred edge.",
    }
    manifest["totalCompressedBytes"] = sum(item["compressedBytes"] for item in chunks + geometry_chunks) + sum((output / manifest[key]).stat().st_size for key in ("roadsFile", "placesFile", "restrictionsFile"))
    manifest["initialCompressedBytes"] = sum(item["compressedBytes"] for item in chunks) + sum((output / manifest[key]).stat().st_size for key in ("roadsFile", "placesFile", "restrictionsFile"))
    if source_record.get("md5"):
        manifest["source"]["md5"] = source_record["md5"]
        manifest["source"]["bytes"] = source_record["bytes"]
    content_address_files(output, manifest)
    temporary_manifest = output / ".manifest.json.tmp"
    temporary_manifest.write_text(json.dumps(manifest, indent=2) + "\n")
    temporary_manifest.replace(output / "manifest.json")
    (output / "LICENSE.txt").write_text(
        "This derived routing database contains OpenStreetMap data.\n"
        "Copyright OpenStreetMap contributors; https://www.openstreetmap.org/copyright\n"
        "Database licensed under the Open Data Commons Open Database License (ODbL) 1.0:\n"
        "https://opendatacommons.org/licenses/odbl/1-0/\n"
        f"Source: {manifest['source']['url']}\nSource data date: {source_date}\n"
        "The complete derived database is supplied in this directory.\n"
        "Rebuild with scripts/download_osm.py and scripts/build_graph.py; see DATA_FORMAT.md.\n"
    )
    log(f"Complete: {manifest['nodes']:,} nodes, {manifest['edges']:,} edges, {manifest['placeCount']:,} places, {manifest['restrictionCount']:,} forbidden turns; {manifest['totalCompressedBytes'] / 1048576:.1f} MiB compressed")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", default="public/data")
    parser.add_argument("--region", default="United Kingdom")
    parser.add_argument("--source-url", default="https://download.geofabrik.de/europe/united-kingdom-latest.osm.pbf")
    parser.add_argument("--source-date")
    parser.add_argument("--wales-polygon", default=".cache/wales.poly")
    parser.add_argument("--max-segment", type=float, default=250)
    parser.add_argument("--location-index", default="flex_mem", help="OSM location index, e.g. sparse_file_array,.cache/node-locations.bin for lower RAM use")
    args = parser.parse_args()
    if args.region == "United Kingdom" and not Path(args.wales_polygon).exists():
        parser.error("Wales boundary missing: run scripts/download_osm.py, or provide --wales-polygon")
    build(args.input, args.output, args.wales_polygon, args.region, args.source_url, args.source_date, args.max_segment, args.location_index)
