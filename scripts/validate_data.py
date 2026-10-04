#!/usr/bin/env python3
"""Validate all emitted graph/geometry chunks and their cross-file references."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re

import numpy as np

DTYPES = {"Int32": "<i4", "Uint32": "<u4", "Float32": "<f4", "Uint16": "<u2", "Uint8": "u1"}


def validate(directory):
    directory = Path(directory)
    manifest = json.loads((directory / "manifest.json").read_text())
    assert manifest["schemaVersion"] == 1, "Unknown data schema"
    def load_gzip(path):
        raw = path.read_bytes()
        if manifest.get("assetNaming"):
            match = re.search(r"\.([0-9a-f]{16})\.(?:bin|json)\.gz$", path.name)
            assert match and hashlib.sha256(raw).hexdigest().startswith(match.group(1)), f"Content hash mismatch: {path}"
        return gzip.decompress(raw)
    graph = bytearray(manifest["graphBytes"])
    cursor = 0
    for chunk in manifest["graphChunks"]:
        path = directory / chunk["file"]
        assert path.stat().st_size == chunk["compressedBytes"], f"Wrong compressed size: {path}"
        data = load_gzip(path)
        assert len(data) == chunk["byteLength"], f"Wrong inflated size: {path}"
        assert chunk["byteOffset"] == cursor, "Graph chunk gap/overlap"
        graph[cursor:cursor + len(data)] = data
        cursor += len(data)
    assert cursor == len(graph), "Incomplete graph"
    arrays = {
        section["name"]: np.frombuffer(graph, dtype=DTYPES[section["type"]], count=section["count"], offset=section["byteOffset"])
        for section in manifest["sections"]
    }
    nodes, edges, geometries = manifest["nodes"], manifest["edges"], manifest["geometries"]
    assert nodes > 0 and edges > 0, "Empty graph"
    for name in ("lat", "lon"):
        assert len(arrays[name]) == nodes, f"Wrong {name} count"
    for name in ("targets", "lengths", "limits", "roads", "geometryRefs", "flags"):
        assert len(arrays[name]) == edges, f"Wrong {name} count"
    offsets = arrays["offsets"]
    assert len(offsets) == nodes + 1 and offsets[0] == 0 and offsets[-1] == edges, "Invalid CSR offsets"
    assert np.all(offsets[1:] >= offsets[:-1]), "Non-monotone CSR offsets"
    assert int(arrays["targets"].max()) < nodes, "Out-of-range graph target"
    assert np.all(np.isfinite(arrays["lengths"])) and np.all(arrays["lengths"] > 0), "Invalid edge lengths"
    assert float(arrays["lengths"].max()) <= manifest["maxSegmentMetres"] + 0.5, "Unexpectedly long graph segment"
    assert np.all(arrays["limits"] > 0), "Zero speed edge"
    assert np.count_nonzero(arrays["flags"] & 1) == manifest["missingLimitEdgeCount"], "Wrong inferred-limit count"
    roads = json.loads(load_gzip(directory / manifest["roadsFile"]))
    places = json.loads(load_gzip(directory / manifest["placesFile"]))
    turns = json.loads(load_gzip(directory / manifest["restrictionsFile"]))
    assert len(roads) == manifest["roadCount"] and int(arrays["roads"].max()) < len(roads), "Invalid road index"
    assert len(places) == manifest["placeCount"], "Wrong place count"
    assert len(turns) == manifest["restrictionCount"], "Wrong turn restriction count"
    geometry_ids = arrays["geometryRefs"] & 0x7fffffff
    assert int(geometry_ids.max()) < geometries, "Out-of-range geometry ID"
    starts_lat, starts_lon = np.empty(geometries, dtype="<i4"), np.empty(geometries, dtype="<i4")
    ends_lat, ends_lon = np.empty(geometries, dtype="<i4"), np.empty(geometries, dtype="<i4")
    geometry_lengths = np.empty(geometries, dtype="<f4")
    geometry_cursor = 0
    for chunk in manifest["geometryChunks"]:
        path = directory / chunk["file"]
        assert path.stat().st_size == chunk["compressedBytes"], f"Wrong compressed size: {path}"
        data = load_gzip(path)
        assert len(data) == chunk["byteLength"], f"Wrong inflated size: {path}"
        count, point_count = map(int, np.frombuffer(data, dtype="<u4", count=2))
        assert count == chunk["count"] and chunk["start"] == geometry_cursor, "Geometry chunk gap/overlap"
        geom_offsets = np.frombuffer(data, dtype="<u4", count=count + 1, offset=8)
        assert geom_offsets[0] == 0 and geom_offsets[-1] == point_count, "Invalid geometry offsets"
        assert np.all(geom_offsets[1:] - geom_offsets[:-1] >= 2), "Degenerate geometry"
        lat = np.frombuffer(data, dtype="<i4", count=point_count, offset=8 + 4 * (count + 1))
        lon = np.frombuffer(data, dtype="<i4", count=point_count, offset=8 + 4 * (count + 1 + point_count))
        start, end = geometry_cursor, geometry_cursor + count
        starts_lat[start:end], starts_lon[start:end] = lat[geom_offsets[:-1]], lon[geom_offsets[:-1]]
        ends_lat[start:end], ends_lon[start:end] = lat[geom_offsets[1:] - 1], lon[geom_offsets[1:] - 1]
        radians_lat = lat.astype(np.float64) * (np.pi / 180_000_000)
        radians_lon = lon.astype(np.float64) * (np.pi / 180_000_000)
        previous_lat, previous_lon = np.roll(radians_lat, 1), np.roll(radians_lon, 1)
        haversine = np.sin((radians_lat - previous_lat) / 2) ** 2
        haversine += np.cos(previous_lat) * np.cos(radians_lat) * np.sin((radians_lon - previous_lon) / 2) ** 2
        haversine = np.clip(haversine, 0, 1)
        legs = 2 * 6371008.8 * np.arctan2(np.sqrt(haversine), np.sqrt(1 - haversine))
        legs[geom_offsets[:-1]] = 0  # Consecutive geometries have independent origins.
        geometry_lengths[start:end] = np.add.reduceat(legs, geom_offsets[:-1])
        geometry_cursor = end
    assert geometry_cursor == geometries, "Missing geometries"
    sources = np.repeat(np.arange(nodes, dtype="<u4"), np.diff(offsets))
    reversed_ = (arrays["geometryRefs"] & 0x80000000) != 0
    for name, starts, ends in (("lat", starts_lat, ends_lat), ("lon", starts_lon, ends_lon)):
        expected_source = np.where(reversed_, ends[geometry_ids], starts[geometry_ids])
        expected_target = np.where(reversed_, starts[geometry_ids], ends[geometry_ids])
        assert np.array_equal(arrays[name][sources], expected_source), f"Geometry {name} source mismatch"
        assert np.array_equal(arrays[name][arrays["targets"]], expected_target), f"Geometry {name} target mismatch"
    expected_lengths = geometry_lengths[geometry_ids]
    assert np.allclose(arrays["lengths"], expected_lengths, atol=0.05, rtol=1e-5), "Stored road costs differ from geometry arc lengths"
    for incoming, outgoing in turns:
        assert 0 <= incoming < edges and 0 <= outgoing < edges, "Out-of-range turn restriction"
        assert arrays["targets"][incoming] == sources[outgoing], "Turn restriction edges do not meet"
    for place in places:
        assert place["name"] and -90 <= place["lat"] <= 90 and -180 <= place["lng"] <= 180, "Invalid gazetteer place"
    compressed_bytes = sum((directory / chunk["file"]).stat().st_size for chunk in manifest["graphChunks"] + manifest["geometryChunks"])
    compressed_bytes += sum((directory / manifest[key]).stat().st_size for key in ("roadsFile", "placesFile", "restrictionsFile"))
    assert compressed_bytes == manifest["totalCompressedBytes"], "Wrong complete database byte count"
    refs = {road["ref"] for road in roads if road["ref"]}
    print(f"Validated {nodes:,} nodes, {edges:,} edges, {geometries:,} shapes, {len(turns):,} forbidden turns; {compressed_bytes / 1048576:.1f} MiB compressed")
    print(f"Numbered references: {len(refs):,}; A47 {'present' if 'A47' in refs else 'absent'}; M1 {'present' if 'M1' in refs else 'absent'}")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", nargs="?", default="public/data")
    validate(parser.parse_args().directory)
