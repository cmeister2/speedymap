import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from download_osm import download


class Response(io.BytesIO):
    def __init__(self, data, *, status=200, headers=None, url="https://example.invalid/dated.pbf"):
        super().__init__(data)
        self.status = status
        self.headers = headers or {}
        self.url = url


class DownloadTests(unittest.TestCase):
    def server(self, payload):
        calls = []
        digest = hashlib.md5(payload).hexdigest()

        def open_(request, timeout=None):
            url = request if isinstance(request, str) else request.full_url
            method = "GET" if isinstance(request, str) else request.get_method()
            if method == "HEAD":
                return Response(b"", headers={"Content-Length": str(len(payload))})
            if url.endswith(".md5"):
                return Response((digest + "  dated.pbf\n").encode())
            range_ = request.get_header("Range")
            calls.append(range_)
            start, end = map(int, range_.removeprefix("bytes=").split("-"))
            return Response(payload[start:end + 1], status=206, headers={"Content-Range": f"bytes {start}-{end}/{len(payload)}"})

        return open_, calls, digest

    def test_same_size_cache_requires_checksum_and_stale_ranges_are_replaced(self):
        payload = b"new-road-database"
        open_, calls, digest = self.server(payload)
        with tempfile.TemporaryDirectory() as temp, patch("download_osm.urllib.request.urlopen", side_effect=open_):
            target = Path(temp) / "source.pbf"
            target.write_bytes(b"X" * len(payload))
            parts = target.with_suffix(".pbf.parts")
            parts.mkdir()
            (parts / "000").write_bytes(b"stale-range")
            (parts / "provenance.json").write_text(json.dumps({"url": "old-source"}))
            download("https://example.invalid/latest.pbf", target, workers=2)
            self.assertEqual(target.read_bytes(), payload)
            self.assertEqual(len(calls), 2)
            self.assertFalse(parts.exists())
            self.assertEqual(json.loads(target.with_suffix(".pbf.source.json").read_text())["md5"], digest)
            calls.clear()
            download("https://example.invalid/latest.pbf", target, workers=2)
            self.assertEqual(calls, [])  # Checksum-verified complete cache performs no range requests.

    def test_matching_provenance_resumes_only_incomplete_range(self):
        payload = b"ABCDEFGH"
        open_, calls, digest = self.server(payload)
        with tempfile.TemporaryDirectory() as temp, patch("download_osm.urllib.request.urlopen", side_effect=open_):
            target = Path(temp) / "source.pbf"
            parts = target.with_suffix(".pbf.parts")
            parts.mkdir()
            (parts / "provenance.json").write_text(json.dumps({"url": "https://example.invalid/dated.pbf", "bytes": 8, "md5": digest, "workers": 2, "span": 4}))
            (parts / "000").write_bytes(b"AB")
            (parts / "001").write_bytes(b"EFGH")
            download("https://example.invalid/latest.pbf", target, workers=2)
            self.assertEqual(target.read_bytes(), payload)
            self.assertEqual(calls, ["bytes=2-3"])


if __name__ == "__main__":
    unittest.main()
