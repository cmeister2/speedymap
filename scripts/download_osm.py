#!/usr/bin/env python3
"""Resume a Geofabrik download with bounded parallel HTTP byte ranges."""
import argparse
import concurrent.futures
import hashlib
import os
from pathlib import Path
import shutil
import time
import urllib.request
import json


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def md5_file(path):
    digest = hashlib.md5()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def download(url, target, workers=8):
    if not 1 <= workers <= 16:
        raise ValueError("workers must be between 1 and 16")
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(urllib.request.Request(url, method="HEAD")) as response:
        size = int(response.headers["Content-Length"])
        resolved = response.url
    with urllib.request.urlopen(resolved + ".md5") as response:
        expected = response.read().decode().split()[0].lower()
    provenance = {"url": resolved, "bytes": size, "md5": expected}
    source_record = target.with_suffix(target.suffix + ".source.json")
    if target.exists() and target.stat().st_size == size:
        print(f"Checking cached source checksum: {target}", flush=True)
        if md5_file(target) == expected:
            source_record.write_text(json.dumps(provenance) + "\n")
            print(f"Verified cached {target}: {size:,} bytes, MD5 {expected}", flush=True)
            return resolved
        print("Cached source checksum failed; downloading a verified replacement", flush=True)
    parts = target.with_suffix(target.suffix + ".parts")
    span = (size + workers - 1) // workers
    parts_provenance = dict(provenance, workers=workers, span=span)
    if parts.exists() and read_json(parts / "provenance.json") != parts_provenance:
        print("Discarding stale ranges from another source or range layout", flush=True)
        shutil.rmtree(parts)
    parts.mkdir(exist_ok=True)
    (parts / "provenance.json").write_text(json.dumps(parts_provenance) + "\n")
    if target.exists() and target.stat().st_size < span and read_json(source_record) == provenance and not (parts / "000").exists():
        shutil.move(target, parts / "000")

    def fetch(i):
        start, end = i * span, min(size, (i + 1) * span) - 1
        part = parts / f"{i:03}"
        for attempt in range(6):
            have = part.stat().st_size if part.exists() else 0
            if have > end - start + 1:
                part.unlink()
                have = 0
            if have == end - start + 1:
                return part
            request = urllib.request.Request(resolved, headers={"Range": f"bytes={start + have}-{end}"})
            try:
                with urllib.request.urlopen(request, timeout=120) as response, part.open("ab") as out:
                    if response.status != 206:
                        raise RuntimeError("Server did not honor byte range")
                    wanted_range = f"bytes {start + have}-{end}/{size}"
                    if response.headers.get("Content-Range") != wanted_range:
                        raise RuntimeError("Server returned a different byte range")
                    shutil.copyfileobj(response, out, 1024 * 1024)
                if part.stat().st_size == end - start + 1:
                    print(f"Downloaded part {i + 1}/{workers}", flush=True)
                    return part
                raise RuntimeError("Incomplete range")
            except Exception:
                if attempt == 5:
                    raise
                time.sleep(2 ** attempt)

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        files = list(pool.map(fetch, range(workers)))
    temporary = target.with_suffix(target.suffix + ".tmp")
    digest = hashlib.md5()
    with temporary.open("wb") as out:
        for part in files:
            with part.open("rb") as source:
                while block := source.read(1024 * 1024):
                    out.write(block)
                    digest.update(block)
    if digest.hexdigest() != expected:
        temporary.unlink(missing_ok=True)
        shutil.rmtree(parts)
        raise RuntimeError(f"MD5 mismatch: {digest.hexdigest()} != {expected}")
    os.replace(temporary, target)
    shutil.rmtree(parts)
    source_record.write_text(json.dumps(provenance) + "\n")
    print(f"Verified {target}: {size:,} bytes, MD5 {expected}", flush=True)
    return resolved


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="https://download.geofabrik.de/europe/united-kingdom-latest.osm.pbf")
    parser.add_argument("--output", default=".cache/united-kingdom-latest.osm.pbf")
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    download(args.url, args.output, args.workers)
    polygon = Path(args.output).parent / "wales.poly"
    if not polygon.exists():
        urllib.request.urlretrieve("https://download.geofabrik.de/europe/united-kingdom/wales.poly", polygon)
    print(f"Wales boundary: {polygon}", flush=True)
