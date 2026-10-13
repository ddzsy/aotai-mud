#!/usr/bin/env python3
"""从 Mapbox Skadi SRTM 瓦片生成 terrain-heightmap.png 与 terrain-meta.json。"""
import gzip
import json
import urllib.request
import numpy as np
from PIL import Image

LA0, LA1 = 32.90, 34.06
LO0, LO1 = 107.50, 107.90
TILES = ["N34E106", "N34E107", "N33E107"]
OUT_W, OUT_H = 384, 352


def load_tile(tile: str):
    url = f"https://elevation-tiles-prod.s3.amazonaws.com/skadi/{tile[:3]}/{tile}.hgt.gz"
    with urllib.request.urlopen(url, timeout=90) as r:
        raw = gzip.decompress(r.read())
    side = int((len(raw) // 2) ** 0.5)
    arr = np.frombuffer(raw, dtype=">i2").reshape(side, side).astype(np.float32)
    return arr, int(tile[1:3]), int(tile[4:7])


def main():
    rows = int(round((LA1 - LA0) * 3600)) + 1
    cols = int(round((LO1 - LO0) * 3600)) + 1
    dem = np.full((rows, cols), np.nan, dtype=np.float32)
    for tile in TILES:
        arr, lat_top, lon_left = load_tile(tile)
        for i, lat in enumerate(np.linspace(LA1, LA0, rows)):
            for j, lon in enumerate(np.linspace(LO0, LO1, cols)):
                if not (lat_top - 1 <= lat <= lat_top) or not (lon_left <= lon < lon_left + 1):
                    continue
                r = int(round((lat_top - lat) * 3600))
                c = int(round((lon - lon_left) * 3600))
                if 0 <= r < 3601 and 0 <= c < 3601:
                    dem[i, j] = arr[r, c]
    dem = np.where(np.isnan(dem), np.nanmean(dem), dem)
    emin, emax = float(dem.min()), float(dem.max())
    norm = ((dem - emin) / (emax - emin) * 255).astype(np.uint8)
    Image.fromarray(norm).resize((OUT_W, OUT_H), Image.BILINEAR).save(
        "terrain-heightmap.png", optimize=True
    )
    meta = {
        "lat_min": LA0,
        "lat_max": LA1,
        "lon_min": LO0,
        "lon_max": LO1,
        "elev_min": emin,
        "elev_max": emax,
        "width": OUT_W,
        "height": OUT_H,
        "source": "SRTM Skadi 1 arc-sec (merged)",
    }
    with open("terrain-meta.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print("wrote terrain-heightmap.png", emin, "–", emax, "m")


if __name__ == "__main__":
    main()
