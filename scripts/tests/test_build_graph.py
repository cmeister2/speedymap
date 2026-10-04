import gzip
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_graph import Polygon, access_allowed, build, directions, parse_speed, speed_limit


FIXTURE = '''<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="speedymap-test">
  <node id="1" lat="52.00" lon="-1.00"/>
  <node id="2" lat="52.00" lon="-0.99"/>
  <node id="3" lat="52.00" lon="-0.98"/>
  <node id="4" lat="52.01" lon="-0.99"/>
  <node id="5" lat="51.48" lon="-3.20"><tag k="place" v="city"/><tag k="name" v="Cardiff"/></node>
  <node id="6" lat="51.48" lon="-3.19"/>
  <node id="7" lat="52.01" lon="-0.98"/>
  <node id="8" lat="52.01" lon="-0.97"/>
  <node id="9" lat="52.01" lon="-0.96"><tag k="barrier" v="bollard"/></node>
  <node id="10" lat="52.01" lon="-0.95"/>
  <way id="100"><nd ref="1"/><nd ref="2"/><nd ref="3"/><tag k="highway" v="primary"/><tag k="ref" v="A47"/><tag k="maxspeed:forward" v="50 mph"/><tag k="maxspeed:backward" v="30 mph"/></way>
  <way id="101"><nd ref="2"/><nd ref="4"/><tag k="highway" v="motorway"/><tag k="ref" v="M1"/></way>
  <way id="102"><nd ref="5"/><nd ref="6"/><tag k="highway" v="residential"/></way>
  <way id="103"><nd ref="4"/><nd ref="7"/><tag k="highway" v="service"/><tag k="access" v="destination"/></way>
  <way id="104"><nd ref="7"/><nd ref="8"/><tag k="highway" v="service"/><tag k="access" v="private"/></way>
  <way id="105"><nd ref="8"/><nd ref="9"/><nd ref="10"/><tag k="highway" v="service"/></way>
  <relation id="200"><member type="way" ref="100" role="from"/><member type="node" ref="2" role="via"/><member type="way" ref="101" role="to"/><tag k="type" v="restriction"/><tag k="restriction" v="no_right_turn"/></relation>
</osm>'''


class BuilderTests(unittest.TestCase):
    def test_osm_speed_units_direction_and_access(self):
        self.assertEqual(parse_speed("70 mph"), 70)
        self.assertAlmostEqual(parse_speed("100"), 62.137119, places=5)
        self.assertEqual(parse_speed("GB:nsl_dual"), 70)
        self.assertIsNone(parse_speed("signals"))
        self.assertEqual(speed_limit({"highway": "residential"}, "forward", True), (200, 1))
        self.assertEqual(speed_limit({"highway": "residential"}, "forward", False), (300, 1))
        self.assertEqual(speed_limit({"highway": "primary", "maxspeed:lanes": "30 mph|50 mph"}, "forward", False), (500, 0))
        self.assertTrue(access_allowed({"access": "private", "motorcar": "yes"}))
        self.assertFalse(access_allowed({"access": "yes", "motorcar": "no"}))
        self.assertEqual(directions({"highway": "motorway"}), (True, False))
        self.assertEqual(directions({"highway": "motorway", "oneway": "no"}), (True, True))
        self.assertEqual(directions({"highway": "primary", "oneway": "-1"}), (False, True))

    def test_real_osm_to_binary_graph(self):
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp)
            source, polygon, output = temp / "fixture.osm", temp / "wales.poly", temp / "data"
            source.write_text(FIXTURE)
            source_record = {"url": "https://example.invalid/dated-fixture.osm", "bytes": source.stat().st_size, "md5": hashlib.md5(source.read_bytes()).hexdigest()}
            source.with_suffix(".osm.source.json").write_text(json.dumps(source_record))
            polygon.write_text("test\n1\n -4 51\n -2 51\n -2 52\n -4 52\n -4 51\nEND\nEND\n")
            output.mkdir()
            stale = output / "graph-999.0000000000000000.bin.gz"
            stale.write_bytes(b"previous snapshot")
            node_cache = temp / "node-locations.bin"
            manifest = build(source, output, polygon, source_date="2026-10-03T20:20:50Z", location_index=f"sparse_file_array,{node_cache}")
            self.assertEqual(manifest["source"]["url"], source_record["url"])
            self.assertEqual(manifest["source"]["md5"], source_record["md5"])
            self.assertFalse(node_cache.exists())
            self.assertFalse(stale.exists())
            for chunk in manifest["graphChunks"] + manifest["geometryChunks"]:
                self.assertRegex(chunk["file"], r"^(graph|geometry)-\d{3}\.[0-9a-f]{16}\.bin\.gz$")
            graph = b"".join(gzip.decompress((output / chunk["file"]).read_bytes()) for chunk in manifest["graphChunks"])
            arrays = {}
            dtypes = {"Int32": "<i4", "Uint32": "<u4", "Float32": "<f4", "Uint16": "<u2", "Uint8": "u1"}
            for section in manifest["sections"]:
                arrays[section["name"]] = np.frombuffer(graph, dtype=dtypes[section["type"]], count=section["count"], offset=section["byteOffset"])
            roads = json.loads(gzip.decompress((output / manifest["roadsFile"]).read_bytes()))
            refs = np.array([roads[road]["ref"] for road in arrays["roads"]])
            a47 = refs == "A47"
            self.assertEqual(set(arrays["limits"][a47]), {300, 500})
            self.assertTrue(np.all(arrays["flags"][a47] == 0))
            m1 = refs == "M1"
            self.assertTrue(np.all(arrays["limits"][m1] == 700))
            sources = np.repeat(np.arange(manifest["nodes"]), np.diff(arrays["offsets"]))
            self.assertTrue(np.all(arrays["lat"][arrays["targets"][m1]] >= arrays["lat"][sources[m1]]))
            self.assertGreater(np.count_nonzero(arrays["flags"] & 2), 0)
            wales = arrays["lat"][sources] == 51480000
            self.assertTrue(np.all(arrays["limits"][wales] == 200))
            self.assertLessEqual(float(arrays["lengths"].max()), 250.2)
            turns = json.loads(gzip.decompress((output / manifest["restrictionsFile"]).read_bytes()))
            self.assertEqual(len(turns), 2)  # Each A47 direction into the M1.
            for incoming, outgoing in turns:
                self.assertEqual(refs[incoming], "A47")
                self.assertEqual(refs[outgoing], "M1")
                self.assertEqual(arrays["targets"][incoming], sources[outgoing])
            self.assertEqual(manifest["placeCount"], 1)
            self.assertEqual(manifest["totalCompressedBytes"], sum(path.stat().st_size for path in output.glob("*.gz")))
            for chunk in manifest["geometryChunks"]:
                data = gzip.decompress((output / chunk["file"]).read_bytes())
                self.assertEqual(len(data), chunk["byteLength"])
                count, points = np.frombuffer(data, dtype="<u4", count=2)
                offsets = np.frombuffer(data, dtype="<u4", count=int(count) + 1, offset=8)
                self.assertEqual(offsets[-1], points)

    def test_rounding_near_segment_boundary_keeps_shapes_on_road(self):
        # The first leg is 250.010541m. Its interpolated 250m endpoint rounds
        # onto the original vertex; the next leg must start a fresh segment.
        source = '''<osm version="0.6"><node id="1" lat="52" lon="-1"/>
          <node id="2" lat="52" lon="-0.996348"/><node id="3" lat="52" lon="-0.99"/>
          <way id="1"><nd ref="1"/><nd ref="2"/><nd ref="3"/>
          <tag k="highway" v="primary"/><tag k="ref" v="A47"/></way></osm>'''
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp)
            path = temp / "rounding.osm"
            path.write_text(source)
            manifest = build(path, temp / "data", region="Test fixture", source_date="test")
            graph = b"".join(gzip.decompress((temp / "data" / chunk["file"]).read_bytes()) for chunk in manifest["graphChunks"])
            section = next(section for section in manifest["sections"] if section["name"] == "lengths")
            lengths = np.frombuffer(graph, dtype="<f4", count=section["count"], offset=section["byteOffset"])
            self.assertLessEqual(float(lengths.max()), 250.2)
            self.assertAlmostEqual(float(lengths.sum()) / 2, 684.585266, places=2)


if __name__ == "__main__":
    unittest.main()
